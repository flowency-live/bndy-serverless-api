const legacy = require('./legacy-handler');
const backline = require('./backline');

exports.handler = async (event, context) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path || '';
  const match = path.match(/^\/api\/source-runs\/backline\/(summary|tasks|subject|source|observation|graph|hydration|trust-loop)$/);
  if (method === 'GET' && match) {
    context.callbackWaitsForEmptyEventLoop = false;
    return await backline.handle(event, match[1]);
  }
  return await legacy.handler(event, context);
};
