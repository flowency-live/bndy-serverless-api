#!/usr/bin/env node

import 'dotenv/config';
import axios from 'axios';
import { extractEventsWithLLM } from './llm-extraction.js';
import { resolveVenue } from './venue-resolution.js';
import { resolveArtist } from './artist-resolution.js';

/**
 * WEEK 1 POC: Extract and Resolve Events
 *
 * Tests the agentic event ingestion pipeline locally:
 * 1. Fetch HTML from gigs-news.uk
 * 2. Extract events with LLM
 * 3. Resolve venues using deterministic scoring
 * 4. Measure accuracy
 */

async function main() {
  console.log('=== BNDY AGENTIC INGESTION POC ===\n');

  // Validate environment variables
  if (!process.env.OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY not set in .env file');
    process.exit(1);
  }

  if (!process.env.GOOGLE_PLACES_API_KEY) {
    console.warn('WARNING: GOOGLE_PLACES_API_KEY not set - venue resolution will fail');
  }

  // Step 1: Load HTML from local file
  const sourceFile = 'DataSource_Examples/gig-news.html';
  const locationContext = 'Greater Manchester, UK';

  console.log(`Loading HTML from: ${sourceFile}`);
  const rawHtml = await loadLocalFile(sourceFile);
  console.log(`Loaded ${rawHtml.length} characters of HTML\n`);

  // Step 2: Extract events with LLM
  console.log('=== STEP 1: LLM EXTRACTION ===');
  const events = await extractEventsWithLLM(rawHtml);
  console.log(`\nExtracted ${events.length} events\n`);

  // Display first few events
  console.log('First 5 extracted events:');
  events.slice(0, 5).forEach((event, i) => {
    console.log(`${i + 1}. ${event.artistName} @ ${event.venueName} on ${event.date}`);
  });
  console.log('');

  // Step 3: Resolve venues (test first 10 only for POC)
  console.log('\n=== STEP 2: VENUE RESOLUTION ===');
  console.log('Testing with first 10 events...\n');

  const testEvents = events.slice(0, 10);
  const results = [];

  for (let i = 0; i < testEvents.length; i++) {
    const event = testEvents[i];
    console.log(`\n[${i + 1}/${testEvents.length}] Processing: ${event.venueName}`);

    try {
      const venueResolution = await resolveVenue(event.venueName, locationContext);
      console.log(`Venue Result: ${venueResolution.action} (confidence: ${venueResolution.confidence})`);

      // Resolve artist using venue location
      const venueLocation = venueResolution.location || { lat: 53.48, lng: -2.24 }; // Fallback to Manchester center
      const artistResolution = await resolveArtist(event.artistName, venueLocation);
      console.log(`Artist Result: ${artistResolution.action} (confidence: ${artistResolution.confidence})`);

      results.push({
        venueName: event.venueName,
        artistName: event.artistName,
        date: event.date,
        venueResolution,
        artistResolution
      });
    } catch (error) {
      console.error(`Error resolving event: ${error}`);
      results.push({
        venueName: event.venueName,
        artistName: event.artistName,
        date: event.date,
        venueResolution: {
          action: 'REVIEW' as const,
          confidence: 0,
          reasons: ['error']
        },
        artistResolution: {
          action: 'REVIEW' as const,
          confidence: 0,
          reasons: ['error']
        }
      });
    }

    // Rate limiting: Wait 200ms between requests
    if (i < testEvents.length - 1) {
      await sleep(200);
    }
  }

  // Step 4: Summary statistics
  console.log('\n\n=== VENUE SUMMARY ===');
  const venueMatched = results.filter(r => r.venueResolution.action === 'MATCH_EXISTING').length;
  const venueCreate = results.filter(r => r.venueResolution.action === 'CREATE_NEW').length;
  const venueReview = results.filter(r => r.venueResolution.action === 'REVIEW').length;

  console.log(`Total tested: ${results.length}`);
  console.log(`MATCH_EXISTING: ${venueMatched} (${Math.round(venueMatched / results.length * 100)}%)`);
  console.log(`CREATE_NEW: ${venueCreate} (${Math.round(venueCreate / results.length * 100)}%)`);
  console.log(`REVIEW: ${venueReview} (${Math.round(venueReview / results.length * 100)}%)`);

  console.log('\n=== ARTIST SUMMARY ===');
  const artistMatched = results.filter(r => r.artistResolution.action === 'MATCH_EXISTING').length;
  const artistCreate = results.filter(r => r.artistResolution.action === 'CREATE_NEW').length;
  const artistReview = results.filter(r => r.artistResolution.action === 'REVIEW').length;

  console.log(`Total tested: ${results.length}`);
  console.log(`MATCH_EXISTING: ${artistMatched} (${Math.round(artistMatched / results.length * 100)}%)`);
  console.log(`CREATE_NEW: ${artistCreate} (${Math.round(artistCreate / results.length * 100)}%)`);
  console.log(`REVIEW: ${artistReview} (${Math.round(artistReview / results.length * 100)}%)`);

  // Auto-approval rate (BOTH venue AND artist matched with high confidence)
  const fullyAutoApproved = results.filter(r =>
    r.venueResolution.action === 'MATCH_EXISTING' && r.venueResolution.confidence >= 0.8 &&
    r.artistResolution.action === 'MATCH_EXISTING' && r.artistResolution.confidence >= 0.9
  ).length;

  console.log(`\n=== OVERALL AUTO-APPROVAL RATE ===`);
  console.log(`Both venue AND artist matched: ${fullyAutoApproved}/${results.length} (${Math.round(fullyAutoApproved / results.length * 100)}%)`);
  console.log(`\nNOTE: Events can only be auto-created when BOTH venue and artist are high-confidence matches`);

  // Write results to file for review
  const outputFile = 'poc-results.json';
  await writeResultsToFile(outputFile, results);
  console.log(`\nResults written to: ${outputFile}`);
  console.log('Review this file to verify match accuracy');
}

/**
 * Load HTML from local file
 */
async function loadLocalFile(filepath: string): Promise<string> {
  const fs = await import('fs/promises');
  return await fs.readFile(filepath, 'utf-8');
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Write results to JSON file
 */
async function writeResultsToFile(filename: string, results: any[]): Promise<void> {
  const fs = await import('fs/promises');
  await fs.writeFile(filename, JSON.stringify(results, null, 2));
}

// Run the POC
main().catch(error => {
  console.error('POC failed:', error);
  process.exit(1);
});
