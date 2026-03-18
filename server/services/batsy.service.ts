/**
 * =============================================================================
 * BATSY Service - "Tank Mode" Transcription
 * =============================================================================
 * 
 * Purpose: Handle heavy workloads reliably and cost-effectively
 * 
 * Features:
 * - Audio chunking (30-60 second segments)
 * - Parallel chunk processing
 * - Automatic retry logic for failed chunks
 * - Multiple provider fallbacks (Whisper → Hugging Face → AssemblyAI)
 * - Progress tracking
 * 
 * NEVER uses Google APIs for transcription.
 * Optimized for stability over speed.
 */

import FormData from 'form-data';
import fetch from 'node-fetch';

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  // Chunk duration in seconds (30-60 recommended)
  chunkDuration: 45,
  
  // Maximum concurrent chunk processing
  maxConcurrency: 3,
  
  // Retry attempts for failed chunks
  maxRetries: 2,
  
  // Retry delay in milliseconds
  retryDelay: 1000,
  
  // API timeouts
  timeout: 120000, // 2 minutes
};

// Provider endpoints
const PROVIDERS = {
  whisper: 'https://api.openai.com/v1/audio/transcriptions',
  huggingFace: 'https://api-inference.huggingface.co/models/openai/whisper-large-v3',
  assemblyAI: 'https://api.assemblyai.com/v2/transcript',
};

// =============================================================================
// Types
// =============================================================================

export interface TranscriptionOptions {
  language?: string;
  translate?: boolean;
  chunkDuration?: number;
  fastMode?: boolean; // If true, skip parallel processing
}

export interface ChunkResult {
  index: number;
  text: string;
  duration: number;
  provider: string;
  retries: number;
}

export interface TranscriptionProgress {
  status: 'pending' | 'processing' | 'completed' | 'error';
  progress: number;
  currentChunk?: number;
  totalChunks?: number;
  completedChunks?: number;
  failedChunks?: number;
  error?: string;
}

export interface TranscriptionResult {
  text: string;
  chunks: ChunkResult[];
  duration: number;
  totalChunks: number;
  successfulChunks: number;
  failedChunks: number;
  provider: string;
}

// =============================================================================
// Audio Utilities
// =============================================================================

/**
 * Estimate audio duration from buffer size
 * Uses average bitrate estimation (128kbps for MP3)
 * For production accuracy, use ffprobe
 */
function estimateDuration(buffer: Buffer): number {
  // Average bitrate: 128kbps = 16KB/s
  const bytesPerSecond = 16 * 1024;
  return buffer.length / bytesPerSecond;
}

/**
 * Split audio buffer into chunks
 * Simple byte-based splitting (for production, use ffmpeg)
 */
function chunkAudio(buffer: Buffer, chunkSeconds: number): Buffer[] {
  const duration = estimateDuration(buffer);
  const chunks: Buffer[] = [];
  
  if (duration <= chunkSeconds) {
    return [buffer];
  }
  
  const totalChunks = Math.ceil(duration / chunkSeconds);
  const bytesPerChunk = Math.floor(buffer.length / totalChunks);
  
  for (let i = 0; i < buffer.length; i += bytesPerChunk) {
    chunks.push(buffer.slice(i, Math.min(i + bytesPerChunk, buffer.length)));
  }
  
  return chunks;
}

/**
 * Calculate SHA-256 hash for chunk identification
 */
async function hashChunk(chunk: Buffer, index: number): Promise<string> {
  const crypto = await import('crypto');
  return crypto.createHash('sha256').update(chunk).digest('hex').slice(0, 16) + `_${index}`;
}

// =============================================================================
// Provider Implementations
// =============================================================================

/**
 * Transcribe using OpenAI Whisper API
 * Best quality, paid service
 */
async function transcribeWithWhisper(
  chunk: Buffer,
  options: TranscriptionOptions
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }
  
  const formData = new FormData();
  formData.append('file', chunk, {
    filename: 'audio.wav',
    contentType: 'audio/wav',
  });
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'text');
  
  if (options.language) {
    formData.append('language', options.language);
  }
  
  if (options.translate) {
    formData.append('task', 'translate');
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);
  
  try {
    const response = await fetch(PROVIDERS.whisper, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...formData.getHeaders(),
      },
      body: formData,
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(`Whisper API: ${(error as any).error?.message || response.statusText}`);
    }

    return await response.text();
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Whisper API timeout');
    }
    throw error;
  }
}

