export interface NormalizedOutcome {
  tokenId: string;
  label: string;
  price: number;
  isWinner?: boolean;
}

export interface NormalizedMarket {
  id: string;
  question: string;
  slug: string;
  type: 'binary' | 'multi';
  outcomes: NormalizedOutcome[];
  isResolved: boolean;
  endDate?: number;
}

export interface MarketMetadata {
  id: string;
  question: string;
  eventSlug: string;
  slug: string;
  url: string;
  outcomes: string[]; // ["No", "Yes"] or ["Trump", "Harris"]
  clobTokenIds?: string[];
  endTime?: number;

  // New Fields for Resolution Logic
  resolved?: boolean;
  outcomeStatuses?: string[];
  winnerTokenId?: string;
  winner?: string;

  // New Normalized Field
  model?: NormalizedMarket;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface MarketPrice {
  bestBid: number;
  bestAsk: number;
  midPrice: number;
}

// --- POSITION LIFECYCLE ENUMS ---
export enum PositionState {
  OPEN = 'OPEN',
  CLOSING = 'CLOSING', // Transient state during execution
  CLOSED = 'CLOSED',
  SETTLED = 'SETTLED',
  INVALIDATED = 'INVALIDATED'
}

export enum CloseTrigger {
  MARKET_RESOLUTION = 'MARKET_RESOLUTION', // Priority 1
  SYSTEM_GUARD = 'SYSTEM_GUARD',           // Priority 2
  USER_ACTION = 'USER_ACTION',             // Priority 3
  COPY_TRADER_EVENT = 'COPY_TRADER_EVENT', // Priority 4
  SYSTEM_POLICY = 'SYSTEM_POLICY',         // Priority 5
  TIMEOUT = 'TIMEOUT'                      // Priority 6
}

export enum CloseCause {
  WINNER_YES = 'WINNER_YES',
  WINNER_NO = 'WINNER_NO',
  SELL = 'SELL',
  MANUAL_CLOSE = 'MANUAL_CLOSE',
  MARKET_EXPIRED = 'MARKET_EXPIRED',
  NO_LIQUIDITY = 'NO_LIQUIDITY',
  COPY_DESYNC = 'COPY_DESYNC',
  SESSION_ROLLOVER = 'SESSION_ROLLOVER',
  TIMEOUT = 'TIMEOUT',
  TARGET_SELLOFF = 'TARGET_SELLOFF'
}

export interface Position {
  marketId: string;
  marketName: string;
  marketSlug: string;
  side: 'YES' | 'NO';
  outcomeLabel: string;
  tokenId?: string; // NEW: Unique identifier for the outcome token
  size: number;
  entryPrice: number;
  investedUsd: number;
  realizedPnL: number;
  currentPrice?: number;
  currentValue?: number;
  unrealizedPnL?: number;

  // LIFECYCLE STATE
  state: PositionState;
  closeTrigger?: CloseTrigger;
  closeCause?: CloseCause;
  closePriority?: number;
  lastEntryTime?: number; // timestamp of entry for min hold check
}

export interface ClosedPosition {
  marketId: string;
  marketName: string;
  marketSlug: string;
  side: 'YES' | 'NO';
  outcomeLabel: string;
  tokenId?: string; // NEW
  entryPrice: number;
  exitPrice: number;
  size: number;
  investedUsd: number;
  returnUsd: number;
  realizedPnL: number;

  closeTimestamp: number;

  // PRESERVED STATE
  state: PositionState;
  closeTrigger: CloseTrigger;
  closeCause: CloseCause;
}

export interface TradeEvent {
  eventId: string;
  timestamp: number;
  marketId: string;
  marketName: string;
  marketSlug: string;
  type: 'BUY' | 'SELL';
  side: 'YES' | 'NO';
  outcomeLabel: string;
  tokenId?: string; // NEW
  price: number;
  quantity: number;
  usdValue: number;

  sourcePrice?: number; // Price source profile traded at
  latencyMs?: number; // Time difference between source trade and bot execution
}

export interface LedgerSchema {
  balance: number;

  positions: Record<string, Position>;
  closedPositions: ClosedPosition[];
  tradeEvents: TradeEvent[];
  marketCache: Record<string, MarketMetadata>;
  processedTxHashes: string[];
}

export enum TradeAmountMode {
  PERCENTAGE = 'PERCENTAGE',
  FIXED = 'FIXED'
}

export interface TradeAmountSettings {
  mode: TradeAmountMode;
  percentage: number; // 0.10 for 10%
  fixedAmountUsd: number; // 10 for $10
}