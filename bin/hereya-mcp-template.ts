#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { HereyaMcpTemplateStack } from '../lib/hereya-mcp-template-stack';

const app = new cdk.App();
new HereyaMcpTemplateStack(app, process.env.STACK_NAME!, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
