/**
 * =============================================================================
 * Router Service - Intelligent Mode Classification
 * =============================================================================
 * 
 * Purpose: Automatically route inputs to BATSY or FLASH mode
 * 
 * Routing Rules:
 * - Duration > 2 minutes → BATSY
 * - Duration ≤ 2 minutes → FLASH
 * - API rate limits hit → Fallback to BATSY
 * - User requests fast output → FLASH
 * - Default → BATSY (safer, more reliable)
 * 
 * The router makes decisions based on:
 * - Input characteristics (duration, size, type)
 * - System state (API health, rate limits)
 * - User preferences (speed vs cost)
 */

import { batsyTranscribe, checkBatsyHealth } from './batsy.service.js';
import { flashProcess, checkFlashHealth } from './flash.service.js';
import { normalizeOutput, type NormalizedOutput } from './normalize.service.js';

// =============================================================================
// Configuration
// =============================================================================

export const ROUTER_CONFIG = {
  // Duration threshold in seconds (120s = 2 minutes)
  durationThreshold: 120,
  
  // File size threshold in bytes (5MB)
  sizeThreshold: 5 * 1024 * 1024,
  
  // Rate limit recovery time in seconds
  rateLimitRecovery: 60,
  
  // Maximum consecutive API errors before fallback
  maxApiErrors: 3,
};

// =============================================================================
// Types
// =============================================================================

export type ProcessingMode = 'BATSY' | 'FLASH' | 'AUTO';

export type InputType = 'audio' | 'video' | 'text' | 'url';

export interface RoutingDecision {
  mode: ProcessingMode;
  reason: string;
  confidence: number; // 0-1
  estimatedTime: number; // seconds
  estimatedCost: number; // API calls
}

export interface ProcessOptions {
  mode?: ProcessingMode;
  language?: string;
  translate?: boolean;
  includeSummary?: boolean;
  includeKeyPoints?: boolean;
  includeHooks?: boolean;
  fastMode?: boolean;
  costSavingMode?: boolean;
}

export interface ProcessResult {
  mode: 'BATSY' | 'FLASH';
  transcript: string;
  clean_text: string;
  summary?: string;
  key_points?: string[];
  hooks?: string[];
  metadata: {
    duration?: number;
    chunks?: number;
    provider?: string;
    processingTime: number;
    model?: string;
  };
}

export interface RateLimitState {
  geminiErrors: number;
  whisperErrors: number;
  lastGeminiError: number;
  lastWhisperError: number;
  geminiBackoffUntil?: number;
  whisperBackoffUntil?: number;
}

// =============================================================================
// Rate Limit Tracking
// =============================================================================

const rateLimitState: RateLimitState = {
  geminiErrors: 0,
  whisperErrors: 0,
  lastGeminiError: 0,
  lastWhisperError: 0,
};

/**
 * Record an API error for rate limit tracking
 */
export function recordApiError(provider: 'gemini' | 'whisper'): void {
  const now = Date.now();
  
  if (provider === 'gemini') {
    rateLimitState.geminiErrors++;
    rateLimitState.lastGeminiError = now;
    // Backoff for 60 seconds after 3 errors
    if (rateLimitState.geminiErrors >= ROUTER_CONFIG.maxApiErrors) {
      rateLimitState.geminiBackoffUntil = now + ROUTER_CONFIG.rateLimitRecovery * 1000;
    }
  } else {
    rateLimitState.whisperErrors++;
    rateLimitState.lastWhisperError = now;
    if (rateLimitState.whisperErrors >= ROUTER_CONFIG.maxApiErrors) {
      rateLimitState.whisperBackoffUntil = now + ROUTER_CONFIG.rateLimitRecovery * 1000;
    }
  }
  
  console.log(`Rate limit: ${provider} errors = ${provider === 'gemini' ? rateLimitState.geminiErrors : rateLimitState.whisperErrors}`);
}

/**
 * Record a successful API call (resets error count)
 */
export function recordApiSuccess(provider: 'gemini' | 'whisper'): void {
  if (provider === 'gemini') {
    rateLimitState.geminiErrors = Math.max(0, rateLimitState.geminiErrors - 1);
  } else {
    rateLimitState.whisperErrors = Math.max(0, rateLimitState.whisperErrors - 1);
  }
}

/**
 * Check if provider is in backoff period
 */
function isInBackoff(provider: 'gemini' | 'whisper'): boolean {
  const now = Date.now();
  const backoffUntil = provider === 'gemini' 
    ? rateLimitState.geminiBackoffUntil 
    : rateLimitState.whisperBackoffUntil;
  
  return backoffUntil !== undefined && now < backoffUntil;
}

