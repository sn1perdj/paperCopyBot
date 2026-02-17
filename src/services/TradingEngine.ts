import * as fs from 'fs';
import * as path from 'path';
import config from '../config/config.js';
import LedgerService from '../services/LedgerService.js';
import PolymarketService from './PolymarketService.js';
import SlippageCalculator from './SlippageCalculator.js';
import { MarketLifecycle, MarketLifecycleResult } from './MarketLifecycle.js'; // NEW
import RetryHelper from './RetryHelper.js';
import PositionFilter from './PositionFilter.js';
import { PositionState, CloseTrigger, CloseCause, TradeAmountMode, TradeAmountSettings, NormalizedMarket, NormalizedOutcome } from '../types.js';
import FeatureSwitches from '../config/switches.js';
import { toTick, fromTick, clampTick, TICK_SCALE, MAX_TICK } from '../utils/ticks.js';

class TradingEngine {
    private static instance: TradingEngine;
    private ledger: LedgerService;
    private api: PolymarketService;
    private slippageCalculator: SlippageCalculator;
    // private marketResolver: MarketResolver; // REMOVED
    private retryHelper: RetryHelper;
    private positionFilter: PositionFilter;
    private isPolling = false;
    // Initialize startup time based on config preference
    private botStartupTime: number = config.START_FROM_NOW
        ? Date.now()
        : Date.now() - (10 * 60 * 1000);

    private tradeSettings: TradeAmountSettings;
    private settingsPath: string;

    private constructor() {
        this.ledger = LedgerService.getInstance();
        this.api = PolymarketService.getInstance();
        this.slippageCalculator = new SlippageCalculator(config.SLIPPAGE_DELAY_PENALTY);
        // this.marketResolver = new MarketResolver(); // DEPRECATED
        this.retryHelper = new RetryHelper({ maxAttempts: 3, baseDelayMs: 300 });
        this.positionFilter = new PositionFilter();

        // Initialize Default Settings
        this.tradeSettings = {
            mode: TradeAmountMode.PERCENTAGE,
            percentage: config.FIXED_COPY_PCT,
            fixedAmountUsd: 10 // Default fallback
        };

        this.settingsPath = path.join(process.cwd(), 'trade_settings.json');
        this.loadSettings();
    }

    public static getInstance() {
        if (!TradingEngine.instance) TradingEngine.instance = new TradingEngine();
        return TradingEngine.instance;
    }

    // --- PUBLIC CONTROL METHODS ---
    public getPollingStatus(): boolean { return this.isPolling; }

    public stopPolling(): void {
        if (this.isPolling) {
            this.isPolling = false;
            console.log('[ENGINE] Stopping polling loop...');
        }
    }

    public getTradeSettings(): TradeAmountSettings {
        return this.tradeSettings;
    }

    public setTradeSettings(settings: Partial<TradeAmountSettings>) {
        this.tradeSettings = { ...this.tradeSettings, ...settings };
        this.saveSettings();
        console.log(`[ENGINE] Updated Trade Settings: Mode=${this.tradeSettings.mode}, Pct=${this.tradeSettings.percentage}, Fixed=$${this.tradeSettings.fixedAmountUsd}`);
    }

