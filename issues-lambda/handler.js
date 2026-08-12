// BNDY Issues Lambda Function - Issue Tracker Management
// Handles bug reports, feature requests, and development issues
// Uses Lambda Authorizer for authentication - receives pre-validated user context

const AWS = require('aws-sdk');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// AWS Services
const dynamodb = new AWS.DynamoDB.DocumentClient();
const ssm = new AWS.SSM({ region: 'eu-west-2' });

// Configuration
const ISSUES_TABLE = 'bndy-issues';

// JWT Secret - cached after first retrieval
let JWT_SECRET = null;

/**
 * Get JWT secret from SSM Parameter Store with fallback to env var
 */
async function getJWTSecret() {
  if (JWT_SECRET) {
    return JWT_SECRET; // Return cached value
  }

  // Try SSM first
  try {
    const result = await ssm.getParameter({
      Name: '/bndy/auth/jwt-secret',
      WithDecryption: true
    }).promise();
    JWT_SECRET = result.Parameter.Value;
    console.log('[ISSUES] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.error('[ISSUES] Failed to get JWT_SECRET from SSM:', error.message);
    // Fallback to environment variable
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      console.log('[ISSUES] JWT_SECRET loaded from environment variable (fallback)');
      return JWT_SECRET;
    }
    throw new Error('JWT_SECRET not available from SSM or environment');
  }
}

// Allowed CORS origins for frontend access
const ALLOWED_ORIGINS = [
  'https://www.bndy.co.uk',       // Primary domain
  'https://backstage.bndy.co.uk', // Legacy domain
  'https://bndy.co.uk',            // Apex domain
  'https://live.bndy.co.uk',      // Frontstage
  'https://gigmap.bndy.co.uk',    // GigMap
  'https://map.bndy.co.uk',       // Map (canonical)
  'https://gigs.bndy.co.uk',      // Gigs
  'http://localhost:3000'          // Local development
];

// Module-level variable to store current request event for CORS
let currentEvent = null;

// Get appropriate origin for CORS based on request origin
const getAllowedOrigin = () => {
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
};

// CORS is now handled by API Gateway CorsConfiguration in template.yaml
const getCorsHeaders = () => ({
  'Content-Type': 'application/json'
});

// Create response
const createResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    ...getCorsHeaders()
  },
  body: JSON.stringify(body)
});

// Parse cookies from event
const parseCookies = (cookieHeader) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookies[name] = value;
    return cookies;
  }, {});
};

