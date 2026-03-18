/**
 * Cache Service
 * 
 * Simple in-memory cache with optional file persistence.
 * Prevents re-transcribing the same audio files.
 * 
 * For production: Replace with Redis or database-backed cache.
 */

import * as fs from 'fs';
import * as path from 'path';

const CACHE_DIR = path.join(process.cwd(), '.cache');

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number; // Time to live in milliseconds
}

export interface TranscriptionCacheData {
  transcript: string;
  duration?: number;
  chunks?: number;
  language?: string;
}

/**
 * Ensure cache directory exists
 */
function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Generate a cache key from audio buffer hash
 */
export function getCacheKey(audioHash: string, options: { language?: string; translate?: boolean }): string {
  const optionsKey = `${options.language || 'auto'}_${options.translate ? 'translate' : 'transcribe'}`;
  return `${audioHash}_${optionsKey}`;
}

/**
 * Get cached transcription result
 */
export function getCachedTranscription(cacheKey: string): TranscriptionCacheData | null {
  try {
    ensureCacheDir();
    const cacheFile = path.join(CACHE_DIR, `${cacheKey}.json`);
    
    if (!fs.existsSync(cacheFile)) {
      return null;
    }
    
    const content = fs.readFileSync(cacheFile, 'utf-8');
    const entry: CacheEntry<TranscriptionCacheData> = JSON.parse(content);
    
    // Check if entry has expired
    if (Date.now() > entry.timestamp + entry.ttl) {
      fs.unlinkSync(cacheFile);
      return null;
    }
    
    return entry.data;
  } catch (error) {
    console.error('Cache read error:', error);
    return null;
  }
}

/**
 * Store transcription result in cache
 */
export function cacheTranscription(
  cacheKey: string,
  data: TranscriptionCacheData,
  ttlHours: number = 24
): void {
  try {
    ensureCacheDir();
    const cacheFile = path.join(CACHE_DIR, `${cacheKey}.json`);
    
    const entry: CacheEntry<TranscriptionCacheData> = {
      data,
      timestamp: Date.now(),
      ttl: ttlHours * 60 * 60 * 1000, // Convert hours to milliseconds
    };
    
    fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2));
  } catch (error) {
    console.error('Cache write error:', error);
  }
}

/**
 * Clear expired cache entries
 * Run periodically or on startup
 */
export function clearExpiredCache(): number {
  try {
    ensureCacheDir();
    const files = fs.readdirSync(CACHE_DIR);
    let cleared = 0;
    
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      
      const filePath = path.join(CACHE_DIR, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const entry: CacheEntry<any> = JSON.parse(content);
        
        if (Date.now() > entry.timestamp + entry.ttl) {
          fs.unlinkSync(filePath);
          cleared++;
        }
      } catch {
        // Invalid cache file, remove it
        fs.unlinkSync(filePath);
        cleared++;
      }
    }
    
    return cleared;
  } catch (error) {
    console.error('Cache cleanup error:', error);
    return 0;
  }
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { entries: number; size: number } {
  try {
    ensureCacheDir();
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
    
    let totalSize = 0;
    for (const file of files) {
      const filePath = path.join(CACHE_DIR, file);
      const stats = fs.statSync(filePath);
      totalSize += stats.size;
    }
    
    return {
      entries: files.length,
      size: totalSize,
    };
  } catch {
    return { entries: 0, size: 0 };
  }
}

/**
 * Clear all cache entries
 */
export function clearAllCache(): void {
  try {
    ensureCacheDir();
    const files = fs.readdirSync(CACHE_DIR);
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(CACHE_DIR, file));
      }
    }
  } catch (error) {
    console.error('Cache clear error:', error);
  }
}
