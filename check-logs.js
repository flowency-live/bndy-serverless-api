const AWS = require('aws-sdk');
const logs = new AWS.CloudWatchLogs({ region: 'eu-west-2' });

async function main() {
  try {
    const logGroup = '/aws/lambda/bndy-serverless-api-EventsFunction-03skAPFIwe9g';

    const streams = await logs.describeLogStreams({
      logGroupName: logGroup,
      orderBy: 'LastEventTime',
      descending: true,
      limit: 1
    }).promise();

    if (!streams.logStreams || streams.logStreams.length === 0) {
      console.log('No log streams found');
      return;
    }

    const streamName = streams.logStreams[0].logStreamName;
    console.log('Latest stream:', streamName);

    const events = await logs.getLogEvents({
      logGroupName: logGroup,
      logStreamName: streamName,
      limit: 100
    }).promise();

    for (const event of events.events) {
      console.log(event.message);
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}
main();
