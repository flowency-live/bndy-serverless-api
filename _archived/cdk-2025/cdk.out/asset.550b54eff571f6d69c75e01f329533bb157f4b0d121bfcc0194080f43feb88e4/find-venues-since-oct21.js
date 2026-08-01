const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

async function findVenuesSinceOct21() {
  console.log('Scanning for venues modified since Oct 21, 2025...\n');

  const cutoffDate = '2025-10-21T00:00:00.000Z';

  const params = {
    TableName: 'bndy-venues'
  };

  const result = await dynamodb.scan(params).promise();
  const allVenues = result.Items;

  console.log(`Total venues in database: ${allVenues.length}\n`);

  // Find venues enriched since Oct 21
  const enrichedSinceOct21 = allVenues.filter(v => {
    return v.enrichment_date && v.enrichment_date >= cutoffDate;
  });

  // Find venues updated since Oct 21 (might include other changes)
  const updatedSinceOct21 = allVenues.filter(v => {
    return v.updated_at && v.updated_at >= cutoffDate;
  });

  console.log('=== VENUES MODIFIED SINCE OCT 21, 2025 ===\n');
  console.log(`Venues with enrichment_date >= Oct 21: ${enrichedSinceOct21.length}`);
  console.log(`Venues with updated_at >= Oct 21: ${updatedSinceOct21.length}\n`);

  // Categorize enriched venues by status
  const byStatus = {
    high_confidence: enrichedSinceOct21.filter(v => v.enrichment_status === 'high_confidence'),
    needs_review: enrichedSinceOct21.filter(v => v.enrichment_status === 'needs_review'),
    no_results: enrichedSinceOct21.filter(v => v.enrichment_status === 'no_results'),
    other: enrichedSinceOct21.filter(v =>
      !['high_confidence', 'needs_review', 'no_results'].includes(v.enrichment_status)
    )
  };

  console.log('Enriched venues by status:');
  console.log(`  high_confidence: ${byStatus.high_confidence.length}`);
  console.log(`  needs_review: ${byStatus.needs_review.length}`);
  console.log(`  no_results: ${byStatus.no_results.length}`);
  console.log(`  other/unknown: ${byStatus.other.length}\n`);

  // Count venues with website or social media added
  const withWebsite = enrichedSinceOct21.filter(v => v.website);
  const withSocial = enrichedSinceOct21.filter(v =>
    v.social_media_urls && v.social_media_urls.length > 0
  );

  console.log('Enriched venues with data:');
  console.log(`  With website: ${withWebsite.length}`);
  console.log(`  With social media: ${withSocial.length}\n`);

  // Sample recent enrichments
  console.log('=== RECENT ENRICHMENTS (Last 10) ===\n');
  const recentEnrichments = enrichedSinceOct21
    .sort((a, b) => b.enrichment_date.localeCompare(a.enrichment_date))
    .slice(0, 10);

  recentEnrichments.forEach((v, i) => {
    console.log(`${i + 1}. ${v.name}`);
    console.log(`   Enriched: ${v.enrichment_date}`);
    console.log(`   Status: ${v.enrichment_status}`);
    console.log(`   Website: ${v.website || 'none'}`);
    console.log(`   Social: ${v.social_media_urls ? v.social_media_urls.length + ' URLs' : 'none'}`);
    console.log('');
  });

  // Enrichments by date
  console.log('=== ENRICHMENTS BY DATE ===\n');
  const byDate = {};
  enrichedSinceOct21.forEach(v => {
    const date = v.enrichment_date.split('T')[0];
    byDate[date] = (byDate[date] || 0) + 1;
  });

  Object.keys(byDate).sort().forEach(date => {
    console.log(`${date}: ${byDate[date]} venues`);
  });

  console.log('\n');

  // Save list for re-enrichment
  const venuesForReEnrichment = enrichedSinceOct21.map(v => ({
    id: v.id,
    name: v.name,
    enrichment_date: v.enrichment_date,
    enrichment_status: v.enrichment_status,
    website: v.website,
    social_media_urls: v.social_media_urls
  }));

  require('fs').writeFileSync(
    'C:/tmp/venues-enriched-since-oct21.json',
    JSON.stringify(venuesForReEnrichment, null, 2)
  );

  console.log(`\nSaved ${venuesForReEnrichment.length} venues to C:/tmp/venues-enriched-since-oct21.json`);
  console.log('\nThese venues should be re-enriched to ensure data integrity.');
}

findVenuesSinceOct21().catch(console.error);