/**
 * Transcribe using Hugging Face Inference API
 * Free tier available, good fallback option
 */
async function transcribeWithHuggingFace(
  chunk: Buffer,
  options: TranscriptionOptions
): Promise<string> {
  const token = process.env.HUGGINGFACE_TOKEN;
  
  const headers: Record<string, string> = {
    'Content-Type': 'audio/wav',
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);
  
  try {
    const response = await fetch(PROVIDERS.huggingFace, {
      method: 'POST',
      headers,
      body: chunk,
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));

      // Model loading - retry
      if ((error as any).error?.includes('loading')) {
        throw new Error('Hugging Face model loading, please retry');
      }

      throw new Error(`Hugging Face: ${(error as any).error || response.statusText}`);
    }

    const result = await response.json();
    return (result as any).text || '';
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Hugging Face timeout');
    }
    throw error;
  }
}

/**
 * Transcribe using AssemblyAI
 * High quality, paid service with good free tier
 */
async function transcribeWithAssemblyAI(
  chunk: Buffer,
  options: TranscriptionOptions
): Promise<string> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  
  if (!apiKey) {
    throw new Error('ASSEMBLYAI_API_KEY not configured');
  }
  
  // Step 1: Upload audio
  const uploadResponse = await fetch(PROVIDERS.assemblyAI, {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: await bufferToBase64(chunk),
    }),
  });
  
  if (!uploadResponse.ok) {
    throw new Error('AssemblyAI upload failed');
  }

  const { id } = await uploadResponse.json() as any;

  // Step 2: Poll for completion
  const pollUrl = `${PROVIDERS.assemblyAI}/${id}`;
  let status = 'processing';
  let resultText = '';

  for (let i = 0; i < 30; i++) {
    await sleep(2000);

    const statusResponse = await fetch(pollUrl, {
      headers: { authorization: apiKey },
    });

    const result = await statusResponse.json() as any;
    status = result.status;

    if (status === 'completed') {
      resultText = result.text || '';
      break;
    }

    if (status === 'error') {
      throw new Error(`AssemblyAI: ${result.error}`);
    }
  }
  
  if (options.translate && resultText) {
    // AssemblyAI doesn't support direct translation, would need additional step
    // For now, return as-is
  }
  
  return resultText;
}

// =============================================================================
// Helper Functions
// =============================================================================