// Authentication validation
const requireAuth = async (event) => {
  // HTTP API v2 passes cookies in event.cookies array
  let sessionToken = null;

  if (event.cookies && Array.isArray(event.cookies)) {
    // HTTP API v2 format
    const cookieString = event.cookies.find(c => c.startsWith('bndy_session='));
    if (cookieString) {
      sessionToken = cookieString.split('=')[1];
    }
  } else {
    // Fallback to headers for compatibility
    const cookies = parseCookies(event.headers?.Cookie || event.headers?.cookie || '');
    sessionToken = cookies.bndy_session;
  }

  console.log('[ISSUES] Checking authentication', {
    hasCookie: !!(event.cookies || event.headers?.Cookie),
    hasSessionToken: !!sessionToken,
    eventCookies: event.cookies?.length || 0
  });

  if (!sessionToken) {
    console.log('[ISSUES] No session token found');
    return { error: 'Not authenticated' };
  }

  try {
    const jwtSecret = await getJWTSecret();
    const session = jwt.verify(sessionToken, jwtSecret);
    console.log('[ISSUES] User authenticated via session', {
      userId: session.userId.substring(0, 8) + '...'
    });
    return { user: session };
  } catch (error) {
    console.error('[ISSUES] Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

// Create new issue
const handleCreateIssue = async (event) => {
  const authResult = await requireAuth(event);

  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const { user } = authResult;

  try {
    const requestBody = JSON.parse(event.body);
    const { title, description, type, location, priority, screenshotUrl } = requestBody;

    console.log(' ISSUES: Create issue request', {
      title: title?.substring(0, 50) + '...',
      type,
      location,
      priority
    });

    // Validate required fields
    if (!title || !description || !type) {
      return createResponse(400, {
        error: 'Missing required fields',
        required: ['title', 'description', 'type']
      });
    }

    // Validate type
    const validTypes = ['bug', 'unfinished', 'enhancement', 'new'];
    if (!validTypes.includes(type)) {
      return createResponse(400, {
        error: 'Invalid type',
        validTypes
      });
    }

    // Validate priority
    const validPriorities = ['critical', 'high', 'medium', 'low'];
    if (priority && !validPriorities.includes(priority)) {
      return createResponse(400, {
        error: 'Invalid priority',
        validPriorities
      });
    }

    // Generate issue ID
    const issueId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Create new issue
    const issueItem = {
      issue_id: issueId,
      title,
      description,
      type,
      location: location || 'Unknown',
      priority: priority || 'medium',
      status: 'new',
      screenshot_url: screenshotUrl || null,
      reported_by: user.userId,
      created_at: now,
      updated_at: now
    };

    await dynamodb.put({
      TableName: ISSUES_TABLE,
      Item: issueItem
    }).promise();

    console.log(' ISSUES: Issue created successfully', {
      issueId,
      type,
      priority
    });

    return createResponse(201, {
      issue: issueItem,
      message: 'Issue created successfully'
    });

  } catch (error) {
    console.error(' ISSUES: Create issue error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Get all issues
const handleListIssues = async (event) => {
  const authResult = await requireAuth(event);

  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  try {
    const queryParams = event.queryStringParameters || {};
    const { status, type, priority, limit } = queryParams;

    console.log(' ISSUES: List issues request', {
      status,
      type,
      priority,
      limit
    });

    let scanParams = {
      TableName: ISSUES_TABLE
    };

    // Add filters if provided
    const filterExpressions = [];
    const expressionAttributeValues = {};

    if (status) {
      filterExpressions.push('#status = :status');
      expressionAttributeValues[':status'] = status;
      scanParams.ExpressionAttributeNames = { '#status': 'status' };
    }

    if (type) {
      filterExpressions.push('#type = :type');
      expressionAttributeValues[':type'] = type;
      scanParams.ExpressionAttributeNames = {
        ...scanParams.ExpressionAttributeNames,
        '#type': 'type'
      };
    }

    if (priority) {
      filterExpressions.push('priority = :priority');
      expressionAttributeValues[':priority'] = priority;
    }

    if (filterExpressions.length > 0) {
      scanParams.FilterExpression = filterExpressions.join(' AND ');
      scanParams.ExpressionAttributeValues = expressionAttributeValues;
    }

    if (limit) {
      scanParams.Limit = parseInt(limit);
    }

    const result = await dynamodb.scan(scanParams).promise();

    // Sort by created_at descending (newest first)
    const issues = result.Items.sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    );

    console.log(` ISSUES: Retrieved ${issues.length} issues`);

    return createResponse(200, {
      issues,
      count: issues.length,
      scannedCount: result.ScannedCount
    });

  } catch (error) {
    console.error(' ISSUES: List issues error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Update issue
const handleUpdateIssue = async (event) => {
  const authResult = await requireAuth(event);

  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  try {
    const issueId = event.pathParameters?.id;
    if (!issueId) {
      return createResponse(400, { error: 'Issue ID required' });
    }

    const requestBody = JSON.parse(event.body);
    const { title, description, type, location, priority, status, screenshotUrl } = requestBody;

    console.log(' ISSUES: Update issue request', {
      issueId: issueId.substring(0, 8) + '...',
      status,
      priority
    });

    // Get existing issue
    const existingIssue = await dynamodb.get({
      TableName: ISSUES_TABLE,
      Key: { issue_id: issueId }
    }).promise();

    if (!existingIssue.Item) {
      return createResponse(404, { error: 'Issue not found' });
    }

    // Build update expression
    const updateExpressions = [];
    const expressionAttributeValues = {};
    const expressionAttributeNames = {};

    if (title) {
      updateExpressions.push('title = :title');
      expressionAttributeValues[':title'] = title;
    }

    if (description) {
      updateExpressions.push('description = :description');
      expressionAttributeValues[':description'] = description;
    }

    if (type) {
      const validTypes = ['bug', 'unfinished', 'enhancement', 'new'];
      if (!validTypes.includes(type)) {
        return createResponse(400, { error: 'Invalid type', validTypes });
      }
      updateExpressions.push('#type = :type');
      expressionAttributeValues[':type'] = type;
      expressionAttributeNames['#type'] = 'type';
    }

    if (location) {
      updateExpressions.push('location = :location');
      expressionAttributeValues[':location'] = location;
    }

    if (priority) {
      const validPriorities = ['critical', 'high', 'medium', 'low'];
      if (!validPriorities.includes(priority)) {
        return createResponse(400, { error: 'Invalid priority', validPriorities });
      }
      updateExpressions.push('priority = :priority');
      expressionAttributeValues[':priority'] = priority;
    }

    if (status) {
      const validStatuses = ['new', 'in-progress', 'resolved', 'wont-fix'];
      if (!validStatuses.includes(status)) {
        return createResponse(400, { error: 'Invalid status', validStatuses });
      }
      updateExpressions.push('#status = :status');
      expressionAttributeValues[':status'] = status;
      expressionAttributeNames['#status'] = 'status';
    }

    if (screenshotUrl !== undefined) {
      updateExpressions.push('screenshot_url = :screenshotUrl');
      expressionAttributeValues[':screenshotUrl'] = screenshotUrl;
    }

    // Always update timestamp
    updateExpressions.push('updated_at = :updatedAt');
    expressionAttributeValues[':updatedAt'] = new Date().toISOString();

    if (updateExpressions.length === 1) { // Only timestamp
      return createResponse(400, { error: 'No fields to update' });
    }

    const updateParams = {
      TableName: ISSUES_TABLE,
      Key: { issue_id: issueId },
      UpdateExpression: 'SET ' + updateExpressions.join(', '),
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    };

    if (Object.keys(expressionAttributeNames).length > 0) {
      updateParams.ExpressionAttributeNames = expressionAttributeNames;
    }

    const result = await dynamodb.update(updateParams).promise();

    console.log(' ISSUES: Issue updated successfully', {
      issueId,
      status: result.Attributes.status
    });

    return createResponse(200, {
      issue: result.Attributes,
      message: 'Issue updated successfully'
    });

  } catch (error) {
    console.error(' ISSUES: Update issue error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Delete issue
const handleDeleteIssue = async (event) => {
  const authResult = await requireAuth(event);

  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  try {
    const issueId = event.pathParameters?.id;
    if (!issueId) {
      return createResponse(400, { error: 'Issue ID required' });
    }

    console.log(' ISSUES: Delete issue request', {
      issueId: issueId.substring(0, 8) + '...'
    });

    // Check if issue exists
    const existingIssue = await dynamodb.get({
      TableName: ISSUES_TABLE,
      Key: { issue_id: issueId }
    }).promise();

    if (!existingIssue.Item) {
      return createResponse(404, { error: 'Issue not found' });
    }

    // Delete issue
    await dynamodb.delete({
      TableName: ISSUES_TABLE,
      Key: { issue_id: issueId }
    }).promise();

    console.log(' ISSUES: Issue deleted successfully', { issueId });

    return createResponse(200, {
      message: 'Issue deleted successfully',
      issueId
    });

  } catch (error) {
    console.error(' ISSUES: Delete issue error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Batch update issues
const handleBatchUpdateIssues = async (event) => {
  const authResult = await requireAuth(event);

  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  try {
    const requestBody = JSON.parse(event.body);
    const { issueIds, updates } = requestBody;

    if (!issueIds || !Array.isArray(issueIds) || issueIds.length === 0) {
      return createResponse(400, { error: 'Issue IDs array required' });
    }

    if (!updates || Object.keys(updates).length === 0) {
      return createResponse(400, { error: 'Updates object required' });
    }

    console.log(' ISSUES: Batch update request', {
      issueCount: issueIds.length,
      updates: Object.keys(updates)
    });

    const results = [];
    const errors = [];

    // Process each issue
    for (const issueId of issueIds) {
      try {
        // Build update expression
        const updateExpressions = [];
        const expressionAttributeValues = {};
        const expressionAttributeNames = {};

        Object.entries(updates).forEach(([key, value]) => {
          if (key === 'status') {
            updateExpressions.push('#status = :status');
            expressionAttributeValues[':status'] = value;
            expressionAttributeNames['#status'] = 'status';
          } else if (key === 'type') {
            updateExpressions.push('#type = :type');
            expressionAttributeValues[':type'] = value;
            expressionAttributeNames['#type'] = 'type';
          } else {
            updateExpressions.push(`${key} = :${key}`);
            expressionAttributeValues[`:${key}`] = value;
          }
        });

        // Always update timestamp
        updateExpressions.push('updated_at = :updatedAt');
        expressionAttributeValues[':updatedAt'] = new Date().toISOString();

        const updateParams = {
          TableName: ISSUES_TABLE,
          Key: { issue_id: issueId },
          UpdateExpression: 'SET ' + updateExpressions.join(', '),
          ExpressionAttributeValues: expressionAttributeValues,
          ReturnValues: 'ALL_NEW'
        };

        if (Object.keys(expressionAttributeNames).length > 0) {
          updateParams.ExpressionAttributeNames = expressionAttributeNames;
        }

        const result = await dynamodb.update(updateParams).promise();
        results.push(result.Attributes);

      } catch (error) {
        console.error(` ISSUES: Failed to update issue ${issueId}:`, error);
        errors.push({
          issueId,
          error: error.message
        });
      }
    }

    console.log(' ISSUES: Batch update completed', {
      successful: results.length,
      failed: errors.length
    });

    return createResponse(200, {
      updated: results,
      errors,
      message: `Updated ${results.length} issues, ${errors.length} failed`
    });

  } catch (error) {
    console.error(' ISSUES: Batch update error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Main handler
exports.handler = async (event, context) => {
  // Store event for CORS headers
  currentEvent = event;

  // HTTP API v2 payload format compatibility
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;
  const routeKey = `${method} ${path}`;

  console.log(' Issues Lambda: Request received', {
    routeKey,
    method,
    path,
    version: event.version || 'v2.0'
  });

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: ''
    };
  }

  try {
    // Route requests (HTTP API v2 format with /api/ prefix)
    if (routeKey === 'POST /api/issues') {
      return await handleCreateIssue(event);
    }

    if (routeKey === 'GET /api/issues') {
      return await handleListIssues(event);
    }

    if (routeKey === 'PUT /api/issues/{id}') {
      return await handleUpdateIssue(event);
    }

    if (routeKey === 'DELETE /api/issues/{id}') {
      return await handleDeleteIssue(event);
    }

    if (routeKey === 'POST /api/issues/batch') {
      return await handleBatchUpdateIssues(event);
    }

    // Route not found
    return createResponse(404, {
      error: 'Route not found',
      routeKey,
      path,
      method,
      availableRoutes: [
        'POST /api/issues',
        'GET /api/issues',
        'PUT /api/issues/{id}',
        'DELETE /api/issues/{id}',
        'POST /api/issues/batch'
      ]
    });

  } catch (error) {
    console.error(' Issues Lambda: Unexpected error:', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: error.message
    });
  }
};