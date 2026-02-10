import * as fs from 'fs';
import * as path from 'path';
import { LedgerSchema, Position, ClosedPosition, TradeEvent, PositionState, CloseTrigger, CloseCause } from '../types.js';

class LedgerService {
  private static instance: LedgerService;
  private ledgerPath: string;
  private state: LedgerSchema;
  public priceCache: Record<string, number> = {};

  private constructor() {
    this.ledgerPath = path.join(process.cwd(), 'data', 'ledger.json');
    this.ensureDirectory();
    this.state = this.loadLedger();
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

  private save(): void {
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

  public updateMarketCache(id: string, question: string, eventSlug: string, outcomes: string[], clobTokenIds: string[] = [], endTime?: number) {
    this.state.marketCache[id] = {
      id,
      question,
      eventSlug: eventSlug,
      slug: eventSlug,
      url: `https://polymarket.com/event/${eventSlug}`,
      outcomes: outcomes,
      clobTokenIds,
      endTime
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



  public updateRealTimePrice(marketId: string, price: number) {
    this.priceCache[marketId] = price;

    // FIX: Instantly update active positions to avoid waiting for polling loop
    const keys = Object.keys(this.state.positions);
    for (const key of keys) {
      const pos = this.state.positions[key];
      if (pos.marketId === marketId) {
        // Calculate Exit Price based on Side
        const exitPrice = pos.side === 'YES' ? price : (1 - price);

        pos.currentPrice = exitPrice;
        pos.currentValue = exitPrice * pos.size;
        pos.unrealizedPnL = pos.currentValue - pos.investedUsd;
      }
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
    latencyMs?: number
  ): boolean {

    if (txHash && this.state.processedTxHashes.includes(txHash)) return false;

    const finalName = marketName || `Market ${marketId.substring(0, 6)}...`;
    // ... (rest of logic) ...
    // (I need to be careful with replace_file_content regular expressions/context. 
    // It might be safer to do 2 separate edits or one big one if I have the context.)
    // Actually, let's look at lines 103-115 for the signature and 201-213 for the object creation.
    // I'll do two chunks in one multi_replace if possible, or just use replace_file_content twice.
    // I'll use separate calls to be safe.

    const costUsd = Math.abs(sizeShares * price);
    const isBuy = sizeShares > 0;
    const posKey = `${marketId}-${side}`;
    const existing = this.state.positions[posKey];

    const markAsProcessed = () => {
      if (txHash) {
        this.state.processedTxHashes.push(txHash);
        this.save();
      }
    };

    if (!isBuy && !existing && actionReason !== 'RESOLUTION') {
      // console.log(`[LEDGER] Skipping Orphan Sell: ${finalName}`);
      markAsProcessed();
      return false;
    }

    if (isBuy && this.state.balance < costUsd) {
      // console.log(`[LEDGER] Insufficient Funds for ${finalName}`);
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
        existing.size += sizeShares;
        existing.investedUsd = oldCost + newCost;
        existing.marketName = finalName;
        existing.marketSlug = marketSlug;
        existing.outcomeLabel = outcomeLabel;
        existing.state = PositionState.OPEN; // Re-affirm OPEN on buy
      } else {
        this.state.positions[posKey] = {
          marketId, marketName: finalName, marketSlug, side,
          outcomeLabel,
          size: sizeShares,
          entryPrice: price,
          investedUsd: costUsd,
          realizedPnL: 0,
          state: PositionState.OPEN
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

        this.state.closedPositions.unshift({
          marketId, marketName: finalName, marketSlug, side,
          outcomeLabel: existing.outcomeLabel || outcomeLabel,
          size: sellShares,
          entryPrice: existing.entryPrice,
          exitPrice: price,
          investedUsd: costBasisOfSold,
          returnUsd: proceeds,
          realizedPnL: existing.realizedPnL,
          closeTimestamp: Date.now(),
          state: PositionState.CLOSED,
          closeTrigger: trigger,
          closeCause: cause
        });
        delete this.state.positions[posKey];
      }
    }



    this.state.tradeEvents.unshift({
      eventId: txHash,
      timestamp: Date.now(),
      marketId, marketName: finalName, marketSlug: marketSlug,
      type: isBuy ? 'BUY' : 'SELL',
      side,
      outcomeLabel: outcomeLabel,
      quantity: Math.abs(sizeShares),
      price,
      usdValue: costUsd,
      sourcePrice,
      latencyMs
    });

    markAsProcessed();
    return true;
  }
}

export default LedgerService;