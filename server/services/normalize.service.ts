/**
 * =============================================================================
 * Normalize Service - Unified Output Format
 * =============================================================================
 * 
 * Purpose: Ensure all outputs conform to the mandatory schema
 * 
 * All outputs from BATSY and FLASH must produce this structure:
 * {
 *   "transcript": "...",
 *   "clean_text": "...",
 *   "summary": "...",
 *   "key_points": [],
 *   "hooks": []
 * }
 * 
 * This layer handles:
 * - Schema validation
 * - Default values for missing fields
 * - Format standardization
 * - Metadata enrichment
 */

// =============================================================================
// Types
// =============================================================================

export interface NormalizedOutput {
  // Core transcript data
  transcript: string;
  
  // Cleaned and formatted text
  clean_text: string;
  
  // Summary (2-3 paragraphs)
  summary: string;
  
  // Key insights (5-10 points)
  key_points: string[];
  
  // Viral hooks (3-5 quotes)
  hooks: string[];
  
  // Metadata
  metadata: {
    // Processing information
    mode: 'BATSY' | 'FLASH';
    processingTime: number;
    timestamp: string;
    
    // Content information
    duration?: number;
    chunks?: number;
    provider?: string;
    model?: string;
    language?: string;
    
    // Quality indicators
    confidence?: number;
    wordCount?: number;
  };
}

export interface RawProcessResult {
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

// =============================================================================
// Default Values
// =============================================================================

const DEFAULTS = {
  summary: 'Summary not available. The transcript has been processed but summarization was not requested or failed.',
  emptyArray: [] as string[],
  minHookLength: 10,
  minKeyPointLength: 5,
};

// =============================================================================
// Normalization Functions
// =============================================================================

/**
 * Ensure summary exists and is properly formatted
 */
function normalizeSummary(summary?: string): string {
  if (!summary || summary.trim().length === 0) {
    return DEFAULTS.summary;
  }
  return summary.trim();
}

/**
 * Ensure key_points is a valid array with minimum quality
 */
function normalizeKeyPoints(points?: string[]): string[] {
  if (!points || !Array.isArray(points)) {
    return DEFAULTS.emptyArray;
  }
  
  return points
    .filter(p => p && typeof p === 'string')
    .map(p => p.trim())
    .filter(p => p.length >= DEFAULTS.minKeyPointLength);
}

/**
 * Ensure hooks is a valid array with minimum quality
 */
function normalizeHooks(hooks?: string[]): string[] {
  if (!hooks || !Array.isArray(hooks)) {
    return DEFAULTS.emptyArray;
  }
  
  return hooks
    .filter(h => h && typeof h === 'string')
    .map(h => h.trim())
    .filter(h => h.length >= DEFAULTS.minHookLength)
    .slice(0, 5); // Maximum 5 hooks
}

/**
 * Calculate word count from text
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Calculate confidence score based on available data
 */
function calculateConfidence(result: RawProcessResult): number {
  let confidence = 0.7; // Base confidence
  
  // Has clean text different from transcript
  if (result.clean_text && result.clean_text !== result.transcript) {
    confidence += 0.1;
  }
  
  // Has summary
  if (result.summary && result.summary.length > 50) {
    confidence += 0.05;
  }
  
  // Has key points
  if (result.key_points && result.key_points.length >= 3) {
    confidence += 0.05;
  }
  
  // Has hooks
  if (result.hooks && result.hooks.length >= 2) {
    confidence += 0.05;
  }
  
  // BATSY with multiple chunks is more reliable
  if (result.mode === 'BATSY' && result.metadata.chunks && result.metadata.chunks > 1) {
    confidence += 0.05;
  }
  
  return Math.min(confidence, 0.95);
}

// =============================================================================
// Main Normalization Function
// =============================================================================

/**
 * Normalize any process result to the standard output format
 */
export function normalizeOutput(result: RawProcessResult): NormalizedOutput {
  const confidence = calculateConfidence(result);
  
  return {
    // Core fields (mandatory)
    transcript: result.transcript?.trim() || '',
    clean_text: result.clean_text?.trim() || result.transcript?.trim() || '',
    summary: normalizeSummary(result.summary),
    key_points: normalizeKeyPoints(result.key_points),
    hooks: normalizeHooks(result.hooks),
    
    // Metadata
    metadata: {
      mode: result.mode,
      processingTime: result.metadata.processingTime,
      timestamp: new Date().toISOString(),
      
      // Optional content info
      duration: result.metadata.duration,
      chunks: result.metadata.chunks,
      provider: result.metadata.provider,
      model: result.metadata.model,
      
      // Quality indicators
      confidence,
      wordCount: countWords(result.clean_text || result.transcript),
    },
  };
}

/**
 * Create an error response in normalized format
 */
export function createErrorOutput(
  error: string,
  mode: 'BATSY' | 'FLASH' = 'BATSY'
): NormalizedOutput {
  return {
    transcript: '',
    clean_text: '',
    summary: 'Processing failed',
    key_points: [],
    hooks: [],
    metadata: {
      mode,
      processingTime: 0,
      timestamp: new Date().toISOString(),
      confidence: 0,
      wordCount: 0,
    },
  };
}

/**
 * Validate that output conforms to schema
 */
export function validateOutput(output: Partial<NormalizedOutput>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  
  // Required fields
  if (!output.transcript) {
    errors.push('Missing required field: transcript');
  }
  
  if (!output.clean_text) {
    errors.push('Missing required field: clean_text');
  }
  
  if (!output.summary) {
    errors.push('Missing required field: summary');
  }
  
  if (!Array.isArray(output.key_points)) {
    errors.push('Missing or invalid field: key_points (must be array)');
  }
  
  if (!Array.isArray(output.hooks)) {
    errors.push('Missing or invalid field: hooks (must be array)');
  }
  
  // Metadata validation
  if (!output.metadata) {
    errors.push('Missing required field: metadata');
  } else {
    if (!output.metadata.mode) {
      errors.push('Missing required field: metadata.mode');
    }
    
    if (!output.metadata.processingTime) {
      errors.push('Missing required field: metadata.processingTime');
    }
    
    if (!output.metadata.timestamp) {
      errors.push('Missing required field: metadata.timestamp');
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Convert normalized output to display-friendly format
 */
export function formatForDisplay(output: NormalizedOutput): {
  title: string;
  sections: Array<{ title: string; content: string | string[] }>;
  stats: Record<string, string | number>;
} {
  return {
    title: `Transcript (${output.metadata.mode} Mode)`,
    sections: [
      {
        title: '📝 Clean Transcript',
        content: output.clean_text,
      },
      {
        title: '📋 Summary',
        content: output.summary,
      },
      {
        title: '🔑 Key Points',
        content: output.key_points.length > 0 
          ? output.key_points 
          : ['No key points extracted'],
      },
      {
        title: '🎣 Hooks',
        content: output.hooks.length > 0 
          ? output.hooks 
          : ['No hooks extracted'],
      },
    ],
    stats: {
      'Mode': output.metadata.mode,
      'Duration': output.metadata.duration ? `${output.metadata.duration}s` : 'N/A',
      'Chunks': output.metadata.chunks || 1,
      'Words': output.metadata.wordCount || 0,
      'Confidence': `${Math.round((output.metadata.confidence || 0) * 100)}%`,
      'Time': `${Math.round(output.metadata.processingTime / 1000)}s`,
    },
  };
}
