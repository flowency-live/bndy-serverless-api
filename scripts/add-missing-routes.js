const AWS = require('aws-sdk');
const apigateway = new AWS.ApiGatewayV2({ region: 'eu-west-2' });
const lambda = new AWS.Lambda({ region: 'eu-west-2' });

const API_ID = 'qry0k6pmd0';

// Routes to add - each maps to a lambda function
const routes = [
  // ArtistSongs routes
  { path: 'GET /api/artists/{artistId}/playbook', functionName: 'bndy-serverless-api-ArtistSongsFunction' },
  { path: 'POST /api/artists/{artistId}/playbook', functionName: 'bndy-serverless-api-ArtistSongsFunction' },
  { path: 'PUT /api/artists/{artistId}/playbook/{artistSongId}', functionName: 'bndy-serverless-api-ArtistSongsFunction' },
  { path: 'DELETE /api/artists/{artistId}/playbook/{artistSongId}', functionName: 'bndy-serverless-api-ArtistSongsFunction' },
  { path: 'GET /api/artists/{artistId}/pipeline', functionName: 'bndy-serverless-api-ArtistSongsFunction' },
  { path: 'POST /api/artists/{artistId}/pipeline/suggestions', functionName: 'bndy-serverless-api-ArtistSongsFunction' },
  { path: 'POST /api/artists/{artistId}/pipeline/{artistSongId}/vote', functionName: 'bndy-serverless-api-ArtistSongsFunction' },
  { path: 'DELETE /api/artists/{artistId}/pipeline/{artistSongId}', functionName: 'bndy-serverless-api-ArtistSongsFunction' },
  { path: 'POST /api/artists/{artistId}/pipeline/{artistSongId}/rag', functionName: 'bndy-serverless-api-ArtistSongsFunction' },
  { path: 'PUT /api/artists/{artistId}/pipeline/{artistSongId}/rag-status', functionName: 'bndy-serverless-api-ArtistSongsFunction' },
  { path: 'PUT /api/artists/{artistId}/pipeline/{artistSongId}/status', functionName: 'bndy-serverless-api-ArtistSongsFunction' },
  { path: 'PUT /api/artists/{artistId}/pipeline/{artistSongId}/comment', functionName: 'bndy-serverless-api-ArtistSongsFunction' },
  { path: 'POST /api/artists/{artistId}/check-vote-reminders', functionName: 'bndy-serverless-api-ArtistSongsFunction' },
  
  // Events routes
  { path: 'GET /api/artists/{artistId}/calendar', functionName: 'bndy-serverless-api-EventsFunction-03skAPFIwe9g' },
  { path: 'POST /api/artists/{artistId}/calendar/subscribe', functionName: 'bndy-serverless-api-EventsFunction-03skAPFIwe9g' },
  { path: 'GET /api/artists/{artistId}/calendar/subscriptions', functionName: 'bndy-serverless-api-EventsFunction-03skAPFIwe9g' },
  { path: 'DELETE /api/artists/{artistId}/calendar/subscriptions/{subscriptionId}', functionName: 'bndy-serverless-api-EventsFunction-03skAPFIwe9g' },
  { path: 'GET /api/artists/{artistId}/events/{id}/ical', functionName: 'bndy-serverless-api-EventsFunction-03skAPFIwe9g' },
  { path: 'POST /api/artists/{artistId}/events/toggle-availability', functionName: 'bndy-serverless-api-EventsFunction-03skAPFIwe9g' },
  { path: 'POST /api/artists/{artistId}/events/bulk-availability', functionName: 'bndy-serverless-api-EventsFunction-03skAPFIwe9g' },
  { path: 'POST /api/artists/{artistId}/events/check-conflicts', functionName: 'bndy-serverless-api-EventsFunction-03skAPFIwe9g' },
  { path: 'GET /api/artists/{artistId}/public-availability', functionName: 'bndy-serverless-api-EventsFunction-03skAPFIwe9g' },
  { path: 'POST /api/artists/{artistId}/public-gigs', functionName: 'bndy-serverless-api-EventsFunction-03skAPFIwe9g' },
  { path: 'POST /api/users/me/unavailability', functionName: 'bndy-serverless-api-EventsFunction-03skAPFIwe9g' },
  { path: 'POST /api/events/batch', functionName: 'bndy-serverless-api-EventsFunction-03skAPFIwe9g' },
  { path: 'POST /api/integration/events', functionName: 'bndy-serverless-api-EventsFunction-03skAPFIwe9g' },
  
  // Setlists routes
  { path: 'GET /api/artists/{artistId}/setlists', functionName: 'bndy-serverless-api-SetlistsFunction' },
  { path: 'POST /api/artists/{artistId}/setlists', functionName: 'bndy-serverless-api-SetlistsFunction' },
  { path: 'GET /api/artists/{artistId}/setlists/{setlistId}', functionName: 'bndy-serverless-api-SetlistsFunction' },
  { path: 'PUT /api/artists/{artistId}/setlists/{setlistId}', functionName: 'bndy-serverless-api-SetlistsFunction' },
  { path: 'DELETE /api/artists/{artistId}/setlists/{setlistId}', functionName: 'bndy-serverless-api-SetlistsFunction' },
];

async function getLambdaArn(functionName) {
  const result = await lambda.getFunction({ FunctionName: functionName }).promise();
  return result.Configuration.FunctionArn;
}

async function createIntegration(apiId, lambdaArn) {
  const integration = await apigateway.createIntegration({
    ApiId: apiId,
    IntegrationType: 'AWS_PROXY',
    IntegrationMethod: 'POST',
    IntegrationUri: lambdaArn,
    PayloadFormatVersion: '2.0',
  }).promise();
  return integration.IntegrationId;
}

async function createRoute(apiId, routeKey, integrationId) {
  await apigateway.createRoute({
    ApiId: apiId,
    RouteKey: routeKey,
    Target: `integrations/${integrationId}`,
  }).promise();
}

async function main() {
  // Get existing routes
  const existingRoutes = await apigateway.getRoutes({ ApiId: API_ID }).promise();
  const existingRouteKeys = existingRoutes.Items.map(r => r.RouteKey);
  
  // Cache integrations by function
  const integrations = {};
  
  let added = 0;
  let skipped = 0;
  
  for (const route of routes) {
    if (existingRouteKeys.includes(route.path)) {
      console.log(`SKIP: ${route.path} (already exists)`);
      skipped++;
      continue;
    }
    
    try {
      // Get or create integration
      if (!integrations[route.functionName]) {
        const arn = await getLambdaArn(route.functionName);
        integrations[route.functionName] = await createIntegration(API_ID, arn);
        console.log(`Created integration for ${route.functionName}`);
      }
      
      await createRoute(API_ID, route.path, integrations[route.functionName]);
      console.log(`ADD: ${route.path}`);
      added++;
    } catch (err) {
      console.error(`ERROR: ${route.path} - ${err.message}`);
    }
  }
  
  console.log(`\nDone: ${added} added, ${skipped} skipped`);
}

main().catch(console.error);
