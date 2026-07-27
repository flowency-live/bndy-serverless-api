// Delete Duplicate Events Script
// Removes the 31 duplicate events identified by the audit

const AWS = require('aws-sdk');

AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const EVENTS_TO_DELETE = [
  "689ac5dc-b8ad-439f-9185-8c249669b42c",
  "cff5c869-1693-4ba2-9745-9e0e698bb01e",
  "b0ef4ac2-21c9-4d5d-8743-12167950b7f6",
  "450d6e18-24e4-4188-8b63-4b4a19f4850d",
  "f06aab98-d008-4767-8849-d331647f46e6",
  "3594f158-5873-4f45-aaed-b3520f0d94c7",
  "c9a17a3e-4441-4b38-bdf1-a079061691f4",
  "23456227-589e-49e2-8a87-0bd702709bed",
  "ffce4442-2d64-45f9-bf56-a1cf365d0ed3",
  "87a63c75-5b5c-419c-93c3-407a4def63a8",
  "ff7a7b30-4ad7-4adf-b6d4-3fb85ea16091",
  "605354bd-bd3e-4e61-9697-355e16cb75ac",
  "ac627d5b-cb04-46de-aefc-2ddcd992e34f",
  "2b93315c-15fc-45fd-a123-5273dcbad0f3",
  "2493c32c-3c0b-4f31-9dc3-2c759869c928",
  "dda14e5c-2704-4246-b1bb-7734abebee0a",
  "22bfc7a9-be7c-4d39-91cc-a0f23774b6f6",
  "4111de6f-f7d8-4632-b937-ef629d8f46c5",
  "7b4b1ac8-af33-426f-a8f0-a794d0e01c6c",
  "71c9d97c-60d1-4b5e-a0ce-4fefd3acef23",
  "2c8b5701-7d69-48ad-abbf-d4a25c05cf69",
  "1c8768bf-1933-4cc7-b7e5-dea00e9670cc",
  "445a3da4-1c01-4c09-9719-f9a5b11324cf",
  "31c5b902-a989-47dd-8ade-92496f152a76",
  "def76376-8dc4-463e-8039-8502d942ed09",
  "4bf64fa2-9a09-4f58-9b4c-7314427b39f1",
  "b6a3c6dd-9deb-48e4-9440-38c1a2a65e02",
  "e70415fd-870d-422f-a62e-944c230811b1",
  "e06353d6-f71c-4b4b-8765-13a26801370e",
  "88c16932-7baa-4de8-bcf0-dfda74402a64",
  "78e529fe-25f9-47ad-ae54-1eb6047be133"
];

async function deleteDuplicateEvents() {
  console.log(`Deleting ${EVENTS_TO_DELETE.length} duplicate events...\n`);

  let deleted = 0;
  let failed = 0;

  for (const eventId of EVENTS_TO_DELETE) {
    try {
      await dynamodb.delete({
        TableName: 'bndy-events',
        Key: { id: eventId }
      }).promise();

      console.log(`✓ Deleted: ${eventId}`);
      deleted++;
    } catch (error) {
      console.error(`✗ Failed to delete ${eventId}:`, error.message);
      failed++;
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Deleted: ${deleted}`);
  console.log(`Failed: ${failed}`);
  console.log(`${'='.repeat(50)}`);

  return { deleted, failed };
}

deleteDuplicateEvents()
  .then(result => {
    console.log('\nDeletion complete.');
    process.exit(result.failed > 0 ? 1 : 0);
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
