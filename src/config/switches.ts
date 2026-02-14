
import config from './config.js';

export const FeatureSwitches = {
    /**
     * SKIP_ACTIVE_POSITIONS
     * 
     * If true: The bot will fetch the target's current positions on startup and add them to a blacklist.
     *          Any subsequent trades for these markets will be ignored (unless we already hold a position locally).
     * 
     * If false: The bot will ignore existing positions and copy every trade event it sees, potentially doubling down.
     */
    SKIP_ACTIVE_POSITIONS: false,

    /**
     * ENABLE_WEATHER_GUARD
     * 
     * If true: Enables strict safeguards for weather markets (no price resolution, min hold time).
     */
    ENABLE_WEATHER_GUARD: true,
};

export default FeatureSwitches;
