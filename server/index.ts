/**
 * Transcription Pipeline Server
 * 
 * Architecture:
 * 1. Upload audio file → Server receives buffer
 * 2. Generate hash → Check cache for existing transcription
 * 3. If not cached → Transcribe with Whisper (chunked if needed)
 * 4. Process text with Gemini → Clean, format, summarize
 * 5. Return complete result with caching
 * 
 * Endpoints:
 * POST /api/transcribe - Upload audio and get full processing
 * POST /api/transcribe/url - Process audio from URL
 * GET /api/cache/stats - Cache statistics
 * DELETE /api/cache - Clear cache
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import { transcribeAudio, generateAudioHash } from './services/transcription.service.js';
import { processText } from './services/gemini.service.js';
import {
  getCachedTranscription,
  cacheTranscription,
  getCacheStats,
  clearAllCache,
  getCacheKey,
} from './services/cache.service.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Configure multer for file uploads (in-memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Track active transcription sessions for progress updates
const activeSessions = new Map<string, {
  status: string;
  progress: number;
  currentChunk?: number;
  totalChunks?: number;
  error?: string;
}>();

/**
 * POST /api/transcribe
 * 
 * Main transcription endpoint
 * Accepts audio file, transcribes with Whisper, processes with Gemini
 */
app.post('/api/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    // Validate file
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }
    
    const audioBuffer = req.file.buffer;
    const filename = req.file.originalname || 'audio.wav';
    
    // Parse options from request
    const { 
      language, 
      translate = false, 
      includeSummary = true, 
      includeKeyPoints = true,
      includeHooks = true,
      useCache = true,
    } = req.body || {};
    
    // Generate hash for caching
    const audioHash = generateAudioHash(audioBuffer);
    const cacheKey = getCacheKey(audioHash, { language, translate });
    
    // Check cache first
    if (useCache) {
      const cached = getCachedTranscription(cacheKey);
      if (cached) {
        console.log(`Cache hit for ${cacheKey}`);
        
        // Process cached transcript with Gemini
        const processed = await processText(cached.transcript, {
          mode: translate ? 'translate' : 'transcribe',
          language,
          includeSummary,
          includeKeyPoints,
          includeHooks,
        });
        
        return res.json({
          success: true,
          source: 'cache',
          transcript: cached.transcript,
          processed,
          duration: cached.duration,
          chunks: cached.chunks,
          processingTime: Date.now() - startTime,
        });
      }
    }
    
    console.log(`Processing new audio: ${filename} (${audioBuffer.length} bytes)`);
    
    // Create session for progress tracking
    const sessionId = `${audioHash}_${Date.now()}`;
    activeSessions.set(sessionId, {
      status: 'processing',
      progress: 0,
    });
    
    // Transcribe with Whisper
    const transcriptionResult = await transcribeAudio(
      audioBuffer,
      filename,
      { language, translate },
      (progress) => {
        activeSessions.set(sessionId, progress);
      }
    );
    
    // Cache the raw transcription
    cacheTranscription(cacheKey, {
      transcript: transcriptionResult.text,
      duration: transcriptionResult.duration,
      chunks: transcriptionResult.chunks,
      language,
    });
    
    // Process text with Gemini
    const processed = await processText(transcriptionResult.text, {
      mode: translate ? 'translate' : 'transcribe',
      language,
      includeSummary,
      includeKeyPoints,
      includeHooks,
    });
    
    // Clean up session
    activeSessions.delete(sessionId);
    
    res.json({
      success: true,
      source: 'transcription',
      sessionId,
      transcript: transcriptionResult.text,
      processed,
      duration: transcriptionResult.duration,
      chunks: transcriptionResult.chunks,
      processingTime: Date.now() - startTime,
    });
    
  } catch (error: any) {
    console.error('Transcription error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Transcription failed',
    });
  }
});

/**
 * GET /api/transcribe/progress/:sessionId
 * 
 * Get progress for an active transcription session
 */
app.get('/api/transcribe/progress/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json(session);
});

/**
 * POST /api/process-text
 * 
 * Process existing text with Gemini (clean, summarize, extract insights)
 * Use this if you already have a transcript from another source
 */
app.post('/api/process-text', async (req: Request, res: Response) => {
  try {
    const { text, mode = 'transcribe', language, includeSummary = true, includeKeyPoints = true, includeHooks = true } = req.body;
    
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text is required' });
    }
    
    const processed = await processText(text, {
      mode,
      language,
      includeSummary,
      includeKeyPoints,
      includeHooks,
    });
    
    res.json({
      success: true,
      ...processed,
    });
  } catch (error: any) {
    console.error('Text processing error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Text processing failed',
    });
  }
});

/**
 * GET /api/cache/stats
 * 
 * Get cache statistics
 */
app.get('/api/cache/stats', (req: Request, res: Response) => {
  const stats = getCacheStats();
  res.json({
    entries: stats.entries,
    size: stats.size,
    sizeFormatted: `${(stats.size / 1024).toFixed(2)} KB`,
  });
});

/**
 * DELETE /api/cache
 * 
 * Clear all cached transcriptions
 */
app.delete('/api/cache', (req: Request, res: Response) => {
  clearAllCache();
  res.json({ success: true, message: 'Cache cleared' });
});

/**
 * Health check endpoint
 */
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      whisper: !!process.env.OPENAI_API_KEY || 'fallback (Hugging Face)',
      gemini: !!process.env.GEMINI_API_KEY,
    },
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🎙️  Transcription server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   Cache:  http://localhost:${PORT}/api/cache/stats`);
});

export default app;