    private loadSettings() {
        // Migration: Check if old file exists in data/ and move it
        const oldPath = path.join(process.cwd(), 'data', 'trade_settings.json');
        if (!fs.existsSync(this.settingsPath) && fs.existsSync(oldPath)) {
            try {
                console.log('[ENGINE] Migrating trade_settings.json from data/ to root...');
                fs.renameSync(oldPath, this.settingsPath);
            } catch (e) {
                console.error('[ENGINE] Failed to migrate settings file:', e);
            }
        }

        if (fs.existsSync(this.settingsPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.settingsPath, 'utf-8'));
                // Merge with defaults to ensure all fields exist
                this.tradeSettings = { ...this.tradeSettings, ...data };
                console.log(`[ENGINE] Loaded settings from ${this.settingsPath}`);
            } catch (e) {
                console.error('[ENGINE] Failed to load trade settings:', e);
            }
        }
    }

    private saveSettings() {
        try {
            const dir = path.dirname(this.settingsPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.settingsPath, JSON.stringify(this.tradeSettings, null, 2));
        } catch (e) {
            console.error('[ENGINE] Failed to save trade settings:', e);
        }
    }

    public async closeAllPositions(): Promise<void> {
        console.log('[ENGINE] 🚨 CLOSING ALL POSITIONS...');
        const positions = Object.values(this.ledger.getPositions());
        if (positions.length === 0) {
            console.log('[ENGINE] No positions to close.');
            return;
        }
        for (const pos of positions) {
            try {
                console.log(`[ENGINE] Closing ${pos.marketName}...`);
                await this.tryClosePosition(
                    pos.marketId,
                    pos.side,
                    CloseTrigger.USER_ACTION,
                    CloseCause.MANUAL_CLOSE,
                    undefined,
                    pos.tokenId,
                    pos.outcomeLabel
                );
                await new Promise(r => setTimeout(r, 200));
            } catch (e) {
                console.error(`[ENGINE] Failed to close ${pos.marketName}`, e);
            }
        }
        console.log('[ENGINE] ✅ All positions closed.');
    }

    // --- PRIORITY SYSTEM ---
    private getPriority(trigger: CloseTrigger): number {
        switch (trigger) {
            case CloseTrigger.MARKET_RESOLUTION: return 1;
            case CloseTrigger.SYSTEM_GUARD: return 2;
            case CloseTrigger.USER_ACTION: return 3;
            case CloseTrigger.COPY_TRADER_EVENT: return 4;
            case CloseTrigger.SYSTEM_POLICY: return 5;
            case CloseTrigger.TIMEOUT: return 6;
            default: return 99;
        }
    }

    /**
     * CENTRALIZED CLOSE LOGIC
     * Handles prioritization, state checks, and execution.
     */
    public async tryClosePosition(
        marketId: string,
        side: 'YES' | 'NO',
        trigger: CloseTrigger,
        cause: CloseCause,
        forcePrice?: number,
        tokenId?: string,
        outcomeLabel?: string
    ): Promise<void> {
        // NEW ROBUST POSITION KEY: Matches LedgerService logic
        let posKey = tokenId ? `${marketId}-${tokenId}` : `${marketId}-${side}-${outcomeLabel}`;
        let pos = this.ledger.getPositions()[posKey];

        // FALLBACK: Legacy Key Check
        if (!pos) {
            const legacyKey = `${marketId}-${side}`;
            if (this.ledger.getPositions()[legacyKey]) {
                posKey = legacyKey;
                pos = this.ledger.getPositions()[posKey];
            }
        }

        // 1. EXISTENCE CHECK
        if (!pos) {
            console.warn(`[CLOSE-FAIL] Position not found: ${posKey}`);
            return;
        }

        // 2. STATE CHECK
        // Allow close if OPEN, or if PENDING_RESOLUTION and it's a RESOLUTION trigger
        const isAllowedState =
            pos.state === PositionState.OPEN ||
            (pos.state === PositionState.PENDING_RESOLUTION && trigger === CloseTrigger.MARKET_RESOLUTION);

        if (!isAllowedState) {
            console.log(`[CLOSE-IGNORE] ${posKey} is ${pos.state}. Ignoring ${trigger}/${cause}`);
            return;
        }

        // 2b. MINIMUM HOLD DURATION CHECK (Prevent Flash Closes)
        // Except for USER ACTION or CONFIRMED RESOLUTION
        if (trigger !== CloseTrigger.USER_ACTION && trigger !== CloseTrigger.MARKET_RESOLUTION) {
            const minHoldMs = 5000; // 5 seconds
            const holdingTime = Date.now() - (pos.lastEntryTime || 0);
            if (holdingTime < minHoldMs) {
                if (config.DEBUG_LOGS) console.warn(`[CLOSE-BLOCK] Holding time ${holdingTime}ms < ${minHoldMs}ms for ${posKey}. Ignoring ${trigger}.`);
                return;
            }
        }

        // 3. PRIORITY CHECK
        const incomingPriority = this.getPriority(trigger);
        if (pos.closePriority !== undefined && incomingPriority > pos.closePriority) {
            console.log(`[CLOSE-IGNORE] Incoming priority ${incomingPriority} is lower priority (numerically higher) than existing ${pos.closePriority} for ${posKey}`);
            return;
        }

        // 4. PRICE DETERMINATION (If not forced)
        let exitPrice = forcePrice || 0;
        if (exitPrice === 0) {
            try {
                // Resolution / Guard: Use authoritative or best effort
                if (trigger === CloseTrigger.MARKET_RESOLUTION) {
                    exitPrice = (cause === CloseCause.WINNER_YES && side === 'YES') ||
                        (cause === CloseCause.WINNER_NO && side === 'NO') ? 1.0 : 0.0;
                } else {
                    // Market-based close
                    const marketPrice = await this.api.getLivePrice(marketId);
                    if (marketPrice) {
                        exitPrice = side === 'YES' ? marketPrice.bestBid : (1 - marketPrice.bestAsk);
                    } else {
                        exitPrice = pos.currentPrice || 0; // Fallback
                    }
                }
            } catch (e) {
                exitPrice = pos.currentPrice || 0;
            }
        }

        exitPrice = Math.max(0, Math.min(1, exitPrice)); // Clamp 0-1

        // 5. UPDATE STATE TO CLOSING (Transient)
        // In a real DB this would be atomic. Here we just set object prop.
        pos.state = PositionState.CLOSING;
        pos.closePriority = incomingPriority;
        pos.closeTrigger = trigger;
        pos.closeCause = cause;

        console.log(`[CLOSE-EXEC] ${trigger} | ${cause} | ${posKey} @ $${exitPrice.toFixed(2)}`);

        // 6. EXECUTE LEDGER UPDATE
        // We pass the "Reason" string in the format "TRIGGER|CAUSE" to match LedgerService parsing logic
        const reasonStr = `${trigger}|${cause}`;

        try {
            const updateOk = this.ledger.updatePosition(
                marketId, pos.marketName, pos.marketSlug, side,
                pos.outcomeLabel,
                -pos.size,
                exitPrice,
                `${trigger}-${Date.now()}`,
                reasonStr,
                0, // sourcePrice - N/A for close
                0, // latencyMs - N/A for close
                pos.tokenId, // NEW: REQUIRED for position lookup
                pos.marketType // PASS MARKET TYPE
            );

            if (!updateOk) {
                throw new Error('Ledger update returned false');
            }
        } catch (err: any) {
            console.error(`[CLOSE-ERROR] Failed to execute close for ${posKey}:`, err);

            // LOG: Resolution Path Diagnostics
            if (trigger === CloseTrigger.MARKET_RESOLUTION) {
                console.error(`[RESOLUTION-FAIL] Close failed for ${posKey}. Cause: ${cause}. Market Status maybe mismatch?`);
            }

            // Revert state so it can be retried
            pos.state = PositionState.OPEN;
            delete pos.closePriority;
            delete pos.closeTrigger;
            delete pos.closeCause;
            return;
        }
    }

    // --- MAIN LOOP ---
    public async startPolling() {
        if (this.isPolling) {
            console.log('[ENGINE] Already running.');
            return;
        }

        this.isPolling = true;
        if (config.DEBUG_LOGS) {
            console.log(`[ENGINE] Started polling ${config.PROFILE_ADDRESS}`);
            console.log(`[ENGINE] Processing trades from: ${new Date(this.botStartupTime).toLocaleTimeString()} onwards`);
        }

        // ... (in startPolling)

        // --- SCAN INITIAL POSITIONS (BLACKLIST) ---
        if (FeatureSwitches.SKIP_ACTIVE_POSITIONS) {
            console.log('[ENGINE] Scanning for existing positions to blacklist...');
            try {
                const currentPositions = await this.api.getPositions(config.PROFILE_ADDRESS);
                if (currentPositions && Array.isArray(currentPositions)) {
                    // Extract unique marketIds (Prioritize conditionId to match Activity stream)
                    const targetMarketIds = currentPositions
                        .map((p: any) => p.conditionId || p.market || p.marketId || p.asset)
                        .filter(id => typeof id === 'string');

                    // NEW: Allow scale-in for positions we ALREADY hold locally
                    const localPositions = this.ledger.getPositions();
                    const localMarketIds = new Set(Object.values(localPositions).map(p => p.marketId));

                    const marketIdsToBlacklist = targetMarketIds.filter(id => {
                        const isHeldLocally = localMarketIds.has(id);
                        if (isHeldLocally) {
                            console.log(`[FILTER] 🟢 Allowing scale-in for existing local position: ${id.substring(0, 10)}...`);
                        }
                        return !isHeldLocally;
                    });

                    this.positionFilter.initialize(marketIdsToBlacklist);
                }
            } catch (e) {
                console.error('[ENGINE] Failed to scan initial positions:', e);
            }
        } else {
            console.log('[ENGINE] SKIP_ACTIVE_POSITIONS = false. Will copy all trades regardless of current holdings.');
        }

        // --- WS SUBSCRIPTION ---
        this.updateWebsocketSubscription();
        setInterval(() => this.updateWebsocketSubscription(), 60000); // Check for new positions every minute

        let tickCount = 0;

        while (this.isPolling) {
            try {


                const activities = await this.api.getUserActivity(config.PROFILE_ADDRESS);
                const fetchTime = Date.now();
                // Process chronologically (Oldest -> Newest) to ensure correct ledger order
                const sortedActivities = activities.reverse();

                for (const act of sortedActivities) {
                    if (act.type === 'TRADE') {
                        await this.processAutoTrade(act, fetchTime);
                    }
                }

                if (tickCount % 10 === 0) {
                    await this.manageLifecycle();
                }

                // CHECK LIQUIDITY (Guard)
                if (tickCount % 5 === 0) { // Check every 5 ticks (~5-10s)
                    await this.checkLiquidity();
                }

                tickCount++;

                // ===== PRICE UPDATE FALLBACK (REST for markets without WS) =====
                const positions = this.ledger.getPositions();
                const posCount = Object.values(positions).length;
                console.log(`[PRICE-UPDATE-DEBUG] Starting price update loop for ${posCount} positions`);

                let skippedCache = 0;
                let skippedNoToken = 0;
                let updated = 0;
                let failed = 0;

                for (const pos of Object.values(positions)) {
                    try {
                        // === CRITICAL FIX: Check cache by tokenId with 30s expiry ===
                        // Skip if WebSocket provided recent data (< 30 seconds old)
                        const cacheKey = pos.tokenId || pos.marketId;
                        const cached = this.ledger.priceCache[cacheKey];
                        const now = Date.now();
                        const CACHE_EXPIRY_MS = 30000; // 30 seconds

                        if (cached && (now - cached.timestamp) < CACHE_EXPIRY_MS) {
                            skippedCache++;
                            // DISABLED CACHE: Always fetch fresh prices per user request
                            // console.log(`[PRICE-UPDATE-DEBUG] Skipped ${pos.marketName.substring(0, 30)}... (cached ${((now - cached.timestamp) / 1000).toFixed(0)}s ago)`);
                            // continue;
                        } else if (cached) {
                            console.log(`[PRICE-UPDATE-DEBUG] Cache expired for ${pos.marketName.substring(0, 30)}... (${((now - cached.timestamp) / 1000).toFixed(0)}s old), fetching fresh`);
                        }

                        // NEW: Use live orderbook instead of stale Gamma API prices
                        // Fetch orderbook for the specific token to get real-time prices
                        if (!pos.tokenId) {
                            // If no tokenId, skip this position (legacy positions)
                            skippedNoToken++;
                            if (config.DEBUG_LOGS) console.warn(`[PRICE-UPDATE] No tokenId for ${pos.marketName}, skipping live price update`);
                            continue;
                        }

                        // === MULTI-OUTCOME FIX: Always fetch YES token's orderbook ===
                        // clobTokenIds ordering is NOT guaranteed. We must dynamically
                        // determine which token is YES by finding the OTHER token.
                        // For NO pos: pos.tokenId = NO token, other = YES token
                        // For YES pos: pos.tokenId = YES token, use directly
                        let fetchTokenId = pos.tokenId;
                        let isNOposition = false;

                        if (pos.marketType === 'MULTI' && pos.side === 'NO') {
                            const cache = this.ledger.getMarketCache(pos.marketId);
                            if (cache?.clobTokenIds && cache.clobTokenIds.length >= 2) {
                                // Find the OTHER token (YES) - the one that is NOT our NO tokenId
                                const yesToken = cache.clobTokenIds.find((t: string) => t !== pos.tokenId);
                                if (yesToken) {
                                    fetchTokenId = yesToken;
                                    isNOposition = true;
                                }
                            }
                        }
                        // YES positions: pos.tokenId IS the YES token, fetch directly (no swap needed)

                        console.log(`[PRICE-UPDATE-DEBUG] Fetching orderbook for ${pos.marketName.substring(0, 30)}... | Token: ${fetchTokenId.substring(0, 8)}...`);
                        const orderBook = await this.api.getOrderBookForToken(fetchTokenId, pos.marketId);
                        if (orderBook && orderBook.bids.length > 0 && orderBook.asks.length > 0) {
                            const bestBid = orderBook.bids[0].price;
                            const bestAsk = orderBook.asks[0].price;
                            const yesMidPrice = (bestBid + bestAsk) / 2;

                            // Derive price based on position side
                            // YES positions: use YES price directly
                            // NO positions: use complement (1 - YES price)
                            const currentPrice = isNOposition ? (1 - yesMidPrice) : yesMidPrice;

                            if (!isNaN(currentPrice) && currentPrice > 0) {
                                const oldPrice = pos.currentPrice;
                                pos.currentPrice = currentPrice;
                                pos.currentValue = currentPrice * pos.size;
                                pos.unrealizedPnL = pos.currentValue - pos.investedUsd;
                                updated++;

                                console.log(`[PRICE-UPDATE] ${pos.marketName.substring(0, 30)}... | ${pos.side}${isNOposition ? ' (from YES book)' : ''} | Old: $${oldPrice?.toFixed(4) || 'N/A'} → New: $${currentPrice.toFixed(4)} (YES mid: ${yesMidPrice.toFixed(4)})`);
                            }
                        } else {
                            failed++;
                            console.log(`[PRICE-UPDATE-DEBUG] Empty orderbook for ${pos.marketName.substring(0, 30)}...`);
                        }
                    } catch (err: any) {
                        failed++;
                        console.error(`[PRICE-UPDATE-DEBUG] Error for ${pos.marketId.substring(0, 8)}...: ${err.message}`);
                    }
                }

                console.log(`[PRICE-UPDATE-DEBUG] Summary: ${posCount} total | ${updated} updated | ${skippedCache} cached | ${skippedNoToken} no-token | ${failed} failed`);

                // === CRITICAL FIX: Persist REST price updates to disk ===
                if (updated > 0) {
                    console.log(`[PRICE-UPDATE] Persisting ${updated} price updates to ledger.json`);
                    this.ledger.save();
                }



            } catch (e) {
                console.error('\n[ENGINE] Poll Error:', e);
            }

            if (!this.isPolling) break;
            await new Promise(r => setTimeout(r, config.POLL_INTERVAL_MS));
        }
        console.log('\n[ENGINE] Polling loop stopped.');
    }

    // --- LIFECYCLE MANAGEMENT (NEW) ---
    private async manageLifecycle() {
        const positions = this.ledger.getPositions();
        if (Object.keys(positions).length === 0) return;

        for (const pos of Object.values(positions)) {
            try {
                // 1. Fetch Fresh Container Context (Event/Market)
                const container = await this.api.getMarketDetails(pos.marketId);
                if (!container) continue;

                // 2. Get Deterministic State via MarketLifecycle Service
                const lifecycle: MarketLifecycleResult = MarketLifecycle.getMarketLifecycle(container, pos.marketId);

                // 3. Apply State Transitions
                if (lifecycle.state === "PENDING_RESOLUTION") {
                    if (pos.state !== PositionState.PENDING_RESOLUTION && pos.state !== PositionState.CLOSED) {
                        console.log(`[LIFECYCLE] Moving ${pos.marketName} to PENDING_RESOLUTION`);
                        this.ledger.updatePositionState(pos.positionId || pos.marketId, PositionState.PENDING_RESOLUTION);
                    }
                }
                else if (lifecycle.state === "CLOSED") {
                    // RESOLVED WITH RESULT
                    const result = lifecycle.result; // "YES_WON" | "NO_WON"
                    const winningLabel = lifecycle.winningOutcomeLabel;

                    if (result || winningLabel) {
                        let isWinner = false;

                        if (lifecycle.marketType === "MULTI" && lifecycle.winningSide) {
                            // MULTI: Compare winningSide against position.side
                            // Each child market is its own YES/NO — resolution is per child, not group
                            isWinner = pos.side === lifecycle.winningSide;
                        } else if (winningLabel && pos.outcomeLabel) {
                            // SINGLE: Check if our position's outcome label matches the winner
                            isWinner = winningLabel.toUpperCase() === pos.outcomeLabel.toUpperCase();
                        } else if (result) {
                            // FALLBACK: Binary/Legacy logic
                            isWinner =
                                (result === "YES_WON" && pos.side === "YES") ||
                                (result === "NO_WON" && pos.side === "NO");
                        }

                        // Check if already closed/settled to avoid spam
                        if (pos.state !== PositionState.CLOSED && pos.state !== PositionState.SETTLED) {
                            const logExtra = lifecycle.marketType === "MULTI"
                                ? `WinningSide: ${lifecycle.winningSide}, MySide: ${pos.side}`
                                : `WinnerLabel: ${winningLabel}, MyLabel: ${pos.outcomeLabel}`;
                            console.log(`[LIFECYCLE] Resolving ${pos.marketName} [${lifecycle.marketType}]. ${logExtra}. Result: ${isWinner ? 'WIN' : 'LOSS'}`);
                            await this.settlePosition(
                                pos.marketId,
                                pos.side,
                                `MARKET_RESOLUTION|${isWinner ? 'WINNER' : 'LOSER'}`,
                                undefined,
                                pos.tokenId,
                                pos.outcomeLabel,
                                isWinner
                            );
                        }
                    }
                }
                else if (lifecycle.state === "ACTIVE") {
                    // Ensure state is OPEN if currently PENDING (reverted?)
                    if (pos.state === PositionState.PENDING_RESOLUTION) {
                        console.log(`[LIFECYCLE] Reverting ${pos.marketName} to ACTIVE/OPEN`);
                        this.ledger.updatePositionState(pos.positionId || pos.marketId, PositionState.OPEN);
                    }
                }

            } catch (e) {
                console.error(`[LIFECYCLE] Error managing ${pos.marketName}:`, e);
            }
        }
    }

    // LEGACY METHODS REMOVED: runWatchdog, checkExpirations

    private liquidityFailures = new Map<string, number>();

    private async checkLiquidity() {
        const positions = Object.values(this.ledger.getPositions());
        if (positions.length === 0) return;

        for (const pos of positions) {
            // Only check open positions
            if (pos.state !== PositionState.OPEN) continue;

            // FX: Skip liquidity check if market is already expired (we are holding for resolution)
            const cache = this.ledger.getMarketCache(pos.marketId);
            if (cache && cache.endTime && Date.now() > cache.endTime) {
                continue;
            }

            try {
                const ob = await this.api.getOrderBook(pos.marketId);
                // If orderbook is completely empty or bids are missing (cannot sell)
                if (!ob || ob.bids.length === 0) {
                    const fails = (this.liquidityFailures.get(pos.marketId) || 0) + 1;
                    this.liquidityFailures.set(pos.marketId, fails);

                    if (fails < 3) {
                        console.warn(`[LIQUIDITY-WARN] Empty book for ${pos.marketName} (${fails}/3). Waiting...`);
                        continue; // Don't close yet
                    }

                    console.warn(`[LIQUIDITY-GUARD] No liquidity for ${pos.marketName} after 3 checks. Holding for resolution.`);
                    // await this.tryClosePosition(
                    //     pos.marketId,
                    //     pos.side,
                    //     CloseTrigger.SYSTEM_GUARD,
                    //     CloseCause.NO_LIQUIDITY,
                    //     0 // Force 0 price if no liquidity? Or tryClose will handle fallback.
                    // );
                } else {
                    this.liquidityFailures.delete(pos.marketId); // Reset on success
                }
            } catch (e) {
                // Ignore transient API errors
            }
        }
    }

    private async settlePosition(
        marketId: string,
        side: 'YES' | 'NO',
        reason: string,
        winningSide?: 'YES' | 'NO' | null,
        tokenId?: string,
        outcomeLabel?: string,
        isWinner?: boolean
    ) {
        let trigger = CloseTrigger.MARKET_RESOLUTION;

        // cause must reflect which SIDE won the MARKET (not whether user won)
        // This is critical because tryClosePosition uses cause to determine exitPrice:
        //   (WINNER_YES && side==='YES') || (WINNER_NO && side==='NO') → 1.0 else 0.0
        let cause: CloseCause;
        if (isWinner !== undefined) {
            // If user won with YES → YES won the market
            // If user won with NO → NO won the market
            // If user lost with YES → NO won the market
            // If user lost with NO → YES won the market
            if (isWinner) {
                cause = side === 'YES' ? CloseCause.WINNER_YES : CloseCause.WINNER_NO;
            } else {
                cause = side === 'YES' ? CloseCause.WINNER_NO : CloseCause.WINNER_YES;
            }
        } else if (winningSide) {
            // Legacy: winningSide directly tells us which side won
            cause = winningSide === 'YES' ? CloseCause.WINNER_YES : CloseCause.WINNER_NO;
        } else {
            cause = CloseCause.WINNER_YES; // Fallback
        }

        await this.tryClosePosition(marketId, side, trigger, cause, 0, tokenId, outcomeLabel);
    }


    // --- TRADING LOGIC ---
    private async processAutoTrade(raw: any, fetchTime: number) {
        const msTimestamp = raw.timestamp * 1000;
        const txHash = raw.transactionHash || raw.id;

        // Time Filter (Lookback window)
        if (msTimestamp < this.botStartupTime) return;

        // Deduplication Filter
        if (this.ledger.getTradeEvents().find(e => e.eventId === txHash)) return;

        const rawSide = (raw.side || '').toUpperCase(); // "BUY" or "SELL"
        const isBuy = rawSide === 'BUY';
        const marketId = raw.marketId || raw.conditionId;

        // Position Filter Check (Avoid Copying Existing Positions)
        if (this.positionFilter.isBlacklisted(marketId)) {
            if (config.DEBUG_LOGS) console.log(`[FILTER] Ignoring update for blacklisted market: ${marketId}`);
            return;
        }

        // ===== 1. FETCH METADATA & NORMALIZED MODEL =====
        let marketName = "Loading...";
        let marketSlug = "";
        let outcomes: string[] = [];
        let model: NormalizedMarket | undefined;

        const cachedMeta = this.ledger.getMarketCache(marketId);
        if (cachedMeta && cachedMeta.model) {
            marketName = cachedMeta.question;
            marketSlug = cachedMeta.slug;
            outcomes = cachedMeta.outcomes;
            model = cachedMeta.model;
        } else {
            const meta = await this.api.getMarketDetails(marketId);
            if (meta) {
                this.ledger.updateMarketCache(marketId, meta.question, meta.slug, meta.outcomes, meta.clobTokenIds, meta.endTime, meta.model);
                // Also update local model ref
                const fresh = this.ledger.getMarketCache(marketId);
                model = fresh?.model;
                marketName = meta.question;
                marketSlug = meta.slug;
                outcomes = meta.outcomes;
            }
        }

        if (!model) {
            console.error(`[ENGINE] Failed to resolve market model for ${marketId}. Skipping.`);
            return;
        }

        // NEW: Detect Market Type immediately
        let marketType: "SINGLE" | "MULTI" = "SINGLE";
        try {
            // Use fresh meta if available, else derive/default.
            // We can re-fetch or use what we have.
            // Since we have 'model', we might have cached it.
            // But we need the CONTAINER (markets array) which might not be in 'model'.
            // Let's safe-fetch specific for this logic to be robust.
            const container = await this.api.getMarketDetails(marketId);
            if (container) {
                marketType = MarketLifecycle.getMarketLifecycle(container, marketId).marketType;
            }
        } catch (e) { }

        // ===== 2. SMART OUTCOME SELECTION =====
        const rawOutcomeStr = String(raw.outcome || '').toUpperCase();
        let selectedOutcome: NormalizedOutcome | undefined;

        // Try to match by label exactly 
        selectedOutcome = model.outcomes.find((o: NormalizedOutcome) => o.label.toUpperCase() === rawOutcomeStr);

        // Fallback: Binary YES/NO mapping for signals
        if (!selectedOutcome && model.type === 'binary') {
            if (['YES', '1', 'TRUE', 'UP', 'PASS'].includes(rawOutcomeStr)) {
                // Find "Yes" or "True" outcome
                selectedOutcome = model.outcomes.find(o => ['YES', 'TRUE', '1'].includes(o.label.toUpperCase()));
            }
            else if (['NO', '0', 'FALSE', 'DOWN', 'FAIL'].includes(rawOutcomeStr)) {
                // Find "No" or "False" outcome
                selectedOutcome = model.outcomes.find(o => ['NO', 'FALSE', '0'].includes(o.label.toUpperCase()));
            }
        }

        if (!selectedOutcome) {
            console.warn(`[ENGINE] Could not map outcome "${rawOutcomeStr}" in market "${marketName}". Skipping.`);
            return;
        }

        const outcomeLabel = selectedOutcome.label;
        const tokenId = selectedOutcome.tokenId;

        // CRITICAL FIX: Side Determination
        // 1. For BINARY markets: If token ID matches Index 0 (NO), force side to NO. Else YES.
        // 2. For MULTI-OUTCOME: Respect the signal's side (YES=Buy, NO=Sell/Short).
        //    BUT since we cannot "Short" an outcome directly in the simple sense (we sell the token we own),
        //    we treat both BUY and SELL as operating on the 'YES' token of that outcome.
        //    The 'SELL' *action* is handled later.
        let side: 'YES' | 'NO';

        if (model.type === 'binary') {
            // FIX: Rely on outcome LABEL, not index.
            // Some markets have ["Yes", "No"] (Index 0 is Yes).
            // We want side="NO" only if the token corresponds to the "No" outcome.
            const outcome = model.outcomes.find(o => o.tokenId === tokenId);
            if (outcome && (outcome.label === 'No' || outcome.label === 'NO')) {
                side = 'NO';
            } else {
                side = 'YES';
            }
        } else {
            // For multi-outcome, we are always trading the Outcome Token itself.
            side = 'YES';
        }

        // ===== 3. FETCH ORDER BOOK FOR SELECTED OUTCOME =====
        let orderBook: any = null;
        let marketPrice: any = null;

        try {
            orderBook = await this.api.getOrderBookForToken(tokenId, marketId);
            if (orderBook && orderBook.bids.length > 0 && orderBook.asks.length > 0) {
                const bestBid = orderBook.bids[0].price;
                const bestAsk = orderBook.asks[0].price;
                const midPrice = (bestBid + bestAsk) / 2;
                marketPrice = { bestBid, bestAsk, midPrice };
            }
        } catch (err: any) {
            console.warn(`[ENGINE] Error fetching order book for token ${tokenId.substring(0, 8)}...: ${err.message}`);
        }

        const sourcePrice = parseFloat(raw.price || '0.5');
        const sourceSize = parseFloat(raw.size || '0');

        // ===== 4. CALCULATE REALISTIC EXECUTION TICK =====
        // Convert prices to ticks immediately
        let executionTick = toTick(sourcePrice);
        const sourceTick = toTick(sourcePrice);

        if (marketPrice) {
            // In multi-outcome, we always trade the specific outcome book.
            // Buying an outcome = Best Ask of that outcome's book.
            // Selling an outcome = Best Bid of that outcome's book.
            if (isBuy) {
                // executionPrice = marketPrice.bestAsk;
                executionTick = toTick(marketPrice.bestAsk);
                if (config.DEBUG_LOGS) console.log(`[EXECUTION-REALISM] Buying ${outcomeLabel} at Best Ask: ${executionTick} (source: ${sourceTick})`);
            } else {
                // executionPrice = marketPrice.bestBid;
                executionTick = toTick(marketPrice.bestBid);
                if (config.DEBUG_LOGS) console.log(`[EXECUTION-REALISM] Selling ${outcomeLabel} at Best Bid: ${executionTick} (source: ${sourceTick})`);
            }
        }

        // ===== 5. 1000 TICK PRICE GUARD (WAIT & RETRY) =====
        if (executionTick >= MAX_TICK) {
            console.log(`[PRICE-GUARD] ⚠️ Execution tick is ${executionTick} (MAX) for ${outcomeLabel}. Waiting 30s...`);
            await new Promise(resolve => setTimeout(resolve, 30000));

            // Re-fetch Order Book
            try {
                const freshOB = await this.api.getOrderBookForToken(tokenId, marketId);
                if (freshOB && freshOB.bids.length > 0 && freshOB.asks.length > 0) {
                    const bestBid = freshOB.bids[0].price;
                    const bestAsk = freshOB.asks[0].price;
                    const midPrice = (bestBid + bestAsk) / 2;
                    marketPrice = { bestBid, bestAsk, midPrice };

                    executionTick = isBuy ? toTick(bestAsk) : toTick(bestBid);
                }
            } catch (e) {
                console.warn(`[PRICE-GUARD] Failed to refresh price. Keeping original price.`);
            }

            if (executionTick >= MAX_TICK) {
                console.log(`[PRICE-GUARD] ⛔ Tick still ${executionTick} after 30s. Skipping trade.`);
                return;
            }
            console.log(`[PRICE-GUARD] ✅ Tick dropped to ${executionTick}. Proceeding.`);
        }

        // NEW: Fixed Share Multiplier Logic
        let myShares = 0;
        const executionPrice = fromTick(executionTick); // Cached decimal for share calc / logging

        if (this.tradeSettings.mode === TradeAmountMode.FIXED) {
            // Fixed Amount Mode: Calculate shares based on execution price
            // shares = fixedAmount / price
            // Guard against price being 0 or very close to 0
            const effectivePrice = Math.max(0.01, executionPrice);
            myShares = this.tradeSettings.fixedAmountUsd / effectivePrice;
            if (config.DEBUG_LOGS) console.log(`[SIZE-CALC] Fixed Mode: $${this.tradeSettings.fixedAmountUsd} / $${effectivePrice.toFixed(2)} = ${myShares.toFixed(2)} shares`);
        } else {
            // Percentage Mode: Share multiplier
            myShares = sourceSize * this.tradeSettings.percentage;
            if (config.DEBUG_LOGS) console.log(`[SIZE-CALC] Pct Mode: ${sourceSize} * ${this.tradeSettings.percentage} = ${myShares.toFixed(2)} shares`);
        }

        // Safety: Enforce Minimum Order Size (Floor)
        if (myShares < config.MIN_ORDER_SIZE_SHARES) {
            if (config.DEBUG_LOGS) console.log(`[UPSIZE-MIN] Calculated ${myShares.toFixed(2)} < Min ${config.MIN_ORDER_SIZE_SHARES}. Upsizing to min.`);
            myShares = config.MIN_ORDER_SIZE_SHARES;
        }

        if (!isBuy) {
            const posKey = `${marketId}-${side}`;
            const currentPos = this.ledger.getPositions()[posKey];
            const ownedShares = currentPos ? currentPos.size : 0;
            if (myShares > ownedShares) myShares = ownedShares;
            if (myShares <= 0) return; // Nothing to sell
        }

        const sharesSigned = isBuy ? myShares : -myShares;

        // ===== PROFITABILITY CHECK FOR SELLS (TICKS) =====
        if (!isBuy) {
            const posKey = `${marketId}-${side}`;
            const currentPos = this.ledger.getPositions()[posKey];
            if (currentPos && currentPos.size > 0) {
                // Use stored entryTick if available, else derive from entryPrice
                const entryTick = currentPos.entryTick ?? toTick(currentPos.entryPrice);
                // Profit/Loss in ticks = (Execution - Entry) since we are selling
                // Actually: Gross PnL = (Exit - Entry)
                // Loss Percent = (Entry - Exit) / Entry

                const tickDiff = entryTick - executionTick;
                const lossPercent = tickDiff / entryTick;

                // Only skip if loss is significantly high (allow some loss to match source profile)
                if (config.ENABLE_TRADE_FILTERS && lossPercent > 0.10) {
                    if (config.DEBUG_LOGS) console.warn(
                        `[SKIP-PROFITABILITY] SKIPPING SELL - Loss ${(lossPercent * 100).toFixed(2)}% exceeds 10% limit. ` +
                        `Entry Tick: ${entryTick}, Exit Tick: ${executionTick}`
                    );
                    return;
                }
            }
        }

        // ===== SLIPPAGE CHECK (if enabled) =====
        if (config.ENABLE_TRADE_FILTERS && config.EXPECTED_EDGE > 0 && orderBook && marketPrice) {
            const costUsd = myShares * executionPrice;
            const slippageEstimate = this.slippageCalculator.calculateExpectedSlippage(
                marketPrice,
                orderBook,
                costUsd,
                isBuy,
                config.EXPECTED_EDGE
            );

            if (!slippageEstimate.shouldExecute) {
                console.log(`❌ [SKIP] Slippage ${(slippageEstimate.totalSlippage * 100).toFixed(2)}% > Threshold (Market too thin)`);
                if (config.DEBUG_LOGS) console.log(this.slippageCalculator.getDetailedLog(
                    slippageEstimate,
                    marketId,
                    costUsd,
                    config.EXPECTED_EDGE
                ));
                return;
            }
        }
        // ===== EXECUTE TRADE WITH RETRY LOGIC =====
        // ===== EXECUTE TRADE WITH RETRY LOGIC =====
        try {
            if (isBuy) {
                // --- BUY: ENTRY ---
                const result = await this.retryHelper.execute(
                    async () => {
                        return this.ledger.updatePosition(
                            marketId,
                            marketName,
                            marketSlug,
                            side,
                            outcomeLabel,
                            sharesSigned,
                            executionPrice, // Converted via fromTick() earlier
                            txHash,
                            'COPY_TRADE', // Entry Reason
                            sourcePrice,
                            Math.max(0, Date.now() - fetchTime),
                            tokenId, // NEW
                            marketType // Pass Detected Type
                        );
                    },
                    `BUY ${myShares.toFixed(1)} shares on ${marketName.substring(0, 20)}...`
                );

                if (result.success && result.data) {
                    const execTime = Date.now();
                    console.log(
                        `✅ [BUY] ${myShares.toFixed(1)} ${outcomeLabel} @ $${executionPrice.toFixed(4)} on "${marketName}"`
                    );
                    this.updateWebsocketSubscription();
                }

            } else {
                // --- SELL: EXIT ---
                // Delegate to Centralized Close Logic
                await this.tryClosePosition(
                    marketId,
                    side,
                    CloseTrigger.COPY_TRADER_EVENT,
                    CloseCause.TARGET_SELLOFF, // Explicit reason requested by user
                    executionPrice, // Converted via fromTick() earlier
                    tokenId,
                    outcomeLabel
                );
            }

        } catch (e: any) {
            console.error(`❌ [CRITICAL] Trade execution failed: ${e.message}`);
        }
    }

    public async manualClosePosition(marketId: string, side: 'YES' | 'NO', tokenId?: string, outcomeLabel?: string) {
        // NEW ROBUST POSITION KEY
        let posKey = tokenId ? `${marketId}-${tokenId}` : `${marketId}-${side}-${outcomeLabel}`;
        let pos = this.ledger.getPositions()[posKey];

        // FALLBACK: Legacy Key Check
        if (!pos) {
            const legacyKey = `${marketId}-${side}`;
            if (this.ledger.getPositions()[legacyKey]) {
                posKey = legacyKey;
                pos = this.ledger.getPositions()[posKey];
            }
        }

        if (!pos) throw new Error(`No position found to close for ${posKey}`);

        // Forward to centralized logic
        // We let tryClosePosition handle price discovery if we don't pass one, 
        // but since manual close logic had specific manual price gathering, 
        // we can keep using tryClosePosition's internal discovery OR pass specific checks.
        // For simplicity and uniformity, we delegate to tryClose(USER_ACTION).

        // Note: The original logic did Slippage Checks. tryClosePosition doesn't strictly prevent it atm,
        // but we can add pre-checks here if needed.

        await this.tryClosePosition(
            marketId,
            side,
            CloseTrigger.USER_ACTION,
            CloseCause.MANUAL_CLOSE,
            undefined, // discovery used
            tokenId,
            outcomeLabel
        );
    }

    private updateWebsocketSubscription() {
        try {
            const positions = this.ledger.getPositions();
            const tokenIds = new Set<string>();

            // === MULTI-OUTCOME FIX: Subscribe to YES tokens for all positions ===
            // For MULTI NO positions, subscribe to the YES token instead,
            // so we get the correct price to derive NO as complement.
            Object.values(positions).forEach(p => {
                if (p.state === PositionState.OPEN && p.tokenId) {
                    if (p.marketType === 'MULTI' && p.side === 'NO') {
                        // Find YES token dynamically (the OTHER token, not pos.tokenId)
                        const cache = this.ledger.getMarketCache(p.marketId);
                        if (cache?.clobTokenIds && cache.clobTokenIds.length >= 2) {
                            const yesToken = cache.clobTokenIds.find((t: string) => t !== p.tokenId);
                            tokenIds.add(yesToken || p.tokenId);
                        } else {
                            tokenIds.add(p.tokenId); // Fallback to position's token
                        }
                    } else {
                        tokenIds.add(p.tokenId);
                    }
                }
            });

            const uniqueTokens = Array.from(tokenIds);

            if (uniqueTokens.length === 0) {
                if (config.DEBUG_LOGS) console.log('[WS] No active positions. Unsubscribing/Idle.');
                return;
            }

            if (config.DEBUG_LOGS) {
                console.log(`[WS] Updating subscription for ${uniqueTokens.length} tokens: ${uniqueTokens.map(t => t.substring(0, 6)).join(', ')}...`);
            }

            this.api.subscribeToOrderbook(uniqueTokens, (data: any) => {
                this.handleWebsocketMessage(data);
            });
        } catch (e: any) {
            console.error('[WS] Failed to update subscription:', e.message);
        }
    }

    private handleWebsocketMessage(data: any) {
        // Placeholder for the actual message handling logic if it was intended to be separate
        // Based on previous code, the logic was inline. 
        // But wait, the previous code had inline logic inside the callback.
        // I should probably restore that inline logic OR delegate to this method.
        // Let's restore the inline logic structure but clean it up.

        // Actually, let's keep the structure simple:
        // The previous `handleWebsocketMessage` didn't exist in the original file I viewed earlier?
        // Let's check the original view.
        // Ah, I see "this.handleWebsocketMessage(data)" in my previous replacement attempt.
        // But the original code had the logic INLINE in the callback.

        // I will put the logic into `handleWebsocketMessage` to fail-safe against the "updates" error.

        let updates: any[] = [];
        if (Array.isArray(data)) updates = data;
        else if (data && typeof data === 'object') {
            if (Array.isArray(data.data)) updates = data.data;
            else if (Array.isArray(data.price_changes)) updates = data.price_changes; // Gamma/Poly variant
            else return;
        } else return;

        if (updates.length === 0) return;

        // Process updates...
        // We need a way to map tokenIds back to markets. 
        // Since we are decoupling the callback, we need to lookup metadata again or pass it.
        // Re-looking up is safer for "current state".

        const positions = this.ledger.getPositions();

        // === MULTI-OUTCOME FIX: Build mapping from YES tokenId → position metadata ===
        // For MULTI NO positions, we subscribed to the YES token, so we need to map
        // YES token updates back to the correct position and derive NO price.
        interface TokenMeta { marketId: string; side: 'YES' | 'NO'; marketType?: string; posTokenId: string; }
        const tokenMetaMap = new Map<string, TokenMeta>();

        Object.values(positions).forEach(p => {
            if (p.state === PositionState.OPEN && p.tokenId) {
                if (p.marketType === 'MULTI' && p.side === 'NO') {
                    // Find YES token dynamically (the OTHER token, not pos.tokenId)
                    const cache = this.ledger.getMarketCache(p.marketId);
                    if (cache?.clobTokenIds && cache.clobTokenIds.length >= 2) {
                        const yesToken = cache.clobTokenIds.find((t: string) => t !== p.tokenId);
                        if (yesToken) tokenMetaMap.set(yesToken, { marketId: p.marketId, side: 'NO', marketType: p.marketType, posTokenId: p.tokenId });
                    }
                } else {
                    tokenMetaMap.set(p.tokenId, { marketId: p.marketId, side: p.side, marketType: p.marketType, posTokenId: p.tokenId });
                }
            }
        });

        for (const update of updates) {
            const tokenId = update.asset_id || update.token_id;
            if (!tokenId || !tokenMetaMap.has(tokenId)) continue;

            const meta = tokenMetaMap.get(tokenId)!;

            // Calculate YES token midpoint
            let yesMidPrice = 0;

            // Case A: Full Orderbook Update
            if (update.bids && update.asks) {
                const bestBid = update.bids.length > 0 ? parseFloat(update.bids[0].price) : 0;
                const bestAsk = update.asks.length > 0 ? parseFloat(update.asks[0].price) : 0;
                if (bestBid > 0 && bestAsk > 0) yesMidPrice = (bestBid + bestAsk) / 2;
                else if (bestBid > 0) yesMidPrice = bestBid;
                else if (bestAsk > 0) yesMidPrice = bestAsk;
            }
            // Case B: Price Change / Ticker
            else if (update.price) {
                yesMidPrice = parseFloat(update.price);
            }

            if (yesMidPrice > 0) {
                // For MULTI NO positions: derive price as complement of YES price
                const isMultiNO = meta.marketType === 'MULTI' && meta.side === 'NO';
                const finalPrice = isMultiNO ? (1 - yesMidPrice) : yesMidPrice;

                if (finalPrice > 0) {
                    this.ledger.updateRealTimePrice(meta.marketId, finalPrice, meta.posTokenId);
                }
            }
        }
    }
}

export default TradingEngine;