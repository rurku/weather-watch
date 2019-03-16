import { Component, OnInit, ViewChild } from '@angular/core';
import * as AWS from 'aws-sdk/global';
import * as DynamoDB from 'aws-sdk/clients/dynamodb';
import * as moment from 'moment';
import * as Chart from 'chart.js';
import { groupBy as _groupBy, map as _map, minBy as _minBy, maxBy as _maxBy, meanBy as _meanBy } from 'lodash-es';

import { DateAdapter, MAT_DATE_LOCALE, MAT_DATE_FORMATS } from '@angular/material';
import { MomentDateAdapter } from '@angular/material-moment-adapter';

export const MY_FORMATS = {
  parse: {
    dateInput: 'YYYY-MM-DD',
  },
  display: {
    dateInput: 'YYYY-MM-DD',
    monthYearLabel: 'MMM YYYY',
    dateA11yLabel: 'LL',
    monthYearA11yLabel: 'MMMM YYYY',
  },
};

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
  providers: [
    // `MomentDateAdapter` can be automatically provided by importing `MomentDateModule` in your
    // application's root module. We provide it at the component level here, due to limitations of
    // our example generation script.
    {provide: DateAdapter, useClass: MomentDateAdapter, deps: [MAT_DATE_LOCALE]},

    {provide: MAT_DATE_FORMATS, useValue: MY_FORMATS},
  ],
})
export class AppComponent implements OnInit {
  chart: Chart;
  private dynamoDbPromise: Promise<DynamoDB>;
  reading: object;
  public date: moment.Moment;
  public time: string;
  public period: string;
  private refreshCount = 0;

  ngOnInit() {
    this.dynamoDbPromise = (async (): Promise<DynamoDB> => {
      const jsonFetch = await fetch('aws-config.json');
      const AWSConfig = await jsonFetch.json();
      AWS.config.region = AWSConfig.Region;
      AWS.config.credentials = new AWS.CognitoIdentityCredentials({
        IdentityPoolId: AWSConfig.IdentityPoolId
      });
      return new DynamoDB();
    })();

    this.setDate(moment());
    this.period = '1d';

    this.scheduleRefresh();
  }

  periodChange(period: string) {
    this.period = period;
    this.scheduleRefresh();
  }

  private addPeriod(t: moment.Moment, subtract = false): moment.Moment {
    const regex = /^(?<number>\d+) *(?<period>\w+)$/;
    const match = regex.exec(this.period);
    const clone = moment(t);
    if (match) {
      const period = match.groups.period as moment.unitOfTime.DurationConstructor;
      clone.add((subtract ? -1 : 1) * parseInt(match.groups.number, 10), period);
    }
    return clone;
  }

  nextPeriod() {
    const dateTime = this.addPeriod(this.getDate());
    this.setDate(dateTime);
    this.scheduleRefresh();
  }

  previousPeriod() {
    const dateTime = this.addPeriod(this.getDate(), true);
    this.setDate(dateTime);
    this.scheduleRefresh();
  }


  setDate(date: moment.Moment) {
    this.date = moment(date).startOf('day');
    this.time = date.format('HH:mm');
  }

  scheduleRefresh() {
    this.refreshCount ++;
    setTimeout((refreshCount) => {
      this.refresh(refreshCount);
    }, 0, this.refreshCount);
  }

  private getDate(): moment.Moment {
    return moment(this.date).add(moment.duration(this.time));
  }

  async refresh(refreshCount: number) {
    const dynamodb = await this.dynamoDbPromise;
    if (refreshCount !== this.refreshCount) { return; }
    const lastResult = await dynamodb.query({
      TableName: 'temperature',
      KeyConditionExpression: 'DayKey = :pk',
      ExpressionAttributeValues: {
        ':pk': {S: moment().utc().format('YYYY-MM-DD')}
      },
      ProjectionExpression: '#ts, #temp',
      ExpressionAttributeNames: {'#ts': 'Timestamp', '#temp': 'Temp'},
      ScanIndexForward: false,
      Limit: 1
    }).promise();
    if (refreshCount !== this.refreshCount) { return; }

    const lastReading = lastResult.Items[0];
    const lastTimestamp = moment.unix(parseInt(lastReading.Timestamp.N, 10));
    this.reading = {temp: parseFloat(lastReading.Temp.N).toFixed(1), time: lastTimestamp.format('YYYY-MM-DD HH:mm:ss')};

    const rangeEnd = this.getDate().utc().unix();
    const rangeStart = this.addPeriod(this.getDate(), true).utc().unix();
    const resolution = 672;

    const minSampleRate = (rangeEnd - rangeStart) / resolution;

    let formatPk: ((t: moment.Moment) => string);
    let pkName: string;
    let pkUnit: string;
    let indexName: string;
    if (minSampleRate >= 3 * 60 * 60) {
      pkName = 'YearKey';
      pkUnit = 'year';
      formatPk = (t) => moment(t).utc().format('YYYY');
      indexName = 'ByYear';
    } else if (minSampleRate >= 15 * 60) {
      pkName = 'MonthKey';
      pkUnit = 'month';
      formatPk = (t) => moment(t).utc().format('YYYY-MM');
      indexName = 'ByMonth';
    } else {
      pkName = 'DayKey';
      pkUnit = 'day';
      formatPk = (t) => moment(t).utc().format('YYYY-MM-DD');
      indexName = undefined;
    }

    const items: DynamoDB.AttributeMap[] = [];

    const pkRange = moment.unix(rangeStart).utc();
    const pkRangeEnd = formatPk(moment.unix(rangeEnd).utc());
    while (formatPk(pkRange) <= pkRangeEnd) {
      const params: DynamoDB.QueryInput = {
        TableName: 'temperature',
        KeyConditionExpression: `${pkName} = :pk AND #ts BETWEEN :from AND :to`,
        ExpressionAttributeValues: {
          ':from': {N: rangeStart.toFixed()},
          ':to': {N: rangeEnd.toFixed()},
          ':pk': {S: formatPk(pkRange)}
        },
        ExpressionAttributeNames: {'#ts': 'Timestamp', '#temp': 'Temp'},
        ProjectionExpression: '#ts, #temp',
        IndexName: indexName,
      };
      const result = await dynamodb.query(params).promise();
      if (refreshCount !== this.refreshCount) { return; }
      items.push(...result.Items);
      pkRange.add(1, pkUnit as moment.unitOfTime.DurationConstructor);
    }

    this.showChart(items, rangeStart, rangeEnd, resolution);
  }

