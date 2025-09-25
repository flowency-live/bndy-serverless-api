// BNDY Auth Lambda Function - PLACEHOLDER
// TODO: Implement authentication routes

exports.handler = async (event, context) => {
  console.log('🔐 Auth Lambda: Request received', {
    httpMethod: event.httpMethod,
    path: event.path
  });

  return {
    statusCode: 501,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Credentials': 'true'
    },
    body: JSON.stringify({
      error: 'Auth Lambda not yet implemented',
      path: event.path
    })
  };
};