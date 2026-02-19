import * as fs from 'fs';
import * as path from 'path';
import { LedgerSchema, Position, ClosedPosition, TradeEvent, PositionState, CloseTrigger, CloseCause, NormalizedMarket } from '../types.js';
import { toTick, TICK_SCALE } from '../utils/ticks.js';
import FileLogger from './FileLogger.js';

class LedgerService {
  private static instance: LedgerService;
  private ledgerPath: string;
  private state: LedgerSchema;
  public priceCache: Record<string, { price: number; timestamp: number }> = {};
  private flog: FileLogger;

  private constructor() {
    this.ledgerPath = path.join(process.cwd(), 'data', 'ledger.json');
    this.ensureDirectory();
    this.state = this.loadLedger();
    this.flog = FileLogger.getInstance();
  }

  public static getInstance(): LedgerService {
    if (!LedgerService.instance) LedgerService.instance = new LedgerService();
    return LedgerService.instance;
  }

  private ensureDirectory(): void {
    const dir = path.dirname(this.ledgerPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private loadLedger(): LedgerSchema {
    if (fs.existsSync(this.ledgerPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.ledgerPath, 'utf-8'));
        return {
          balance: data.balance ?? 1000,

          positions: data.positions ?? {},
          closedPositions: data.closedPositions ?? [],
          tradeEvents: data.tradeEvents ?? [],
          marketCache: data.marketCache ?? {},
          processedTxHashes: data.processedTxHashes ?? []
        };
      } catch (e) { console.error('Ledger corrupted, starting fresh'); }
    }
    return { balance: 1000, positions: {}, closedPositions: [], tradeEvents: [], marketCache: {}, processedTxHashes: [] };
  }

  public save(): void {
    fs.writeFileSync(this.ledgerPath, JSON.stringify(this.state, null, 2));
  }

  // --- GETTERS ---
  public getBalance() { return this.state.balance; }
  public getPositions() { return this.state.positions; }
  public getClosedPositions() { return this.state.closedPositions; }
  public getTradeEvents() { return this.state.tradeEvents; }


  // FIX: Accessor for TradingEngine
  public getMarketCache(marketId: string) {
    return this.state.marketCache[marketId];
  }

  public updateMarketCache(id: string, question: string, eventSlug: string, outcomes: string[], clobTokenIds: string[] = [], endTime?: number, model?: NormalizedMarket) {
    // Normalize endTime to milliseconds if it looks like seconds (small integer vs large integer)
    let finalEndTime = endTime;
    if (finalEndTime && finalEndTime < 10000000000) { // Less than 10 billion (seconds < year 2286)
      finalEndTime = finalEndTime * 1000;
    }

    this.state.marketCache[id] = {
      id,
      question,
      eventSlug: eventSlug,
      slug: eventSlug,
      url: `https://polymarket.com/event/${eventSlug}`,
      outcomes: outcomes,
      clobTokenIds,
      endTime: finalEndTime,
      model // SAVE MODEL
    };
    this.save();
  }

  public getDailyStats() {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dailyRealized = this.state.closedPositions
      .filter(p => p.closeTimestamp >= startOfDay)
      .reduce((sum, p) => sum + p.realizedPnL, 0);
    return { dailyRealized };
  }

  public getAllTimeStats() {
    const totalRealized = this.state.closedPositions.reduce((sum, p) => sum + p.realizedPnL, 0);
    return { totalRealized };
  }

