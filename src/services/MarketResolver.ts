/**
 * Market Resolver Service
 *
 * Polls Polymarket CLOB API and UMA CTF Adapter to check actual market resolution status
 * instead of relying on price-based detection ($0.99 / $0.01 thresholds)
 */

import PolymarketService from './PolymarketService.js';
import RetryHelper from './RetryHelper.js';
import config from '../config/config.js';

export interface MarketResolutionStatus {
  marketId: string;
  isResolved: boolean;
  winningSide?: 'YES' | 'NO' | null;
  winningOutcomeLabel?: string;      // Multi-Outcome Support
  winningOutcomeIndex?: number;      // Multi-Outcome Support
  settlementPrice?: number;
  resolvedAt?: number;
  source: 'clob' | 'metadata' | 'fallback';
  confidence: 'high' | 'medium' | 'low';
  marketSlug?: string;
}

export class MarketResolver {
  private api: PolymarketService;
  private retryHelper: RetryHelper;
  private resolutionCache: Map<string, MarketResolutionStatus>;
  private cacheExpiryMs: number = 60000; // 1 minute cache
  private lastCacheUpdate: Map<string, number>;

  constructor() {
    this.api = PolymarketService.getInstance();
    this.retryHelper = new RetryHelper({
      maxAttempts: 2,
      baseDelayMs: 300,
      maxDelayMs: 3000
    });
    this.resolutionCache = new Map();
    this.lastCacheUpdate = new Map();
  }

  /**
   * Check if a market is resolved
   * Uses multiple data sources with fallback chain
   */
  public async checkResolution(marketId: string): Promise<MarketResolutionStatus> {
    // Check cache first
    const cached = this.getFromCache(marketId);
    if (cached) {
      console.debug(`[RESOLVER] Using cached resolution for ${marketId.substring(0, 8)}...`);
      return cached;
    }

    // Try primary sources
    let resolution = await this.checkViaMetadata(marketId);
    if (resolution.confidence === 'high' || resolution.confidence === 'medium') {
      this.cacheResolution(marketId, resolution);
      return resolution;
    }

    // Fallback: Check via order book (price-based)
    // SMART LOGIC: Only allow price-based resolution for 15m markets (Fast markets)
    // For 2026/Long-term markets, we strictly wait for metadata (Safety)
    // SMART LOGIC: Only allow price-based resolution for 15m markets (Fast markets)
    // BUT: Explicitly exclude Weather markets (which often sit at 99% odds)
    const is15m = resolution.marketSlug && resolution.marketSlug.includes('15m');
    const isWeather = (resolution.marketSlug && resolution.marketSlug.includes('weather')) ||
      (resolution.marketSlug && resolution.marketSlug.includes('rain')) ||
      (resolution.marketSlug && resolution.marketSlug.includes('temperature'));

    // CRITICAL: Disabling price-based resolution. Reliability > Speed.
    // Markets can touch 0.99/0.01 and revert. We must wait for official resolution.
    const allowPriceResolution = false; // Previously: Boolean(is15m && !isWeather);

    const fallbackResolution = await this.checkViaOrderBook(marketId, allowPriceResolution);

    // If fallback found something, return it
    if (fallbackResolution.isResolved) {
      this.cacheResolution(marketId, fallbackResolution);
      return fallbackResolution;
    }

    // Otherwise return the metadata result (which was likely unresolved)
    this.cacheResolution(marketId, resolution);
    return resolution;
  }

  /*
   * Robustly determine the winner using Normalized Model or Fallbacks
   */
  private determineWinningOutcome(details: any): { label: string | null, index: number | null, side: 'YES' | 'NO' | null } {
    const model = details.model;

    // 1. Check if we have a Normalized Model (Preferred for Multi-Outcome)
    // 1. Check if we have a Normalized Model (Preferred for Multi-Outcome)
    if (model && model.outcomes) {
      // Check 'winner' field in raw details (Legacy / Specific format) - PRIORITIZE
      if (details.winner) {
        const w = String(details.winner).toUpperCase();
        return { label: w, index: -1, side: (w === 'YES' ? 'YES' : (w === 'NO' ? 'NO' : null)) };
      }

      // Check outcome prices (e.g. ["0", "0", "1"])
      if (details.outcomePrices) {
        try {
          const prices = JSON.parse(details.outcomePrices);
          if (Array.isArray(prices)) {
            // Find index with price 1 (Strictly settled)
            // We use 0.999 to avoid floating point issues but essentially strict
            const winIdx = prices.findIndex((p: any) => Number(p) >= 0.999);
            if (winIdx !== -1) {
              const label = model.outcomes[winIdx]?.label || null;
              // Map to legacy side if binary
              let side: 'YES' | 'NO' | null = null;
              if (model.type === 'binary') {
                if (winIdx === 1) side = 'YES'; // Index 1 is usually Yes
                if (winIdx === 0) side = 'NO';
              }
              return { label, index: winIdx, side };
            }
          }
        } catch (e) { }
      }
    }

    // 2. Fallback to Legacy Logic (if no model)
    // Check explicit winner field
    if (details.winner) {
      const w = String(details.winner).toUpperCase();
      if (w === 'YES' || w === '1' || w === 'TRUE') return { label: 'Yes', index: 1, side: 'YES' };
      if (w === 'NO' || w === '0' || w === 'FALSE') return { label: 'No', index: 0, side: 'NO' };
    }

    // Check legacy resolvedBy logic
    if (details.resolved && details.resolvedBy) {
      if ((details as any).winner === 'YES' || (details as any).winner === '1') return { label: 'Yes', index: 1, side: 'YES' };
      if ((details as any).winner === 'NO' || (details as any).winner === '0') return { label: 'No', index: 0, side: 'NO' };
    }

    // Check outcome prices (Legacy binary assumption)
    if (details.outcomePrices) {
      try {
        const prices = JSON.parse(details.outcomePrices);
        if (Array.isArray(prices) && prices.length === 2) {
          if (Number(prices[0]) >= 0.999) return { label: 'No', index: 0, side: 'NO' };
          if (Number(prices[1]) >= 0.999) return { label: 'Yes', index: 1, side: 'YES' };
        }
      } catch (e) { }
    }

    return { label: null, index: null, side: null };
  }

