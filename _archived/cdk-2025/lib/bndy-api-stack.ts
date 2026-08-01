import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';

// Lambda configuration for each function
interface LambdaConfig {
  name: string;
  path: string;
  description: string;
  memorySize?: number;
  timeout?: number;
  routes: {
    method: apigatewayv2.HttpMethod;
    path: string;
  }[];
  environment?: Record<string, string>;
}

export class BndyApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Use existing IAM role
    const lambdaRole = iam.Role.fromRoleArn(
      this,
      'ExistingLambdaRole',
      'arn:aws:iam::771551874768:role/bndy-api-instance-role'
    );

    // Create secret for JWT (migrate from hardcoded env var)
    const jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      secretName: 'bndy/jwt-secret',
      description: 'JWT signing secret for BNDY API',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'secret',
        excludePunctuation: true,
        passwordLength: 64,
      },
    });

    // Create HTTP API Gateway
    const httpApi = new apigatewayv2.HttpApi(this, 'BndyHttpApi', {
      apiName: 'bndy-api',
      description: 'BNDY Platform HTTP API',
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.PUT,
          apigatewayv2.CorsHttpMethod.DELETE,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'],
        maxAge: cdk.Duration.days(1),
      },
    });

    // Define all Lambda configurations
    const lambdaConfigs: LambdaConfig[] = [
      {
        name: 'artists',
        path: '../../artists-lambda',
        description: 'BNDY Artists API - handles /api/artists endpoints',
        routes: [
          { method: apigatewayv2.HttpMethod.GET, path: '/api/artists' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/artists/by-external-id' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/artists' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/artists/{id}' },
          { method: apigatewayv2.HttpMethod.PUT, path: '/api/artists/{id}' },
          { method: apigatewayv2.HttpMethod.PUT, path: '/api/artists/{id}/mcp' },
          { method: apigatewayv2.HttpMethod.DELETE, path: '/api/artists/{id}' },
        ],
      },
      {
        name: 'artist-songs',
        path: '../../artist-songs-lambda',
        description: 'BNDY Artist Songs API - handles /api/artist-songs endpoints',
        routes: [
          { method: apigatewayv2.HttpMethod.GET, path: '/api/artist-songs' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/artist-songs' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/artist-songs/{id}' },
          { method: apigatewayv2.HttpMethod.PUT, path: '/api/artist-songs/{id}' },
          { method: apigatewayv2.HttpMethod.DELETE, path: '/api/artist-songs/{id}' },
        ],
      },
      {
        name: 'auth',
        path: '../../auth-lambda',
        description: 'BNDY Authentication API - handles OAuth and sessions',
        routes: [
          { method: apigatewayv2.HttpMethod.POST, path: '/api/auth/login' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/auth/logout' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/auth/refresh' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/auth/me' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/auth/register' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/auth/facebook' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/auth/google' },
        ],
      },
      {
        name: 'events',
        path: '../../events-lambda',
        description: 'BNDY Events API - handles /api/events and /api/calendar endpoints',
        routes: [
          { method: apigatewayv2.HttpMethod.GET, path: '/api/events' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/events/by-external-id' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/events' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/events/{id}' },
          { method: apigatewayv2.HttpMethod.PUT, path: '/api/events/{id}' },
          { method: apigatewayv2.HttpMethod.PUT, path: '/api/events/{id}/mcp' },
          { method: apigatewayv2.HttpMethod.DELETE, path: '/api/events/{id}' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/calendar' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/calendar/{id}' },
        ],
      },
      {
        name: 'events-agent',
        path: '../../events-agent-lambda',
        description: 'BNDY Events Agent - AI-powered event discovery',
        memorySize: 1024,
        timeout: 120,
        routes: [
          { method: apigatewayv2.HttpMethod.POST, path: '/api/events-agent' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/events-agent/{id}' },
        ],
      },
      {
        name: 'flowency-invite',
        path: '../../flowency-invite-lambda',
        description: 'BNDY Flowency Integration - external invites',
        routes: [
          { method: apigatewayv2.HttpMethod.POST, path: '/api/flowency/invite' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/flowency/status/{id}' },
        ],
      },
      {
        name: 'invites',
        path: '../../invites-lambda',
        description: 'BNDY Invites API - handles artist/band invitations',
        routes: [
          { method: apigatewayv2.HttpMethod.GET, path: '/api/invites' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/invites' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/invites/{id}' },
          { method: apigatewayv2.HttpMethod.PUT, path: '/api/invites/{id}' },
          { method: apigatewayv2.HttpMethod.DELETE, path: '/api/invites/{id}' },
        ],
      },
      {
        name: 'issues',
        path: '../../issues-lambda',
        description: 'BNDY Issues API - handles user-reported issues',
        routes: [
          { method: apigatewayv2.HttpMethod.GET, path: '/api/issues' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/issues' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/issues/{id}' },
          { method: apigatewayv2.HttpMethod.PUT, path: '/api/issues/{id}' },
        ],
      },
      {
        name: 'memberships',
        path: '../../memberships-lambda',
        description: 'BNDY Memberships API - handles artist/band memberships',
        routes: [
          { method: apigatewayv2.HttpMethod.GET, path: '/api/memberships' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/memberships' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/memberships/{membershipId}' },
          { method: apigatewayv2.HttpMethod.PUT, path: '/api/memberships/{membershipId}' },
          { method: apigatewayv2.HttpMethod.DELETE, path: '/api/memberships/{membershipId}' },
        ],
      },
      {
        name: 'notifications',
        path: '../../notifications-lambda',
        description: 'BNDY Notifications API - handles push notifications',
        routes: [
          { method: apigatewayv2.HttpMethod.GET, path: '/api/notifications' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/notifications' },
          { method: apigatewayv2.HttpMethod.PUT, path: '/api/notifications/{id}' },
          { method: apigatewayv2.HttpMethod.DELETE, path: '/api/notifications/{id}' },
        ],
      },
      {
        name: 'setlists',
        path: '../../setlists-lambda',
        description: 'BNDY Setlists API - handles band setlists',
        routes: [
          { method: apigatewayv2.HttpMethod.GET, path: '/api/setlists' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/setlists' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/setlists/{id}' },
          { method: apigatewayv2.HttpMethod.PUT, path: '/api/setlists/{id}' },
          { method: apigatewayv2.HttpMethod.DELETE, path: '/api/setlists/{id}' },
        ],
      },
      {
        name: 'songs',
        path: '../../songs-lambda',
        description: 'BNDY Songs API - handles song library',
        routes: [
          { method: apigatewayv2.HttpMethod.GET, path: '/api/songs' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/songs' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/songs/{id}' },
          { method: apigatewayv2.HttpMethod.PUT, path: '/api/songs/{id}' },
          { method: apigatewayv2.HttpMethod.DELETE, path: '/api/songs/{id}' },
        ],
      },
      {
        name: 'spotify',
        path: '../../spotify-lambda',
        description: 'BNDY Spotify Integration - handles Spotify API',
        routes: [
          { method: apigatewayv2.HttpMethod.GET, path: '/api/spotify/search' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/spotify/track/{id}' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/spotify/artist/{id}' },
        ],
      },
      {
        name: 'uploads',
        path: '../../uploads-lambda',
        description: 'BNDY Uploads API - handles S3 file uploads',
        routes: [
          { method: apigatewayv2.HttpMethod.POST, path: '/api/uploads' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/uploads/{id}' },
          { method: apigatewayv2.HttpMethod.DELETE, path: '/api/uploads/{id}' },
        ],
      },
      {
        name: 'users',
        path: '../../users-lambda',
        description: 'BNDY Users API - handles user profiles',
        routes: [
          { method: apigatewayv2.HttpMethod.GET, path: '/api/users' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/users/{id}' },
          { method: apigatewayv2.HttpMethod.PUT, path: '/api/users/{id}' },
          { method: apigatewayv2.HttpMethod.DELETE, path: '/api/users/{id}' },
        ],
      },
      {
        name: 'venues',
        path: '../../venues-lambda',
        description: 'BNDY Venues API - handles /api/venues and integration endpoints',
        routes: [
          { method: apigatewayv2.HttpMethod.GET, path: '/api/venues' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/venues/by-external-id' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/venues' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/venues/{id}' },
          { method: apigatewayv2.HttpMethod.PUT, path: '/api/venues/{id}' },
          { method: apigatewayv2.HttpMethod.DELETE, path: '/api/venues/{id}' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/integration/venues' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/integration/venues/{id}' },
        ],
      },
      {
        name: 'venue-crm',
        path: '../../venue-crm-lambda',
        description: 'BNDY Venue CRM API - handles venue relationship management',
        routes: [
          { method: apigatewayv2.HttpMethod.GET, path: '/api/venue-crm' },
          { method: apigatewayv2.HttpMethod.POST, path: '/api/venue-crm' },
          { method: apigatewayv2.HttpMethod.GET, path: '/api/venue-crm/{id}' },
          { method: apigatewayv2.HttpMethod.PUT, path: '/api/venue-crm/{id}' },
        ],
      },
      {
        name: 'venue-enrichment',
        path: '../../venue-enrichment-lambda',
        description: 'BNDY Venue Enrichment - background data enrichment (no HTTP routes)',
        memorySize: 1024,
        timeout: 300,
        routes: [], // No HTTP routes - invoked by other means
      },
    ];

    // Create Lambda functions and routes
    const lambdaFunctions: Record<string, lambda.Function> = {};

    for (const config of lambdaConfigs) {
      // Create log group with retention
      const logGroup = new logs.LogGroup(this, `${this.toPascalCase(config.name)}LogGroup`, {
        logGroupName: `/aws/lambda/bndy-${config.name}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      // Create Lambda function
      const fn = new lambda.Function(this, `${this.toPascalCase(config.name)}Function`, {
        functionName: `bndy-${config.name}`,
        description: config.description,
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'handler.handler',
        code: lambda.Code.fromAsset(path.join(__dirname, config.path)),
        memorySize: config.memorySize ?? 512,
        timeout: cdk.Duration.seconds(config.timeout ?? 30),
        role: lambdaRole,
        environment: {
          NODE_ENV: 'production',
          JWT_SECRET_ARN: jwtSecret.secretArn,
          ...config.environment,
        },
        tracing: lambda.Tracing.ACTIVE,
        logGroup,
      });

      // Grant read access to JWT secret
      jwtSecret.grantRead(fn);

      lambdaFunctions[config.name] = fn;

      // Create routes for each endpoint
      for (const route of config.routes) {
        const integration = new apigatewayv2Integrations.HttpLambdaIntegration(
          `${this.toPascalCase(config.name)}${route.method}${this.sanitizePath(route.path)}Integration`,
          fn
        );

        httpApi.addRoutes({
          path: route.path,
          methods: [route.method],
          integration,
        });
      }
    }

    // Outputs
    new cdk.CfnOutput(this, 'HttpApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'BNDY HTTP API Gateway endpoint URL',
      exportName: 'BndyApiUrl',
    });

    new cdk.CfnOutput(this, 'HttpApiId', {
      value: httpApi.apiId,
      description: 'BNDY HTTP API Gateway ID',
      exportName: 'BndyApiId',
    });
  }

  private toPascalCase(str: string): string {
    return str
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  }

  private sanitizePath(path: string): string {
    return path
      .replace(/\//g, '')
      .replace(/\{/g, '')
      .replace(/\}/g, '')
      .replace(/api/gi, '');
  }
}
