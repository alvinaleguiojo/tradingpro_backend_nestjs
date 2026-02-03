import { Logger } from '@nestjs/common';

const logger = new Logger('DatabaseUtils');

/**
 * Retry a database operation with exponential backoff
 * Useful for handling transient connection issues in serverless environments
 * Note: MongoDB/Mongoose handles most retries internally, but this can be used for custom retry logic
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    operationName?: string;
  } = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 100,
    maxDelayMs = 2000,
    operationName = 'Database operation',
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      
      // Check if this is a retryable error
      const isRetryable = isRetryableError(error);
      
      if (!isRetryable || attempt === maxRetries) {
        logger.error(
          `${operationName} failed after ${attempt} attempt(s): ${error.message}`,
        );
        throw error;
      }

      // Calculate delay with exponential backoff + jitter
      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100,
        maxDelayMs,
      );

      logger.warn(
        `${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${Math.round(delay)}ms: ${error.message}`,
      );

      await sleep(delay);
    }
  }

  throw lastError || new Error(`${operationName} failed after ${maxRetries} attempts`);
}

/**
 * Check if an error is retryable (connection issues, timeouts, etc.)
 */
export function isRetryableError(error: any): boolean {
  if (!error) return false;

  const message = error.message?.toLowerCase() || '';
  const code = error.code?.toLowerCase() || '';

  const retryablePatterns = [
    'connection terminated',
    'connection timeout',
    'connection refused',
    'econnreset',
    'econnrefused',
    'etimedout',
    'socket hang up',
    'network error',
    'topology was destroyed',
    'serverselectionerror',
    'pool destroyed',
    'connection closed',
  ];

  // Check message patterns
  for (const pattern of retryablePatterns) {
    if (message.includes(pattern)) {
      return true;
    }
  }

  // Check PostgreSQL error codes for connection issues
  const retryableCodes = [
    '08000', // connection_exception
    '08003', // connection_does_not_exist
    '08006', // connection_failure
    '08001', // sqlclient_unable_to_establish_sqlconnection
    '08004', // sqlserver_rejected_establishment_of_sqlconnection
    '57p01', // admin_shutdown
    // MongoDB error codes
    '11600', // InterruptedAtShutdown
    '11601', // Interrupted
    '11602', // InterruptedDueToReplStateChange
  ];

  if (retryableCodes.includes(code)) {
    return true;
  }

  return false;
}

/**
 * Sleep utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