  /**
   * Primary source: Check market metadata from Gamma API
   * Most reliable way to detect if market is officially resolved
   */
  private async checkViaMetadata(marketId: string): Promise<MarketResolutionStatus> {
    const result = await this.retryHelper.execute(
      async () => {
        const details = await this.api.getMarketDetails(marketId);
        return details;
      },
      `Check market metadata for ${marketId.substring(0, 8)}...`,
      (err) => {
        // Only retry on network errors, not on 404
        const msg = err.message.toLowerCase();
        return msg.includes('network') || msg.includes('timeout') || msg.includes('5');
      }
    );

    if (!result.success || !result.data) {
      if (config.DEBUG_LOGS) console.debug(`[RESOLVER] Metadata check failed for ${marketId.substring(0, 8)}...`);
      return {
        marketId,
        isResolved: false,
        source: 'metadata',
        confidence: 'low'
      };
    }

    const details = result.data;
    const slug = details.slug || '';

    // Determine winner using new robust logic
    const winInfo = this.determineWinningOutcome(details);

    // Official Resolution OR Closed with clear winner OR Market with definitive price
    // We allow active markets to resolve if the price/winner is definitive.
    if (details.resolved || winInfo.label || winInfo.index !== null || winInfo.side) {
      if (config.DEBUG_LOGS) console.log(`[RESOLVER] ${details.slug} -> Resolved/Closed. Winner: ${winInfo.label || winInfo.side}`);
      return {
        marketId,
        isResolved: true,
        winningSide: winInfo.side,
        winningOutcomeLabel: winInfo.label || undefined,
        winningOutcomeIndex: winInfo.index !== null ? winInfo.index : undefined,
        source: 'metadata',
        confidence: 'high',
        resolvedAt: Date.now(),
        marketSlug: details.slug
      };
    }

    // Check if closed (accepting no more trades, but not yet resolved)
    if (details.closed) {
      if (config.DEBUG_LOGS) console.log(`[RESOLVER] Market ${marketId.substring(0, 8)}... is CLOSED (waiting for resolution)`);
      return {
        marketId,
        isResolved: false,
        source: 'metadata',
        confidence: 'high',
        resolvedAt: undefined,
        marketSlug: slug
      };
    }

    return {
      marketId,
      isResolved: false,
      source: 'metadata',
      confidence: 'medium',
      marketSlug: slug
    };
  }


  /**
   * Secondary source: Check order book prices
   * Disabled per user requirement to only use official metadata.
   */
  private async checkViaOrderBook(marketId: string, allowResolution: boolean): Promise<MarketResolutionStatus> {
    return {
      marketId,
      isResolved: false,
      source: 'fallback',
      confidence: 'low'
    };
  }

  /**
   * Determine which side won based on market metadata
   */
  private determineWinningSide(details: any): 'YES' | 'NO' | null {
    // Only trust official resolution metadata (winner fields)
    if (details.resolved && details.resolvedBy) {
      if ((details as any).winner === 'YES' || (details as any).winner === '1') return 'YES';
      if ((details as any).winner === 'NO' || (details as any).winner === '0') return 'NO';
    }

    return null;
  }

  /**
   * Cache resolution result
   */
  private cacheResolution(marketId: string, resolution: MarketResolutionStatus): void {
    this.resolutionCache.set(marketId, resolution);
    this.lastCacheUpdate.set(marketId, Date.now());
  }

  /**
   * Get cached resolution if still valid
   */
  private getFromCache(marketId: string): MarketResolutionStatus | null {
    const lastUpdate = this.lastCacheUpdate.get(marketId);
    if (!lastUpdate) return null;

    const cached = this.resolutionCache.get(marketId);
    if (!cached) return null;

    const isResolved = cached.isResolved;
    const expiry = isResolved ? 60000 : 5000;

    const ageMs = Date.now() - lastUpdate;
    if (ageMs > expiry) {
      this.resolutionCache.delete(marketId);
      this.lastCacheUpdate.delete(marketId);
      return null;
    }

    return cached;
  }

  /**
   * Clear all caches
   */
  public clearCache(): void {
    this.resolutionCache.clear();
    this.lastCacheUpdate.clear();
  }
}

export default MarketResolver;
