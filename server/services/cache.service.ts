/**
 * =============================================================================
 * Cache Service - Hash-Based Deduplication
 * =============================================================================
 * 
 * Purpose: Avoid reprocessing the same audio/text inputs
 * 
 * Features:
 * - SHA-256 hash-based content identification
 * - File-based persistence
 * - TTL-based expiration
 * - Automatic cleanup
 * - Memory + disk hybrid storage
 * 
 * Cache Keys:
 * - Audio files: hash(buffer) + options
 * - Text: hash(text) + options
 * - URLs: hash(url) + timestamp (for freshness)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  // Cache directory
  cacheDir: path.join(process.cwd(), '.cache'),
  
  // Default TTL in hours
  defaultTTL: 24,
  
  // Maximum cache size in MB
  maxCacheSize: 500,
  
  // Cleanup interval in hours
  cleanupInterval: 6,
};

// =============================================================================
// Types
// =============================================================================

export interface CacheEntry<T> {
  data: T;
  createdAt: number;
  expiresAt: number;
  ttl: number;
  accessCount: number;
  lastAccessed: number;
}

export interface CacheKeyOptions {
  language?: string;
  translate?: boolean;
  includeSummary?: boolean;
  includeKeyPoints?: boolean;
  includeHooks?: boolean;
}

export interface CacheStats {
  entries: number;
  totalSize: number;
  totalSizeFormatted: string;
  oldestEntry: string;
  newestEntry: string;
  hits: number;
  misses: number;
  hitRate: number;
}

// =============================================================================
// In-Memory Cache (LRU-style)
// =============================================================================

const memoryCache = new Map<string, CacheEntry<any>>();
const cacheStats = {
  hits: 0,
  misses: 0,
};

/**
 * Get item from memory cache
 */
function getFromMemory<T>(key: string): T | null {
  const entry = memoryCache.get(key);
  
  if (!entry) {
    return null;
  }
  
  // Check expiration
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  
  // Update access info
  entry.accessCount++;
  entry.lastAccessed = Date.now();
  memoryCache.set(key, entry);
  
  cacheStats.hits++;
  return entry.data as T;
}

/**
 * Set item in memory cache
 */
function setInMemory<T>(key: string, data: T, ttlHours: number): void {
  const now = Date.now();
  const ttl = ttlHours * 60 * 60 * 1000;
  
  const entry: CacheEntry<T> = {
    data,
    createdAt: now,
    expiresAt: now + ttl,
    ttl,
    accessCount: 0,
    lastAccessed: now,
  };
  
  memoryCache.set(key, entry);
  
  // Prune if too large
  if (memoryCache.size > 1000) {
    pruneMemoryCache();
  }
}

/**
 * Remove least recently used items from memory cache
 */
function pruneMemoryCache(): void {
  const entries = Array.from(memoryCache.entries());
  
  // Sort by last accessed (oldest first)
  entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
  
  // Remove oldest 25%
  const toRemove = Math.floor(entries.length * 0.25);
  for (let i = 0; i < toRemove; i++) {
    memoryCache.delete(entries[i][0]);
  }
}

// =============================================================================
// File-Based Cache
// =============================================================================

/**
 * Ensure cache directory exists
 */
function ensureCacheDir(): void {
  if (!fs.existsSync(CONFIG.cacheDir)) {
    fs.mkdirSync(CONFIG.cacheDir, { recursive: true });
  }
}

/**
 * Get cache file path for a key
 */
function getCacheFilePath(key: string): string {
  // Sanitize key for filesystem
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CONFIG.cacheDir, `${safeKey}.json`);
}

/**
 * Get item from file cache
 */
function getFromFile<T>(key: string): T | null {
  try {
    const filePath = getCacheFilePath(key);
    
    if (!fs.existsSync(filePath)) {
      return null;
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const entry: CacheEntry<T> = JSON.parse(content);
    
    // Check expiration
    if (Date.now() > entry.expiresAt) {
      fs.unlinkSync(filePath);
      return null;
    }
    
    // Update access info
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    fs.writeFileSync(filePath, JSON.stringify(entry));
    
    return entry.data;
  } catch (error) {
    console.error('Cache read error:', error);
    return null;
  }
}

/**
 * Set item in file cache
 */
function setInFile<T>(key: string, data: T, ttlHours: number): void {
  try {
    ensureCacheDir();
    
    const filePath = getCacheFilePath(key);
    const now = Date.now();
    const ttl = ttlHours * 60 * 60 * 1000;
    
    const entry: CacheEntry<T> = {
      data,
      createdAt: now,
      expiresAt: now + ttl,
      ttl,
      accessCount: 0,
      lastAccessed: now,
    };
    
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));
  } catch (error) {
    console.error('Cache write error:', error);
  }
}

// =============================================================================
// Hash Generation
// =============================================================================

/**
 * Generate SHA-256 hash for content
 */
export function generateHash(content: Buffer | string): string {
  const hash = crypto.createHash('sha256');
  
  if (Buffer.isBuffer(content)) {
    // Sample first 1MB for large files (fast hashing)
    const sampleSize = Math.min(content.length, 1024 * 1024);
    hash.update(content.slice(0, sampleSize));
  } else {
    hash.update(content);
  }
  
  return hash.digest('hex');
}

