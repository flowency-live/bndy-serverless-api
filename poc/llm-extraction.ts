import OpenAI from 'openai';
import { ExtractSchema, ExtractedEvent } from './schemas.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Extract events from raw HTML using LLM
 * LLM RESPONSIBILITY: EXTRACTION ONLY (not matching or decisions)
 */
export async function extractEventsWithLLM(rawHtml: string): Promise<ExtractedEvent[]> {
  // Strip boilerplate HTML
  const text = htmlToVisibleText(rawHtml);

  // Clamp input length (prevent excessive token usage)
  const clampedText = text.slice(0, 50000); // ~12k tokens max

  const prompt = `
Extract gig events from this webpage. Return ONLY valid JSON.

STRICT RULES:
- venueName: Include city if mentioned (e.g., "Queens Hotel Macclesfield")
- artistName: Band/artist name only
- date: YYYY-MM-DD format (parse relative dates like "this Saturday")
- time: HH:mm format, omit if not specified (we default to 20:00 later)
- facebookUrl: Only if explicitly mentioned
- notes: Ticket price, entry info, etc.
- Maximum 200 events

JSON Schema:
{
  "events": [
    {
      "venueName": "string",
      "artistName": "string",
      "date": "YYYY-MM-DD",
      "time": "HH:mm" (optional),
      "facebookUrl": "https://..." (optional),
      "notes": "string" (optional)
    }
  ]
}

Text:
${clampedText}
`;

  console.log('Calling OpenAI for extraction...');
  console.log(`Input length: ${clampedText.length} chars`);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0 // Deterministic
  });

  const content = response.choices[0].message.content || '{}';
  const parsed = JSON.parse(content);

  console.log(`Raw LLM response parsed, validating with Zod...`);

  // Validate strictly (throws if invalid)
  const validated = ExtractSchema.parse(parsed);

  console.log(`Validation successful: ${validated.events.length} events extracted`);

  return validated.events;
}

/**
 * Convert HTML to visible text (remove scripts, styles, tags)
 */
function htmlToVisibleText(html: string): string {
  return html
    .replace(/<script[^>]*>.*?<\/script>/gis, '') // Remove scripts
    .replace(/<style[^>]*>.*?<\/style>/gis, '')   // Remove styles
    .replace(/<[^>]+>/g, ' ')                      // Remove tags
    .replace(/\s+/g, ' ')                          // Collapse whitespace
    .trim();
}
