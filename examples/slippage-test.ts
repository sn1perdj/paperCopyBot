/**
 * Example: Testing SlippageCalculator in isolation
 *
 * This file demonstrates how to use the SlippageCalculator for different market scenarios.
 * Run with: npx ts-node examples/slippage-test.ts
 */

import SlippageCalculator from '../src/services/SlippageCalculator.js';
import { MarketPrice, OrderBook } from '../src/types.js';

// Example 1: Healthy market with good liquidity
console.log('\n=== SCENARIO 1: Healthy Market (Good Liquidity) ===');
{
  const calculator = new SlippageCalculator(0.003); // 0.3% delay penalty

  const marketPrice: MarketPrice = {
    bestBid: 0.45,
    bestAsk: 0.47,
    midPrice: 0.46
  };

  const orderBook: OrderBook = {
    bids: [
      { price: 0.45, size: 1000 },
      { price: 0.44, size: 2000 },
      { price: 0.43, size: 3000 }
    ],
    asks: [
      { price: 0.47, size: 1000 },
      { price: 0.48, size: 2000 },
      { price: 0.49, size: 3000 }
    ]
  };

  const slippageEstimate = calculator.calculateExpectedSlippage(
    marketPrice,
    orderBook,
    100, // $100 trade
    true, // BUY
    0.06 // 6% expected edge
  );

  console.log(calculator.getDetailedLog(slippageEstimate, '0xmarket1', 100, 0.06));
}

// Example 2: Illiquid market (wide spread, low depth)
console.log('\n=== SCENARIO 2: Illiquid Market (Poor Liquidity) ===');
{
  const calculator = new SlippageCalculator(0.003);

  const marketPrice: MarketPrice = {
    bestBid: 0.40,
    bestAsk: 0.55,
    midPrice: 0.475
  };

  const orderBook: OrderBook = {
    bids: [{ price: 0.40, size: 50 }], // Only 50 shares at best bid
    asks: [{ price: 0.55, size: 50 }]  // Only 50 shares at best ask
  };

  const slippageEstimate = calculator.calculateExpectedSlippage(
    marketPrice,
    orderBook,
    1000, // $1000 trade (large relative to liquidity)
    true,
    0.06
  );

  console.log(calculator.getDetailedLog(slippageEstimate, '0xmarket2', 1000, 0.06));
}

// Example 3: Large trade in small market
console.log('\n=== SCENARIO 3: Large Trade in Small Market ===');
{
  const calculator = new SlippageCalculator(0.003);

  const marketPrice: MarketPrice = {
    bestBid: 0.50,
    bestAsk: 0.51,
    midPrice: 0.505
  };

  const orderBook: OrderBook = {
    bids: [
      { price: 0.50, size: 100 },
      { price: 0.49, size: 100 }
    ],
    asks: [
      { price: 0.51, size: 100 },
      { price: 0.52, size: 100 }
    ]
  };

  const slippageEstimate = calculator.calculateExpectedSlippage(
    marketPrice,
    orderBook,
    500, // $500 trade (large for this market)
    false, // SELL
    0.06
  );

  console.log(calculator.getDetailedLog(slippageEstimate, '0xmarket3', 500, 0.06));
}

// Example 4: Small edge, should be more conservative
console.log('\n=== SCENARIO 4: Small Expected Edge (2%) ===');
{
  const calculator = new SlippageCalculator(0.003);

  const marketPrice: MarketPrice = {
    bestBid: 0.45,
    bestAsk: 0.47,
    midPrice: 0.46
  };

  const orderBook: OrderBook = {
    bids: [
      { price: 0.45, size: 1000 },
      { price: 0.44, size: 2000 }
    ],
    asks: [
      { price: 0.47, size: 1000 },
      { price: 0.48, size: 2000 }
    ]
  };

  const slippageEstimate = calculator.calculateExpectedSlippage(
    marketPrice,
    orderBook,
    100,
    true,
    0.02 // Only 2% edge (more conservative)
  );

  console.log(calculator.getDetailedLog(slippageEstimate, '0xmarket4', 100, 0.02));
}

// Example 5: Edge case - empty order book
console.log('\n=== SCENARIO 5: Empty Order Book (No Liquidity) ===');
{
  const calculator = new SlippageCalculator(0.003);

  const marketPrice: MarketPrice = {
    bestBid: 0.50,
    bestAsk: 0.50,
    midPrice: 0.50
  };

  const orderBook: OrderBook = {
    bids: [],
    asks: []
  };

  const slippageEstimate = calculator.calculateExpectedSlippage(
    marketPrice,
    orderBook,
    100,
    true,
    0.06
  );

  console.log(calculator.getDetailedLog(slippageEstimate, '0xmarket5', 100, 0.06));
}

// Example 6: Different delay penalties
console.log('\n=== SCENARIO 6: High Delay Penalty (0.5%) ===');
{
  const calculator = new SlippageCalculator(0.005); // 0.5% delay penalty

  const marketPrice: MarketPrice = {
    bestBid: 0.45,
    bestAsk: 0.47,
    midPrice: 0.46
  };

  const orderBook: OrderBook = {
    bids: [
      { price: 0.45, size: 1000 },
      { price: 0.44, size: 2000 }
    ],
    asks: [
      { price: 0.47, size: 1000 },
      { price: 0.48, size: 2000 }
    ]
  };

  const slippageEstimate = calculator.calculateExpectedSlippage(
    marketPrice,
    orderBook,
    100,
    true,
    0.06
  );

  console.log(calculator.getDetailedLog(slippageEstimate, '0xmarket6', 100, 0.06));
}

console.log('\n=== Test Complete ===\n');
