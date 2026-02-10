import { OrderBook, MarketPrice } from '../types.js';

export interface SlippageEstimate {
  spreadPct: number;
  impactPct: number;
  delayPenalty: number;
  totalSlippage: number;
  d1Percent: number; // Liquidity within 1% of midPrice
  shouldExecute: boolean;
  reason: string;
}

export class SlippageCalculator {
  // Configurable delay penalty (0.2% to 0.5%, default 0.3%)
  private readonly delayPenalty: number = 0.003;

  constructor(delayPenaltyOverride?: number) {
    // Validate delay penalty is within acceptable range
    if (delayPenaltyOverride !== undefined) {
      if (delayPenaltyOverride < 0.002 || delayPenaltyOverride > 0.005) {
        console.warn(
          `[SLIPPAGE] Delay penalty ${(delayPenaltyOverride * 100).toFixed(2)}% outside recommended range (0.2%-0.5%), using default 0.3%`
        );
        (this as any).delayPenalty = 0.003;
      } else {
        (this as any).delayPenalty = delayPenaltyOverride;
      }
    }
  }

  /**
   * Calculate expected slippage based on market conditions and trade parameters.
   *
   * @param marketPrice - Current market price (bestBid, bestAsk, midPrice)
   * @param orderBook - Full order book with bids and asks arrays
   * @param tradeSize - Trade size in USDC
   * @param isBuy - Whether this is a buy order (true) or sell (false)
   * @param expectedEdge - Historical edge of the trader being copied (e.g., 0.06 for 6%)
   * @returns SlippageEstimate with components and execution recommendation
   */
  public calculateExpectedSlippage(
    marketPrice: MarketPrice,
    orderBook: OrderBook,
    tradeSize: number,
    isBuy: boolean,
    expectedEdge: number
  ): SlippageEstimate {
    const { bestBid, bestAsk, midPrice } = marketPrice;

    // ===== VALIDATION & EDGE CASES =====
    if (!orderBook || !orderBook.bids || !orderBook.asks) {
      return {
        spreadPct: Infinity,
        impactPct: Infinity,
        delayPenalty: this.delayPenalty,
        totalSlippage: Infinity,
        d1Percent: 0,
        shouldExecute: false,
        reason: 'Invalid order book structure'
      };
    }

    if (tradeSize <= 0) {
      return {
        spreadPct: 0,
        impactPct: 0,
        delayPenalty: this.delayPenalty,
        totalSlippage: 0,
        d1Percent: 0,
        shouldExecute: false,
        reason: 'Trade size must be positive'
      };
    }

    if (midPrice <= 0) {
      return {
        spreadPct: Infinity,
        impactPct: Infinity,
        delayPenalty: this.delayPenalty,
        totalSlippage: Infinity,
        d1Percent: 0,
        shouldExecute: false,
        reason: 'Invalid market price (midPrice <= 0)'
      };
    }

    if (bestAsk <= 0 || bestBid <= 0) {
      return {
        spreadPct: Infinity,
        impactPct: Infinity,
        delayPenalty: this.delayPenalty,
        totalSlippage: Infinity,
        d1Percent: 0,
        shouldExecute: false,
        reason: 'Invalid bid/ask prices'
      };
    }

    // ===== A. MARKET SPREAD PERCENTAGE =====
    const spreadPct = (bestAsk - bestBid) / midPrice;

    // ===== B. DEPTH-BASED IMPACT =====
    const d1Percent = this.calculateD1Percent(orderBook, bestBid, bestAsk, midPrice, isBuy);

    let impactPct: number;
    if (d1Percent === 0) {
      // Empty book within 1% range - trade would fail
      impactPct = Infinity;
    } else {
      impactPct = tradeSize / d1Percent;
    }

    // ===== C. EXECUTION DELAY PENALTY =====
    const delayPenaltyComponent = this.delayPenalty;

    // ===== TOTAL SLIPPAGE =====
    let totalSlippage: number;
    if (!isFinite(impactPct)) {
      totalSlippage = Infinity;
    } else {
      totalSlippage = spreadPct + impactPct + delayPenaltyComponent;
    }

    // ===== EXECUTION DECISION (2026 OFFICIAL LOGIC) =====
    // New threshold logic: Threshold = Spread + 0.5%
    // Hard cap: If Spread > 15%, SKIP (dead market protection)

    let shouldExecute: boolean;
    let reason: string;

    // Hard cap: reject if spread is too wide (dead market)
    if (spreadPct > 0.15) {
      shouldExecute = false;
      reason = `HARD CAP: Spread ${(spreadPct * 100).toFixed(2)}% > 15% limit (dead market protection)`;
    } else {
      // DYNAMIC CALCULATION: Threshold = Spread + (ExpectedEdge * EdgeFactor)
      // EdgeFactor = 0.4 (40%) gives us a healthy impact budget while maintaining positive EV
      const edgeFactor = 0.4;
      const adaptiveBuffer = expectedEdge * edgeFactor;
      const threshold = spreadPct + adaptiveBuffer;

      shouldExecute = totalSlippage <= threshold && isFinite(totalSlippage);

      reason = !shouldExecute
        ? `Slippage ${(totalSlippage * 100).toFixed(4)}% > Threshold ${(threshold * 100).toFixed(4)}% (Spread+${(adaptiveBuffer * 100).toFixed(2)}% Edge Budget)`
        : `OK - Slippage ${(totalSlippage * 100).toFixed(4)}% <= Threshold ${(threshold * 100).toFixed(4)}% (Spread+${(adaptiveBuffer * 100).toFixed(2)}% Edge Budget)`;
    }

    return {
      spreadPct,
      impactPct: isFinite(impactPct) ? impactPct : Infinity,
      delayPenalty: delayPenaltyComponent,
      totalSlippage,
      d1Percent,
      shouldExecute,
      reason
    };
  }

