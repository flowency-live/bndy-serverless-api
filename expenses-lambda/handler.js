// BNDY Expenses Lambda Function - Financial Tracking
// Handles: Artist expense CRUD, finances summary

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });

// Configuration
const EXPENSES_TABLE = 'bndy-expenses';
const INCOME_TABLE = 'bndy-income';
const EVENTS_TABLE = 'bndy-events';
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';
const ARTISTS_TABLE = 'bndy-artists';

// Valid income categories
const INCOME_CATEGORIES = [
  'gig_payment',        // Linked to event (use Mark as Paid for this)
  'member_contribution', // Member adds to shared pot
  'tips',               // Tips/donations
  'merch',              // Merchandise sales
  'other'               // Other income
];

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

// Users table for platformAdmin lookup
const USERS_TABLE = 'bndy-users';

// JWT Secret - cached after first retrieval
let JWT_SECRET = null;

// Module-level variable to store current request event for CORS
let currentEvent = null;

// Allowed CORS origins for frontend access
const ALLOWED_ORIGINS = [
  'https://www.bndy.co.uk',
  'https://backstage.bndy.co.uk',
  'https://bndy.co.uk',
  'https://live.bndy.co.uk',
  'http://localhost:3000',
  'http://localhost:3001'
];

/**
 * Get JWT secret from SSM Parameter Store with fallback to env var
 */
async function getJWTSecret() {
  if (JWT_SECRET) {
    return JWT_SECRET;
  }

  try {
    const result = await ssm.getParameter({
      Name: '/bndy/auth/jwt-secret',
      WithDecryption: true
    }).promise();
    JWT_SECRET = result.Parameter.Value;
    console.log('[EXPENSES] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.log('SSM fetch failed, using env var:', error.message);
    JWT_SECRET = process.env.JWT_SECRET;
    return JWT_SECRET;
  }
}

// Get appropriate origin for CORS based on request origin
const getAllowedOrigin = () => {
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
};

/**
 * CORS headers for all responses
 */
const getCorsHeaders = () => ({
  'Access-Control-Allow-Origin': getAllowedOrigin(),
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Credentials': 'true',
  'Content-Type': 'application/json'
});

/**
 * Parse cookies from event
 */
const parseCookies = (cookieHeader) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookies[name] = value;
    return cookies;
  }, {});
};

/**
 * Authenticate user from session cookie (cookie-based auth like events-lambda)
 */
async function authenticateUser(event) {
  let sessionToken = null;

  // Try event.cookies array first (HTTP API format)
  if (event.cookies && Array.isArray(event.cookies)) {
    const cookieString = event.cookies.find(c => c.startsWith('bndy_session='));
    if (cookieString) {
      sessionToken = cookieString.split('=')[1];
    }
  } else {
    // Fallback to parsing Cookie header
    const cookies = parseCookies(event.headers?.Cookie || event.headers?.cookie || '');
    sessionToken = cookies.bndy_session;
  }

  if (!sessionToken) {
    console.log('[EXPENSES] No session token found in cookies');
    return null;
  }

  const secret = await getJWTSecret();

  try {
    const decoded = jwt.verify(sessionToken, secret);

    // Fetch user to check platformAdmin flag
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: decoded.userId }
    }).promise();

    const platformAdmin = userResult.Item?.platformAdmin || false;

    return {
      userId: decoded.userId || decoded.sub,
      email: decoded.email,
      platformAdmin
    };
  } catch (error) {
    console.log('[EXPENSES] JWT verification failed:', error.message);
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
// Income Handlers
// =============================================================================

/**
 * POST /api/artists/{artistId}/income - Create income entry
 */
const handleCreateIncome = async (event, user) => {
  const { artistId } = event.pathParameters;
  const incomeData = JSON.parse(event.body);

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

  // Validate required fields
  if (!incomeData.date) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'date is required' })
    };
  }

  if (incomeData.amount === undefined || incomeData.amount === null) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'amount is required' })
    };
  }

  if (!incomeData.category || !INCOME_CATEGORIES.includes(incomeData.category)) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        error: 'Invalid category',
        validCategories: INCOME_CATEGORIES
      })
    };
  }

  // Require description for non-gig income
  if (incomeData.category !== 'gig_payment' && !incomeData.description) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'description is required for non-gig income' })
    };
  }

  const incomeId = crypto.randomUUID();
  const now = new Date().toISOString();

  const newIncome = {
    id: incomeId,
    artistId,
    date: incomeData.date,
    amount: parseFloat(incomeData.amount),
    category: incomeData.category,
    createdBy: user.userId,
    createdAt: now,
    updatedAt: now
  };

  // Optional fields
  if (incomeData.description) newIncome.description = incomeData.description;
  if (incomeData.relatedEventId) newIncome.relatedEventId = incomeData.relatedEventId;
  if (incomeData.memberId) newIncome.memberId = incomeData.memberId;

  await dynamodb.put({
    TableName: INCOME_TABLE,
    Item: newIncome
  }).promise();

  console.log('INCOME: Created', { incomeId, artistId, category: incomeData.category, amount: newIncome.amount });

  return {
    statusCode: 201,
    headers: getCorsHeaders(),
    body: JSON.stringify(newIncome)
  };
};

