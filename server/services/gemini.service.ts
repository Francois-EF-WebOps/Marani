/**
 * Gemini Text Processing Service
 * 
 * Handles text-only operations with Google Gemini:
 * - Cleaning and formatting transcripts
 * - Summarization
 * - Extracting key insights and hooks
 * 
 * IMPORTANT: This service ONLY processes text, never audio.
 * Audio transcription is handled by Whisper (transcription.service.ts)
 */

import { GoogleGenAI } from '@google/genai';

// Initialize Gemini client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface TextProcessingOptions {
  mode: 'transcribe' | 'translate';
  language?: string;
  includeSummary?: boolean;
  includeKeyPoints?: boolean;
  includeHooks?: boolean;
}

export interface ProcessedText {
  cleanedText: string;
  summary?: string;
  keyPoints?: string[];
  hooks?: string[];
  metadata: {
    originalLength: number;
    processedLength: number;
    processingTime: number;
  };
}

/**
 * Prompt for cleaning and formatting transcript text
 */
const CLEANUP_PROMPT = `You are a professional transcript editor. Clean and format the following transcript:

1. Fix any transcription errors based on context
2. Add proper punctuation and paragraph breaks
3. Remove filler words (um, uh, like) unless they add meaning
4. Fix capitalization
5. Keep the original meaning and tone intact

Provide ONLY the cleaned transcript, nothing else.`;

/**
 * Prompt for translation to English
 */
const TRANSLATE_PROMPT = `You are a professional translator. Translate the following text to English:

1. Maintain the original meaning and tone
2. Use natural, fluent English
3. Preserve any technical terms or proper nouns
4. Add paragraph breaks for readability

Provide ONLY the translated text, nothing else.`;

/**
 * Prompt for summarization
 */
const SUMMARY_PROMPT = `Summarize the following transcript in 2-3 concise paragraphs:

1. Capture the main message and key arguments
2. Include important context and conclusions
3. Keep it clear and engaging

Provide ONLY the summary, nothing else.`;

/**
 * Prompt for extracting key points
 */
const KEY_POINTS_PROMPT = `Extract the 5-10 most important key points from this transcript:

1. Each point should be a complete thought
2. Focus on actionable insights and main arguments
3. Order by importance

Format as a bulleted list.`;

/**
 * Prompt for extracting hooks (attention-grabbing quotes/lines)
 */
const HOOKS_PROMPT = `Extract 3-5 compelling "hooks" from this transcript - memorable quotes or lines that would grab attention:

1. Each hook should be 1-2 sentences
2. Choose impactful, quotable moments
3. Include variety (questions, bold statements, insights)

Format as a list.`;

/**
 * Process text with Gemini - clean, format, summarize
 */
export async function processText(
  transcript: string,
  options: TextProcessingOptions
): Promise<ProcessedText> {
  const startTime = Date.now();
  
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  
  // Determine the main processing prompt
  const mainPrompt = options.mode === 'translate' 
    ? TRANSLATE_PROMPT 
    : CLEANUP_PROMPT;
  
  // Build the content parts
  const parts = [
    { text: mainPrompt },
    { text: `\n\nTranscript to process:\n\n${transcript}` }
  ];
  
  // Generate cleaned/translated text
  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: { parts },
  });
  
  const cleanedText = response.text?.trim() || transcript;
  
  const result: ProcessedText = {
    cleanedText,
    metadata: {
      originalLength: transcript.length,
      processedLength: cleanedText.length,
      processingTime: Date.now() - startTime,
    },
  };
  
  // Process additional requests in parallel if requested
  const additionalPromises: Promise<void>[] = [];
  
  if (options.includeSummary) {
    additionalPromises.push(
      (async () => {
        try {
          const summaryResponse = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: { 
              parts: [
                { text: SUMMARY_PROMPT },
                { text: `\n\nTranscript:\n\n${cleanedText}` }
              ] 
            },
          });
          result.summary = summaryResponse.text?.trim();
        } catch (error) {
          console.error('Failed to generate summary:', error);
        }
      })()
    );
  }
  
  if (options.includeKeyPoints) {
    additionalPromises.push(
      (async () => {
        try {
          const pointsResponse = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: { 
              parts: [
                { text: KEY_POINTS_PROMPT },
                { text: `\n\nTranscript:\n\n${cleanedText}` }
              ] 
            },
          });
          // Parse bullet points from response
          const pointsText = pointsResponse.text?.trim() || '';
          result.keyPoints = pointsText
            .split('\n')
            .filter(line => line.trim().match(/^[-•*]|\d+\./))
            .map(line => line.replace(/^[-•*]|\d+\.\s*/, '').trim())
            .filter(line => line.length > 0);
        } catch (error) {
          console.error('Failed to extract key points:', error);
        }
      })()
    );
  }
  
  if (options.includeHooks) {
    additionalPromises.push(
      (async () => {
        try {
          const hooksResponse = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: { 
              parts: [
                { text: HOOKS_PROMPT },
                { text: `\n\nTranscript:\n\n${cleanedText}` }
              ] 
            },
          });
          const hooksText = hooksResponse.text?.trim() || '';
          result.hooks = hooksText
            .split('\n')
            .filter(line => line.trim().length > 0)
            .map(line => line.replace(/^[-•*]|\d+\.\s*/, '').trim())
            .filter(line => line.length > 10); // Minimum hook length
        } catch (error) {
          console.error('Failed to extract hooks:', error);
        }
      })()
    );
  }
  
  // Wait for all additional processing to complete
  await Promise.all(additionalPromises);
  
  // Update metadata
  result.metadata.processingTime = Date.now() - startTime;
  
  return result;
}

/**
 * Quick text cleanup without additional processing
 * Use for simple formatting needs
 */
export async function quickCleanText(text: string): Promise<string> {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: { 
        parts: [
          { text: CLEANUP_PROMPT },
          { text: `\n\nText:\n\n${text}` }
        ] 
      },
    });
    return response.text?.trim() || text;
  } catch (error) {
    console.error('Quick clean failed:', error);
    return text;
  }
}
