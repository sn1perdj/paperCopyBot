export interface MarketLifecycleResult {
    marketType: "SINGLE" | "MULTI";
    state: "ACTIVE" | "PENDING_RESOLUTION" | "CLOSED";
    result?: "YES_WON" | "NO_WON";
    winningOutcomeLabel?: string;
    winningOutcomeIndex?: number;
}

export class MarketLifecycle {

    /**
     * Deterministic State Engine for Market Lifecycle
     * 
     * @param container - The full market container object (Event). 
     *                    MUST contain 'markets' array to detect type.
     * @param marketId - The specific market ID we are checking (for multi-outcome context)
     */
    public static getMarketLifecycle(container: any, marketId: string): MarketLifecycleResult {
        const markets = container.markets || [];
        // Default to SINGLE if no markets array or length <= 1
        const marketType: "SINGLE" | "MULTI" = (markets.length > 1) ? "MULTI" : "SINGLE";

        // Helper to determine winner from market data
        const determineWinner = (market: any): Partial<MarketLifecycleResult> => {
            const umaStatus = market.umaResolutionStatus;
            const now = Date.now();
            const end = new Date(market.endDate).getTime();

            if (umaStatus === "resolved") {
                let result: "YES_WON" | "NO_WON" | undefined;
                let winningOutcomeLabel: string | undefined;
                let winningOutcomeIndex: number | undefined;

                try {
                    const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
                    const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;

                    if (Array.isArray(outcomes) && Array.isArray(prices)) {
                        for (let i = 0; i < outcomes.length; i++) {
                            // Winner has price 1 (or close to 1)
                            if (Number(prices[i]) >= 0.99) {
                                winningOutcomeIndex = i;
                                winningOutcomeLabel = String(outcomes[i]);
                                const labelUpper = winningOutcomeLabel.toUpperCase();

                                // Legacy Result Mapping
                                if (labelUpper.includes("YES") || labelUpper.includes("UP")) {
                                    result = "YES_WON";
                                } else if (labelUpper.includes("NO") || labelUpper.includes("DOWN")) {
                                    result = "NO_WON";
                                }
                                break; // Found winner
                            }
                        }
                    }
                } catch (e) {
                    console.error("[LIFECYCLE] Failed parsing resolution data", e);
                }

                return {
                    state: "CLOSED",
                    result,
                    winningOutcomeLabel,
                    winningOutcomeIndex
                };
            } else if (now >= end) {
                return { state: "PENDING_RESOLUTION" };
            } else {
                return { state: "ACTIVE" };
            }
        };

        // --- EXECUTE DETERMINISTIC CHECK ---
        if (marketType === "SINGLE") {
            const market = markets.length > 0 ? markets[0] : container;
            return { marketType, ...determineWinner(market) } as MarketLifecycleResult;
        }

        if (marketType === "MULTI") {
            const market = markets.find((m: any) => m.id === marketId);
            if (!market) return { marketType: "MULTI", state: "ACTIVE" };
            return { marketType, ...determineWinner(market) } as MarketLifecycleResult;
        }

        return { marketType: "SINGLE", state: "ACTIVE" };
    }
}
