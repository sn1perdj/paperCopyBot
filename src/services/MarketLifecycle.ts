export interface MarketLifecycleResult {
    marketType: "SINGLE" | "MULTI";
    state: "ACTIVE" | "PENDING_RESOLUTION" | "CLOSED";
    result?: "YES_WON" | "NO_WON";
    winningOutcomeLabel?: string;
    winningOutcomeIndex?: number;
    winningSide?: "YES" | "NO"; // MULTI-only: the winning side within this child market
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

        // Helper to determine winner from resolution data (shared by both)
        const parseWinner = (market: any): { result?: "YES_WON" | "NO_WON"; winningOutcomeLabel?: string; winningOutcomeIndex?: number } => {
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

            return { result, winningOutcomeLabel, winningOutcomeIndex };
        };

        // SINGLE-OUTCOME LOGIC: Use endDate
        const determineSingleOutcomeState = (market: any): Partial<MarketLifecycleResult> => {
            const umaStatus = market.umaResolutionStatus;
            const now = Date.now();
            const end = new Date(market.endDate).getTime();

            if (umaStatus === "resolved") {
                return {
                    state: "CLOSED",
                    ...parseWinner(market)
                };
            } else if (now >= end) {
                return { state: "PENDING_RESOLUTION" };
            } else {
                return { state: "ACTIVE" };
            }
        };

        // MULTI-OUTCOME: Determine winningSide from outcomePrices per child market
        const parseMultiWinner = (market: any): { winningSide?: "YES" | "NO"; winningOutcomeLabel?: string; winningOutcomeIndex?: number } => {
            try {
                const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
                const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;

                if (Array.isArray(outcomes) && Array.isArray(prices)) {
                    const winningIndex = prices.findIndex((p: any) => Number(p) >= 0.99);
                    if (winningIndex !== -1) {
                        const winningLabel = String(outcomes[winningIndex]).toUpperCase();
                        let winningSide: "YES" | "NO" | undefined;

                        if (winningLabel === "YES" || winningLabel.includes("YES")) {
                            winningSide = "YES";
                        } else if (winningLabel === "NO" || winningLabel.includes("NO")) {
                            winningSide = "NO";
                        }

                        return {
                            winningSide,
                            winningOutcomeLabel: String(outcomes[winningIndex]),
                            winningOutcomeIndex: winningIndex
                        };
                    }
                }
            } catch (e) {
                console.error("[LIFECYCLE] Failed parsing MULTI resolution data", e);
            }

            return {};
        };

        // MULTI-OUTCOME LOGIC: Use acceptingOrders flag
        const determineMultiOutcomeState = (market: any): Partial<MarketLifecycleResult> => {
            const umaStatus = market.umaResolutionStatus || market.uma_resolution_status;
            // Handle both camelCase and snake_case, and string/boolean
            const acceptingOrders = market.acceptingOrders ?? market.accepting_orders;
            const isAccepting = acceptingOrders === true || acceptingOrders === "true";

            if (umaStatus === "resolved") {
                const winner = parseMultiWinner(market);
                return {
                    state: "CLOSED",
                    result: winner.winningSide === "YES" ? "YES_WON" : winner.winningSide === "NO" ? "NO_WON" : undefined,
                    ...winner
                };
            } else if (!isAccepting) {
                return { state: "PENDING_RESOLUTION" };
            } else {
                return { state: "ACTIVE" };
            }
        };

        // --- EXECUTE DETERMINISTIC CHECK ---
        if (marketType === "SINGLE") {
            const market = markets.length > 0 ? markets[0] : container;
            return { marketType, ...determineSingleOutcomeState(market) } as MarketLifecycleResult;
        }

        if (marketType === "MULTI") {
            // Match by condition_id (marketId is a condition_id) or id
            const market = markets.find((m: any) =>
                m.condition_id === marketId || m.conditionId === marketId || m.id === marketId
            );
            if (!market) {
                console.warn(`[LIFECYCLE] No market found for ${marketId} in ${markets.length} event markets. IDs: ${markets.map((m: any) => m.id || m.condition_id).join(', ')}`);
                return { marketType: "MULTI", state: "ACTIVE" };
            }
            return { marketType, ...determineMultiOutcomeState(market) } as MarketLifecycleResult;
        }

        return { marketType: "SINGLE", state: "ACTIVE" };
    }
}