// =============================================================================
// Input Analysis
// =============================================================================

/**
 * Analyze input to determine characteristics
 */
function analyzeInput(
  data: Buffer | string,
  inputType: InputType
): {
  duration: number;
  size: number;
  isText: boolean;
} {
  const isText = inputType === 'text';
  
  if (isText) {
    const text = data as string;
    // Estimate "duration" based on word count
    // Average speaking rate: 150 words/minute
    const wordCount = text.split(/\s+/).length;
    const estimatedDuration = (wordCount / 150) * 60;
    
    return {
      duration: estimatedDuration,
      size: text.length,
      isText: true,
    };
  }
  
  // Audio/video buffer
  const buffer = data as Buffer;
  // Estimate duration: ~16KB/s at 128kbps
  const estimatedDuration = buffer.length / (16 * 1024);
  
  return {
    duration: estimatedDuration,
    size: buffer.length,
    isText: false,
  };
}

// =============================================================================
// Routing Logic
// =============================================================================

/**
 * Make routing decision based on input and system state
 */
export function decideMode(
  data: Buffer | string,
  inputType: InputType,
  options: ProcessOptions
): RoutingDecision {
  const analysis = analyzeInput(data, inputType);
  const durationMinutes = analysis.duration / 60;
  
  // Check for explicit user preference
  if (options.fastMode) {
    return {
      mode: 'FLASH',
      reason: 'User requested fast mode',
      confidence: 0.9,
      estimatedTime: Math.min(30, analysis.duration * 0.5),
      estimatedCost: 4, // Multiple Gemini calls
    };
  }
  
  if (options.costSavingMode) {
    return {
      mode: 'BATSY',
      reason: 'User requested cost saving mode',
      confidence: 0.95,
      estimatedTime: analysis.duration * 1.5,
      estimatedCost: 1, // Single Whisper call (cheaper)
    };
  }
  
  // Text input always goes to FLASH (already transcribed)
  if (analysis.isText) {
    // Check if Gemini is available
    if (!checkFlashHealth()) {
      return {
        mode: 'BATSY',
        reason: 'Text input but Gemini unavailable',
        confidence: 0.5,
        estimatedTime: 10,
        estimatedCost: 0,
      };
    }
    
    return {
      mode: 'FLASH',
      reason: `Text input (${Math.round(analysis.size)} chars)`,
      confidence: 1.0,
      estimatedTime: Math.min(20, analysis.duration * 0.3),
      estimatedCost: options.includeSummary && options.includeKeyPoints ? 4 : 1,
    };
  }
  
  // Check rate limit status
  if (isInBackoff('gemini')) {
    return {
      mode: 'BATSY',
      reason: 'Gemini API in backoff period',
      confidence: 0.8,
      estimatedTime: analysis.duration * 1.5,
      estimatedCost: 1,
    };
  }
  
  // Duration-based routing
  if (analysis.duration > ROUTER_CONFIG.durationThreshold) {
    // Long content → BATSY
    return {
      mode: 'BATSY',
      reason: `Long content (${Math.round(durationMinutes)} min > 2 min threshold)`,
      confidence: 0.95,
      estimatedTime: analysis.duration * 1.2,
      estimatedCost: 1,
    };
  }
  
  if (analysis.duration <= 30) {
    // Very short content → FLASH (fast response)
    return {
      mode: 'FLASH',
      reason: `Short content (${Math.round(analysis.duration)}s ≤ 30s)`,
      confidence: 0.85,
      estimatedTime: analysis.duration * 0.5,
      estimatedCost: 4,
    };
  }
  
  // Medium content (30s - 2min) → Default to BATSY for reliability
  return {
    mode: 'BATSY',
    reason: `Medium content (${Math.round(analysis.duration)}s) - default for reliability`,
    confidence: 0.7,
    estimatedTime: analysis.duration * 1.2,
    estimatedCost: 1,
  };
}

// =============================================================================
// Main Processing Pipeline
// =============================================================================

/**
 * Process input through the routing pipeline
 * 
 * Flow:
 * 1. Analyze input
 * 2. Make routing decision
 * 3. Execute appropriate mode
 * 4. Normalize output
 * 5. Return unified result
 */
