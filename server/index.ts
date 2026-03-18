/**
 * =============================================================================
 * Marani Transcription Server
 * =============================================================================
 * 
 * Architecture Overview:
 * 
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                         CLIENT                                  │
 * │                    (React Frontend)                             │
 * └─────────────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                      EXPRESS SERVER                             │
 * │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
 * │  │   Upload    │  │   Queue     │  │   Progress Tracking     │ │
 * │  │  Handler    │  │   Manager   │  │   (WebSocket/Polling)   │ │
 * │  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
 * └─────────────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                       ROUTER SERVICE                            │
 * │  ┌──────────────────────────────────────────────────────────┐  │
 * │  │  Input Analysis → Mode Decision → Execute → Normalize    │  │
 * │  └──────────────────────────────────────────────────────────┘  │
 * └─────────────────────────────────────────────────────────────────┘
 *                              │
 *              ┌───────────────┴───────────────┐
 *              ▼                               ▼
 * ┌─────────────────────────┐    ┌─────────────────────────┐
 * │      BATSY MODE         │    │      FLASH MODE         │
 * │    (Heavy/Long)         │    │    (Light/Short)        │
 * │  ┌───────────────────┐  │    │  ┌───────────────────┐  │
 * │  │  Whisper API      │  │    │  │  Gemini API       │  │
 * │  │  Hugging Face     │  │    │  │  (Text only)      │  │
 * │  │  AssemblyAI       │  │    │  └───────────────────┘  │
 * │  │  (Chunking+Retry) │  │    │                        │
 * │  └───────────────────┘  │    │                        │
 * └─────────────────────────┘    └─────────────────────────┘
 *              │                               │
 *              └───────────────┬───────────────┘
 *                              ▼
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                    NORMALIZE SERVICE                            │
 * │  { transcript, clean_text, summary, key_points, hooks }         │
 * └─────────────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                      CACHE SERVICE                              │
 * │  Hash-based deduplication (Memory + Disk)                       │
 * └─────────────────────────────────────────────────────────────────┘
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';

// Import services
import {
  routeAndProcess,
  getRouterHealth,
  recordApiError,
} from './services/router.service.js';
import {
  generateHash,
  generateCacheKey,
  getCached,
  setCached,
  getCacheStats,
  clearCache,
  initializeCache,
} from './services/cache.service.js';
import { normalizeOutput, createErrorOutput } from './services/normalize.service.js';

// =============================================================================
// Configuration
// =============================================================================

const PORT = process.env.PORT || 3001;
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

// =============================================================================
// Express Setup
// =============================================================================

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// File upload configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
});

// =============================================================================
// Queue System
// =============================================================================

interface QueueJob {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  createdAt: number;
  completedAt?: number;
  error?: string;
  result?: any;
  type: 'transcribe' | 'process-text';
}

const jobQueue = new Map<string, QueueJob>();
const activeJobs = new Set<string>();
const MAX_CONCURRENT_JOBS = 3;

/**
 * Add job to queue
 */
function addJobToQueue(job: QueueJob): void {
  jobQueue.set(job.id, job);
  processQueue();
}

/**
 * Process next job in queue
 */
async function processQueue(): Promise<void> {
  if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
    return;
  }
  
  const pendingJobs = Array.from(jobQueue.values())
    .filter(j => j.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt);
  
  for (const job of pendingJobs) {
    if (activeJobs.size >= MAX_CONCURRENT_JOBS) break;
    
    activeJobs.add(job.id);
    job.status = 'processing';
    
    // Process asynchronously
    processJob(job).catch(error => {
      console.error(`Job ${job.id} failed:`, error);
    });
  }
}

/**
 * Process a single job
 */
async function processJob(job: QueueJob): Promise<void> {
  try {
    job.progress = 10;
    
    // Job processing logic is handled by the endpoint
    // This is just for queue management
    
    job.status = 'completed';
    job.completedAt = Date.now();
    job.progress = 100;
  } catch (error: any) {
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = Date.now();
  } finally {
    activeJobs.delete(job.id);
    processQueue();
  }
}

/**
 * Get job status
 */
function getJobStatus(jobId: string): QueueJob | null {
  return jobQueue.get(jobId) || null;
}

// =============================================================================
// Initialize Cache
// =============================================================================

initializeCache();

// =============================================================================
// API Endpoints
// =============================================================================

/**
 * POST /api/transcribe
 * 
 * Main transcription endpoint
 * Accepts audio/video files and processes through BATSY/FLASH pipeline
 */
