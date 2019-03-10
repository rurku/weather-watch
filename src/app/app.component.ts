import { Component, OnInit, ViewChild } from '@angular/core';
import * as AWS from 'aws-sdk/global';
import * as DynamoDB from 'aws-sdk/clients/dynamodb';
import * as moment from 'moment';
import * as Chart from 'chart.js';
import { groupBy as _groupBy, map as _map, minBy as _minBy, maxBy as _maxBy, meanBy as _meanBy } from 'lodash-es';

import * as AWSConfig from './aws-config.json';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit {
  chart: Chart;
  private dynamodb: DynamoDB;
  reading: object;
  public date: moment.Moment;
  public period: string;
  private refreshCount = 0;

  constructor() {
    AWS.config.region = AWSConfig.Region;
    AWS.config.credentials = new AWS.CognitoIdentityCredentials({
      IdentityPoolId: AWSConfig.IdentityPoolId
    });
    this.dynamodb = new DynamoDB();
  }

  ngOnInit() {
    this.date = moment();
    this.period = '1 day';

    this.scheduleRefresh();
  }

  periodChange(period: string) {
    this.period = period;
    this.scheduleRefresh();
  }

  scheduleRefresh() {
    this.refreshCount ++;
    setTimeout((refreshCount) => {
      this.refresh(refreshCount);
    }, 0, this.refreshCount);
  }

  async refresh(refreshCount: number) {
    if (refreshCount !== this.refreshCount) { return; }

    const lastResult = await this.dynamodb.query({
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

    const regex = /^(?<number>\d+) *(?<period>\w+)$/;
    const match = regex.exec(this.period);
    if (match) {
      const rangeEnd = moment(this.date).utc().unix();
      const period = match.groups.period as moment.unitOfTime.DurationConstructor;
      const rangeStart = moment(this.date).utc().add(-parseInt(match.groups.number, 10), period).unix();
      const resolution = 672;
      //const resolution = 2787;

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

      let pkRange = moment.unix(rangeStart).utc();
      const pkRangeEnd = formatPk(moment.unix(rangeEnd).utc())
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
        const result = await this.dynamodb.query(params).promise();
        if (refreshCount !== this.refreshCount) { return; }
        items.push(...result.Items);
        pkRange.add(1, pkUnit as moment.unitOfTime.DurationConstructor);
      }

      this.showChart(items, rangeStart, rangeEnd, resolution);
    }

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

    const minValue = _minBy(average, x => x.y).y;
    const maxValue = _maxBy(average, x => x.y).y;
    let suggestedLow: number;
    let suggestedHigh: number;
    if (maxValue - minValue < 6)
    {
      suggestedLow = (maxValue + minValue) / 2 + 3;
      suggestedHigh = (maxValue + minValue) / 2 - 3;
    }

    if (!this.chart) {
      this.chart = new Chart('canvas2', {
          type: 'scatter',
          data: {
              datasets: [{
                  data: average,
                  fill: false,
                  borderColor: 'rgba(200,200,200,1)',
                  borderWidth: 1,
                  //borderWidth: 1,
                  showLine: true,
                  pointRadius: 1.5,
                  pointHitRadius: 0,
                  pointBorderWidth: 0,
                  pointBackgroundColor: 'rgba(0,0,0,1)',
                  //pointHoverBackgroundColor: 'rgba(50,50,50,1)'
              }]
          },
          options: {
            responsive: true,
            aspectRatio: 4,
            scales: {
                xAxes: [{
                  afterBuildTicks: (a: any) => {
                    const ticks: number[] = [];
                    let hours: number[];
                    if (a.max - a.min > 10 * 24 * 3600) {
                      hours = [0];
                    } else if (a.max - a.min > 24 * 3600) {
                      hours = [0, 6, 12, 18];
                    } else {
                      hours = Array.from(Array(24).keys());
                    }
                    let tick = Math.ceil(a.min / 3600) * 3600;
                    while (tick <= a.max) {
                      if (hours.includes(moment.unix(tick).hour())) {
                        ticks.push(tick);
                      }
                      tick += 3600;
                    }
                    a.ticks = ticks;
                  },
                  ticks: {
                    min: timestampFrom,
                    max: timestampTo,
                    stepSize: 3600,
                    callback: (value, index, values): any => {
                      if (moment.unix(value).hour() === 0 && moment.unix(value).minute() === 0) {
                        return [moment.unix(value).format('HH:mm'), moment.unix(value).format('YYYY-MM-DD')];
                      } else {
                        return [moment.unix(value).format('HH:mm')];
                      }
                    },
                    // major: {
                    //   fontStyle: 'bold',
                    //   display: true,
                    //   stepSize: 7200,
                    // },
                  },
                }],
                yAxes: [{
                  ticks: {
//                    min: Math.floor(suggestedLow),
//                    max: Math.floor(suggestedHigh),
                    stepSize: 1,
                    autoSkip: false
                  }
                }]
            },
            tooltips: {
              mode: 'x',
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
      //this.chart.config.options.scales.yAxes[0].ticks.min = suggestedLow;
      //this.chart.config.options.scales.yAxes[0].ticks.max = suggestedHigh;
      this.chart.update();
    }
  }
}
