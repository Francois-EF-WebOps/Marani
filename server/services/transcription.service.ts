/**
 * Transcription Service
 * 
 * Handles audio transcription using OpenAI Whisper API.
 * Supports chunking for large files and caching to avoid re-transcription.
 * 
 * Why Whisper instead of Gemini for transcription:
 * - Whisper is purpose-built for speech-to-text
 * - More accurate for various accents and audio quality
 * - No quota issues with Google's audio processing limits
 * - Better handling of background noise and overlapping speech
 */

import FormData from 'form-data';
import fetch from 'node-fetch';

// Whisper API endpoint (OpenAI)
const WHISPER_API_URL = 'https://api.openai.com/v1/audio/transcriptions';

// Alternative: Hugging Face free inference (no API key needed for basic usage)
const HF_API_URL = 'https://api-inference.huggingface.co/models/openai/whisper-large-v3';

export interface TranscriptionOptions {
  language?: string;      // e.g., 'en', 'fr', 'es' - auto-detected if not specified
  translate?: boolean;    // If true, translate to English
  chunkDuration?: number; // Duration in seconds for chunking (default: 60s)
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
  chunks?: number;
}

export interface TranscriptionProgress {
  status: 'pending' | 'processing' | 'completed' | 'error';
  progress: number;       // 0-100 percentage
  currentChunk?: number;
  totalChunks?: number;
  error?: string;
}

/**
 * Calculate audio duration from buffer (approximate for MP3/WAV)
 * This is a simplified estimation - for production, use ffprobe
 */
function estimateAudioDuration(buffer: Buffer): number {
  // Rough estimation based on common bitrates
  // 128kbps MP3: ~9KB per second
  // This is approximate - actual implementation should use ffprobe
  const estimatedBitrate = 128 * 1000 / 8; // 128kbps in bytes/sec
  return buffer.length / estimatedBitrate;
}

/**
 * Split audio buffer into chunks
 * For production, use ffmpeg-wasm or server-side ffmpeg
 */
function chunkAudioBuffer(buffer: Buffer, chunkDuration: number): Buffer[] {
  const duration = estimateAudioDuration(buffer);
  const chunks: Buffer[] = [];
  
  if (duration <= chunkDuration) {
    return [buffer];
  }
  
  const chunkSize = Math.floor(buffer.length / (duration / chunkDuration));
  
  for (let i = 0; i < buffer.length; i += chunkSize) {
    chunks.push(buffer.slice(i, Math.min(i + chunkSize, buffer.length)));
  }
  
  return chunks;
}

/**
 * Transcribe audio using OpenAI Whisper API
 */
async function transcribeWithWhisper(
  audioBuffer: Buffer,
  filename: string,
  options: TranscriptionOptions
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured. Please add it to your .env file.');
  }
  
  const formData = new FormData();
  formData.append('file', audioBuffer, {
    filename: filename || 'audio.wav',
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
  
  const response = await fetch(WHISPER_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      ...formData.getHeaders(),
    },
    body: formData,
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Whisper API error: ${error.error?.message || response.statusText}`);
  }
  
  return await response.text();
}

/**
 * Transcribe audio using Hugging Face free inference
 * This is a fallback option when OpenAI API key is not available
 */
async function transcribeWithHuggingFace(
  audioBuffer: Buffer,
  options: TranscriptionOptions
): Promise<string> {
  const hfToken = process.env.HUGGINGFACE_TOKEN;
  
  const headers: Record<string, string> = {
    'Content-Type': 'audio/wav',
  };
  
  if (hfToken) {
    headers['Authorization'] = `Bearer ${hfToken}`;
  }
  
  const response = await fetch(HF_API_URL, {
    method: 'POST',
    headers,
    body: audioBuffer,
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Hugging Face API error: ${error.error || response.statusText}`);
  }
  
  const result = await response.json();
  return result.text || '';
}

/**
 * Main transcription function with chunking support
 * Automatically falls back to Hugging Face if OpenAI key is not available
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string,
  options: TranscriptionOptions = {},
  onProgress?: (progress: TranscriptionProgress) => void
): Promise<TranscriptionResult> {
  const chunkDuration = options.chunkDuration || 60; // 60 seconds per chunk
  const duration = estimateAudioDuration(audioBuffer);
  const needsChunking = duration > chunkDuration;
  
  onProgress?.({
    status: 'processing',
    progress: 0,
    currentChunk: 0,
    totalChunks: needsChunking ? Math.ceil(duration / chunkDuration) : 1,
  });
  
  let chunks: Buffer[];
  if (needsChunking) {
    chunks = chunkAudioBuffer(audioBuffer, chunkDuration);
  } else {
    chunks = [audioBuffer];
  }
  
  const transcribedChunks: string[] = [];
  let hasOpenAIKey = !!process.env.OPENAI_API_KEY;
  
  for (let i = 0; i < chunks.length; i++) {
    try {
      const chunk = chunks[i];
      let text: string;
      
      // Try OpenAI Whisper first (better quality)
      if (hasOpenAIKey) {
        try {
          text = await transcribeWithWhisper(chunk, `chunk_${i}_${filename}`, options);
        } catch (error: any) {
          // If OpenAI fails due to auth/quota, fall back to Hugging Face
          if (error.message.includes('API key') || error.message.includes('quota')) {
            hasOpenAIKey = false;
            console.log('Falling back to Hugging Face for transcription');
            text = await transcribeWithHuggingFace(chunk, options);
          } else {
            throw error;
          }
        }
      } else {
        // Use Hugging Face
        text = await transcribeWithHuggingFace(chunk, options);
      }
      
      transcribedChunks.push(text);
      
      onProgress?.({
        status: 'processing',
        progress: Math.round(((i + 1) / chunks.length) * 100),
        currentChunk: i + 1,
        totalChunks: chunks.length,
      });
    } catch (error: any) {
      onProgress?.({
        status: 'error',
        progress: 0,
        error: error.message || `Failed to transcribe chunk ${i + 1}`,
      });
      throw error;
    }
  }
  
  // Merge chunks with proper spacing
  const fullText = transcribedChunks.join(' ').replace(/\s+/g, ' ').trim();
  
  onProgress?.({
    status: 'completed',
    progress: 100,
    currentChunk: chunks.length,
    totalChunks: chunks.length,
  });
  
  return {
    text: fullText,
    duration: Math.round(duration),
    chunks: chunks.length,
  };
}

/**
 * Generate a cache key from audio buffer
 * Uses simple hash for quick comparison
 */
export function generateAudioHash(buffer: Buffer): string {
  // Simple hash - for production, use crypto.createHash('sha256')
  let hash = 0;
  const sampleSize = Math.min(buffer.length, 10000);
  
  for (let i = 0; i < sampleSize; i += Math.max(1, Math.floor(buffer.length / sampleSize))) {
    hash = ((hash << 5) - hash) + buffer[i];
    hash |= 0;
  }
  
  return `audio_${Math.abs(hash).toString(16)}`;
}
