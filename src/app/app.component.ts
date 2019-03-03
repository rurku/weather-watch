import { Component, OnInit, ViewChild } from '@angular/core';
import * as AWS from 'aws-sdk';
import * as moment from 'moment';
import { Chart } from 'chart.js';
import * as _ from 'lodash';

import * as AWSConfig from './aws-config.json';
import { DynamoDB } from 'aws-sdk';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit {
  chart: any;
  private dynamodb: DynamoDB;
  reading: object;

  constructor() {
    AWS.config.region = AWSConfig.Region;
    AWS.config.credentials = new AWS.CognitoIdentityCredentials({
      IdentityPoolId: AWSConfig.IdentityPoolId
    });
    this.dynamodb = new AWS.DynamoDB();
  }

  ngOnInit() {
    this.scan();
  }

  private async scan() {
    setTimeout(() => this.scan(), 300000);
    const nowUtc = Math.floor(Date.now() / 1000);
    const rangeStart = nowUtc - 60 * 60 * 24;
    const params: DynamoDB.ScanInput = {
      TableName: 'temp201903',
      FilterExpression: '#ts BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':from': {N: rangeStart.toFixed()},
        ':to': {N: nowUtc.toFixed()},
      },
      ExpressionAttributeNames: {'#ts': 'timestamp', '#temp': 'temp'},
      ProjectionExpression: '#ts, #temp'
    };
    const result = await this.dynamodb.scan(params).promise();
    const lastReading = result.Items.sort((a, b) => ((parseInt(a.timestamp.N, 10) > parseInt(b.timestamp.N, 10)) ? -1 : 1))[0];
    console.debug(`scanned: ${result.ScannedCount} count: ${result.Count} capacity: ${JSON.stringify(result.ConsumedCapacity)}`);
    const lastTimestamp = moment(parseInt(lastReading.timestamp.N, 10) * 1000);
    this.reading = {temp: parseFloat(lastReading.temp.N).toFixed(1), time: lastTimestamp.format('YYYY-MM-DD HH:mm:ss')};
    this.showChart(result, rangeStart, nowUtc);
  }

  private showChart(samples: DynamoDB.ScanOutput, timestampFrom: number, timestampTo: number) {
    const data = samples.Items.map((item): any => {
      return {
        x: parseInt(item.timestamp.N, 10),
        y: parseFloat(item.temp.N)
      };
    });
    const grouped = _.groupBy(data, i => Math.floor(i.x / 600) * 600);
    const average = _.map(grouped, (g, key) => {
      return {
        y: Math.round(_.meanBy(g, item => item.y) * 100) / 100,
        x: key,
      };
    });

    const minValue = _.minBy(average, x => x.y).y;
    const maxValue = _.maxBy(average, x => x.y).y;
    let suggestedLow: number;
    let suggestedHigh: number;
    if (maxValue - minValue < 6)
    {
      suggestedLow = (maxValue + minValue) / 2 + 3;
      suggestedHigh = (maxValue + minValue) / 2 - 3;
    }


    this.chart = new Chart('canvas2', {
        type: 'scatter',
        data: {
            datasets: [{
                data: average,
                fill: false,
                borderColor: 'rgba(100,100,100,1)'
                // backgroundColor: [
                //     'rgba(255, 99, 132, 0.2)',
                //     'rgba(54, 162, 235, 0.2)',
                //     'rgba(255, 206, 86, 0.2)',
                //     'rgba(75, 192, 192, 0.2)',
                //     'rgba(153, 102, 255, 0.2)',
                //     'rgba(255, 159, 64, 0.2)'
                // ],
                // borderColor: [
                //     'rgba(255,99,132,1)',
                //     'rgba(54, 162, 235, 1)',
                //     'rgba(255, 206, 86, 1)',
                //     'rgba(75, 192, 192, 1)',
                //     'rgba(153, 102, 255, 1)',
                //     'rgba(255, 159, 64, 1)'
                // ],
                // borderWidth: 1
            }]
        },
        options: {
          scales: {
              xAxes: [{
                ticks: {
                  min: timestampFrom,
                  max: timestampTo,
                  stepSize: 3600,
                  callback: (value, index, values) => {
                    return moment(value * 1000).format('HH:mm');
                  }
                }
              }],
              yAxes: [{
                ticks: {
                  min: suggestedLow,
                  max: suggestedHigh,
                }
              }]
          },
          tooltips: {
            callbacks: {
              label: function (tooltipItem, data) {
                return [
                  `${tooltipItem.yLabel}℃`,
                  moment(tooltipItem.xLabel * 1000).format('YYYY-MM-DD HH:mm')
                ];
              }
            }
          },
          legend: {
            display: false
          }
        }
    });
  }
}
