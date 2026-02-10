import * as fs from 'fs';
import * as path from 'path';
import config from '../config/config.js';
import LedgerService from '../services/LedgerService.js';
import PolymarketService from './PolymarketService.js';
import SlippageCalculator from './SlippageCalculator.js';
import MarketResolver from './MarketResolver.js';
import RetryHelper from './RetryHelper.js';
import PositionFilter from './PositionFilter.js';
import { PositionState, CloseTrigger, CloseCause, TradeAmountMode, TradeAmountSettings } from '../types.js';
import FeatureSwitches from '../config/switches.js';

class TradingEngine {
    private static instance: TradingEngine;
    private ledger: LedgerService;
    private api: PolymarketService;
    private slippageCalculator: SlippageCalculator;
    private marketResolver: MarketResolver;
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
        this.marketResolver = new MarketResolver();
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
                await this.tryClosePosition(pos.marketId, pos.side, CloseTrigger.USER_ACTION, CloseCause.MANUAL_CLOSE);
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
        forcePrice?: number
    ): Promise<void> {
        const posKey = `${marketId}-${side}`;
        const pos = this.ledger.getPositions()[posKey];

        // 1. EXISTENCE CHECK
        if (!pos) {
            console.warn(`[CLOSE-FAIL] Position not found: ${posKey}`);
            return;
        }

        // 2. STATE CHECK
        if (pos.state !== PositionState.OPEN) {
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
            console.log(`[CLOSE-IGNORE] Priority ${incomingPriority} < Existing ${pos.closePriority} for ${posKey}`);
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

        this.ledger.updatePosition(
            marketId, pos.marketName, pos.marketSlug, side,
            pos.outcomeLabel,
            -pos.size,
            exitPrice,
            `${trigger}-${Date.now()}`,
            reasonStr
        );
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
                    await this.runWatchdog();
                }

                // CHECK EXPIRATIONS (Immediate Liquidation Trigger)
                await this.checkExpirations();

                // CHECK LIQUIDITY (Guard)
                if (tickCount % 5 === 0) { // Check every 5 ticks (~5-10s)
                    await this.checkLiquidity();
                }

                tickCount++;

                // ===== PRICE UPDATE FALLBACK (REST for markets without WS) =====
                const positions = this.ledger.getPositions();

                for (const pos of Object.values(positions)) {
                    try {
                        // Skip if WebSocket is already providing real-time data
                        if (this.ledger.priceCache[pos.marketId]) {
                            continue;
                        }

                        // Fallback: Fetch from REST API only if no WebSocket data
                        const prices = await this.api.getOutcomePrices(pos.marketId);
                        if (prices && prices.length >= 2 && (prices[0] + prices[1] > 0)) {
                            // API returns prices as [NO_price, YES_price] (based on ["No", "Yes"] outcome order)
                            const exitPrice = pos.side === 'YES' ? prices[1] : prices[0];

                            if (!isNaN(exitPrice)) {
                                pos.currentPrice = exitPrice;
                                pos.currentValue = exitPrice * pos.size;
                                pos.unrealizedPnL = pos.currentValue - pos.investedUsd;
                            }
                        }
                    } catch (err: any) {
                        console.error(`[ENGINE] Price update failed for ${pos.marketId}:`, err.message);
                    }
                }



            } catch (e) {
                console.error('\n[ENGINE] Poll Error:', e);
            }

            if (!this.isPolling) break;
            await new Promise(r => setTimeout(r, config.POLL_INTERVAL_MS));
        }
        console.log('\n[ENGINE] Polling loop stopped.');
    }

    // --- WATCHDOG (Resolution Monitoring) ---
    private async runWatchdog() {
        const positions = this.ledger.getPositions();
        const openMarkets = Object.keys(positions);
        if (openMarkets.length === 0) return;

        const uniqueIds = [...new Set(Object.values(positions).map(p => p.marketId))];

        for (const marketId of uniqueIds) {
            try {
                // Check actual market resolution status (not price-based)
                const resolutionStatus = await this.marketResolver.checkResolution(marketId);

                if (resolutionStatus.isResolved) {
                    if (config.DEBUG_LOGS) console.log(
                        `\n[WATCHDOG] Market ${marketId.substring(0, 8)}... is RESOLVED. ` +
                        `Winner: ${resolutionStatus.winningSide || 'TBD'} (Source: ${resolutionStatus.source})`
                    );

                    // Settle all positions in this market
                    const reason = `RESOLUTION: WINNER_${resolutionStatus.winningSide || 'UNKNOWN'}`;
                    if (positions[`${marketId}-YES`]) {
                        await this.settlePosition(marketId, 'YES', reason, resolutionStatus.winningSide);
                    }
                    if (positions[`${marketId}-NO`]) {
                        await this.settlePosition(marketId, 'NO', reason, resolutionStatus.winningSide);
                    }
                }
            } catch (err: any) {
                console.error(`[WATCHDOG] Error checking resolution for ${marketId.substring(0, 8)}...:`, err.message);
                // Continue with other markets if one fails
            }
        }
    }

    private async checkExpirations() {
        const now = Date.now();
        const positionsArray = Object.values(this.ledger.getPositions());
        if (positionsArray.length === 0) return;

        for (const pos of positionsArray) {
            let cache = this.ledger.getMarketCache(pos.marketId);

            // Fetch if missing
            if (!cache || !cache.endTime) {
                try {
                    const meta = await this.api.getMarketDetails(pos.marketId);
                    if (meta && meta.endTime) {
                        this.ledger.updateMarketCache(pos.marketId, meta.question, meta.slug, meta.outcomes, meta.clobTokenIds, meta.endTime);
                        cache = this.ledger.getMarketCache(pos.marketId);
                    }
                } catch (e) { }
            }

            if (cache && cache.endTime) {
                if (now >= cache.endTime) {
                    // EXPIRED -> Trigger Guard Close
                    // FIX: Watchdog will handle resolution. Do NOT close prematurely.
                    if (config.DEBUG_LOGS) console.log(`[EXPIRATION-WATCH] Market ${pos.marketId} expired. Holding for resolution.`);

                    // We only close if NOT already closing/closed (handled by tryClosePosition checks)
                    /* await this.tryClosePosition(
                        pos.marketId,
                        pos.side,
                        CloseTrigger.SYSTEM_GUARD,
                        CloseCause.MARKET_EXPIRED
                    ); */
                }
            }
        }
    }

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

    private async settlePosition(marketId: string, side: 'YES' | 'NO', reason: string, winningSide?: 'YES' | 'NO' | null) {
        let trigger = CloseTrigger.MARKET_RESOLUTION;
        let cause = CloseCause.WINNER_YES; // Default

        if (winningSide === 'YES') cause = CloseCause.WINNER_YES;
        else if (winningSide === 'NO') cause = CloseCause.WINNER_NO;
        else if (reason.includes('EXPIRED')) {
            trigger = CloseTrigger.SYSTEM_GUARD;
            cause = CloseCause.MARKET_EXPIRED;
        }

        await this.tryClosePosition(marketId, side, trigger, cause);
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

        // ===== 1. FETCH ORDER BOOK FOR REALISTIC EXECUTION & SLIPPAGE =====
        let orderBook: any = null;
        let marketPrice: any = null;

        try {
            orderBook = await this.api.getOrderBook(marketId);
            if (orderBook && orderBook.bids.length > 0 && orderBook.asks.length > 0) {
                const bestBid = orderBook.bids[0].price;
                const bestAsk = orderBook.asks[0].price;
                const midPrice = (bestBid + bestAsk) / 2;
                marketPrice = { bestBid, bestAsk, midPrice };
            }
        } catch (err: any) {
            console.warn(`[ENGINE] Error fetching order book for ${marketId.substring(0, 8)}...: ${err.message}`);
        }

        // 2. Fetch Metadata
        let marketName = "Loading...";
        let marketSlug = "";
        let outcomes = ["No", "Yes"];

        const cachedMeta = this.ledger.getMarketCache(marketId);
        if (cachedMeta) {
            marketName = cachedMeta.question;
            marketSlug = cachedMeta.slug;
            outcomes = cachedMeta.outcomes;
        } else {
            const meta = await this.api.getMarketDetails(marketId);
            if (meta) {
                this.ledger.updateMarketCache(marketId, meta.question, meta.slug, meta.outcomes, meta.clobTokenIds, meta.endTime);
                marketName = meta.question;
                marketSlug = meta.slug;
                outcomes = meta.outcomes;
            }
        }


        // 3. SMART OUTCOME MAPPING
        const rawOutcomeStr = String(raw.outcome || '').toUpperCase();
        let outcomeIndex = -1;

        if (outcomes.length > 0) {
            const directIndex = outcomes.findIndex(o => String(o).toUpperCase() === rawOutcomeStr);
            if (directIndex !== -1) outcomeIndex = directIndex;
        }

        if (outcomeIndex === -1) {
            if (['NO', '0', 'FALSE', 'DOWN', 'FAIL'].includes(rawOutcomeStr)) outcomeIndex = 0;
            else if (['YES', '1', 'TRUE', 'UP', 'PASS'].includes(rawOutcomeStr)) outcomeIndex = 1;
        }

        if (outcomeIndex === -1) outcomeIndex = 1;

        const outcomeLabel = outcomes[outcomeIndex] || rawOutcomeStr;
        const side: 'YES' | 'NO' = outcomeIndex === 0 ? 'NO' : 'YES';

        const sourcePrice = parseFloat(raw.price || '0.5');
        const sourceSize = parseFloat(raw.size || '0');

        // ===== 4. CALCULATE REALISTIC EXECUTION PRICE (YES/NO Handling) =====
        let executionPrice = sourcePrice;

        if (marketPrice) {
            if (side === 'YES') {
                // YES Side: Standard Logic
                // Buy YES @ Ask, Sell YES @ Bid
                if (isBuy) {
                    executionPrice = marketPrice.bestAsk;
                    if (config.DEBUG_LOGS) console.log(`[EXECUTION-REALISM] Buying YES at Best Ask: $${executionPrice.toFixed(4)} (source: $${sourcePrice.toFixed(4)})`);
                } else {
                    executionPrice = marketPrice.bestBid;
                    if (config.DEBUG_LOGS) console.log(`[EXECUTION-REALISM] Selling YES at Best Bid: $${executionPrice.toFixed(4)} (source: $${sourcePrice.toFixed(4)})`);
                }
            } else {
                // NO Side: Inverted Logic (Buying NO = Selling YES)
                // Buy NO @ (1 - Bid), Sell NO @ (1 - Ask)
                if (isBuy) {
                    executionPrice = 1 - marketPrice.bestBid;
                    if (config.DEBUG_LOGS) console.log(`[EXECUTION-REALISM] Buying NO at (1 - Best Bid): $${executionPrice.toFixed(4)} (source: $${sourcePrice.toFixed(4)})`);
                } else {
                    executionPrice = 1 - marketPrice.bestAsk;
                    if (config.DEBUG_LOGS) console.log(`[EXECUTION-REALISM] Selling NO at (1 - Best Ask): $${executionPrice.toFixed(4)} (source: $${sourcePrice.toFixed(4)})`);
                }
            }
        }

        // ===== 4b. $1.00 PRICE GUARD (WAIT & RETRY) =====
        if (executionPrice >= 1.0) {
            console.log(`[PRICE-GUARD] ⚠️ Execution price is $1.00. Waiting 30s for pullback...`);
            await new Promise(resolve => setTimeout(resolve, 30000));

            // Re-fetch Order Book
            try {
                const freshOB = await this.api.getOrderBook(marketId);
                if (freshOB && freshOB.bids.length > 0 && freshOB.asks.length > 0) {
                    const bestBid = freshOB.bids[0].price;
                    const bestAsk = freshOB.asks[0].price;
                    const midPrice = (bestBid + bestAsk) / 2;
                    const freshMarketPrice = { bestBid, bestAsk, midPrice };
                    marketPrice = freshMarketPrice; // Update local scope variable for subsequent logs if needed

                    // Recalculate execution price
                    if (side === 'YES') {
                        if (isBuy) {
                            executionPrice = freshMarketPrice.bestAsk;
                        } else {
                            executionPrice = freshMarketPrice.bestBid;
                        }
                    } else {
                        if (isBuy) {
                            executionPrice = 1 - freshMarketPrice.bestBid;
                        } else {
                            executionPrice = 1 - freshMarketPrice.bestAsk;
                        }
                    }
                }
            } catch (e) {
                console.warn(`[PRICE-GUARD] Failed to refresh price after wait. Keeping original price.`);
            }

            if (executionPrice >= 1.0) {
                console.log(`[PRICE-GUARD] ⛔ Price still $1.00 after 30s wait. Skipping trade.`);
                return;
            }
            console.log(`[PRICE-GUARD] ✅ Price dropped to ${executionPrice.toFixed(4)}. Proceeding.`);
        }

        // NEW: Fixed Share Multiplier Logic
        let myShares = 0;

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

        // ===== PROFITABILITY CHECK FOR SELLS =====
        if (!isBuy) {
            const posKey = `${marketId}-${side}`;
            const currentPos = this.ledger.getPositions()[posKey];
            if (currentPos && currentPos.size > 0) {
                const costBasis = currentPos.investedUsd / currentPos.size;
                const netProceeds = executionPrice;
                const lossPercent = (costBasis - netProceeds) / costBasis;

                // Only skip if loss is significantly high (allow some loss to match source profile)
                if (config.ENABLE_TRADE_FILTERS && lossPercent > 0.10) {
                    if (config.DEBUG_LOGS) console.warn(
                        `[SKIP-PROFITABILITY] SKIPPING SELL - Loss ${(lossPercent * 100).toFixed(2)}% exceeds 10% limit. ` +
                        `Cost Basis: $${costBasis.toFixed(4)}, Net Proceeds: $${netProceeds.toFixed(4)}`
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
                            executionPrice,
                            txHash,
                            'COPY_TRADE', // Entry Reason
                            sourcePrice,
                            Math.max(0, Date.now() - fetchTime)
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
                    CloseCause.SELL,
                    executionPrice // Use calculated execution price
                );
            }

        } catch (e: any) {
            console.error(`❌ [CRITICAL] Trade execution failed: ${e.message}`);
        }
    }

    public async manualClosePosition(marketId: string, side: 'YES' | 'NO') {
        const posKey = `${marketId}-${side}`;
        const pos = this.ledger.getPositions()[posKey];
        if (!pos) throw new Error("No position found to close");

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
            CloseCause.MANUAL_CLOSE
        );
    }

    private async updateWebsocketSubscription() {
        try {
            const positions = this.ledger.getPositions();
            const marketIds = [...new Set(Object.values(positions).map(p => p.marketId))];

            if (marketIds.length === 0) return;

            // Resolve tokens
            const tokenIds: string[] = [];
            const tokenToMarketMap = new Map<string, { marketId: string, isIndex1: boolean }>(); // tokenId -> { marketId, isIndex1 }

            for (const mid of marketIds) {
                // FIX: Use cached clobTokenIds from Ledger
                const meta = this.ledger.getMarketCache(mid);

                // Helper to register a token
                const register = (tokens: string[]) => {
                    const yesToken = tokens[1]; // Index 1 is standard "YES"
                    const noToken = tokens[0];  // Index 0 is standard "NO"

                    if (yesToken) {
                        tokenIds.push(yesToken);
                        tokenToMarketMap.set(yesToken, { marketId: mid, isIndex1: true });
                    } else if (noToken) {
                        // Fallback to NO token if YES is missing
                        tokenIds.push(noToken);
                        tokenToMarketMap.set(noToken, { marketId: mid, isIndex1: false });
                    }
                };

                if (meta && meta.clobTokenIds && meta.clobTokenIds.length > 0) {
                    register(meta.clobTokenIds);
                } else {
                    // Fallback to API
                    const newMeta = await this.api.getMarketDetails(mid);
                    if (newMeta && newMeta.clobTokenIds) {
                        this.ledger.updateMarketCache(mid, newMeta.question, newMeta.slug, newMeta.outcomes, newMeta.clobTokenIds);
                        register(newMeta.clobTokenIds);
                    }
                }
            }

            if (tokenIds.length > 0) {
                // console.log(`[WS-SETUP] Subscribing to ${tokenIds.length} tokens`);
                this.api.subscribeToOrderbook(tokenIds, (data: any) => {
                    // Parse message into updates
                    let updates: any[] = [];

                    if (Array.isArray(data)) {
                        updates = data;
                    } else if (data && typeof data === 'object') {
                        if (Array.isArray(data.data)) {
                            updates = data.data;
                        } else if (Array.isArray(data.price_changes)) {
                            updates = data.price_changes;
                        } else {
                            return; // Skip malformed messages
                        }
                    } else {
                        return;
                    }

                    if (updates.length === 0) return;

                    // Group by marketId
                    const byMarket = new Map<string, { bids: any[], asks: any[], isIndex1: boolean }>();

                    for (const update of updates) {
                        const info = tokenToMarketMap.get(update.asset_id);
                        if (!info) continue;

                        const { marketId, isIndex1 } = info;

                        if (!byMarket.has(marketId)) {
                            byMarket.set(marketId, { bids: [], asks: [], isIndex1 });
                        }

                        const book = byMarket.get(marketId)!;
                        if (update.side === "BUY") {
                            book.bids.push(update);
                        } else if (update.side === "SELL") {
                            book.asks.push(update);
                        }
                    }

                    // Calculate midpoint and update ledger
                    for (const [marketId, book] of byMarket.entries()) {
                        if (book.bids.length === 0 && book.asks.length === 0) continue;

                        book.bids.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
                        book.asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

                        // Calculate price of the TRACKED token
                        let midpoint = 0;
                        if (book.bids.length > 0 && book.asks.length > 0) {
                            midpoint = (parseFloat(book.bids[0].price) + parseFloat(book.asks[0].price)) / 2;
                        } else if (book.bids.length > 0) {
                            midpoint = parseFloat(book.bids[0].price);
                        } else {
                            midpoint = parseFloat(book.asks[0].price);
                        }

                        // Normalize: Ledger ALWAYS expects Index 1 (YES) price
                        // If we tracked Index 1: Send midpoint.
                        // If we tracked Index 0: Send 1 - midpoint.
                        const index1Price = book.isIndex1 ? midpoint : (1 - midpoint);

                        this.ledger.updateRealTimePrice(marketId, index1Price);
                    }
                });
            }

        } catch (e) {
            console.error('[ENGINE] Failed to update WS subs:', e);
        }
    }
}

export default TradingEngine;