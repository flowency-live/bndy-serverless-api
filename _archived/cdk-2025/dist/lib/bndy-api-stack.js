"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BndyApiStack = void 0;
const cdk = require("aws-cdk-lib");
const lambda = require("aws-cdk-lib/aws-lambda");
const apigatewayv2 = require("aws-cdk-lib/aws-apigatewayv2");
const apigatewayv2Integrations = require("aws-cdk-lib/aws-apigatewayv2-integrations");
const iam = require("aws-cdk-lib/aws-iam");
const logs = require("aws-cdk-lib/aws-logs");
const secretsmanager = require("aws-cdk-lib/aws-secretsmanager");
const path = require("path");
class BndyApiStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Use existing IAM role
        const lambdaRole = iam.Role.fromRoleArn(this, 'ExistingLambdaRole', 'arn:aws:iam::771551874768:role/bndy-api-instance-role');
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
        const lambdaConfigs = [
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
        const lambdaFunctions = {};
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
                const integration = new apigatewayv2Integrations.HttpLambdaIntegration(`${this.toPascalCase(config.name)}${route.method}${this.sanitizePath(route.path)}Integration`, fn);
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
    toPascalCase(str) {
        return str
            .split('-')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join('');
    }
    sanitizePath(path) {
        return path
            .replace(/\//g, '')
            .replace(/\{/g, '')
            .replace(/\}/g, '')
            .replace(/api/gi, '');
    }
}
exports.BndyApiStack = BndyApiStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYm5keS1hcGktc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvYm5keS1hcGktc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbUNBQW1DO0FBQ25DLGlEQUFpRDtBQUNqRCw2REFBNkQ7QUFDN0Qsc0ZBQXNGO0FBQ3RGLDJDQUEyQztBQUMzQyw2Q0FBNkM7QUFDN0MsaUVBQWlFO0FBRWpFLDZCQUE2QjtBQWdCN0IsTUFBYSxZQUFhLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDekMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4Qix3QkFBd0I7UUFDeEIsTUFBTSxVQUFVLEdBQUcsR0FBRyxDQUFDLElBQUksQ0FBQyxXQUFXLENBQ3JDLElBQUksRUFDSixvQkFBb0IsRUFDcEIsdURBQXVELENBQ3hELENBQUM7UUFFRix5REFBeUQ7UUFDekQsTUFBTSxTQUFTLEdBQUcsSUFBSSxjQUFjLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxXQUFXLEVBQUU7WUFDN0QsVUFBVSxFQUFFLGlCQUFpQjtZQUM3QixXQUFXLEVBQUUsaUNBQWlDO1lBQzlDLG9CQUFvQixFQUFFO2dCQUNwQixvQkFBb0IsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztnQkFDeEMsaUJBQWlCLEVBQUUsUUFBUTtnQkFDM0Isa0JBQWtCLEVBQUUsSUFBSTtnQkFDeEIsY0FBYyxFQUFFLEVBQUU7YUFDbkI7U0FDRixDQUFDLENBQUM7UUFFSCwwQkFBMEI7UUFDMUIsTUFBTSxPQUFPLEdBQUcsSUFBSSxZQUFZLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDNUQsT0FBTyxFQUFFLFVBQVU7WUFDbkIsV0FBVyxFQUFFLHdCQUF3QjtZQUNyQyxhQUFhLEVBQUU7Z0JBQ2IsWUFBWSxFQUFFLENBQUMs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QUFDO1FBRUQsVUFBVTtRQUNWLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ3BDLEtBQUssRUFBRSxPQUFPLENBQUMsV0FBVztZQUMxQixXQUFXLEVBQUUsb0NBQW9DO1lBQ2pELFVBQVUsRUFBRSxZQUFZO1NBQ3pCLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsV0FBVyxFQUFFO1lBQ25DLEtBQUssRUFBRSxPQUFPLENBQUMsS0FBSztZQUNwQixXQUFXLEVBQUUsMEJBQTBCO1lBQ3ZDLFVBQVUsRUFBRSxXQUFXO1NBQ3hCLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFTyxZQUFZLENBQUMsR0FBVztRQUM5QixPQUFPLEdBQUc7YUFDUCxLQUFLLENBQUMsR0FBRyxDQUFDO2FBQ1YsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLFdBQVcsRUFBRSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7YUFDM0QsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ2QsQ0FBQztJQUVPLFlBQVksQ0FBQyxJQUFZO1FBQy9CLE9BQU8sSUFBSTthQUNSLE9BQU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDO2FBQ2xCLE9BQU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDO2FBQ2xCLE9BQU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDO2FBQ2xCLE9BQU8sQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDMUIsQ0FBQztDQUNGO0FBL1VELG9DQStVQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XHJcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcclxuaW1wb3J0ICogYXMgYXBpZ2F0ZXdheXYyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djInO1xyXG5pbXBvcnQgKiBhcyBhcGlnYXRld2F5djJJbnRlZ3JhdGlvbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnMnO1xyXG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XHJcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xyXG5pbXBvcnQgKiBhcyBzZWNyZXRzbWFuYWdlciBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc2VjcmV0c21hbmFnZXInO1xyXG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcclxuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcclxuXHJcbi8vIExhbWJkYSBjb25maWd1cmF0aW9uIGZvciBlYWNoIGZ1bmN0aW9uXHJcbmludGVyZmFjZSBMYW1iZGFDb25maWcge1xyXG4gIG5hbWU6IHN0cmluZztcclxuICBwYXRoOiBzdHJpbmc7XHJcbiAgZGVzY3JpcHRpb246IHN0cmluZztcclxuICBtZW1vcnlTaXplPzogbnVtYmVyO1xyXG4gIHRpbWVvdXQ/OiBudW1iZXI7XHJcbiAgcm91dGVzOiB7XHJcbiAgICBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kO1xyXG4gICAgcGF0aDogc3RyaW5nO1xyXG4gIH1bXTtcclxuICBlbnZpcm9ubWVudD86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBCbmR5QXBpU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xyXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogY2RrLlN0YWNrUHJvcHMpIHtcclxuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xyXG5cclxuICAgIC8vIFVzZSBleGlzdGluZyBJQU0gcm9sZVxyXG4gICAgY29uc3QgbGFtYmRhUm9sZSA9IGlhbS5Sb2xlLmZyb21Sb2xlQXJuKFxyXG4gICAgICB0aGlzLFxyXG4gICAgICAnRXhpc3RpbmdMYW1iZGFSb2xlJyxcclxuICAgICAgJ2Fybjphd3M6aWFtOjo3NzE1NTE4NzQ3Njg6cm9sZS9ibmR5LWFwaS1pbnN0YW5jZS1yb2xlJ1xyXG4gICAgKTtcclxuXHJcbiAgICAvLyBDcmVhdGUgc2VjcmV0IGZvciBKV1QgKG1pZ3JhdGUgZnJvbSBoYXJkY29kZWQgZW52IHZhcilcclxuICAgIGNvbnN0IGp3dFNlY3JldCA9IG5ldyBzZWNyZXRzbWFuYWdlci5TZWNyZXQodGhpcywgJ0p3dFNlY3JldCcsIHtcclxuICAgICAgc2VjcmV0TmFtZTogJ2JuZHkvand0LXNlY3JldCcsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnSldUIHNpZ25pbmcgc2VjcmV0IGZvciBCTkRZIEFQSScsXHJcbiAgICAgIGdlbmVyYXRlU2VjcmV0U3RyaW5nOiB7XHJcbiAgICAgICAgc2VjcmV0U3RyaW5nVGVtcGxhdGU6IEpTT04uc3RyaW5naWZ5KHt9KSxcclxuICAgICAgICBnZW5lcmF0ZVN0cmluZ0tleTogJ3NlY3JldCcsXHJcbiAgICAgICAgZXhjbHVkZVB1bmN0dWF0aW9uOiB0cnVlLFxyXG4gICAgICAgIHBhc3N3b3JkTGVuZ3RoOiA2NCxcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIENyZWF0ZSBIVFRQIEFQSSBHYXRld2F5XHJcbiAgICBjb25zdCBodHRwQXBpID0gbmV3IGFwaWdhdGV3YXl2Mi5IdHRwQXBpKHRoaXMsICdCbmR5SHR0cEFwaScsIHtcclxuICAgICAgYXBpTmFtZTogJ2JuZHktYXBpJyxcclxuICAgICAgZGVzY3JpcHRpb246ICdCTkRZIFBsYXRmb3JtIEhUVFAgQVBJJyxcclxuICAgICAgY29yc1ByZWZsaWdodDoge1xyXG4gICAgICAgIGFsbG93SGVhZGVyczogWydDb250ZW50LVR5cGUnLCAnQXV0aG9yaXphdGlvbicsICdYLUFwaS1LZXknXSxcclxuICAgICAgICBhbGxvd01ldGhvZHM6IFtcclxuICAgICAgICAgIGFwaWdhdGV3YXl2Mi5Db3JzSHR0cE1ldGhvZC5HRVQsXHJcbiAgICAgICAgICBhcGlnYXRld2F5djIuQ29yc0h0dHBNZXRob2QuUE9TVCxcclxuICAgICAgICAgIGFwaWdhdGV3YXl2Mi5Db3JzSHR0cE1ldGhvZC5QVVQsXHJcbiAgICAgICAgICBhcGlnYXRld2F5djIuQ29yc0h0dHBNZXRob2QuREVMRVRFLFxyXG4gICAgICAgICAgYXBpZ2F0ZXdheXYyLkNvcnNIdHRwTWV0aG9kLk9QVElPTlMsXHJcbiAgICAgICAgXSxcclxuICAgICAgICBhbGxvd09yaWdpbnM6IFsnKiddLFxyXG4gICAgICAgIG1heEFnZTogY2RrLkR1cmF0aW9uLmRheXMoMSksXHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyBEZWZpbmUgYWxsIExhbWJkYSBjb25maWd1cmF0aW9uc1xyXG4gICAgY29uc3QgbGFtYmRhQ29uZmlnczogTGFtYmRhQ29uZmlnW10gPSBbXHJcbiAgICAgIHtcclxuICAgICAgICBuYW1lOiAnYXJ0aXN0cycsXHJcbiAgICAgICAgcGF0aDogJy4uLy4uL2FydGlzdHMtbGFtYmRhJyxcclxuICAgICAgICBkZXNjcmlwdGlvbjogJ0JORFkgQXJ0aXN0cyBBUEkgLSBoYW5kbGVzIC9hcGkvYXJ0aXN0cyBlbmRwb2ludHMnLFxyXG4gICAgICAgIHJvdXRlczogW1xyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogJy9hcGkvYXJ0aXN0cycgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6ICcvYXBpL2FydGlzdHMvYnktZXh0ZXJuYWwtaWQnIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogJy9hcGkvYXJ0aXN0cycgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6ICcvYXBpL2FydGlzdHMve2lkfScgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5QVVQsIHBhdGg6ICcvYXBpL2FydGlzdHMve2lkfScgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5QVVQsIHBhdGg6ICcvYXBpL2FydGlzdHMve2lkfS9tY3AnIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuREVMRVRFLCBwYXRoOiAnL2FwaS9hcnRpc3RzL3tpZH0nIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIG5hbWU6ICdhcnRpc3Qtc29uZ3MnLFxyXG4gICAgICAgIHBhdGg6ICcuLi8uLi9hcnRpc3Qtc29uZ3MtbGFtYmRhJyxcclxuICAgICAgICBkZXNjcmlwdGlvbjogJ0JORFkgQXJ0aXN0IFNvbmdzIEFQSSAtIGhhbmRsZXMgL2FwaS9hcnRpc3Qtc29uZ3MgZW5kcG9pbnRzJyxcclxuICAgICAgICByb3V0ZXM6IFtcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6ICcvYXBpL2FydGlzdC1zb25ncycgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiAnL2FwaS9hcnRpc3Qtc29uZ3MnIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuR0VULCBwYXRoOiAnL2FwaS9hcnRpc3Qtc29uZ3Mve2lkfScgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5QVVQsIHBhdGg6ICcvYXBpL2FydGlzdC1zb25ncy97aWR9JyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkRFTEVURSwgcGF0aDogJy9hcGkvYXJ0aXN0LXNvbmdzL3tpZH0nIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIG5hbWU6ICdhdXRoJyxcclxuICAgICAgICBwYXRoOiAnLi4vLi4vYXV0aC1sYW1iZGEnLFxyXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQk5EWSBBdXRoZW50aWNhdGlvbiBBUEkgLSBoYW5kbGVzIE9BdXRoIGFuZCBzZXNzaW9ucycsXHJcbiAgICAgICAgcm91dGVzOiBbXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogJy9hcGkvYXV0aC9sb2dpbicgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiAnL2FwaS9hdXRoL2xvZ291dCcgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiAnL2FwaS9hdXRoL3JlZnJlc2gnIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuR0VULCBwYXRoOiAnL2FwaS9hdXRoL21lJyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6ICcvYXBpL2F1dGgvcmVnaXN0ZXInIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogJy9hcGkvYXV0aC9mYWNlYm9vaycgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiAnL2FwaS9hdXRoL2dvb2dsZScgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbmFtZTogJ2V2ZW50cycsXHJcbiAgICAgICAgcGF0aDogJy4uLy4uL2V2ZW50cy1sYW1iZGEnLFxyXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQk5EWSBFdmVudHMgQVBJIC0gaGFuZGxlcyAvYXBpL2V2ZW50cyBhbmQgL2FwaS9jYWxlbmRhciBlbmRwb2ludHMnLFxyXG4gICAgICAgIHJvdXRlczogW1xyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogJy9hcGkvZXZlbnRzJyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogJy9hcGkvZXZlbnRzL2J5LWV4dGVybmFsLWlkJyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6ICcvYXBpL2V2ZW50cycgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6ICcvYXBpL2V2ZW50cy97aWR9JyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLlBVVCwgcGF0aDogJy9hcGkvZXZlbnRzL3tpZH0nIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuUFVULCBwYXRoOiAnL2FwaS9ldmVudHMve2lkfS9tY3AnIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuREVMRVRFLCBwYXRoOiAnL2FwaS9ldmVudHMve2lkfScgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6ICcvYXBpL2NhbGVuZGFyJyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogJy9hcGkvY2FsZW5kYXIve2lkfScgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbmFtZTogJ2V2ZW50cy1hZ2VudCcsXHJcbiAgICAgICAgcGF0aDogJy4uLy4uL2V2ZW50cy1hZ2VudC1sYW1iZGEnLFxyXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQk5EWSBFdmVudHMgQWdlbnQgLSBBSS1wb3dlcmVkIGV2ZW50IGRpc2NvdmVyeScsXHJcbiAgICAgICAgbWVtb3J5U2l6ZTogMTAyNCxcclxuICAgICAgICB0aW1lb3V0OiAxMjAsXHJcbiAgICAgICAgcm91dGVzOiBbXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogJy9hcGkvZXZlbnRzLWFnZW50JyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogJy9hcGkvZXZlbnRzLWFnZW50L3tpZH0nIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIG5hbWU6ICdmbG93ZW5jeS1pbnZpdGUnLFxyXG4gICAgICAgIHBhdGg6ICcuLi8uLi9mbG93ZW5jeS1pbnZpdGUtbGFtYmRhJyxcclxuICAgICAgICBkZXNjcmlwdGlvbjogJ0JORFkgRmxvd2VuY3kgSW50ZWdyYXRpb24gLSBleHRlcm5hbCBpbnZpdGVzJyxcclxuICAgICAgICByb3V0ZXM6IFtcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiAnL2FwaS9mbG93ZW5jeS9pbnZpdGUnIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuR0VULCBwYXRoOiAnL2FwaS9mbG93ZW5jeS9zdGF0dXMve2lkfScgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbmFtZTogJ2ludml0ZXMnLFxyXG4gICAgICAgIHBhdGg6ICcuLi8uLi9pbnZpdGVzLWxhbWJkYScsXHJcbiAgICAgICAgZGVzY3JpcHRpb246ICdCTkRZIEludml0ZXMgQVBJIC0gaGFuZGxlcyBhcnRpc3QvYmFuZCBpbnZpdGF0aW9ucycsXHJcbiAgICAgICAgcm91dGVzOiBbXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuR0VULCBwYXRoOiAnL2FwaS9pbnZpdGVzJyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6ICcvYXBpL2ludml0ZXMnIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuR0VULCBwYXRoOiAnL2FwaS9pbnZpdGVzL3tpZH0nIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuUFVULCBwYXRoOiAnL2FwaS9pbnZpdGVzL3tpZH0nIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuREVMRVRFLCBwYXRoOiAnL2FwaS9pbnZpdGVzL3tpZH0nIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIG5hbWU6ICdpc3N1ZXMnLFxyXG4gICAgICAgIHBhdGg6ICcuLi8uLi9pc3N1ZXMtbGFtYmRhJyxcclxuICAgICAgICBkZXNjcmlwdGlvbjogJ0JORFkgSXNzdWVzIEFQSSAtIGhhbmRsZXMgdXNlci1yZXBvcnRlZCBpc3N1ZXMnLFxyXG4gICAgICAgIHJvdXRlczogW1xyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogJy9hcGkvaXNzdWVzJyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6ICcvYXBpL2lzc3VlcycgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6ICcvYXBpL2lzc3Vlcy97aWR9JyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLlBVVCwgcGF0aDogJy9hcGkvaXNzdWVzL3tpZH0nIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIG5hbWU6ICdtZW1iZXJzaGlwcycsXHJcbiAgICAgICAgcGF0aDogJy4uLy4uL21lbWJlcnNoaXBzLWxhbWJkYScsXHJcbiAgICAgICAgZGVzY3JpcHRpb246ICdCTkRZIE1lbWJlcnNoaXBzIEFQSSAtIGhhbmRsZXMgYXJ0aXN0L2JhbmQgbWVtYmVyc2hpcHMnLFxyXG4gICAgICAgIHJvdXRlczogW1xyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogJy9hcGkvbWVtYmVyc2hpcHMnIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogJy9hcGkvbWVtYmVyc2hpcHMnIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuR0VULCBwYXRoOiAnL2FwaS9tZW1iZXJzaGlwcy97bWVtYmVyc2hpcElkfScgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5QVVQsIHBhdGg6ICcvYXBpL21lbWJlcnNoaXBzL3ttZW1iZXJzaGlwSWR9JyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkRFTEVURSwgcGF0aDogJy9hcGkvbWVtYmVyc2hpcHMve21lbWJlcnNoaXBJZH0nIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIG5hbWU6ICdub3RpZmljYXRpb25zJyxcclxuICAgICAgICBwYXRoOiAnLi4vLi4vbm90aWZpY2F0aW9ucy1sYW1iZGEnLFxyXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQk5EWSBOb3RpZmljYXRpb25zIEFQSSAtIGhhbmRsZXMgcHVzaCBub3RpZmljYXRpb25zJyxcclxuICAgICAgICByb3V0ZXM6IFtcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6ICcvYXBpL25vdGlmaWNhdGlvbnMnIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogJy9hcGkvbm90aWZpY2F0aW9ucycgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5QVVQsIHBhdGg6ICcvYXBpL25vdGlmaWNhdGlvbnMve2lkfScgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5ERUxFVEUsIHBhdGg6ICcvYXBpL25vdGlmaWNhdGlvbnMve2lkfScgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbmFtZTogJ3NldGxpc3RzJyxcclxuICAgICAgICBwYXRoOiAnLi4vLi4vc2V0bGlzdHMtbGFtYmRhJyxcclxuICAgICAgICBkZXNjcmlwdGlvbjogJ0JORFkgU2V0bGlzdHMgQVBJIC0gaGFuZGxlcyBiYW5kIHNldGxpc3RzJyxcclxuICAgICAgICByb3V0ZXM6IFtcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6ICcvYXBpL3NldGxpc3RzJyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6ICcvYXBpL3NldGxpc3RzJyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogJy9hcGkvc2V0bGlzdHMve2lkfScgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5QVVQsIHBhdGg6ICcvYXBpL3NldGxpc3RzL3tpZH0nIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuREVMRVRFLCBwYXRoOiAnL2FwaS9zZXRsaXN0cy97aWR9JyB9LFxyXG4gICAgICAgIF0sXHJcbiAgICAgIH0sXHJcbiAgICAgIHtcclxuICAgICAgICBuYW1lOiAnc29uZ3MnLFxyXG4gICAgICAgIHBhdGg6ICcuLi8uLi9zb25ncy1sYW1iZGEnLFxyXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQk5EWSBTb25ncyBBUEkgLSBoYW5kbGVzIHNvbmcgbGlicmFyeScsXHJcbiAgICAgICAgcm91dGVzOiBbXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuR0VULCBwYXRoOiAnL2FwaS9zb25ncycgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiAnL2FwaS9zb25ncycgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6ICcvYXBpL3NvbmdzL3tpZH0nIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuUFVULCBwYXRoOiAnL2FwaS9zb25ncy97aWR9JyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkRFTEVURSwgcGF0aDogJy9hcGkvc29uZ3Mve2lkfScgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbmFtZTogJ3Nwb3RpZnknLFxyXG4gICAgICAgIHBhdGg6ICcuLi8uLi9zcG90aWZ5LWxhbWJkYScsXHJcbiAgICAgICAgZGVzY3JpcHRpb246ICdCTkRZIFNwb3RpZnkgSW50ZWdyYXRpb24gLSBoYW5kbGVzIFNwb3RpZnkgQVBJJyxcclxuICAgICAgICByb3V0ZXM6IFtcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6ICcvYXBpL3Nwb3RpZnkvc2VhcmNoJyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogJy9hcGkvc3BvdGlmeS90cmFjay97aWR9JyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogJy9hcGkvc3BvdGlmeS9hcnRpc3Qve2lkfScgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbmFtZTogJ3VwbG9hZHMnLFxyXG4gICAgICAgIHBhdGg6ICcuLi8uLi91cGxvYWRzLWxhbWJkYScsXHJcbiAgICAgICAgZGVzY3JpcHRpb246ICdCTkRZIFVwbG9hZHMgQVBJIC0gaGFuZGxlcyBTMyBmaWxlIHVwbG9hZHMnLFxyXG4gICAgICAgIHJvdXRlczogW1xyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6ICcvYXBpL3VwbG9hZHMnIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuR0VULCBwYXRoOiAnL2FwaS91cGxvYWRzL3tpZH0nIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuREVMRVRFLCBwYXRoOiAnL2FwaS91cGxvYWRzL3tpZH0nIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIG5hbWU6ICd1c2VycycsXHJcbiAgICAgICAgcGF0aDogJy4uLy4uL3VzZXJzLWxhbWJkYScsXHJcbiAgICAgICAgZGVzY3JpcHRpb246ICdCTkRZIFVzZXJzIEFQSSAtIGhhbmRsZXMgdXNlciBwcm9maWxlcycsXHJcbiAgICAgICAgcm91dGVzOiBbXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuR0VULCBwYXRoOiAnL2FwaS91c2VycycgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6ICcvYXBpL3VzZXJzL3tpZH0nIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuUFVULCBwYXRoOiAnL2FwaS91c2Vycy97aWR9JyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkRFTEVURSwgcGF0aDogJy9hcGkvdXNlcnMve2lkfScgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbmFtZTogJ3ZlbnVlcycsXHJcbiAgICAgICAgcGF0aDogJy4uLy4uL3ZlbnVlcy1sYW1iZGEnLFxyXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQk5EWSBWZW51ZXMgQVBJIC0gaGFuZGxlcyAvYXBpL3ZlbnVlcyBhbmQgaW50ZWdyYXRpb24gZW5kcG9pbnRzJyxcclxuICAgICAgICByb3V0ZXM6IFtcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6ICcvYXBpL3ZlbnVlcycgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6ICcvYXBpL3ZlbnVlcy9ieS1leHRlcm5hbC1pZCcgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiAnL2FwaS92ZW51ZXMnIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuR0VULCBwYXRoOiAnL2FwaS92ZW51ZXMve2lkfScgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5QVVQsIHBhdGg6ICcvYXBpL3ZlbnVlcy97aWR9JyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkRFTEVURSwgcGF0aDogJy9hcGkvdmVudWVzL3tpZH0nIH0sXHJcbiAgICAgICAgICB7IG1ldGhvZDogYXBpZ2F0ZXdheXYyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogJy9hcGkvaW50ZWdyYXRpb24vdmVudWVzJyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogJy9hcGkvaW50ZWdyYXRpb24vdmVudWVzL3tpZH0nIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIG5hbWU6ICd2ZW51ZS1jcm0nLFxyXG4gICAgICAgIHBhdGg6ICcuLi8uLi92ZW51ZS1jcm0tbGFtYmRhJyxcclxuICAgICAgICBkZXNjcmlwdGlvbjogJ0JORFkgVmVudWUgQ1JNIEFQSSAtIGhhbmRsZXMgdmVudWUgcmVsYXRpb25zaGlwIG1hbmFnZW1lbnQnLFxyXG4gICAgICAgIHJvdXRlczogW1xyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogJy9hcGkvdmVudWUtY3JtJyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6ICcvYXBpL3ZlbnVlLWNybScgfSxcclxuICAgICAgICAgIHsgbWV0aG9kOiBhcGlnYXRld2F5djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6ICcvYXBpL3ZlbnVlLWNybS97aWR9JyB9LFxyXG4gICAgICAgICAgeyBtZXRob2Q6IGFwaWdhdGV3YXl2Mi5IdHRwTWV0aG9kLlBVVCwgcGF0aDogJy9hcGkvdmVudWUtY3JtL3tpZH0nIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIG5hbWU6ICd2ZW51ZS1lbnJpY2htZW50JyxcclxuICAgICAgICBwYXRoOiAnLi4vLi4vdmVudWUtZW5yaWNobWVudC1sYW1iZGEnLFxyXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQk5EWSBWZW51ZSBFbnJpY2htZW50IC0gYmFja2dyb3VuZCBkYXRhIGVucmljaG1lbnQgKG5vIEhUVFAgcm91dGVzKScsXHJcbiAgICAgICAgbWVtb3J5U2l6ZTogMTAyNCxcclxuICAgICAgICB0aW1lb3V0OiAzMDAsXHJcbiAgICAgICAgcm91dGVzOiBbXSwgLy8gTm8gSFRUUCByb3V0ZXMgLSBpbnZva2VkIGJ5IG90aGVyIG1lYW5zXHJcbiAgICAgIH0sXHJcbiAgICBdO1xyXG5cclxuICAgIC8vIENyZWF0ZSBMYW1iZGEgZnVuY3Rpb25zIGFuZCByb3V0ZXNcclxuICAgIGNvbnN0IGxhbWJkYUZ1bmN0aW9uczogUmVjb3JkPHN0cmluZywgbGFtYmRhLkZ1bmN0aW9uPiA9IHt9O1xyXG5cclxuICAgIGZvciAoY29uc3QgY29uZmlnIG9mIGxhbWJkYUNvbmZpZ3MpIHtcclxuICAgICAgLy8gQ3JlYXRlIGxvZyBncm91cCB3aXRoIHJldGVudGlvblxyXG4gICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIGAke3RoaXMudG9QYXNjYWxDYXNlKGNvbmZpZy5uYW1lKX1Mb2dHcm91cGAsIHtcclxuICAgICAgICBsb2dHcm91cE5hbWU6IGAvYXdzL2xhbWJkYS9ibmR5LSR7Y29uZmlnLm5hbWV9YCxcclxuICAgICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXHJcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcclxuICAgICAgfSk7XHJcblxyXG4gICAgICAvLyBDcmVhdGUgTGFtYmRhIGZ1bmN0aW9uXHJcbiAgICAgIGNvbnN0IGZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBgJHt0aGlzLnRvUGFzY2FsQ2FzZShjb25maWcubmFtZSl9RnVuY3Rpb25gLCB7XHJcbiAgICAgICAgZnVuY3Rpb25OYW1lOiBgYm5keS0ke2NvbmZpZy5uYW1lfWAsXHJcbiAgICAgICAgZGVzY3JpcHRpb246IGNvbmZpZy5kZXNjcmlwdGlvbixcclxuICAgICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcclxuICAgICAgICBhcmNoaXRlY3R1cmU6IGxhbWJkYS5BcmNoaXRlY3R1cmUuQVJNXzY0LFxyXG4gICAgICAgIGhhbmRsZXI6ICdoYW5kbGVyLmhhbmRsZXInLFxyXG4gICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCBjb25maWcucGF0aCkpLFxyXG4gICAgICAgIG1lbW9yeVNpemU6IGNvbmZpZy5tZW1vcnlTaXplID8/IDUxMixcclxuICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyhjb25maWcudGltZW91dCA/PyAzMCksXHJcbiAgICAgICAgcm9sZTogbGFtYmRhUm9sZSxcclxuICAgICAgICBlbnZpcm9ubWVudDoge1xyXG4gICAgICAgICAgTk9ERV9FTlY6ICdwcm9kdWN0aW9uJyxcclxuICAgICAgICAgIEpXVF9TRUNSRVRfQVJOOiBqd3RTZWNyZXQuc2VjcmV0QXJuLFxyXG4gICAgICAgICAgLi4uY29uZmlnLmVudmlyb25tZW50LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgdHJhY2luZzogbGFtYmRhLlRyYWNpbmcuQUNUSVZFLFxyXG4gICAgICAgIGxvZ0dyb3VwLFxyXG4gICAgICB9KTtcclxuXHJcbiAgICAgIC8vIEdyYW50IHJlYWQgYWNjZXNzIHRvIEpXVCBzZWNyZXRcclxuICAgICAgand0U2VjcmV0LmdyYW50UmVhZChmbik7XHJcblxyXG4gICAgICBsYW1iZGFGdW5jdGlvbnNbY29uZmlnLm5hbWVdID0gZm47XHJcblxyXG4gICAgICAvLyBDcmVhdGUgcm91dGVzIGZvciBlYWNoIGVuZHBvaW50XHJcbiAgICAgIGZvciAoY29uc3Qgcm91dGUgb2YgY29uZmlnLnJvdXRlcykge1xyXG4gICAgICAgIGNvbnN0IGludGVncmF0aW9uID0gbmV3IGFwaWdhdGV3YXl2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXHJcbiAgICAgICAgICBgJHt0aGlzLnRvUGFzY2FsQ2FzZShjb25maWcubmFtZSl9JHtyb3V0ZS5tZXRob2R9JHt0aGlzLnNhbml0aXplUGF0aChyb3V0ZS5wYXRoKX1JbnRlZ3JhdGlvbmAsXHJcbiAgICAgICAgICBmblxyXG4gICAgICAgICk7XHJcblxyXG4gICAgICAgIGh0dHBBcGkuYWRkUm91dGVzKHtcclxuICAgICAgICAgIHBhdGg6IHJvdXRlLnBhdGgsXHJcbiAgICAgICAgICBtZXRob2RzOiBbcm91dGUubWV0aG9kXSxcclxuICAgICAgICAgIGludGVncmF0aW9uLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgLy8gT3V0cHV0c1xyXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0h0dHBBcGlVcmwnLCB7XHJcbiAgICAgIHZhbHVlOiBodHRwQXBpLmFwaUVuZHBvaW50LFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ0JORFkgSFRUUCBBUEkgR2F0ZXdheSBlbmRwb2ludCBVUkwnLFxyXG4gICAgICBleHBvcnROYW1lOiAnQm5keUFwaVVybCcsXHJcbiAgICB9KTtcclxuXHJcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnSHR0cEFwaUlkJywge1xyXG4gICAgICB2YWx1ZTogaHR0cEFwaS5hcGlJZCxcclxuICAgICAgZGVzY3JpcHRpb246ICdCTkRZIEhUVFAgQVBJIEdhdGV3YXkgSUQnLFxyXG4gICAgICBleHBvcnROYW1lOiAnQm5keUFwaUlkJyxcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSB0b1Bhc2NhbENhc2Uoc3RyOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHN0clxyXG4gICAgICAuc3BsaXQoJy0nKVxyXG4gICAgICAubWFwKCh3b3JkKSA9PiB3b3JkLmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICsgd29yZC5zbGljZSgxKSlcclxuICAgICAgLmpvaW4oJycpO1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBzYW5pdGl6ZVBhdGgocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBwYXRoXHJcbiAgICAgIC5yZXBsYWNlKC9cXC8vZywgJycpXHJcbiAgICAgIC5yZXBsYWNlKC9cXHsvZywgJycpXHJcbiAgICAgIC5yZXBsYWNlKC9cXH0vZywgJycpXHJcbiAgICAgIC5yZXBsYWNlKC9hcGkvZ2ksICcnKTtcclxuICB9XHJcbn1cclxuIl19