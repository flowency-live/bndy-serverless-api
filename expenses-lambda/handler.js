// BNDY Expenses Lambda Function - Financial Tracking
// Handles: Artist expense CRUD, finances summary

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });

// Configuration
const EXPENSES_TABLE = 'bndy-expenses';
const EVENTS_TABLE = 'bndy-events';
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';
const ARTISTS_TABLE = 'bndy-artists';

// Valid expense categories
const EXPENSE_CATEGORIES = [
  'equipment_purchase',
  'equipment_hire',
  'rehearsal_room',
  'studio_hire',
  'dep_fee',
  'member_payment',
  'marketing',
  'other'
];

// Valid payment methods (for gig fees)
const PAYMENT_METHODS = ['cash', 'bank_transfer', 'gig_realm', 'events_uk', 'other'];

// JWT Secret - cached after first retrieval
let JWT_SECRET = null;

/**
 * Get JWT secret from SSM Parameter Store with fallback to env var
 */
async function getJWTSecret() {
  if (JWT_SECRET) {
    return JWT_SECRET;
  }

  try {
    const result = await ssm.getParameter({
      Name: '/bndy/jwt-secret',
      WithDecryption: true
    }).promise();
    JWT_SECRET = result.Parameter.Value;
    return JWT_SECRET;
  } catch (error) {
    console.log('SSM fetch failed, using env var:', error.message);
    JWT_SECRET = process.env.JWT_SECRET;
    return JWT_SECRET;
  }
}

/**
 * CORS headers for all responses
 */
const getCorsHeaders = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Credentials': 'true',
  'Content-Type': 'application/json'
});

/**
 * Authenticate user from JWT token
 */
async function authenticateUser(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  const secret = await getJWTSecret();

  try {
    const decoded = jwt.verify(token, secret);
    return {
      userId: decoded.userId || decoded.sub,
      email: decoded.email,
      platformAdmin: decoded.platformAdmin || false
    };
  } catch (error) {
    console.log('JWT verification failed:', error.message);
    return null;
  }
}

/**
 * Verify user is a member of the artist
 */
async function verifyMembership(userId, artistId) {
  const result = await dynamodb.query({
    TableName: MEMBERSHIPS_TABLE,
    IndexName: 'user_id-index',
    KeyConditionExpression: 'user_id = :userId',
    FilterExpression: 'artist_id = :artistId',
    ExpressionAttributeValues: {
      ':userId': userId,
      ':artistId': artistId
    }
  }).promise();

  return result.Items && result.Items.length > 0 ? result.Items[0] : null;
}

// =============================================================================
// Expense Handlers
// =============================================================================

/**
 * POST /api/artists/{artistId}/expenses - Create expense
 */
const handleCreateExpense = async (event, user) => {
  const { artistId } = event.pathParameters;
  const expenseData = JSON.parse(event.body);

  // Verify membership
  let membership = null;
  if (!user.platformAdmin) {
    membership = await verifyMembership(user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Not a member of this artist' })
      };
    }
  }

  // Validate required fields
  if (!expenseData.date) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'date is required' })
    };
  }

  if (expenseData.amount === undefined || expenseData.amount === null) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'amount is required' })
    };
  }

  if (!expenseData.category || !EXPENSE_CATEGORIES.includes(expenseData.category)) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        error: 'Invalid category',
        validCategories: EXPENSE_CATEGORIES
      })
    };
  }

  // Require description for "other" category
  if (expenseData.category === 'other' && !expenseData.description) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'description is required for "other" category' })
    };
  }

  const expenseId = crypto.randomUUID();
  const now = new Date().toISOString();

  const newExpense = {
    id: expenseId,
    artistId,
    date: expenseData.date,
    amount: parseFloat(expenseData.amount),
    category: expenseData.category,
    createdBy: user.userId,
    createdAt: now,
    updatedAt: now
  };

  // Optional fields
  if (expenseData.description) newExpense.description = expenseData.description;
  if (expenseData.paidBy) newExpense.paidBy = expenseData.paidBy;
  if (expenseData.relatedEventId) newExpense.relatedEventId = expenseData.relatedEventId;
  if (expenseData.groupId) newExpense.groupId = expenseData.groupId;

  await dynamodb.put({
    TableName: EXPENSES_TABLE,
    Item: newExpense
  }).promise();

  console.log('EXPENSE: Created', { expenseId, artistId, category: expenseData.category, amount: newExpense.amount });

  return {
    statusCode: 201,
    headers: getCorsHeaders(),
    body: JSON.stringify(newExpense)
  };
};

/**
 * GET /api/artists/{artistId}/expenses - List expenses
 */
