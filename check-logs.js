const AWS = require('aws-sdk');

const logs = new AWS.CloudWatchLogs({ region: 'eu-west-2' });

async function getLogs() {
  const tenMinutesAgo = Date.now() - (10 * 60 * 1000);

  const params = {
    logGroupName: '/aws/lambda/bndy-serverless-api-SetlistsFunction',
    startTime: tenMinutesAgo,
    limit: 100,
  };

  try {
    const result = await logs.filterLogEvents(params).promise();
    console.log('Found', result.events.length, 'log events:');
    console.log('===================================================');
    result.events.forEach(event => {
      console.log(event.message.trim());
    });

    if (result.events.length === 0) {
      console.log('\nNo ENRICHMENT logs found. Checking for ANY recent logs...\n');
      const anyParams = {
        logGroupName: '/aws/lambda/bndy-serverless-api-SetlistsFunction',
        startTime: tenMinutesAgo,
        limit: 20,
      };
      const anyResult = await logs.filterLogEvents(anyParams).promise();
      console.log('Found', anyResult.events.length, 'total log events:');
      anyResult.events.forEach(event => {
        console.log(event.message);
      });
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

getLogs();
