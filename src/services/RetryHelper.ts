/**
 * Retry Helper with Exponential Backoff
 *
 * Implements "Newbie Tip" safety layer:
 * - Wraps API calls with automatic retry logic
 * - Exponential backoff: wait time = baseDelayMs * (2 ^ attemptNumber)
 * - Logs errors without crashing
 * - Returns null on final failure instead of throwing
 */

import config from '../config/config.js';

export interface RetryConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  exponentialBase?: number;
}

export interface RetryResult<T> {
  success: boolean;
  data: T | null;
  error: Error | null;
  attempts: number;
  totalTimeMs: number;
}

export class RetryHelper {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly exponentialBase: number;

  constructor(config: RetryConfig = {}) {
    this.maxAttempts = config.maxAttempts ?? 3;
    this.baseDelayMs = config.baseDelayMs ?? 500;
    this.maxDelayMs = config.maxDelayMs ?? 10000;
    this.exponentialBase = config.exponentialBase ?? 2;
  }

  /**
   * Execute an async function with retry logic
   *
   * @param fn - Async function to execute
   * @param operationName - Name for logging
   * @param shouldRetry - Optional function to determine if error is retryable
   * @returns Retry result with data, error, and attempt info
   */
  public async execute<T>(
    fn: () => Promise<T>,
    operationName: string,
    shouldRetry?: (error: Error) => boolean
  ): Promise<RetryResult<T>> {
    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        if (config.DEBUG_LOGS) console.debug(`[RETRY] Attempt ${attempt}/${this.maxAttempts}: ${operationName}`);
        const data = await fn();

        const totalTimeMs = Date.now() - startTime;
        if (config.DEBUG_LOGS) console.debug(
          `[RETRY ✓] ${operationName} succeeded after ${attempt} attempt(s) in ${totalTimeMs}ms`
        );

        return {
          success: true,
          data,
          error: null,
          attempts: attempt,
          totalTimeMs
        };
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Check if we should retry
        const isRetryable = shouldRetry ? shouldRetry(lastError) : this.isRetryableError(lastError);

        if (attempt === this.maxAttempts) {
          // Final attempt failed
          const totalTimeMs = Date.now() - startTime;
          console.error(
            `[RETRY ✗] ${operationName} failed after ${this.maxAttempts} attempts in ${totalTimeMs}ms: ${lastError.message}`
          );

          return {
            success: false,
            data: null,
            error: lastError,
            attempts: attempt,
            totalTimeMs
          };
        }

        if (!isRetryable) {
          // Non-retryable error, fail immediately
          const totalTimeMs = Date.now() - startTime;
          console.warn(
            `[RETRY ✗] Non-retryable error in ${operationName} after ${attempt} attempt(s): ${lastError.message}`
          );

          return {
            success: false,
            data: null,
            error: lastError,
            attempts: attempt,
            totalTimeMs
          };
        }

        // Wait before retrying
        const delayMs = this.calculateDelay(attempt);
        console.warn(
          `[RETRY] ${operationName} attempt ${attempt} failed: ${lastError.message}. Retrying in ${delayMs}ms...`
        );

        await this.sleep(delayMs);
      }
    }

    // Should not reach here, but return error as fallback
    const totalTimeMs = Date.now() - startTime;
    return {
      success: false,
      data: null,
      error: lastError,
      attempts: this.maxAttempts,
      totalTimeMs
    };
  }

  /**
   * Determine if an error is retryable
   * Retryable: Network errors, timeouts, 5xx server errors
   * Non-retryable: 4xx client errors, auth errors
   */
  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();

    // Network and timeout errors
    if (
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('fetch') ||
      message.includes('aborted') ||
      message.includes('temporarily') ||
      message.includes('unavailable')
    ) {
      return true;
    }

    // 5xx server errors
    if (message.includes('500') || message.includes('502') || message.includes('503')) {
      return true;
    }

    // DNS errors
    if (message.includes('enotfound') || message.includes('getaddrinfo')) {
      return true;
    }

    return false;
  }

  /**
   * Calculate delay for exponential backoff
   * Formula: min(baseDelay * (base ^ attempt), maxDelay)
   */
  private calculateDelay(attempt: number): number {
    const exponentialDelay = this.baseDelayMs * Math.pow(this.exponentialBase, attempt - 1);
    return Math.min(exponentialDelay, this.maxDelayMs);
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default RetryHelper;
