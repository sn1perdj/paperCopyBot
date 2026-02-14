/**
 * @file ticks.ts
 * @description Core utility for integer tick arithmetic.
 * Ensures deterministic pricing and zero float rounding drift.
 * 
 * Polymarket microstructure:
 * - Price domain: 0.001 – 0.999
 * - Tick size: 0.001
 * - Valid ticks: 1 – 999
 * - NEVER 0
 * - NEVER 1000
 */

// Tick range constants
export const MIN_TICK = 1;
export const MAX_TICK = 999;
export const TICK_SCALE = 1000;

/**
 * Convert decimal probability to integer tick.
 * Handles clamping and floor logic.
 * 
 * @param price Decimal price (e.g., 0.53)
 * @returns Integer tick (e.g., 530)
 * @throws Error if input is invalid
 */
export function toTick(price: number): number {
    if (typeof price !== "number" || isNaN(price)) {
        throw new Error("Invalid price input");
    }

    // Use Math.floor to match user requirement logic (though standard rounding might vary, sticking to plan)
    // "The tick = Math.floor(price * TICK_SCALE);" from prompt
    const tick = Math.floor(price * TICK_SCALE);

    return clampTick(tick);
}

/**
 * Convert integer tick to decimal probability.
 * 
 * @param tick Integer tick (e.g., 530)
 * @returns Decimal price (e.g., 0.53)
 */
export function fromTick(tick: number): number {
    return clampTick(tick) / TICK_SCALE;
}

/**
 * Clamp tick-value to valid Polymarket range [1, 999].
 * 
 * @param tick Integer tick
 * @returns Clamped tick
 */
export function clampTick(tick: number): number {
    if (tick < MIN_TICK) return MIN_TICK;
    if (tick > MAX_TICK) return MAX_TICK;
    return tick;
}
