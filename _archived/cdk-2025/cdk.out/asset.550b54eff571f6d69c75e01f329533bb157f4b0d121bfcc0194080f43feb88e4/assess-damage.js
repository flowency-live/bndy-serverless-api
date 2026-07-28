const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

async function assessDamage() {
  console.log('Scanning bndy-venues for AI-created and enriched venues...\n');

  const params = {
    TableName: 'bndy-venues'
  };

  const result = await dynamodb.scan(params).promise();
  const venues = result.Items;

  console.log(`Total venues in database: ${venues.length}\n`);

  // Categorize venues
  const aiCreated = venues.filter(v => v.ai_created === true);
  const hasEnrichmentStatus = venues.filter(v => v.enrichment_status);
  const hasEnrichmentData = venues.filter(v => v.enrichment_data);
  const highConfidence = venues.filter(v => v.enrichment_status === 'high_confidence');
  const needsReview = venues.filter(v => v.enrichment_status === 'needs_review');

  console.log('=== DAMAGE ASSESSMENT ===\n');
  console.log(`AI Created venues: ${aiCreated.length}`);
  console.log(`Venues with enrichment_status: ${hasEnrichmentStatus.length}`);
  console.log(`  - high_confidence: ${highConfidence.length}`);
  console.log(`  - needs_review: ${needsReview.length}`);
  console.log(`Venues with enrichment_data: ${hasEnrichmentData.length}\n`);

  // Find venues with social media or website that were enriched
  const enrichedWithWebsite = venues.filter(v =>
    v.enrichment_status && v.website
  );
  const enrichedWithSocial = venues.filter(v =>
    v.enrichment_status && v.social_media_urls && v.social_media_urls.length > 0
  );

  console.log(`Enriched venues with website: ${enrichedWithWebsite.length}`);
  console.log(`Enriched venues with social media: ${enrichedWithSocial.length}\n`);

  // Sample some HIGH confidence venues to see what URLs were added
  console.log('=== SAMPLE HIGH CONFIDENCE ENRICHMENTS ===\n');
  highConfidence.slice(0, 10).forEach((v, i) => {
    console.log(`${i+1}. ${v.name}`);
    console.log(`   Website: ${v.website || 'none'}`);
    console.log(`   Social: ${JSON.stringify(v.social_media_urls || [])}`);
    console.log(`   Enriched: ${v.enrichment_date || 'unknown'}\n`);
  });

  // Output venues to clear
  const venuesToClear = {
    aiCreated: aiCreated.map(v => ({ id: v.id, name: v.name })),
    enrichedHighConfidence: highConfidence.map(v => ({
      id: v.id,
      name: v.name,
      website: v.website,
      social: v.social_media_urls
    }))
  };

  console.log('\n=== VENUES TO CLEAR ===');
  console.log(`AI Created (will clear website + social): ${aiCreated.length}`);
  console.log(`High Confidence Enriched (will clear website + social): ${highConfidence.length}`);

  const allAffected = new Set([
    ...aiCreated.map(v => v.id),
    ...highConfidence.map(v => v.id)
  ]);
  console.log(`Total unique venues affected: ${allAffected.size}`);

  // Write to file for clearing script
  require('fs').writeFileSync('C:/tmp/venues-to-clear.json', JSON.stringify(venuesToClear, null, 2));
  console.log('\nWrote venue list to C:/tmp/venues-to-clear.json');
}

assessDamage().catch(console.error);