const handleGetExpenses = async (event, user) => {
  const { artistId } = event.pathParameters;
  const { startDate, endDate } = event.queryStringParameters || {};

  // Verify membership
  if (!user.platformAdmin) {
    const membership = await verifyMembership(user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Not a member of this artist' })
      };
    }
  }

  // Build query with optional date range
  const queryParams = {
    TableName: EXPENSES_TABLE,
    IndexName: 'artistId-date-index',
    KeyConditionExpression: 'artistId = :artistId',
    ExpressionAttributeValues: {
      ':artistId': artistId
    },
    ScanIndexForward: false // Most recent first
  };

  // Add date range filter if provided
  if (startDate && endDate) {
    queryParams.KeyConditionExpression += ' AND #date BETWEEN :start AND :end';
    queryParams.ExpressionAttributeNames = { '#date': 'date' };
    queryParams.ExpressionAttributeValues[':start'] = startDate;
    queryParams.ExpressionAttributeValues[':end'] = endDate;
  } else if (startDate) {
    queryParams.KeyConditionExpression += ' AND #date >= :start';
    queryParams.ExpressionAttributeNames = { '#date': 'date' };
    queryParams.ExpressionAttributeValues[':start'] = startDate;
  } else if (endDate) {
    queryParams.KeyConditionExpression += ' AND #date <= :end';
    queryParams.ExpressionAttributeNames = { '#date': 'date' };
    queryParams.ExpressionAttributeValues[':end'] = endDate;
  }

  const result = await dynamodb.query(queryParams).promise();

  console.log('EXPENSE: Listed', { artistId, count: result.Items?.length || 0 });

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({ expenses: result.Items || [] })
  };
};

/**
 * PUT /api/artists/{artistId}/expenses/{id} - Update expense
 */
const handleUpdateExpense = async (event, user) => {
  const { artistId, id } = event.pathParameters;
  const updates = JSON.parse(event.body);

  // Verify membership
  if (!user.platformAdmin) {
    const membership = await verifyMembership(user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Not a member of this artist' })
      };
    }
  }

  // Verify expense exists and belongs to this artist
  const existing = await dynamodb.get({
    TableName: EXPENSES_TABLE,
    Key: { id }
  }).promise();

  if (!existing.Item) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Expense not found' })
    };
  }

  if (existing.Item.artistId !== artistId) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Expense does not belong to this artist' })
    };
  }

  // Validate category if updating
  if (updates.category && !EXPENSE_CATEGORIES.includes(updates.category)) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        error: 'Invalid category',
        validCategories: EXPENSE_CATEGORIES
      })
    };
  }

  // Build update expression
  const updateExpressions = [];
  const attributeNames = {};
  const attributeValues = {};

  const allowedFields = ['date', 'amount', 'category', 'description', 'paidBy', 'relatedEventId', 'groupId'];

  allowedFields.forEach(field => {
    if (updates[field] !== undefined) {
      const placeholder = `#${field}`;
      const valuePlaceholder = `:${field}`;
      attributeNames[placeholder] = field;
      attributeValues[valuePlaceholder] = field === 'amount' ? parseFloat(updates[field]) : updates[field];
      updateExpressions.push(`${placeholder} = ${valuePlaceholder}`);
    }
  });

  // Always update updatedAt
  attributeNames['#updatedAt'] = 'updatedAt';
  attributeValues[':updatedAt'] = new Date().toISOString();
  updateExpressions.push('#updatedAt = :updatedAt');

  if (updateExpressions.length === 1) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'No valid fields to update' })
    };
  }

  await dynamodb.update({
    TableName: EXPENSES_TABLE,
    Key: { id },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: attributeNames,
    ExpressionAttributeValues: attributeValues
  }).promise();

  const updated = await dynamodb.get({
    TableName: EXPENSES_TABLE,
    Key: { id }
  }).promise();

  console.log('EXPENSE: Updated', { expenseId: id, artistId });

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify(updated.Item)
  };
};

/**
 * DELETE /api/artists/{artistId}/expenses/{id} - Delete expense
 */
const handleDeleteExpense = async (event, user) => {
  const { artistId, id } = event.pathParameters;

  // Verify membership
  if (!user.platformAdmin) {
    const membership = await verifyMembership(user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Not a member of this artist' })
      };
    }
  }

  // Verify expense exists and belongs to this artist
  const existing = await dynamodb.get({
    TableName: EXPENSES_TABLE,
    Key: { id }
  }).promise();

  if (!existing.Item) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Expense not found' })
    };
  }

  if (existing.Item.artistId !== artistId) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Expense does not belong to this artist' })
    };
  }

  await dynamodb.delete({
    TableName: EXPENSES_TABLE,
    Key: { id }
  }).promise();

  console.log('EXPENSE: Deleted', { expenseId: id, artistId });

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({ success: true, message: 'Expense deleted' })
  };
};

// =============================================================================
// Finances Summary Handler
// =============================================================================

/**
 * GET /api/artists/{artistId}/finances - Get finances summary
 */
