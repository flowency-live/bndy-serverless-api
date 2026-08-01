#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BndyApiStack } from '../lib/bndy-api-stack';

const app = new cdk.App();

new BndyApiStack(app, 'BndyApiStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'eu-west-2',
  },
  description: 'BNDY Platform Serverless API - Lambda Functions + API Gateway',
});
