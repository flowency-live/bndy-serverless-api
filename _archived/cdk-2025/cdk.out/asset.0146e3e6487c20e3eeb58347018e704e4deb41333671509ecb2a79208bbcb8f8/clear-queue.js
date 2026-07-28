const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({ region: 'eu-west-2' });
const dynamodb = DynamoDBDocumentClient.from(client);

async function clearQueue() {
  console.log('Scanning queue table...');
  const result = await dynamodb.send(new ScanCommand({
    TableName: 'bndy-ingest-queue'
  }));

  const items = result.Items || [];
  console.log(`Found ${items.length} items to delete`);

  for (let i = 0; i < items.length; i++) {
    await dynamodb.send(new DeleteCommand({
      TableName: 'bndy-ingest-queue',
      Key: { queue_id: items[i].queue_id }
    }));
    if ((i + 1) % 10 === 0) {
      console.log(`Deleted ${i + 1}/${items.length}...`);
    }
  }

  console.log('Done! Queue cleared.');
}

clearQueue().catch(console.error);