/**
 * Generate cache key from hash and options
 */
export function generateCacheKey(
  contentHash: string,
  options: CacheKeyOptions
): string {
  const optionsString = JSON.stringify({
    l: options.language || 'auto',
    t: options.translate || false,
    s: options.includeSummary || false,
    k: options.includeKeyPoints || false,
    h: options.includeHooks || false,
  });
  
  const optionsHash = crypto.createHash('md5').update(optionsString).digest('hex');
  
  return `cache_${contentHash}_${optionsHash}`;
}

/**
 * Generate cache key for URL (includes date for freshness)
 */
export function generateURLCacheKey(url: string, options: CacheKeyOptions): string {
  // Include date to refresh cached URLs periodically
  const today = new Date().toISOString().split('T')[0];
  const content = `${url}_${today}`;
  const contentHash = generateHash(content);
  
  return generateCacheKey(contentHash, options);
}

// =============================================================================
// Main Cache Functions
// =============================================================================

/**
 * Get cached result (checks memory first, then file)
 */
export function getCached<T>(key: string): T | null {
  // Try memory first
  const memoryResult = getFromMemory<T>(key);
  if (memoryResult) {
    return memoryResult;
  }
  
  // Try file
  const fileResult = getFromFile<T>(key);
  if (fileResult) {
    // Load into memory
    setInMemory(key, fileResult, CONFIG.defaultTTL);
    return fileResult;
  }
  
  cacheStats.misses++;
  return null;
}

/**
 * Set cached result (stores in both memory and file)
 */
export function setCached<T>(key: string, data: T, ttlHours: number = CONFIG.defaultTTL): void {
  setInMemory(key, data, ttlHours);
  setInFile(key, data, ttlHours);
}

/**
 * Check if key exists in cache
 */
export function hasCached(key: string): boolean {
  return getCached(key) !== null;
}

/**
 * Remove item from cache
 */
export function removeFromCache(key: string): void {
  memoryCache.delete(key);
  
  try {
    const filePath = getCacheFilePath(key);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Cache delete error:', error);
  }
}

/**
 * Clear all cache entries
 */
export function clearCache(): void {
  memoryCache.clear();
  
  try {
    ensureCacheDir();
    const files = fs.readdirSync(CONFIG.cacheDir);
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(CONFIG.cacheDir, file));
      }
    }
  } catch (error) {
    console.error('Cache clear error:', error);
  }
  
  cacheStats.hits = 0;
  cacheStats.misses = 0;
}

/**
 * Clean up expired entries
 */
export function cleanupExpired(): number {
  let cleaned = 0;
  const now = Date.now();
  
  // Clean memory cache
  for (const [key, entry] of memoryCache.entries()) {
    if (now > entry.expiresAt) {
      memoryCache.delete(key);
      cleaned++;
    }
  }
  
  // Clean file cache
  try {
    ensureCacheDir();
    const files = fs.readdirSync(CONFIG.cacheDir);
    
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      
      const filePath = path.join(CONFIG.cacheDir, file);
      
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const entry: CacheEntry<any> = JSON.parse(content);
        
        if (now > entry.expiresAt) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // Invalid file, remove it
        fs.unlinkSync(filePath);
        cleaned++;
      }
    }
  } catch (error) {
    console.error('Cache cleanup error:', error);
  }
  
  console.log(`Cache cleanup: removed ${cleaned} expired entries`);
  return cleaned;
}

/**
 * Get cache statistics
 */
export function getCacheStats(): CacheStats {
  ensureCacheDir();
  
  const files = fs.readdirSync(CONFIG.cacheDir).filter(f => f.endsWith('.json'));
  let totalSize = 0;
  let oldest = Infinity;
  let newest = 0;
  
  for (const file of files) {
    const filePath = path.join(CONFIG.cacheDir, file);
    
    try {
      const stats = fs.statSync(filePath);
      totalSize += stats.size;
      
      const content = fs.readFileSync(filePath, 'utf-8');
      const entry: CacheEntry<any> = JSON.parse(content);
      
      if (entry.createdAt < oldest) oldest = entry.createdAt;
      if (entry.createdAt > newest) newest = entry.createdAt;
    } catch {
      // Skip invalid files
    }
  }
  
  const totalHits = cacheStats.hits;
  const totalMisses = cacheStats.misses;
  const hitRate = totalHits + totalMisses > 0 
    ? totalHits / (totalHits + totalMisses) 
    : 0;
  
  return {
    entries: files.length + memoryCache.size,
    totalSize,
    totalSizeFormatted: formatBytes(totalSize),
    oldestEntry: oldest === Infinity ? 'N/A' : new Date(oldest).toISOString(),
    newestEntry: newest === 0 ? 'N/A' : new Date(newest).toISOString(),
    hits: totalHits,
    misses: totalMisses,
    hitRate,
  };
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Initialize cache with periodic cleanup
 */
export function initializeCache(): void {
  ensureCacheDir();
  
  // Run cleanup on startup
  cleanupExpired();
  
  // Schedule periodic cleanup
  setInterval(() => {
    cleanupExpired();
  }, CONFIG.cleanupInterval * 60 * 60 * 1000);
  
  console.log(`Cache initialized: ${CONFIG.cacheDir}`);
}
