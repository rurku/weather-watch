import { Component, OnInit, ViewChild } from '@angular/core';
import * as AWS from 'aws-sdk/global';
import * as DynamoDB from 'aws-sdk/clients/dynamodb';
import { format } from 'date-fns';
import * as Chart from 'chart.js';
import { groupBy as _groupBy, map as _map, minBy as _minBy, maxBy as _maxBy, meanBy as _meanBy } from 'lodash-es';

import * as AWSConfig from './aws-config.json';

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
    this.dynamodb = new DynamoDB();
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
    const lastTimestamp = new Date(parseInt(lastReading.timestamp.N, 10) * 1000);
    this.reading = {temp: parseFloat(lastReading.temp.N).toFixed(1), time: format(lastTimestamp, 'YYYY-MM-DD HH:mm:ss')};
    this.showChart(result, rangeStart, nowUtc);
  }

  private showChart(samples: DynamoDB.ScanOutput, timestampFrom: number, timestampTo: number) {
    const data = samples.Items.map((item): any => {
      return {
        x: parseInt(item.timestamp.N, 10),
        y: parseFloat(item.temp.N)
      };
    });
    const grouped = _groupBy(data, i => Math.floor(i.x / 600) * 600);
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
                    return format(value * 1000, 'HH:mm');
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
              label: (tooltipItem) =>  {
                return [
                  `${tooltipItem.yLabel}℃`,
                  format(parseInt(tooltipItem.xLabel, 10) * 1000, 'YYYY-MM-DD HH:mm')
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