  /**
   * Calculate total liquidity (in USDC) available within 1% of the midPrice.
   *
   * For BUY orders: Sum all asks where price <= bestAsk * 1.01
   * For SELL orders: Sum all bids where price >= bestBid * 0.99
   *
   * @private
   */
  private calculateD1Percent(
    orderBook: OrderBook,
    bestBid: number,
    bestAsk: number,
    midPrice: number,
    isBuy: boolean
  ): number {
    let totalLiquidity = 0;

    if (isBuy) {
      // BUY: Calculate USDC from asks within 1% above bestAsk
      const askThreshold = bestAsk * 1.01;
      for (const level of orderBook.asks) {
        if (level.price <= askThreshold) {
          // USDC = price * size
          totalLiquidity += level.price * level.size;
        }
      }
    } else {
      // SELL: Calculate USDC from bids within 1% below bestBid
      const bidThreshold = bestBid * 0.99;
      for (const level of orderBook.bids) {
        if (level.price >= bidThreshold) {
          // USDC = price * size
          totalLiquidity += level.price * level.size;
        }
      }
    }

    return totalLiquidity;
  }

  /**
   * Convenience method to check if a trade should execute.
   * Use this directly in your placeOrder logic.
   *
   * @param slippageEstimate - Result from calculateExpectedSlippage()
   * @returns true if trade should execute, false otherwise
   */
  public shouldExecuteTrade(slippageEstimate: SlippageEstimate): boolean {
    return slippageEstimate.shouldExecute;
  }

  /**
   * Get a detailed log message about the slippage calculation.
   */
  public getDetailedLog(
    slippageEstimate: SlippageEstimate,
    marketId: string,
    tradeSize: number,
    expectedEdge: number
  ): string {
    const totalSlippage = isFinite(slippageEstimate.totalSlippage)
      ? (slippageEstimate.totalSlippage * 100).toFixed(2)
      : 'INF';

    return `[SLIPPAGE] Market: ${marketId.substring(0, 8)}... | Slippage: ${totalSlippage}% | Skip: ${slippageEstimate.reason}`;
  }
}

export default SlippageCalculator;
