import { Component, OnInit } from '@angular/core';
import * as AWS from 'aws-sdk';
import * as moment from 'moment';

import * as AWSConfig from './aws-config.json';
import { DynamoDB } from 'aws-sdk';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit {
  private dynamodb: DynamoDB;
  private reading: object;

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
  }
}
