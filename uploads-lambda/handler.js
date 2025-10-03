// BNDY Uploads Lambda Function - S3 Image Upload Management
// Generates presigned URLs for secure client-side S3 uploads

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// AWS Services
const s3 = new AWS.S3({ region: 'eu-west-2' });

// Configuration
const BUCKET_NAME = 'bndy-images';
const FRONTEND_URL = 'https://backstage.bndy.co.uk';
const JWT_SECRET = process.env.JWT_SECRET;

const corsHeaders = {
  'Access-Control-Allow-Origin': FRONTEND_URL,
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Credentials': 'true'
};

// Create response
const createResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    ...corsHeaders
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
const requireAuth = (event) => {
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
    const session = jwt.verify(sessionToken, JWT_SECRET);
    console.log('UPLOADS: User authenticated via session', {
      userId: session.userId.substring(0, 8) + '...'
    });
    return { user: session };
  } catch (error) {
    console.error('UPLOADS: Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

// Generate presigned URL for upload
const handleGenerateUploadUrl = async (event) => {
  const authResult = requireAuth(event);

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

    // Generate presigned URL (expires in 5 minutes)
    const presignedUrl = s3.getSignedUrl('putObject', {
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      Expires: 300, // 5 minutes
      ACL: 'public-read',
      ContentLengthRange: [1, maxFileSize], // Enforce size limit in S3
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
    console.error('UPLOADS: Generate upload URL error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Main handler
exports.handler = async (event, context) => {
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
      headers: corsHeaders,
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