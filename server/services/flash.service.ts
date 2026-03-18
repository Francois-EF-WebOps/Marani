/**
 * =============================================================================
 * FLASH Service - "Wily Mode" Text Processing
 * =============================================================================
 * 
 * Purpose: Fast, intelligent processing of light inputs
 * 
 * Features:
 * - Text cleaning and formatting
 * - Summarization
 * - Key insights extraction
 * - Hook generation (viral quotes)
 * 
 * NEVER processes raw audio/video.
 * Only works with already-transcribed text.
 * Optimized for speed and minimal API usage.
 */

import { GoogleGenAI, type Content } from '@google/genai';

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  // Model to use (gemini-2.0-flash is fast and cheap)
  model: 'gemini-2.0-flash',
  
  // Maximum text length per request (tokens approximation)
  maxTextLength: 100000,
  
  // Timeout for API calls
  timeout: 30000,
};

// =============================================================================
// Types
// =============================================================================

export interface FlashOptions {
  mode: 'transcribe' | 'translate' | 'clean' | 'summarize';
  language?: string;
  includeSummary?: boolean;
  includeKeyPoints?: boolean;
  includeHooks?: boolean;
  includeTimestamps?: boolean;
  tone?: 'professional' | 'casual' | 'engaging';
}

export interface FlashResult {
  transcript: string;
  clean_text: string;
  summary?: string;
  key_points?: string[];
  hooks?: string[];
  metadata: {
    originalLength: number;
    processedLength: number;
    processingTime: number;
    model: string;
    mode: string;
  };
}

// =============================================================================
// Prompts
// =============================================================================

const PROMPTS = {
  clean: `You are a professional transcript editor. Clean and format the following text:

1. Fix any errors based on context
2. Add proper punctuation and paragraph breaks
3. Remove filler words (um, uh, like) unless they add meaning
4. Fix capitalization
5. Maintain the original meaning and tone
6. Keep speaker distinctions if present

Provide ONLY the cleaned text, nothing else.`,

  translate: `You are a professional translator. Translate the following text to English:

1. Maintain the original meaning and tone
2. Use natural, fluent English
3. Preserve technical terms and proper nouns
4. Add paragraph breaks for readability
5. Keep any speaker distinctions

Provide ONLY the translated text, nothing else.`,

  summarize: `Summarize the following transcript in 2-3 concise paragraphs:

1. Capture the main message and key arguments
2. Include important context and conclusions
3. Keep it clear and engaging
4. Focus on what matters most

Provide ONLY the summary, nothing else.`,

  keyPoints: `Extract the 5-10 most important key points from this transcript:

1. Each point should be a complete, standalone thought
2. Focus on actionable insights and main arguments
3. Order by importance (most important first)
4. Be specific, not vague

Format as a bulleted list with "-" prefix.`,

  hooks: `Extract 3-5 compelling "hooks" from this transcript - memorable quotes that would grab attention:

1. Each hook should be 1-2 sentences maximum
2. Choose impactful, quotable moments
3. Include variety (questions, bold statements, insights)
4. These will be used as social media teasers

Format as a list with "-" prefix.`,
};

// =============================================================================
// Gemini Client
// =============================================================================

let aiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured');
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

// =============================================================================
// Processing Functions
// =============================================================================

/**
 * Send text to Gemini for processing
 */
async function processWithGemini(
  prompt: string,
  text: string
): Promise<string> {
  const client = getGeminiClient();
  
  const contents: Content = {
    parts: [
      { text: prompt },
      { text: `\n\nText to process:\n\n${text.slice(0, CONFIG.maxTextLength)}` }
    ]
  };
  
  const response = await client.models.generateContent({
    model: CONFIG.model,
    contents,
  });
  
  return response.text?.trim() || '';
}

/**
 * Process text with multiple Gemini calls in parallel where possible
 */