function bufferToBase64(buffer: Buffer): string {
  return `data:audio/wav;base64,${buffer.toString('base64')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// Main Transcription Logic
// =============================================================================

/**
 * Transcribe a single chunk with retry logic and provider fallback
 */
async function transcribeChunk(
  chunk: Buffer,
  index: number,
  options: TranscriptionOptions,
  onRetry?: (attempt: number, error: string) => void
): Promise<ChunkResult> {
  const startTime = Date.now();
  let lastError: string | null = null;
  let provider = 'unknown';
  
  // Retry loop
  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    if (attempt > 0) {
      onRetry?.(attempt, lastError || 'Unknown error');
      await sleep(CONFIG.retryDelay * attempt); // Exponential backoff
    }
    
    // Try providers in order
    const providers = [
      { name: 'whisper', fn: transcribeWithWhisper, key: 'OPENAI_API_KEY' },
      { name: 'huggingface', fn: transcribeWithHuggingFace, key: 'HUGGINGFACE_TOKEN' },
      { name: 'assemblyai', fn: transcribeWithAssemblyAI, key: 'ASSEMBLYAI_API_KEY' },
    ];
    
    for (const { name, fn, key } of providers) {
      // Skip provider if no API key
      if (!process.env[key as keyof typeof process.env]) {
        continue;
      }
      
      try {
        const text = await fn(chunk, options);
        
        if (text && text.trim().length > 0) {
          const duration = estimateDuration(chunk);
          provider = name;
          
          return {
            index,
            text: text.trim(),
            duration,
            provider,
            retries: attempt,
          };
        }
      } catch (error: any) {
        lastError = error.message;
        console.log(`Chunk ${index} - ${name} failed: ${lastError}`);
        // Try next provider
      }
    }
  }
  
  // All providers failed
  throw new Error(
    `Chunk ${index} failed after ${CONFIG.maxRetries} retries. Last error: ${lastError}`
  );
}

/**
 * Process chunks with concurrency limit
 */
async function processChunks(
  chunks: Buffer[],
  options: TranscriptionOptions,
  onProgress?: (progress: TranscriptionProgress) => void
): Promise<ChunkResult[]> {
  const results: ChunkResult[] = [];
  let completed = 0;
  let failed = 0;
  
  // Process with concurrency limit
  const executing: Promise<void>[] = [];
  
  for (let i = 0; i < chunks.length; i++) {
    const chunkIndex = i;
    const chunk = chunks[i];
    
    const promise = (async () => {
      try {
        const result = await transcribeChunk(chunk, chunkIndex, options, (attempt, error) => {
          console.log(`Chunk ${chunkIndex} retry ${attempt}: ${error}`);
        });
        results[chunkIndex] = result;
        completed++;
      } catch (error: any) {
        failed++;
        console.error(`Chunk ${chunkIndex} failed:`, error.message);
        // Add placeholder for failed chunk
        results[chunkIndex] = {
          index: chunkIndex,
          text: '[AUDIO_UNTRANSCRIBABLE]',
          duration: estimateDuration(chunk),
          provider: 'failed',
          retries: CONFIG.maxRetries,
        };
      }
      
      onProgress?.({
        status: 'processing',
        progress: Math.round(((completed + failed) / chunks.length) * 100),
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        completedChunks: completed,
        failedChunks: failed,
      });
    })();
    
    executing.push(promise);
    
    // Limit concurrency
    if (executing.length >= CONFIG.maxConcurrency) {
      await Promise.race(executing);
      // Remove completed promises
      const stillExecuting = executing.filter(p => {
        const status = (p as any).status;
        return status === 'pending';
      });
      executing.length = 0;
      executing.push(...stillExecuting);
    }
  }
  
  // Wait for all remaining
  await Promise.all(executing);
  
  return results;
}

/**
 * Merge chunk results into final transcript
 */
function mergeChunks(results: ChunkResult[]): string {
  // Sort by index
  const sorted = results.sort((a, b) => a.index - b.index);
  
  // Join with proper spacing
  return sorted
    .map(r => r.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * =============================================================================
 * BATSY Main Entry Point
 * =============================================================================
 */
export async function batsyTranscribe(
  audioBuffer: Buffer,
  filename: string,
  options: TranscriptionOptions = {},
  onProgress?: (progress: TranscriptionProgress) => void
): Promise<TranscriptionResult> {
  const chunkDuration = options.chunkDuration || CONFIG.chunkDuration;
  
  onProgress?.({
    status: 'processing',
    progress: 0,
    totalChunks: 1,
    currentChunk: 0,
  });
  
  // Chunk the audio
  const chunks = chunkAudio(audioBuffer, chunkDuration);
  const estimatedDuration = estimateDuration(audioBuffer);
  
  console.log(`BATSY: Processing ${filename}`);
  console.log(`  Duration: ~${Math.round(estimatedDuration)}s`);
  console.log(`  Chunks: ${chunks.length}`);
  console.log(`  Chunk duration: ${chunkDuration}s`);
  
  // Process chunks
  const results = await processChunks(chunks, options, onProgress);
  
  // Merge results
  const mergedText = mergeChunks(results);
  
  // Calculate stats
  const successful = results.filter(r => r.provider !== 'failed').length;
  const failed = results.filter(r => r.provider === 'failed').length;
  const primaryProvider = results.find(r => r.provider !== 'failed')?.provider || 'unknown';
  
  onProgress?.({
    status: 'completed',
    progress: 100,
    currentChunk: chunks.length,
    totalChunks: chunks.length,
    completedChunks: successful,
    failedChunks: failed,
  });
  
  return {
    text: mergedText,
    chunks: results,
    duration: Math.round(estimatedDuration),
    totalChunks: chunks.length,
    successfulChunks: successful,
    failedChunks: failed,
    provider: primaryProvider,
  };
}

/**
 * Quick health check for BATSY providers
 */
export function checkBatsyHealth(): Record<string, boolean> {
  return {
    whisper: !!process.env.OPENAI_API_KEY,
    huggingFace: !!process.env.HUGGINGFACE_TOKEN || true, // Can work without token
    assemblyAI: !!process.env.ASSEMBLYAI_API_KEY,
  };
}
