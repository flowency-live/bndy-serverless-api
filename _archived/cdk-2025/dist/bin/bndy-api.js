#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("source-map-support/register");
const cdk = require("aws-cdk-lib");
const bndy_api_stack_1 = require("../lib/bndy-api-stack");
const app = new cdk.App();
new bndy_api_stack_1.BndyApiStack(app, 'BndyApiStack', {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: 'eu-west-2',
    },
    description: 'BNDY Platform Serverless API - Lambda Functions + API Gateway',
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYm5keS1hcGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9iaW4vYm5keS1hcGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQ0EsdUNBQXFDO0FBQ3JDLG1DQUFtQztBQUNuQywwREFBcUQ7QUFFckQsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7QUFFMUIsSUFBSSw2QkFBWSxDQUFDLEdBQUcsRUFBRSxjQUFjLEVBQUU7SUFDcEMsR0FBRyxFQUFFO1FBQ0gsT0FBTyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CO1FBQ3hDLE1BQU0sRUFBRSxXQUFXO0tBQ3BCO0lBQ0QsV0FBVyxFQUFFLCtEQUErRDtDQUM3RSxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIjIS91c3IvYmluL2VudiBub2RlXHJcbmltcG9ydCAnc291cmNlLW1hcC1zdXBwb3J0L3JlZ2lzdGVyJztcclxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcclxuaW1wb3J0IHsgQm5keUFwaVN0YWNrIH0gZnJvbSAnLi4vbGliL2JuZHktYXBpLXN0YWNrJztcclxuXHJcbmNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XHJcblxyXG5uZXcgQm5keUFwaVN0YWNrKGFwcCwgJ0JuZHlBcGlTdGFjaycsIHtcclxuICBlbnY6IHtcclxuICAgIGFjY291bnQ6IHByb2Nlc3MuZW52LkNES19ERUZBVUxUX0FDQ09VTlQsXHJcbiAgICByZWdpb246ICdldS13ZXN0LTInLFxyXG4gIH0sXHJcbiAgZGVzY3JpcHRpb246ICdCTkRZIFBsYXRmb3JtIFNlcnZlcmxlc3MgQVBJIC0gTGFtYmRhIEZ1bmN0aW9ucyArIEFQSSBHYXRld2F5JyxcclxufSk7XHJcbiJdfQ==