  public getTotalUnrealizedPnL() {
    return Object.values(this.state.positions).reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0);
  }



  public updateRealTimePrice(marketId: string, price: number, tokenId?: string) {
    // === CRITICAL FIX: Key cache by tokenId for MULTI markets ===
    // Previously used marketId, but MULTI markets have multiple outcomes/tokens
    // sharing the same marketId, causing cache collisions.
    const cacheKey = tokenId || marketId;
    this.priceCache[cacheKey] = { price, timestamp: Date.now() };

    // FIX: Instantly update active positions to avoid waiting for polling loop
    const keys = Object.keys(this.state.positions);
    let updated = false;
    for (const key of keys) {
      const pos = this.state.positions[key];
      if (pos.marketId === marketId) {
        // 1. If we matched by tokenId, use direct price (Multi-Outcome)
        if (tokenId && pos.tokenId === tokenId) {
          pos.currentPrice = price;
          updated = true;
        }
        // 2. Backward compatibility: Binary side-based inversion
        else if (!tokenId) {
          const exitPrice = pos.side === 'YES' ? price : (1 - price);
          pos.currentPrice = exitPrice;
          updated = true;
        }
        else {
          continue; // Different token in same market
        }


        // UPDATE TICK
        try {
          if (pos.currentPrice !== undefined) {
            pos.currentTick = toTick(pos.currentPrice);
          }
        } catch (e) { }

        pos.currentValue = pos.currentPrice * pos.size;
        pos.unrealizedPnL = pos.currentValue - pos.investedUsd;
      }
    }

    // === CRITICAL FIX: Persist price updates to disk ===
    if (updated) {
      this.save();
    }
  }

  // --- TRADING LOGIC ---
  public updatePosition(
    marketId: string,
    marketName: string,
    marketSlug: string,
    side: 'YES' | 'NO',
    outcomeLabel: string,
    sizeShares: number,
    price: number,
    txHash: string,
    actionReason: string,
    sourcePrice?: number,
    latencyMs?: number,
    tokenId?: string, // NEW
    marketType?: "SINGLE" | "MULTI" // NEW: Step 1 Requirement
  ): boolean {

    if (txHash && this.state.processedTxHashes.includes(txHash)) return false;

    const finalName = marketName || `Market ${marketId.substring(0, 6)}...`;

    // Normalize tick price from input price
    let tickPrice = 0;
    try {
      tickPrice = toTick(price);
    } catch (error) {
      console.error(`[LEDGER] Invalid price for tick conversion: ${price}`);
      tickPrice = Math.floor(price * TICK_SCALE); // Fallback
    }
    // ... (rest of logic) ...
    // (I need to be careful with replace_file_content regular expressions/context. 
    // It might be safer to do 2 separate edits or one big one if I have the context.)
    // Actually, let's look at lines 103-115 for the signature and 201-213 for the object creation.
    // I'll do two chunks in one multi_replace if possible, or just use replace_file_content twice.
    // I'll use separate calls to be safe.

    const costUsd = Math.abs(sizeShares * price);
    const isBuy = sizeShares > 0;

    // NEW ROBUST POSITION KEY: Use tokenId if available, else side-label fallback
    const canonicalKey = tokenId ? `${marketId}-${tokenId}` : `${marketId}-${side}-${outcomeLabel}`;
    let posKey = canonicalKey;
    let existing = this.state.positions[posKey];

    // FALLBACK & MIGRATION: Check for Legacy Key (MarketId-Side)
    if (!existing) {
      const legacyKey = `${marketId}-${side}`;
      if (this.state.positions[legacyKey]) {
        // Found legacy position -> MIGRATE to Canonical Key
        console.log(`[LEDGER] Migrating legacy position ${legacyKey} -> ${canonicalKey}`);
        this.state.positions[canonicalKey] = {
          ...this.state.positions[legacyKey],
          positionId: canonicalKey, // Set new ID
          tokenId: tokenId || this.state.positions[legacyKey].tokenId // Ensure tokenId is set
        };
        delete this.state.positions[legacyKey];

        // Update reference
        posKey = canonicalKey;
        existing = this.state.positions[posKey];
        this.save();
      }
    }

    const markAsProcessed = () => {
      if (txHash) {
        this.state.processedTxHashes.push(txHash);
        this.save();
      }
    };

    if (!isBuy && !existing && actionReason !== 'RESOLUTION') {
      this.flog.ledger('Skipping orphan sell — no position exists', { market: finalName?.substring(0, 40), posKey });
      markAsProcessed();
      return false;
    }

    if (isBuy && this.state.balance < costUsd) {
      this.flog.ledger('Insufficient funds — trade rejected', { market: finalName?.substring(0, 40), costUsd: costUsd.toFixed(2), balance: this.state.balance.toFixed(2) });
      markAsProcessed();
      return false;
    }

    if (isBuy) {
      this.state.balance -= costUsd;

      if (existing) {
        // ... (existing update logic) ...
        const oldShares = existing.size;
        const oldCost = existing.size * existing.entryPrice;
        const newCost = sizeShares * price;

        existing.entryPrice = (oldCost + newCost) / (oldShares + sizeShares);
        // Update average entry tick
        existing.entryTick = toTick(existing.entryPrice);

        existing.size += sizeShares;
        existing.investedUsd = oldCost + newCost;
        existing.marketName = finalName;
        existing.marketSlug = marketSlug;
        existing.outcomeLabel = outcomeLabel;
        existing.tokenId = tokenId || existing.tokenId;
        existing.positionId = existing.positionId || posKey; // Backfill if missing
        existing.state = PositionState.OPEN; // Re-affirm OPEN on buy
      } else {
        this.state.positions[posKey] = {
          marketId, marketName: finalName, marketSlug, side,
          outcomeLabel,
          tokenId,
          positionId: posKey, // Store Canonical ID
          size: sizeShares,
          entryPrice: price,
          entryTick: tickPrice, // STORE TICK
          investedUsd: costUsd,
          realizedPnL: 0,
          state: PositionState.OPEN,
          marketType: marketType // STORE MARKET TYPE
        };
      }
    } else {
      // SELLING / CLOSING
      this.state.balance += costUsd;
      if (!existing) return false;

      // -- STATE CHECK --
      if (existing.state !== PositionState.OPEN && existing.state !== PositionState.CLOSING) {
        console.warn(`[LEDGER] Attempted to modify NON-OPEN position ${posKey} (State: ${existing.state})`);
        return false;
      }

      const sellShares = Math.abs(sizeShares);
      const costBasisOfSold = existing.entryPrice * sellShares;
      const proceeds = sellShares * price;
      const pnl = proceeds - costBasisOfSold;

      existing.size -= sellShares;
      existing.investedUsd -= costBasisOfSold;
      existing.realizedPnL += pnl;

      // FIX: Check if this is a system-triggered settlement vs a trader sell
      const isSettlement = actionReason.includes('RESOLUTION') || actionReason.includes('MARKET_RESOLUTION');

      if (!isSettlement) {
        this.state.tradeEvents.unshift({
          eventId: txHash,
          timestamp: Date.now(),
          marketId, marketName: finalName, marketSlug: marketSlug,
          type: 'SELL',
          side,
          outcomeLabel: outcomeLabel,
          tokenId: tokenId || (existing?.tokenId),
          quantity: Math.abs(sizeShares),
          price,
          usdValue: costUsd,
          sourcePrice,
          latencyMs
        });
      }

      // Check if fully closed (or effectively closed)
      if (existing.size < 0.1) {
        // PARSE ACTION REASON for Trigger/Cause
        // Format expectation: "TRIGGER|CAUSE" or legacy string
        // But we should really pass explicit params. 
        // For now, let's parse the 'actionReason' string if it contains delimiter, 
        // or default to legacy mapping if not.

        let trigger = CloseTrigger.SYSTEM_POLICY;
        let cause = CloseCause.MANUAL_CLOSE;

        if (actionReason.includes('|')) {
          const parts = actionReason.split('|');
          trigger = parts[0] as CloseTrigger;
          cause = parts[1] as CloseCause;
        } else {
          // Backward compatibility / simplified calls
          if (actionReason === 'RESOLUTION') { trigger = CloseTrigger.MARKET_RESOLUTION; cause = CloseCause.WINNER_YES; } // Approximate
          else if (actionReason === 'Why') { /*...*/ }
          // We will enforce the new format in TradingEngine calls.
        }

        const closeTs = Date.now();
        this.state.closedPositions.unshift({
          marketId, marketName: finalName, marketSlug, side,
          outcomeLabel: existing.outcomeLabel || outcomeLabel,
          tokenId: existing.tokenId || tokenId,
          size: sellShares,
          entryPrice: existing.entryPrice,
          entryTick: existing.entryTick, // PRESERVE ENTRY TICK
          exitPrice: price,
          exitTick: tickPrice, // STORE EXIT TICK
          investedUsd: costBasisOfSold,
          returnUsd: proceeds,
          realizedPnL: existing.realizedPnL,
          closeTimestamp: closeTs,
          state: PositionState.CLOSED,
          closeTrigger: trigger,
          closeCause: cause
        });
        this.flog.ledger('POSITION CLOSED', {
          market: finalName?.substring(0, 40), side,
          outcomeLabel: existing.outcomeLabel || outcomeLabel,
          trigger, cause,
          entryPrice: existing.entryPrice?.toFixed(4),
          exitPrice: price?.toFixed(4),
          size: sellShares?.toFixed(2),
          invested: costBasisOfSold?.toFixed(2),
          returned: proceeds?.toFixed(2),
          realizedPnL: existing.realizedPnL?.toFixed(2),
          balance: this.state.balance?.toFixed(2)
        });
        delete this.state.positions[posKey];
      }
    }

    // START_OLD_LOG_BLOCK
    /*
    this.state.tradeEvents.unshift({
      eventId: txHash,
      timestamp: Date.now(),
      marketId, marketName: finalName, marketSlug: marketSlug,
      type: isBuy ? 'BUY' : 'SELL',
      side,
      outcomeLabel: outcomeLabel,
      tokenId: tokenId || (existing?.tokenId),
      quantity: Math.abs(sizeShares),
      price,
      usdValue: costUsd,
      sourcePrice,
      latencyMs
    });
    */
    // END_OLD_LOG_BLOCK

    if (isBuy) {
      this.state.tradeEvents.unshift({
        eventId: txHash,
        timestamp: Date.now(),
        marketId, marketName: finalName, marketSlug: marketSlug,
        type: 'BUY',
        side,
        outcomeLabel: outcomeLabel,
        tokenId: tokenId || (existing?.tokenId),
        quantity: Math.abs(sizeShares),
        price,
        usdValue: costUsd,
        sourcePrice,
        latencyMs
      });
    }

    markAsProcessed();
    return true;
  }

  /**
   * Updates the state of a position (e.g. ACTIVE -> PENDING_RESOLUTION)
   * Persists changes to ledger.json
   */
  public updatePositionState(posKey: string, newState: PositionState): void {
    if (this.state.positions[posKey]) {
      this.state.positions[posKey].state = newState;
      this.save();
    }
  }
}

export default LedgerService;