app.post('/api/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
  const jobId = uuidv4();
  const startTime = Date.now();
  
  try {
    // Validate input
    if (!req.file && !req.body.text && !req.body.url) {
      return res.status(400).json({
        success: false,
        error: 'Missing input: provide audio file, text, or URL',
      });
    }
    
    // Parse options
    const {
      language,
      translate = false,
      includeSummary = true,
      includeKeyPoints = true,
      includeHooks = true,
      useCache = true,
      forceMode,
      fastMode = false,
      costSavingMode = false,
    } = req.body || {};
    
    // Determine input type and data
    let inputData: Buffer | string;
    let inputType: 'audio' | 'video' | 'text' | 'url';
    let contentHash: string;
    
    if (req.file) {
      // File upload
      inputData = req.file.buffer;
      inputType = req.file.mimetype.startsWith('video') ? 'video' : 'audio';
      contentHash = generateHash(inputData);
    } else if (req.body.text) {
      // Text input
      inputData = req.body.text;
      inputType = 'text';
      contentHash = generateHash(inputData);
    } else if (req.body.url) {
      // URL input
      inputData = req.body.url;
      inputType = 'url';
      contentHash = generateHash(inputData);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid input format',
      });
    }
    
    // Generate cache key
    const cacheKey = generateCacheKey(contentHash, {
      language,
      translate,
      includeSummary,
      includeKeyPoints,
      includeHooks,
    });
    
    // Check cache
    if (useCache) {
      const cached = getCached(cacheKey);
      if (cached) {
        console.log(`✅ Cache hit: ${cacheKey}`);
        return res.json({
          success: true,
          source: 'cache',
          cached: true,
          ...(cached as any),
          processingTime: Date.now() - startTime,
        });
      }
      console.log(`⏳ Cache miss: ${cacheKey}`);
    }
    
    // Create job
    const job: QueueJob = {
      id: jobId,
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
      type: 'transcribe',
    };
    addJobToQueue(job);
    
    // Process through router
    const result = await routeAndProcess(inputData, inputType, {
      mode: forceMode,
      language,
      translate,
      includeSummary,
      includeKeyPoints,
      includeHooks,
      fastMode,
      costSavingMode,
    });
    
    // Cache result
    if (useCache) {
      setCached(cacheKey, result, 24);
    }
    
    // Update job
    job.result = result;
    job.status = 'completed';
    job.completedAt = Date.now();
    job.progress = 100;
    
    res.json({
      success: true,
      jobId,
      source: 'processing',
      cached: false,
      ...result,
      processingTime: Date.now() - startTime,
    });
    
  } catch (error: any) {
    console.error('Transcription error:', error);
    recordApiError(error.message.includes('GEMINI') ? 'gemini' : 'whisper');
    
    // Update job
    const job = jobQueue.get(jobId);
    if (job) {
      job.status = 'failed';
      job.error = error.message;
      job.completedAt = Date.now();
    }
    
    res.status(500).json({
      success: false,
      jobId,
      error: error.message,
      mode: 'BATSY', // Default for error output
    });
  }
});

/**
 * GET /api/job/:jobId
 * 
 * Get job status and result
 */
app.get('/api/job/:jobId', (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = getJobStatus(jobId);
  
  if (!job) {
    return res.status(404).json({
      success: false,
      error: 'Job not found',
    });
  }
  
  res.json({
    success: true,
    job: {
      id: job.id,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      error: job.error,
      result: job.result,
    },
  });
});

/**
 * POST /api/process-text
 * 
 * Process existing text through FLASH mode
 */
app.post('/api/process-text', async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    const {
      text,
      mode = 'clean',
      language,
      includeSummary = true,
      includeKeyPoints = true,
      includeHooks = true,
    } = req.body;
    
    if (!text || typeof text !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Text is required',
      });
    }
    
    // Process as text (FLASH mode)
    const result = await routeAndProcess(text, 'text', {
      mode: 'FLASH',
      language,
      translate: mode === 'translate',
      includeSummary,
      includeKeyPoints,
      includeHooks,
    });
    
    res.json({
      success: true,
      ...result,
      processingTime: Date.now() - startTime,
    });
    
  } catch (error: any) {
    console.error('Text processing error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/health
 * 
 * System health check
 */
app.get('/api/health', (req: Request, res: Response) => {
  const routerHealth = getRouterHealth();
  const cacheStats = getCacheStats();
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      router: routerHealth,
      cache: {
        entries: cacheStats.entries,
        size: cacheStats.totalSizeFormatted,
        hitRate: `${(cacheStats.hitRate * 100).toFixed(1)}%`,
      },
      queue: {
        active: activeJobs.size,
        pending: Array.from(jobQueue.values()).filter(j => j.status === 'pending').length,
        total: jobQueue.size,
      },
    },
  });
});

/**
 * GET /api/cache/stats
 * 
 * Cache statistics
 */
app.get('/api/cache/stats', (req: Request, res: Response) => {
  const stats = getCacheStats();
  res.json({
    success: true,
    ...stats,
  });
});

/**
 * DELETE /api/cache
 * 
 * Clear all cache
 */
app.delete('/api/cache', (req: Request, res: Response) => {
  clearCache();
  res.json({
    success: true,
    message: 'Cache cleared',
  });
});

/**
 * GET /api/queue/stats
 * 
 * Queue statistics
 */
app.get('/api/queue/stats', (req: Request, res: Response) => {
  const jobs = Array.from(jobQueue.values());
  
  res.json({
    success: true,
    queue: {
      total: jobs.length,
      active: activeJobs.size,
      pending: jobs.filter(j => j.status === 'pending').length,
      processing: jobs.filter(j => j.status === 'processing').length,
      completed: jobs.filter(j => j.status === 'completed').length,
      failed: jobs.filter(j => j.status === 'failed').length,
      maxConcurrent: MAX_CONCURRENT_JOBS,
    },
  });
});

// =============================================================================
// Start Server
// =============================================================================

app.listen(PORT, () => {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║           MARANI TRANSCRIPTION SERVER                     ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  Server running on port ${PORT}                              ║`);
  console.log(`║  Health:   http://localhost:${PORT}/api/health              ║`);
  console.log(`║  Cache:    http://localhost:${PORT}/api/cache/stats         ║`);
  console.log(`║  Queue:    http://localhost:${PORT}/api/queue/stats         ║`);
  console.log('╚═══════════════════════════════════════════════════════════╝');
  
  // Log available providers
  const health = getRouterHealth();
  console.log('\n📊 Available Services:');
  console.log(`   BATSY (Heavy):  ${health.batSYAvailable ? '✅' : '❌'}`);
  console.log(`   FLASH (Light):  ${health.flashAvailable ? '✅' : '❌'}`);
  
  if (health.recommendations.length > 0) {
    console.log('\n⚠️  Recommendations:');
    health.recommendations.forEach(r => console.log(`   - ${r}`));
  }
});

export default app;
