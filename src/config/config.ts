import * as process from 'process';

interface Config {
  PROFILE_ADDRESS: string;
  POLL_INTERVAL_MS: number;
  MAX_TRADE_SIZE_USD: number;
  MAX_EXPOSURE_PCT: number;
  PORT: number;
  EXPECTED_EDGE: number; // Historical edge of source profile (e.g., 0.06 for 6%)
  SLIPPAGE_DELAY_PENALTY: number; // Latency penalty (0.2% - 0.5%, default 0.3%)
  ENABLE_TRADE_FILTERS: boolean; // Enable/disable safety checking
  DEBUG_LOGS: boolean;
  FIXED_COPY_PCT: number;
  MIN_ORDER_SIZE_SHARES: number;
  START_FROM_NOW: boolean;
}

const parseIntEnv = (key: string, defaultVal: number): number => {
  const v = process.env[key];
  if (v === undefined || v === '') return defaultVal;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? defaultVal : n;
};

const parseFloatEnv = (key: string, defaultVal: number): number => {
  const v = process.env[key];
  if (v === undefined || v === '') return defaultVal;
  const n = parseFloat(v);
  return Number.isNaN(n) ? defaultVal : n;
};

export const config: Config = {
  PROFILE_ADDRESS: process.env.PROFILE_ADDRESS ?? '',
  POLL_INTERVAL_MS: parseIntEnv('POLL_INTERVAL_MS', 1000),
  MAX_TRADE_SIZE_USD: parseFloatEnv('MAX_TRADE_SIZE_USD', 10),
  MAX_EXPOSURE_PCT: parseFloatEnv('MAX_EXPOSURE_PCT', 0.2),
  PORT: parseIntEnv('PORT', 3000),
  EXPECTED_EDGE: parseFloatEnv('EXPECTED_EDGE', 0.06), // Default 6% edge
  SLIPPAGE_DELAY_PENALTY: parseFloatEnv('SLIPPAGE_DELAY_PENALTY', 0.003), // Default 0.3%
  ENABLE_TRADE_FILTERS: false, // ⚠️ CHANGE TO false TO DISABLE ALL SAFETY CHECKS (Slippage & Profitability)
  DEBUG_LOGS: process.env.DEBUG_LOGS === 'true' || process.env.DEBUG_LOGS === '1',
  FIXED_COPY_PCT: parseFloatEnv('FIXED_COPY_PCT', 0.10), // 10% of target's share count
  MIN_ORDER_SIZE_SHARES: parseFloatEnv('MIN_ORDER_SIZE_SHARES', 1), // Minimum shares to execute
  START_FROM_NOW: process.env.START_FROM_NOW !== 'false', // Default true (only process new trades)
};

export type { Config };

export default config;
