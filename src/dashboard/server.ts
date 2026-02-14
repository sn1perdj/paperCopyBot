import express from 'express';
import { createServer } from 'http';

import path from 'path';
import { fileURLToPath } from 'url';
import LedgerService from '../services/LedgerService.js';
import TradingEngine from '../services/TradingEngine.js';
import PolymarketService from '../services/PolymarketService.js';
import { config } from '../config/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class DashboardServer {
    private app = express();
    private httpServer = createServer(this.app);

    private ledger = LedgerService.getInstance();
    private engine = TradingEngine.getInstance();
    private poly = PolymarketService.getInstance();
    private cachedProfileName: string = '';

    constructor(port: number) {
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, 'public')));

        // Fetch profile name once on startup
        if (config.PROFILE_ADDRESS) {
            this.poly.getProfileName(config.PROFILE_ADDRESS).then(name => {
                this.cachedProfileName = name;
                console.log(`[DASHBOARD] Target Profile: ${name} (${config.PROFILE_ADDRESS})`);
            });
        }

        // --- API: STATS ---
        this.app.get('/api/stats', async (req, res) => {
            const positions = Object.values(this.ledger.getPositions());

            const enrichedPositions = positions.map(p => {
                const cache = this.ledger.getMarketCache(p.marketId);
                return {
                    ...p,
                    currentPrice: p.currentPrice ?? null,
                    currentValue: p.currentValue ?? null,
                    unrealizedPnL: p.unrealizedPnL ?? null,
                    endTime: (cache && cache.endTime) ? (cache.endTime < 10000000000 ? cache.endTime * 1000 : cache.endTime) : undefined
                };
            });

            const dailyStats = this.ledger.getDailyStats();
            const allTimeStats = this.ledger.getAllTimeStats();
            const totalUnrealized = this.ledger.getTotalUnrealizedPnL();

            res.json({
                botStatus: this.engine.getPollingStatus() ? 'RUNNING' : 'STOPPED',
                balance: this.ledger.getBalance(),

                // NEW: Split Metrics
                dailyRealizedPnL: dailyStats.dailyRealized,
                totalUnrealizedPnL: totalUnrealized,

                // Keep for backward compat if needed, but UI will use new fields
                dailyPnL: dailyStats.dailyRealized + totalUnrealized,
                allTimePnL: allTimeStats.totalRealized,
                totalUnrealized,
                activePositions: enrichedPositions.reverse(),
                closedPositions: this.ledger.getClosedPositions(),
                history: this.ledger.getTradeEvents(),
                profile: {
                    address: config.PROFILE_ADDRESS,
                    name: this.cachedProfileName || config.PROFILE_ADDRESS
                }
            });
        });


        // --- API: CONTROLS ---

        // Toggle Bot On/Off
        this.app.post('/api/control/toggle', (req, res) => {
            const isRunning = this.engine.getPollingStatus();
            if (isRunning) {
                this.engine.stopPolling();
                console.log('[SYSTEM] Bot Stopped by User');
            } else {
                // Start without awaiting (background)
                this.engine.startPolling().catch(e => console.error(e));
                console.log('[SYSTEM] Bot Started by User');
            }
            res.json({ success: true, isRunning: !isRunning });
        });

        // Close All Positions
        this.app.post('/api/control/close-all', async (req, res) => {
            try {
                console.log('[WARN] Closing ALL positions...');
                await this.engine.closeAllPositions();
                res.json({ success: true });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        // Single Manual Close
        this.app.post('/api/close', async (req, res) => {
            try {
                const { marketId, side, tokenId, outcomeLabel } = req.body;
                await this.engine.manualClosePosition(marketId, side, tokenId, outcomeLabel);
                console.log('[TRADE] MANUAL CLOSE:', outcomeLabel || side, 'on', marketId);
                res.json({ success: true });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        // --- API: SETTINGS ---
        this.app.get('/api/settings/trade-amount', (req, res) => {
            res.json(this.engine.getTradeSettings());
        });

        this.app.post('/api/settings/trade-amount', (req, res) => {
            try {
                const { mode, percentage, fixedAmountUsd } = req.body;
                this.engine.setTradeSettings({ mode, percentage, fixedAmountUsd });
                res.json({ success: true, settings: this.engine.getTradeSettings() });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });
    }

    public start(port: number) {
        this.httpServer.listen(port, () => console.log(`Dashboard on ${port}`));
    }
}