/**
 * GET /api/artists/{artistId}/income - List income entries
 */
const handleGetIncome = async (event, user) => {
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
    TableName: INCOME_TABLE,
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

  console.log('INCOME: Listed', { artistId, count: result.Items?.length || 0 });

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({ income: result.Items || [] })
  };
};

/**
 * DELETE /api/artists/{artistId}/income/{id} - Delete income entry
 */
const handleDeleteIncome = async (event, user) => {
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

  // Verify income exists and belongs to this artist
  const existing = await dynamodb.get({
    TableName: INCOME_TABLE,
    Key: { id }
  }).promise();

  if (!existing.Item) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Income entry not found' })
    };
  }

  if (existing.Item.artistId !== artistId) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Income entry does not belong to this artist' })
    };
  }

  await dynamodb.delete({
    TableName: INCOME_TABLE,
    Key: { id }
  }).promise();

  console.log('INCOME: Deleted', { incomeId: id, artistId });

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({ success: true, message: 'Income entry deleted' })
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

  // Fetch gigs with fees OR noFee flag for date range (public_gig and gig types)
  const eventsResult = await dynamodb.query({
    TableName: EVENTS_TABLE,
    IndexName: 'artistId-date-index',
    KeyConditionExpression: 'artistId = :artistId AND #date BETWEEN :start AND :end',
    FilterExpression: '(#type = :gig OR #type = :publicGig) AND (attribute_exists(agreedFee) OR noFee = :true)',
    ExpressionAttributeNames: { '#date': 'date', '#type': 'type' },
    ExpressionAttributeValues: {
      ':artistId': artistId,
      ':start': start,
      ':end': end,
      ':gig': 'gig',
      ':publicGig': 'public_gig',
      ':true': true
    }
  }).promise();

  const gigsWithFees = eventsResult.Items || [];

  // Fetch standalone income for date range
  let standaloneIncome = [];
  try {
    const incomeResult = await dynamodb.query({
      TableName: INCOME_TABLE,
      IndexName: 'artistId-date-index',
      KeyConditionExpression: 'artistId = :artistId AND #date BETWEEN :start AND :end',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':start': start,
        ':end': end
      }
    }).promise();
    standaloneIncome = incomeResult.Items || [];
  } catch (err) {
    // Table may not exist yet, continue without standalone income
    console.log('FINANCES: Income table query failed (may not exist yet):', err.message);
  }

  // Calculate totals
  let totalIncome = 0;
  let totalPaidIncome = 0;
  let totalUnpaidIncome = 0;
  let totalExpenses = 0;
  let totalStandaloneIncome = 0;
  let totalGigIncome = 0; // Track gig revenue separately (even if distributed)

  // Income from gigs
  gigsWithFees.forEach(gig => {
    // For noFee gigs, only count actualFee if paid
    if (gig.noFee) {
      if (gig.datePaid && gig.actualFee !== undefined) {
        totalIncome += gig.actualFee;
        totalPaidIncome += gig.actualFee;
        totalGigIncome += gig.actualFee; // Track gig revenue
      }
      // noFee gigs with no payment yet don't contribute to unpaid income
    } else {
      const fee = gig.actualFee !== undefined ? gig.actualFee : gig.agreedFee;
      totalIncome += fee;
      if (gig.datePaid) {
        totalPaidIncome += fee;
        totalGigIncome += fee; // Track gig revenue
      } else {
        totalUnpaidIncome += fee;
      }
    }
  });

  // Standalone income (already received)
  standaloneIncome.forEach(inc => {
    totalStandaloneIncome += inc.amount;
    totalIncome += inc.amount;
    totalPaidIncome += inc.amount; // Standalone income is always "received"
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
    noFee: gig.noFee || false,
    isPaid: !!gig.datePaid
  }));

  console.log('FINANCES: Summary generated', {
    artistId,
    income: totalIncome,
    gigIncome: totalGigIncome,
    expenses: totalExpenses,
    balance,
    gigCount: gigsWithFees.length,
    standaloneIncomeCount: standaloneIncome.length,
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
        totalStandaloneIncome,
        totalGigIncome, // Gig revenue (even if distributed to members)
        totalExpenses,
        balance
      },
      income,
      standaloneIncome,
      expenses,
      dateRange: { startDate: start, endDate: end }
    })
  };
};

// =============================================================================
// Main Handler / Router
// =============================================================================

exports.handler = async (event) => {
  // Set current event for CORS origin handling
  currentEvent = event;

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

    // POST /api/artists/{artistId}/income
    if (path.match(/\/api\/artists\/[^/]+\/income$/) && method === 'POST') {
      return await handleCreateIncome(event, user);
    }

    // GET /api/artists/{artistId}/income
    if (path.match(/\/api\/artists\/[^/]+\/income$/) && method === 'GET') {
      return await handleGetIncome(event, user);
    }

    // DELETE /api/artists/{artistId}/income/{id}
    if (path.match(/\/api\/artists\/[^/]+\/income\/[^/]+$/) && method === 'DELETE') {
      return await handleDeleteIncome(event, user);
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
