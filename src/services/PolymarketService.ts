import axios, { AxiosInstance } from 'axios';
import { WebSocket } from 'ws';
import { OrderBook, OrderBookLevel, MarketPrice } from '../types.js';
import { config } from '../config/config.js';

const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export interface UserActivityTrade {
  id: string; timestamp: number; type: string; outcome: string;
  size: number; price: number; marketId: string; side: string;
}

export class PolymarketService {
  private static instance: PolymarketService;
  private dataApiClient: AxiosInstance;

  private gammaApiClient: AxiosInstance;
  private ws: WebSocket | null = null;
  private keepAliveInterval: NodeJS.Timeout | null = null;

  private constructor() {
    this.dataApiClient = axios.create({ baseURL: 'https://data-api.polymarket.com', timeout: 5000 });
    this.gammaApiClient = axios.create({ baseURL: 'https://gamma-api.polymarket.com', timeout: 5000 });
  }

  public static getInstance(): PolymarketService {
    if (!PolymarketService.instance) PolymarketService.instance = new PolymarketService();
    return PolymarketService.instance;
  }

  public async getUserActivity(address: string) {
    try {
      const res = await this.dataApiClient.get(`/activity?user=${address}&limit=10`);
      return res.data;
    } catch (e) { return []; }
  }

  public async getPositions(address: string) {
    try {
      const res = await this.dataApiClient.get(`/positions?user=${address}&size_min=1`); // Filter practically closed positions
      return res.data;
    } catch (e) {
      console.error('[API] Failed to fetch positions:', e);
      return [];
    }
  }

  public async getProfileName(address: string): Promise<string> {
    try {
      const res = await this.dataApiClient.get(`/users/${address}`);
      return res.data?.display_name || res.data?.name || address;
    } catch (e) {
      return address;
    }
  }

  public async getMarketDetails(marketId: string) {
    try {
      let data = null;
      try {
        const res = await this.gammaApiClient.get(`/markets/${marketId}`);
        data = res.data;
      } catch (e) {
        try {
          const res = await this.gammaApiClient.get(`/markets?condition_ids=${marketId}`);
          if (Array.isArray(res.data) && res.data.length > 0) data = res.data[0];
        } catch (inner) { return null; }
      }

      if (!data) return null;

      let eventSlug = data.slug;
      if (data.events && Array.isArray(data.events) && data.events.length > 0) {
        eventSlug = data.events[0].slug;
      }

      // Parse outcomes safely
      let outcomes = ["No", "Yes"]; // Default
      if (data.outcomes) {
        try {
          // Sometimes it's a string "[\"A\", \"B\"]", sometimes an array
          outcomes = typeof data.outcomes === 'string' ? JSON.parse(data.outcomes) : data.outcomes;
        } catch (e) { }
      }

      // Parse clobTokenIds
      let clobTokenIds: string[] = [];
      if (data.clobTokenIds) {
        try {
          clobTokenIds = typeof data.clobTokenIds === 'string' ? JSON.parse(data.clobTokenIds) : data.clobTokenIds;
        } catch (e) { }
      }

      return {
        question: data.question,
        slug: eventSlug,
        active: data.active,
        closed: data.closed,
        // CRITICAL FIX: resolvedBy is often an address that exists even for live markets.
        // A market is only officially RESOLVED if active=false AND (resolvedBy or UMA status says so).
        resolved: !data.active && !!(data.resolvedBy || data.umaResolutionStatus === 'resolved'),
        outcomePrices: data.outcomePrices,
        outcomes: outcomes, // Return the names (e.g. ["Up", "Down"])
        clobTokenIds,
        endTime: data.endDate ? new Date(data.endDate).getTime() : undefined
      };
    } catch (e) { return null; }
  }