const handleGetFinances = async (event, user) => {
  const { artistId } = event.pathParameters;
  const { startDate, endDate } = event.queryStringParameters || {};

  // Verify membership
  if (!user.platformAdmin) {
    const membership = await verifyMembership(user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Not a member of this artist' })
      };
    }
  }

  // Default date range: all time
  const start = startDate || '2020-01-01';
  const end = endDate || '2099-12-31';

  // Fetch expenses for date range
  const expensesResult = await dynamodb.query({
    TableName: EXPENSES_TABLE,
    IndexName: 'artistId-date-index',
    KeyConditionExpression: 'artistId = :artistId AND #date BETWEEN :start AND :end',
    ExpressionAttributeNames: { '#date': 'date' },
    ExpressionAttributeValues: {
      ':artistId': artistId,
      ':start': start,
      ':end': end
    }
  }).promise();

  const expenses = expensesResult.Items || [];

  // Fetch gigs with fees for date range (public_gig and gig types)
  const eventsResult = await dynamodb.query({
    TableName: EVENTS_TABLE,
    IndexName: 'artistId-date-index',
    KeyConditionExpression: 'artistId = :artistId AND #date BETWEEN :start AND :end',
    FilterExpression: '(#type = :gig OR #type = :publicGig) AND attribute_exists(agreedFee)',
    ExpressionAttributeNames: { '#date': 'date', '#type': 'type' },
    ExpressionAttributeValues: {
      ':artistId': artistId,
      ':start': start,
      ':end': end,
      ':gig': 'gig',
      ':publicGig': 'public_gig'
    }
  }).promise();

  const gigsWithFees = eventsResult.Items || [];

  // Calculate totals
  let totalIncome = 0;
  let totalPaidIncome = 0;
  let totalUnpaidIncome = 0;
  let totalExpenses = 0;

  // Income from gigs
  gigsWithFees.forEach(gig => {
    const fee = gig.actualFee !== undefined ? gig.actualFee : gig.agreedFee;
    totalIncome += fee;
    if (gig.datePaid) {
      totalPaidIncome += fee;
    } else {
      totalUnpaidIncome += fee;
    }
  });

  // Expenses
  expenses.forEach(expense => {
    totalExpenses += expense.amount;
  });

  const balance = totalPaidIncome - totalExpenses;

  // Build gigs list for income tab
  const income = gigsWithFees.map(gig => ({
    id: gig.id,
    date: gig.date,
    title: gig.title,
    venueId: gig.venueId,
    agreedFee: gig.agreedFee,
    actualFee: gig.actualFee,
    datePaid: gig.datePaid,
    paymentMethod: gig.paymentMethod,
    splitBetweenMembers: gig.splitBetweenMembers,
    isPaid: !!gig.datePaid
  }));

  console.log('FINANCES: Summary generated', {
    artistId,
    income: totalIncome,
    expenses: totalExpenses,
    balance,
    gigCount: gigsWithFees.length,
    expenseCount: expenses.length
  });

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({
      summary: {
        totalIncome,
        totalPaidIncome,
        totalUnpaidIncome,
        totalExpenses,
        balance
      },
      income,
      expenses,
      dateRange: { startDate: start, endDate: end }
    })
  };
};

// =============================================================================
// Main Handler / Router
// =============================================================================

exports.handler = async (event) => {
  console.log('EXPENSES: Request received', {
    path: event.rawPath || event.path,
    method: event.requestContext?.http?.method || event.httpMethod,
    pathParameters: event.pathParameters
  });

  // Handle OPTIONS (CORS preflight)
  const method = event.requestContext?.http?.method || event.httpMethod;
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: ''
    };
  }

  // Authenticate user for all routes
  const user = await authenticateUser(event);
  if (!user) {
    return {
      statusCode: 401,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }

  const path = event.rawPath || event.path || '';
  const artistId = event.pathParameters?.artistId;
  const expenseId = event.pathParameters?.id;

  try {
    // Route requests

    // GET /api/artists/{artistId}/finances
    if (path.match(/\/api\/artists\/[^/]+\/finances$/) && method === 'GET') {
      return await handleGetFinances(event, user);
    }

    // POST /api/artists/{artistId}/expenses
    if (path.match(/\/api\/artists\/[^/]+\/expenses$/) && method === 'POST') {
      return await handleCreateExpense(event, user);
    }

    // GET /api/artists/{artistId}/expenses
    if (path.match(/\/api\/artists\/[^/]+\/expenses$/) && method === 'GET') {
      return await handleGetExpenses(event, user);
    }

    // PUT /api/artists/{artistId}/expenses/{id}
    if (path.match(/\/api\/artists\/[^/]+\/expenses\/[^/]+$/) && method === 'PUT') {
      return await handleUpdateExpense(event, user);
    }

    // DELETE /api/artists/{artistId}/expenses/{id}
    if (path.match(/\/api\/artists\/[^/]+\/expenses\/[^/]+$/) && method === 'DELETE') {
      return await handleDeleteExpense(event, user);
    }

    // No matching route
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Not found', path, method })
    };

  } catch (error) {
    console.error('EXPENSES: Error', { error: error.message, stack: error.stack });
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
