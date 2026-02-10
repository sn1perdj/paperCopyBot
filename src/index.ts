import 'dotenv/config'; // Ensures environment variables are loaded first
import { config } from './config/config.js';
import LedgerService from './services/LedgerService.js';
import LogService from './services/LogService.js';
import PolymarketService from './services/PolymarketService.js';
import TradingEngine from './services/TradingEngine.js';
import DashboardServer from './dashboard/server.js';

// ===== GRACEFUL SHUTDOWN HANDLER =====
async function gracefulShutdown() {
    console.log('\n═════════════════════════════════════════════════════');
    console.log('🛑 GRACEFUL SHUTDOWN INITIATED (SIGINT)');
    console.log('═════════════════════════════════════════════════════');

    const tradingEngine = TradingEngine.getInstance();
    const ledgerService = LedgerService.getInstance();
    const logService = LogService.getInstance();

    try {
        // 1. Stop polling
        console.log('[SHUTDOWN] Stopping polling loop...');
        tradingEngine.stopPolling();
        await new Promise(r => setTimeout(r, 1000)); // Give it time to stop

        // 2. Log final state
        const positions = ledgerService.getPositions();
        const balance = ledgerService.getBalance();
        const closedPositions = ledgerService.getClosedPositions();

        console.log('\n[SHUTDOWN] 📊 FINAL BOT STATE:');
        console.log(`├─ Current Balance: $${balance.toFixed(2)}`);
        console.log(`├─ Open Positions: ${Object.keys(positions).length}`);
        console.log(`├─ Closed Positions (Total): ${closedPositions.length}`);

        if (Object.keys(positions).length > 0) {
            console.log(`├─ Open Positions Details:`);
            for (const pos of Object.values(positions)) {
                const pnl = pos.unrealizedPnL || 0;
                const pnlSign = pnl >= 0 ? '📈' : '📉';
                const price = pos.currentPrice || 0;
                console.log(
                    `│  ├─ ${pos.side} ${pos.size.toFixed(2)} units in "${pos.marketName.substring(0, 30)}..." @ $${price.toFixed(4)} | P&L: ${pnlSign} $${pnl.toFixed(2)}`
                );
            }
        }

        // 3. Log fees and stats
        const dailyPnL = ledgerService.getDailyStats().dailyRealized || 0;
        console.log(`└─ Daily Realized P&L: $${dailyPnL.toFixed(2)}`);

        logService.logSystem('SHUTDOWN', 'Bot shutdown complete. Final state logged.');
        console.log('\n[SHUTDOWN] ✅ Graceful shutdown complete. Exiting...');
        console.log('═════════════════════════════════════════════════════\n');

        process.exit(0);
    } catch (err: any) {
        console.error('[SHUTDOWN] Error during graceful shutdown:', err.message);
        logService.logError('SHUTDOWN', err);
        process.exit(1);
    }
}

/**
 * MAIN ENTRY POINT
 * Initializes all services, handles dependencies, and starts the loops.
 */
async function main() {
    console.log('--------------------------------------------------');
    console.log('🚀 Polymarket Paper Trading Bot Starting...');
    console.log('--------------------------------------------------');

    // 1. Initialize Logger
    const logService = LogService.getInstance();
    if (config.DEBUG_LOGS) logService.logSystem('System', 'Boot sequence initiated');

    try {
        // 2. Initialize Ledger
        const ledgerService = LedgerService.getInstance();
        const currentBalance = ledgerService.getBalance();
        if (config.DEBUG_LOGS) logService.logSystem('Ledger', `Ledger initialized. Current Balance: $${currentBalance.toFixed(2)}`);

        // 3. Initialize API Connection
        // Just invoking getInstance ensures the connection is ready
        PolymarketService.getInstance();
        if (config.DEBUG_LOGS) logService.logSystem('API', 'Polymarket Service ready');

        // 4. Initialize Trading Engine
        const tradingEngine = TradingEngine.getInstance();

        // 5. Start Dashboard Server
        // UPDATED: No longer needs setServices(), it connects automatically via Singletons
        const dashboard = new DashboardServer(config.PORT);
        dashboard.start(config.PORT);
        logService.logSystem('Dashboard', `UI running at http://localhost:${config.PORT}`);

        // 6. Start the Copy-Trading Loop
        if (config.DEBUG_LOGS) logService.logSystem('Engine', `Tracking Profile: ${config.PROFILE_ADDRESS}`);
        logService.logSystem('Engine', 'Starting polling loop...');

        await tradingEngine.startPolling();

    } catch (error) {
        console.error('❌ CRITICAL STARTUP ERROR:', error);
        logService.logError('Startup', error);
        process.exit(1);
    }
}

// ------------------------------------------------------------------
// GLOBAL ERROR HANDLERS
// ------------------------------------------------------------------

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ UNHANDLED REJECTION:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ UNCAUGHT EXCEPTION:', error);
    process.exit(1);
});

process.on('SIGINT', () => {
    gracefulShutdown();
});

// Execute
main();