  public async getOrderBook(marketId: string): Promise<OrderBook | null> {
    try {
      // Get market metadata to extract token IDs
      const marketCache = await this.getMarketDetails(marketId);
      if (!marketCache?.clobTokenIds || marketCache.clobTokenIds.length < 2) {
        console.debug(`[ORDERBOOK] No token IDs available for market ${marketId.substring(0, 8)}...`);
        return null;
      }

      // YES outcome token is at index 1
      const yesTokenId = marketCache.clobTokenIds[1];
      if (!yesTokenId) {
        console.debug(`[ORDERBOOK] Missing YES token for ${marketId.substring(0, 8)}...`);
        return null;
      }

      // Use token_id parameter (CLOB API requirement, not market_id)
      const url = `https://clob.polymarket.com/book?token_id=${yesTokenId}`;

      const res = await fetch(url, {
        signal: AbortSignal.timeout(3000)
      });

      if (!res.ok) {
        console.debug(`[ORDERBOOK] HTTP ${res.status} for token ${yesTokenId.substring(0, 8)}... (market: ${marketId.substring(0, 8)}...)`);
        return null;
      }

      const book = await res.json();

      // Validate book structure
      if (!book || typeof book !== 'object') {
        console.debug(`[ORDERBOOK] Invalid book structure for ${marketId.substring(0, 8)}...`);
        return null;
      }

      // Parse bids and asks with proper structure
      const bids: OrderBookLevel[] = (book?.bids || []).map((l: any) => ({
        price: Number(l.price),
        size: Number(l.size)
      }));

      const asks: OrderBookLevel[] = (book?.asks || []).map((l: any) => ({
        price: Number(l.price),
        size: Number(l.size)
      }));

      // Sort bids descending (highest first) and asks ascending (lowest first)
      bids.sort((a, b) => b.price - a.price);
      asks.sort((a, b) => a.price - b.price);

      // Log successful fetch with book depth info
      if (bids.length > 0 && asks.length > 0) {
        const bestBid = bids[0].price;
        const bestAsk = asks[0].price;
        const spread = ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2) * 100).toFixed(2);
        const totalBidDepth = bids.reduce((sum, b) => sum + (b.price * b.size), 0);
        const totalAskDepth = asks.reduce((sum, a) => sum + (a.price * a.size), 0);
        if (config.DEBUG_LOGS) console.debug(
          `[ORDERBOOK ✓] ${marketId.substring(0, 8)}... | Bid: ${bestBid.toFixed(4)} | Ask: ${bestAsk.toFixed(4)} | Spread: ${spread}% | Depth: $${(totalBidDepth + totalAskDepth).toFixed(0)}`
        );
      } else {
        if (config.DEBUG_LOGS) console.debug(`[ORDERBOOK] Empty book for ${marketId.substring(0, 8)}... (bids: ${bids.length}, asks: ${asks.length})`);
      }

      return { bids, asks };
    } catch (e: any) {
      if (e.name === 'AbortError') {
        if (config.DEBUG_LOGS) console.debug(`[ORDERBOOK] Timeout (3s) fetching ${marketId.substring(0, 8)}...`);
      } else if (e instanceof TypeError) {
        if (config.DEBUG_LOGS) console.debug(`[ORDERBOOK] Network error for ${marketId.substring(0, 8)}...: ${e.message}`);
      } else {
        if (config.DEBUG_LOGS) console.debug(`[ORDERBOOK] Error for ${marketId.substring(0, 8)}...: ${e.message}`);
      }
      return null;
    }
  }

  public async getOutcomePrices(marketId: string): Promise<number[] | null> {
    try {
      const res = await this.gammaApiClient.get(`/markets/${marketId}`, { timeout: 2000 });
      const raw = res.data?.outcomePrices;
      if (!raw) return null;
      const prices = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(prices) || prices.length < 2) return null;
      return prices.map(Number);
    } catch (e: any) {
      // console.error(`[API] fetchOutcomePrices primary failed for ${marketId}: ${e.message}`);
      try {
        const res = await this.gammaApiClient.get(`/markets?condition_ids=${marketId}`, { timeout: 2000 });
        const data = Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null;
        if (!data?.outcomePrices) return null;
        const prices = typeof data.outcomePrices === 'string' ? JSON.parse(data.outcomePrices) : data.outcomePrices;
        if (!Array.isArray(prices) || prices.length < 2) return null;
        return prices.map(Number);
      } catch (inner: any) {
        // console.error(`[API] fetchOutcomePrices fallback failed for ${marketId}: ${inner.message}`);
        return null;
      }
    }
  }

  public async getLivePrice(conditionId: string): Promise<MarketPrice | null> {
    const book = await this.getOrderBook(conditionId);
    if (!book || book.bids.length === 0 || book.asks.length === 0) return null;

    const bestBid = book.bids[0].price;
    const bestAsk = book.asks[0].price;
    const midPrice = (bestBid + bestAsk) / 2;

    // console.log('[CLOB PRICE]', conditionId, { bestBid, bestAsk, midPrice });

    return { bestBid, bestAsk, midPrice };
  }

  /**
   * Subscribes to the Orderbook channel for the given token IDs.
   */
  public subscribeToOrderbook(tokenIds: string[], onMessage: (data: any) => void) {
    if (this.ws) {
      this.ws.close();
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
    }

    this.ws = new WebSocket(CLOB_WS_URL);

    if (!this.ws) {
      console.error("Failed to initialize WebSocket");
      return;
    }

    const ws = this.ws as any;

    ws.on("open", () => {
      // console.log("Connected to Polymarket CLOB WebSocket");

      const subscriptionMessage = {
        type: "market",
        assets_ids: tokenIds,
        channel: "book"
      };

      ws.send(JSON.stringify(subscriptionMessage));
      // console.log(`Subscribed to book for tokens: ${tokenIds.join(", ")}`);
    });

    ws.on("message", (data: any) => {
      try {
        const parsed = JSON.parse(data.toString());
        onMessage(parsed);
      } catch (err) {
        console.error("Failed to parse WS message", err);
      }
    });

    ws.on("error", (err: any) => {
      // console.error("WebSocket error:", err);
    });

    ws.on("close", () => {
      // console.log("WebSocket connection closed");
    });
  }

  public close() {
    if (this.ws) {
      this.ws.close();
    }
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
    }
  }



}



export default PolymarketService;