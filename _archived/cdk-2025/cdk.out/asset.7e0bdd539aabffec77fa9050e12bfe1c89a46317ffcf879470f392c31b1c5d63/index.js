import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({ region: "eu-west-2" });
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME || "bndy-data";

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': true,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS'
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  try {
    const token = event.pathParameters?.token;

    if (!token) {
      console.log('No token provided');
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: 'Token is required' })
      };
    }

    console.log(`Validating Flowency invite token: ${token}`);

    // Query DynamoDB for invite
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        token: token
      }
    }));

    if (!result.Item) {
      console.log(`Invite not found: ${token}`);
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ message: 'Invite not found or expired' })
      };
    }

    const invite = result.Item;

    // Check if this is a Flowency invite
    if (invite.inviteType !== 'flowency') {
      console.log(`Not a Flowency invite: ${token}, type: ${invite.inviteType}`);
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ message: 'Invite not found or expired' })
      };
    }

    console.log(`Flowency invite found for client: ${invite.clientId}`);

    // Check if expired
    if (invite.expiresAt && invite.expiresAt < Date.now()) {
      console.log(`Invite expired: ${token}`);
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ message: 'Invite has expired' })
      };
    }

    // Check if active
    if (invite.status !== 'active') {
      console.log(`Invite not active: ${token}, status: ${invite.status}`);
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ message: 'Invite is no longer active' })
      };
    }

    // Return invite details
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        token: invite.token,
        clientId: invite.clientId,
        clientName: invite.clientName,
        status: invite.status,
        expiresAt: invite.expiresAt
      })
    };

  } catch (error) {
    console.error('Error validating Flowency invite:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: 'Internal server error' })
    };
  }
};