async function processText(
  text: string,
  options: FlashOptions
): Promise<FlashResult> {
  const startTime = Date.now();
  const originalLength = text.length;
  
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required for FLASH mode');
  }
  
  // Determine main processing based on mode
  let cleanText: string;
  
  switch (options.mode) {
    case 'translate':
      cleanText = await processWithGemini(PROMPTS.translate, text);
      break;
    case 'clean':
      cleanText = await processWithGemini(PROMPTS.clean, text);
      break;
    case 'summarize':
      // For summarize-only, skip cleaning
      cleanText = text;
      break;
    case 'transcribe':
    default:
      cleanText = await processWithGemini(PROMPTS.clean, text);
      break;
  }
  
  // Build result
  const result: FlashResult = {
    transcript: text,
    clean_text: cleanText,
    metadata: {
      originalLength,
      processedLength: cleanText.length,
      processingTime: Date.now() - startTime,
      model: CONFIG.model,
      mode: options.mode,
    },
  };
  
  // Process additional requests in parallel
  const additionalPromises: Promise<void>[] = [];
  
  if (options.includeSummary) {
    additionalPromises.push(
      (async () => {
        try {
          result.summary = await processWithGemini(PROMPTS.summarize, cleanText);
        } catch (error) {
          console.error('FLASH summary failed:', error);
          result.summary = '[Summary generation failed]';
        }
      })()
    );
  }
  
  if (options.includeKeyPoints) {
    additionalPromises.push(
      (async () => {
        try {
          const pointsText = await processWithGemini(PROMPTS.keyPoints, cleanText);
          result.key_points = parseBulletPoints(pointsText);
        } catch (error) {
          console.error('FLASH key points failed:', error);
          result.key_points = [];
        }
      })()
    );
  }

  if (options.includeHooks) {
    additionalPromises.push(
      (async () => {
        try {
          const hooksText = await processWithGemini(PROMPTS.hooks, cleanText);
          result.hooks = parseBulletPoints(hooksText);
        } catch (error) {
          console.error('FLASH hooks failed:', error);
          result.hooks = [];
        }
      })()
    );
  }
  
  // Wait for all additional processing
  await Promise.all(additionalPromises);
  
  // Update processing time
  result.metadata.processingTime = Date.now() - startTime;
  
  return result;
}

/**
 * Parse bullet points from Gemini response
 */
function parseBulletPoints(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.match(/^[-•*]|\d+\./))
    .map(line => line.replace(/^[-•*]|\d+\.\s*/, '').trim())
    .filter(line => line.length > 0);
}

// =============================================================================
// Quick Processing (Single Call)
// =============================================================================

/**
 * Ultra-fast processing with single API call
 * Returns only cleaned text, no extras
 */
export async function flashQuickClean(text: string): Promise<string> {
  try {
    return await processWithGemini(PROMPTS.clean, text);
  } catch (error) {
    console.error('Quick clean failed:', error);
    return text;
  }
}

/**
 * Quick summary only
 */
export async function flashQuickSummary(text: string): Promise<string> {
  try {
    return await processWithGemini(PROMPTS.summarize, text);
  } catch (error) {
    console.error('Quick summary failed:', error);
    return '[Summary unavailable]';
  }
}

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * FLASH Main Entry Point
 * 
 * @param text - Already transcribed text (NOT audio)
 * @param options - Processing options
 */
export async function flashProcess(
  text: string,
  options: FlashOptions
): Promise<FlashResult> {
  if (!text || text.trim().length === 0) {
    throw new Error('Empty text provided to FLASH');
  }
  
  console.log(`FLASH: Processing ${text.length} characters`);
  console.log(`  Mode: ${options.mode}`);
  console.log(`  Options: summary=${options.includeSummary}, points=${options.includeKeyPoints}, hooks=${options.includeHooks}`);
  
  return processText(text, options);
}

/**
 * Check FLASH service health
 */
export function checkFlashHealth(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

/**
 * Estimate processing cost (in API calls)
 */
export function estimateFlashCost(textLength: number, options: FlashOptions): number {
  let calls = 1; // Base cleaning/translating call
  
  if (options.includeSummary) calls++;
  if (options.includeKeyPoints) calls++;
  if (options.includeHooks) calls++;
  
  return calls;
}