  private showChart(samples: DynamoDB.AttributeMap[], timestampFrom: number, timestampTo: number, resolution: number) {
    const data = samples.map((item): any => {
      return {
        x: parseInt(item.Timestamp.N, 10),
        y: parseFloat(item.Temp.N)
      };
    });

    const scaleFactor = (timestampTo - timestampFrom) / resolution;
    const grouped = _groupBy(data, i => Math.floor(Math.floor(i.x / scaleFactor) * scaleFactor));
    const average = _map(grouped, (g, key) => {
      return {
        y: Math.round(_meanBy(g, item => item.y) * 100) / 100,
        x: key,
      };
    });

    if (!this.chart) {
      this.chart = new Chart('canvas2', {
          type: 'scatter',
          data: {
              datasets: [{
                  data: average,
                  fill: false,
                  borderColor: 'rgba(50,50,50,1)',
                  borderWidth: 1,
                  showLine: true,
                  pointRadius: 0.5,
                  pointHitRadius: 0,
                  pointBorderWidth: 0,
                  pointBackgroundColor: 'rgba(0,0,0,1)',
              }]
          },
          options: {
            responsive: true,
            aspectRatio: 3,
            scales: {
                xAxes: [{
                  id: 'primary',
                  afterBuildTicks: (axis: any) => {
                    const ticks: number[] = [];
                    let tick = Math.ceil(axis.min / 3600) * 3600;
                    while (tick <= axis.max) {
                      ticks.push(tick);
                      tick += 3600;
                    }
                    axis.ticks = ticks;
                  },
                  ticks: {
                    min: timestampFrom,
                    max: timestampTo,
                    callback: (value, index, values): any => {
                        return moment.unix(value).format('HH:mm');
                    },
                    autoSkip: true,
                  },
                },
                {
                  id: 'secondary',
                  afterBuildTicks: (a: any) => {
                    const ticks: number[] = [];
                    const tickMoment = moment.unix(a.min).startOf('day');
                    while (tickMoment.isSameOrBefore(moment.unix(a.max))) {
                      if (tickMoment.isSameOrAfter(moment.unix(a.min))) {
                        ticks.push(moment(tickMoment).utc().unix());
                      }
                      tickMoment.add(1, 'day');
                    }
                    a.ticks = ticks;
                  },
                  type: 'linear',
                  gridLines: {
                    color: 'rgba(100,100,100,1)',
                    lineWidth: 1,
                    drawTicks: false,
                    drawBorder: false
                  },
                  ticks: {
                    min: timestampFrom,
                    max: timestampTo,
                    callback: (value, index, values): any => {
                      return moment.unix(value).format('YYYY-MM-DD');
                    },
                  }
                }],
                yAxes: [{
                  ticks: {
                    stepSize: 1
                  }
                }]
            },
            tooltips: {
              mode: 'index',
              intersect: false,
              callbacks: {
                label: (tooltipItem) =>  {
                  return [
                    `${tooltipItem.yLabel}℃`,
                    moment(parseInt(tooltipItem.xLabel, 10) * 1000).format('YYYY-MM-DD HH:mm')
                  ];
                }
              }
            },
            legend: {
              display: false
            }
          }
      });
    } else {
      this.chart.data.datasets[0].data = average;
      this.chart.config.options.scales.xAxes[0].ticks.min = timestampFrom;
      this.chart.config.options.scales.xAxes[0].ticks.max = timestampTo;
      this.chart.config.options.scales.xAxes[1].ticks.min = timestampFrom;
      this.chart.config.options.scales.xAxes[1].ticks.max = timestampTo;
      this.chart.update();
    }
  }
}
