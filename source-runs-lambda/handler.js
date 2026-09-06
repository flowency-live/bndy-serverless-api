const legacy = require('./legacy-handler');
const backline = require('./backline');
const intelligence = require('./intelligence');

exports.handler = async (event, context) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path || '';
  if (method === 'GET' && path === '/api/source-runs/intelligence') {
    context.callbackWaitsForEmptyEventLoop = false;
    return await intelligence.handle(event);
  }
  const match = path.match(/^\/api\/source-runs\/backline\/(summary|tasks|subject|source|observation|graph|hydration|trust-loop|holds|operations)$/);
  if (method === 'GET' && match) {
    context.callbackWaitsForEmptyEventLoop = false;
    return await backline.handle(event, match[1]);
  }
  return await legacy.handler(event, context);
};
