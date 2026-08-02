'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSamRoutes,
  duplicateRoutes,
  classifyBaseline,
  buildInventory
} = require('../security-route-inventory');

const FIXTURE = `
Resources:
  BndyHttpApi:
    Type: AWS::Serverless::HttpApi
  ArtistsFunction:
    Type: AWS::Serverless::Function
    Properties:
      Events:
        GetArtists:
          Type: HttpApi
          Properties:
            ApiId: !Ref BndyHttpApi
            Path: /api/artists
            Method: GET
        CreateArtist:
          Type: HttpApi
          Properties:
            ApiId: !Ref BndyHttpApi
            Path: /api/artists
            Method: POST
        DeleteArtistMcp:
          Type: HttpApi
          Properties:
            ApiId: !Ref BndyHttpApi
            Path: /api/artists/{id}/mcp
            Method: DELETE
            Auth:
              Authorizer: AdminAuthorizer
  DuplicateFunction:
    Type: AWS::Serverless::Function
    Properties:
      Events:
        DuplicateGetArtists:
          Type: HttpApi
          Properties:
            ApiId: !Ref BndyHttpApi
            Path: /api/artists
            Method: GET
  QueueFunction:
    Type: AWS::Serverless::Function
    Properties:
      Events:
        QueueEvent:
          Type: SQS
          Properties:
            Queue: example
`;

test('parses only HttpApi routes with method and path', () => {
  const routes = parseSamRoutes(FIXTURE);
  assert.equal(routes.length, 4);
  assert.deepEqual(
    routes.map(route => `${route.method} ${route.path}`),
    [
      'GET /api/artists',
      'POST /api/artists',
      'DELETE /api/artists/{id}/mcp',
      'GET /api/artists'
    ]
  );
});

test('captures a declared event authorizer', () => {
  const routes = parseSamRoutes(FIXTURE);
  const route = routes.find(item => item.event === 'DeleteArtistMcp');
  assert.equal(route.authorizer, 'AdminAuthorizer');
  assert.equal(route.authDeclared, true);
});

test('detects duplicate method and path declarations', () => {
  const duplicates = duplicateRoutes(parseSamRoutes(FIXTURE));
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].route, 'GET /api/artists');
  assert.equal(duplicates[0].declarations.length, 2);
});

test('classifies mutations as admin by default', () => {
  assert.equal(classifyBaseline({ method: 'POST', path: '/api/artists' }), 'admin');
  assert.equal(classifyBaseline({ method: 'PUT', path: '/api/artists/1' }), 'admin');
  assert.equal(classifyBaseline({ method: 'DELETE', path: '/api/artists/1' }), 'admin');
});

test('classifies HTTP MCP routes as deprecated before mutation default', () => {
  assert.equal(
    classifyBaseline({ method: 'DELETE', path: '/api/artists/{id}/mcp' }),
    'deprecated'
  );
});

test('classifies future AI routes separately', () => {
  assert.equal(
    classifyBaseline({ method: 'POST', path: '/api/ai/artists/find-or-create' }),
    'ai-integration'
  );
});

test('reports unauthenticated mutations without claiming handler-level auth knowledge', () => {
  const inventory = buildInventory(parseSamRoutes(FIXTURE));
  assert.equal(inventory.summary.mutationRoutes, 2);
  assert.equal(inventory.summary.unauthenticatedMutationRoutes, 1);
  assert.equal(inventory.summary.httpMcpRoutes, 1);
  assert.equal(inventory.summary.duplicateRouteKeys, 1);

  const createRoute = inventory.routes.find(route => route.event === 'CreateArtist');
  assert.equal(createRoute.currentRisk, 'unauthenticated-mutation-declared-in-sam');

  const protectedDelete = inventory.routes.find(route => route.event === 'DeleteArtistMcp');
  assert.equal(protectedDelete.currentRisk, null);
});
