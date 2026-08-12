// BNDY Uploads Lambda Function - S3 Image Upload Management
// Generates presigned URLs for secure client-side S3 uploads

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// AWS Services
const s3 = new AWS.S3({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

// Configuration
const BUCKET_NAME = 'bndy-images';
const USERS_TABLE = 'bndy-users';

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
    console.log('[UPLOADS] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.error('[UPLOADS] Failed to get JWT_SECRET from SSM:', error.message);
    // Fallback to environment variable
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      console.log('[UPLOADS] JWT_SECRET loaded from environment variable (fallback)');
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
  let sessionToken = null;

  if (event.cookies && Array.isArray(event.cookies)) {
    const cookieString = event.cookies.find(c => c.startsWith('bndy_session='));
    if (cookieString) {
      sessionToken = cookieString.split('=')[1];
    }
  } else {
    const cookies = parseCookies(event.headers?.Cookie || event.headers?.cookie || '');
    sessionToken = cookies.bndy_session;
  }

  console.log('UPLOADS: Checking authentication', {
    hasCookie: !!(event.cookies || event.headers?.Cookie),
    hasSessionToken: !!sessionToken
  });

  if (!sessionToken) {
    console.log('UPLOADS: No session token found');
    return { error: 'Not authenticated' };
  }

  try {
    const jwtSecret = await getJWTSecret();
    const session = jwt.verify(sessionToken, jwtSecret);

    // Fetch user to check platformAdmin flag
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: session.userId }
    }).promise();

    const platformAdmin = userResult.Item?.platform_admin || false;

    console.log('UPLOADS: User authenticated via session', {
      userId: session.userId.substring(0, 8) + '...',
      platformAdmin
    });

    return {
      user: {
        ...session,
        platformAdmin
      }
    };
  } catch (error) {
    console.error('UPLOADS: Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

// Generate presigned URL for upload
const handleGenerateUploadUrl = async (event) => {
  const authResult = await requireAuth(event);

  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const { user } = authResult;

  try {
    const requestBody = JSON.parse(event.body);
    const { fileName, contentType, uploadType = 'avatar' } = requestBody;

    console.log('UPLOADS: Generate upload URL request', {
      fileName: fileName?.substring(0, 50),
      contentType,
      uploadType
    });

    // Validate content type
    if (!contentType || !contentType.startsWith('image/')) {
      return createResponse(400, {
        error: 'Invalid content type',
        message: 'Only image files are allowed'
      });
    }

    // Validate file extension
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const fileExtension = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
    if (!allowedExtensions.includes(fileExtension)) {
      return createResponse(400, {
        error: 'Invalid file extension',
        allowedExtensions
      });
    }

    // Validate file size (5MB limit)
    const { fileSize } = requestBody;
    const maxFileSize = 5 * 1024 * 1024; // 5MB
    if (fileSize && fileSize > maxFileSize) {
      return createResponse(400, {
        error: 'File too large',
        message: `File size must be less than ${maxFileSize / 1024 / 1024}MB`,
        maxSize: maxFileSize
      });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const randomId = crypto.randomBytes(8).toString('hex');
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `${uploadType}/${user.userId}/${timestamp}-${randomId}-${sanitizedFileName}`;

    console.log('UPLOADS: Generating presigned URL', {
      bucket: BUCKET_NAME,
      key,
      contentType,
      userId: user.userId.substring(0, 8) + '...'
    });

    // Generate presigned URL (expires in 5 minutes)
    const presignedUrl = s3.getSignedUrl('putObject', {
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      Expires: 300, // 5 minutes
      // Note: ACL removed - bucket uses public-read bucket policy instead
      // Note: File size validation done client-side before request
      Metadata: {
        'uploaded-by': user.userId,
        'upload-type': uploadType,
        'original-filename': fileName
      }
    });

    // Generate the public URL for accessing the uploaded image
    const publicUrl = `https://${BUCKET_NAME}.s3.eu-west-2.amazonaws.com/${key}`;

    console.log('UPLOADS: Presigned URL generated', {
      key,
      publicUrl: publicUrl.substring(0, 80) + '...'
    });

    return createResponse(200, {
      uploadUrl: presignedUrl,
      publicUrl,
      key,
      expiresIn: 300
    });

  } catch (error) {
    console.error('UPLOADS: Generate upload URL error:', {
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
      stack: error.stack
    });
    return createResponse(500, {
      error: 'Internal server error',
      details: error.message
    });
  }
};

// Main handler
exports.handler = async (event, context) => {
  // Store event for CORS headers
  currentEvent = event;

  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;
  const routeKey = `${method} ${path}`;

  console.log('UPLOADS: Request received', {
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
    // Route requests
    if (routeKey === 'POST /uploads/presigned-url') {
      return await handleGenerateUploadUrl(event);
    }

    // Route not found
    return createResponse(404, {
      error: 'Route not found',
      routeKey,
      availableRoutes: [
        'POST /uploads/presigned-url'
      ]
    });

  } catch (error) {
    console.error('UPLOADS: Unexpected error:', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: error.message
    });
  }
};