export async function routeAndProcess(
  data: Buffer | string,
  inputType: InputType,
  options: ProcessOptions = {}
): Promise<NormalizedOutput> {
  const startTime = Date.now();
  
  // Make routing decision
  const decision = decideMode(data, inputType, options);
  
  console.log('╔════════════════════════════════════════╗');
  console.log('║         ROUTER DECISION                ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║ Mode:       ${decision.mode.padEnd(26)} ║`);
  console.log(`║ Reason:     ${decision.reason.substring(0, 26).padEnd(26)} ║`);
  console.log(`║ Confidence: ${(decision.confidence * 100).toFixed(0).padEnd(25)}% ║`);
  console.log('╚════════════════════════════════════════╝');

  try {
    if (decision.mode === 'FLASH') {
      // FLASH mode - text processing only
      if (!checkFlashHealth()) {
        throw new Error('FLASH mode requires GEMINI_API_KEY');
      }
      
      // If input is audio, we need to transcribe first (quick)
      let text: string;
      if (inputType === 'text') {
        text = data as string;
      } else {
        // Short audio - use quick Whisper transcription
        console.log('FLASH: Quick transcribing short audio...');
        const { batsyTranscribe } = await import('./batsy.service.js');
        const transcribed = await batsyTranscribe(
          data as Buffer,
          'short_audio.wav',
          { 
            language: options.language,
            translate: options.translate,
            fastMode: true,
          }
        );
        text = transcribed.text;
        recordApiSuccess('whisper');
      }
      
      // Process with FLASH
      const flashResult = await flashProcess(text, {
        mode: options.translate ? 'translate' : 'transcribe',
        language: options.language,
        includeSummary: options.includeSummary,
        includeKeyPoints: options.includeKeyPoints,
        includeHooks: options.includeHooks,
      });
      
      recordApiSuccess('gemini');

      // Return normalized FLASH result
      return normalizeOutput({
        mode: 'FLASH',
        transcript: flashResult.transcript,
        clean_text: flashResult.clean_text,
        summary: flashResult.summary,
        key_points: flashResult.key_points,
        hooks: flashResult.hooks,
        metadata: {
          processingTime: Date.now() - startTime,
          model: flashResult.metadata.model,
        },
      });
    } else {
      // BATSY mode - full transcription pipeline
      const batsyResult = await batsyTranscribe(
        data as Buffer,
        'audio_input.wav',
        {
          language: options.language,
          translate: options.translate,
        }
      );

      recordApiSuccess('whisper');

      // Post-process with FLASH (if available)
      let cleanText = batsyResult.text;
      let summary: string | undefined;
      let keyPoints: string[] | undefined;
      let hooks: string[] | undefined;

      if (checkFlashHealth() && options.includeSummary) {
        try {
          const flashResult = await flashProcess(batsyResult.text, {
            mode: 'clean',
            includeSummary: options.includeSummary,
            includeKeyPoints: options.includeKeyPoints,
            includeHooks: options.includeHooks,
          });

          cleanText = flashResult.clean_text;
          summary = flashResult.summary;
          keyPoints = flashResult.key_points;
          hooks = flashResult.hooks;

          recordApiSuccess('gemini');
        } catch (error) {
          console.error('BATSY post-process failed:', error);
          recordApiError('gemini');
        }
      }

      // Return normalized BATSY result
      return normalizeOutput({
        mode: 'BATSY',
        transcript: batsyResult.text,
        clean_text: cleanText,
        summary,
        key_points: keyPoints,
        hooks,
        metadata: {
          duration: batsyResult.duration,
          chunks: batsyResult.totalChunks,
          provider: batsyResult.provider,
          processingTime: Date.now() - startTime,
        },
      });
    }
    
  } catch (error: any) {
    console.error('Router processing error:', error);
    
    // Record error for rate limiting
    if (error.message.includes('GEMINI')) {
      recordApiError('gemini');
    } else if (error.message.includes('Whisper') || error.message.includes('OPENAI')) {
      recordApiError('whisper');
    }
    
    throw error;
  }
}

// =============================================================================
// Health Check
// =============================================================================

export function getRouterHealth(): {
  mode: 'healthy' | 'degraded' | 'limited';
  batSYAvailable: boolean;
  flashAvailable: boolean;
  recommendations: string[];
} {
  const batSYHealth = checkBatsyHealth();
  const flashHealth = checkFlashHealth();
  
  const batSYAvailable = batSYHealth.whisper || batSYHealth.huggingFace;
  const flashAvailable = flashHealth;
  
  const recommendations: string[] = [];
  
  if (!batSYAvailable && !flashAvailable) {
    recommendations.push('No transcription providers available. Configure API keys.');
  } else if (!flashAvailable) {
    recommendations.push('FLASH mode unavailable. Add GEMINI_API_KEY for text processing.');
  } else if (!batSYAvailable) {
    recommendations.push('BATSY mode unavailable. Add OPENAI_API_KEY or HUGGINGFACE_TOKEN.');
  }
  
  return {
    mode: batSYAvailable && flashAvailable ? 'healthy' : 'degraded',
    batSYAvailable,
    flashAvailable,
    recommendations,
  };
}
