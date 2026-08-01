/**
 * Backfill Danny Brab nameVariants
 * Fix #3d: Add known billing variations for Danny Brab
 */
const AWS = require('aws-sdk');
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const DANNY_BRAB_ID = 'FIT600aoQ5lpNSejGctN';
const VARIANTS = ['Danny & Friends', 'Danny Brab & Friends'];

async function main() {
  // Get current record
  const result = await dynamodb.get({
    TableName: 'bndy-artists',
    Key: { id: DANNY_BRAB_ID }
  }).promise();

  if (!result.Item) {
    console.log('ERROR: Danny Brab artist not found!');
    return;
  }

  console.log('Current Danny Brab record:');
  console.log('  Name:', result.Item.name);
  console.log('  Location:', result.Item.location);
  console.log('  Current nameVariants:', JSON.stringify(result.Item.name_variants || []));

  const existingVariants = result.Item.name_variants || [];
  const allVariants = [...new Set([...existingVariants, ...VARIANTS])];

  if (existingVariants.length === allVariants.length) {
    console.log('\nNo update needed - variants already present');
    return;
  }

  // Update with merged variants
  await dynamodb.update({
    TableName: 'bndy-artists',
    Key: { id: DANNY_BRAB_ID },
    UpdateExpression: 'SET name_variants = :variants, updated_at = :now',
    ExpressionAttributeValues: {
      ':variants': allVariants,
      ':now': new Date().toISOString()
    }
  }).promise();

  console.log('\nUpdated Danny Brab with nameVariants:', JSON.stringify(allVariants));
}

main().catch(console.error);
