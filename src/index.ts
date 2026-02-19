import 'dotenv/config'; // Ensures environment variables are loaded first
import { config } from './config/config.js';
import LedgerService from './services/LedgerService.js';
import LogService from './services/LogService.js';
import PolymarketService from './services/PolymarketService.js';
import TradingEngine from './services/TradingEngine.js';
import DashboardServer from './dashboard/server.js';
import FileLogger from './services/FileLogger.js';

// ===== GRACEFUL SHUTDOWN HANDLER =====
async function gracefulShutdown() {
    const flog = FileLogger.getInstance();

    console.log('\n═════════════════════════════════════════════════════');
    console.log('🛑 GRACEFUL SHUTDOWN INITIATED (SIGINT)');
    console.log('═════════════════════════════════════════════════════');
    flog.shutdown('SIGINT received — graceful shutdown initiated');

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

        const finalState = {
            balance: balance.toFixed(2),
            openPositions: Object.keys(positions).length,
            closedPositionsTotal: closedPositions.length,
            positions: Object.values(positions).map(p => ({
                market: p.marketName?.substring(0, 40),
                side: p.side,
                size: p.size?.toFixed(2),
                state: p.state,
                unrealizedPnL: (p.unrealizedPnL || 0).toFixed(2)
            }))
        };
        flog.shutdown('Final bot state captured', finalState);

        if (config.DEBUG_LOGS) {
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
        }

        logService.logSystem('SHUTDOWN', 'Bot shutdown complete. Final state logged.');
        flog.shutdown('Graceful shutdown complete. Exiting with code 0.');
        flog.flush();
        console.log('\n[SHUTDOWN] ✅ Graceful shutdown complete. Exiting...');
        console.log('═════════════════════════════════════════════════════\n');

        process.exit(0);
    } catch (err: any) {
        console.error('[SHUTDOWN] Error during graceful shutdown:', err.message);
        flog.crash('Error during graceful shutdown', { error: err.message, stack: err.stack });
        flog.flush();
        logService.logError('SHUTDOWN', err);
        process.exit(1);
    }
}

/**
 * MAIN ENTRY POINT
 * Initializes all services, handles dependencies, and starts the loops.
 */
async function main() {
    const flog = FileLogger.getInstance();

    console.log('--------------------------------------------------');
    console.log('🚀 Polymarket Paper Trading Bot Starting...');
    console.log('--------------------------------------------------');

    flog.boot('=== BOT PROCESS STARTED ===', {
        pid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        cwd: process.cwd()
    });

    // 1. Initialize Logger
    const logService = LogService.getInstance();
    if (config.DEBUG_LOGS) logService.logSystem('System', 'Boot sequence initiated');
    flog.boot('LogService initialized');

    try {
        // 2. Initialize Ledger
        const ledgerService = LedgerService.getInstance();
        const currentBalance = ledgerService.getBalance();
        const openCount = Object.keys(ledgerService.getPositions()).length;
        if (config.DEBUG_LOGS) logService.logSystem('Ledger', `Ledger initialized. Current Balance: $${currentBalance.toFixed(2)}`);
        flog.boot('LedgerService initialized', { balance: currentBalance.toFixed(2), openPositions: openCount });

        // 3. Initialize API Connection
        PolymarketService.getInstance();
        if (config.DEBUG_LOGS) logService.logSystem('API', 'Polymarket Service ready');
        flog.boot('PolymarketService initialized');

        // 4. Initialize Trading Engine
        const tradingEngine = TradingEngine.getInstance();
        flog.boot('TradingEngine initialized');

        // 5. Start Dashboard Server
        const dashboard = new DashboardServer(config.PORT);
        dashboard.start(config.PORT);
        if (config.DEBUG_LOGS) logService.logSystem('Dashboard', `UI running at http://localhost:${config.PORT}`);
        flog.boot(`Dashboard started on port ${config.PORT}`);

        // 6. Start the Copy-Trading Loop
        if (config.DEBUG_LOGS) logService.logSystem('Engine', `Tracking Profile: ${config.PROFILE_ADDRESS}`);
        if (config.DEBUG_LOGS) logService.logSystem('Engine', 'Starting polling loop...');
        flog.boot('Starting polling loop', { profile: config.PROFILE_ADDRESS, pollInterval: config.POLL_INTERVAL_MS });

        await tradingEngine.startPolling();

    } catch (error: any) {
        console.error('❌ CRITICAL STARTUP ERROR:', error);
        flog.crash('CRITICAL STARTUP ERROR', { error: error.message, stack: error.stack });
        flog.flush();
        logService.logError('Startup', error);
        process.exit(1);
    }
}

// ------------------------------------------------------------------
// GLOBAL ERROR HANDLERS
// ------------------------------------------------------------------

process.on('unhandledRejection', (reason: any, promise) => {
    console.error('⚠️ UNHANDLED REJECTION:', reason);
    const flog = FileLogger.getInstance();
    flog.crash('UNHANDLED REJECTION', {
        reason: reason?.message || String(reason),
        stack: reason?.stack || 'no stack'
    });
});

process.on('uncaughtException', (error) => {
    console.error('❌ UNCAUGHT EXCEPTION:', error);
    const flog = FileLogger.getInstance();
    flog.crash('UNCAUGHT EXCEPTION — process will exit(1)', {
        error: error.message,
        stack: error.stack
    });
    flog.flush();
    process.exit(1);
});

process.on('SIGINT', () => {
    gracefulShutdown();
});

process.on('SIGTERM', () => {
    const flog = FileLogger.getInstance();
    flog.shutdown('SIGTERM received — process being killed by OS/VPS');
    flog.flush();
    gracefulShutdown();
});

// Execute
main();