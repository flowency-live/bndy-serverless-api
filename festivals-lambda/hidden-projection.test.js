const { loadVenuePoints } = require('./handlers/public-v1');

function promiseResult(value) {
  return { promise: () => Promise.resolve(value) };
}

describe('festival venue point projection', () => {
  it('aliases DynamoDB reserved attribute hidden', async () => {
    const batchGet = jest.fn(() => promiseResult({ Responses: { 'bndy-venues': [] } }));

    await loadVenuePoints({ batchGet }, [{ venueIds: ['v1'] }]);

    expect(batchGet).toHaveBeenCalledTimes(1);
    expect(batchGet.mock.calls[0][0].RequestItems['bndy-venues']).toMatchObject({
      ProjectionExpression: 'id, city, latitude, longitude, #hidden, publicationScopes',
      ExpressionAttributeNames: { '#hidden': 'hidden' }
    });
  });
});
