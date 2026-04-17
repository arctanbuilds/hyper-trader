/**
 * Full Trade Lifecycle Simulation
 * Walks through: Entry → price moves → BE trigger → TP or SL close
 * Tests the actual code logic extracted from trading-engine.ts
 */

function formatHLPrice(price: number, szDecimals: number): string {
  if (Number.isInteger(price)) return price.toString();
  const maxDecimals = Math.max(6 - szDecimals, 0);
  return price.toFixed(maxDecimals).replace(/0+$/, '').replace(/\.$/, '');
}

function displayPrice(price: number, szDecimals: number): string {
  return formatHLPrice(price, szDecimals);
}

// Simulate a trade
interface SimTrade {
  id: number;
  coin: string;
  side: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  szDecimals: number;
}

function simCheckExits(trade: SimTrade, currentPrice: number): { action: string; newSL?: number } {
  const szd = trade.szDecimals;
  
  // BE check
  const rawPricePct = trade.side === "long"
    ? (currentPrice - trade.entryPrice) / trade.entryPrice
    : (trade.entryPrice - currentPrice) / trade.entryPrice;
  const beSL = trade.entryPrice;
  const currentSL = trade.stopLoss;
  const isStillOriginalSL = trade.side === "long"
    ? currentSL < trade.entryPrice * 0.999
    : currentSL > trade.entryPrice * 1.001;
  
  if (rawPricePct >= 0.002 && isStillOriginalSL) {
    trade.stopLoss = beSL;
    return { action: `[BE] SL moved to $${displayPrice(beSL, szd)} (price +${(rawPricePct*100).toFixed(2)}%)`, newSL: beSL };
  }
  
  // TP/SL check
  const tpHit = (trade.side === "long" && currentPrice >= trade.takeProfit1) ||
                (trade.side === "short" && currentPrice <= trade.takeProfit1);
  const slHit = trade.stopLoss > 0 && (
    (trade.side === "long" && currentPrice <= trade.stopLoss) ||
    (trade.side === "short" && currentPrice >= trade.stopLoss)
  );
  
  const isBE = !isStillOriginalSL;
  if (tpHit) return { action: `TP +0.43% @ $${displayPrice(currentPrice, szd)}` };
  if (slHit) return { action: isBE ? `SL @ BE $${displayPrice(currentPrice, szd)}` : `SL -0.5% @ $${displayPrice(currentPrice, szd)}` };
  
  return { action: `HOLD (price ${(rawPricePct*100).toFixed(3)}%, SL=$${displayPrice(trade.stopLoss, szd)})` };
}

console.log("========================================");
console.log("SCENARIO 1: BTC LONG — TP after BE move");
console.log("========================================");
{
  const entry = 84500;
  const trade: SimTrade = {
    id: 1, coin: "BTC", side: "long", entryPrice: entry,
    stopLoss: entry * 0.995,    // -0.5% = $84077.50
    takeProfit1: entry * 1.0043, // +0.43% = $84863.35
    szDecimals: 5,
  };
  console.log(`Entry: $${entry} | SL: $${trade.stopLoss.toFixed(2)} | TP: $${trade.takeProfit1.toFixed(2)}`);
  
  const prices = [84500, 84550, 84600, 84650, 84669, 84700, 84800, 84863.35];
  for (const p of prices) {
    const result = simCheckExits(trade, p);
    console.log(`  Price $${p.toFixed(2)} → ${result.action}`);
  }
}

console.log("\n==========================================");
console.log("SCENARIO 2: ETH SHORT — BE then SL @ BE");
console.log("==========================================");
{
  const entry = 2400;
  const trade: SimTrade = {
    id: 2, coin: "ETH", side: "short", entryPrice: entry,
    stopLoss: entry * 1.005,     // +0.5% = $2412
    takeProfit1: entry * 0.9957, // -0.43% = $2389.68
    szDecimals: 4,
  };
  console.log(`Entry: $${entry} | SL: $${trade.stopLoss.toFixed(2)} | TP: $${trade.takeProfit1.toFixed(2)}`);
  
  const prices = [2400, 2398, 2396, 2395.2, 2394, 2397, 2399, 2400, 2400.5];
  for (const p of prices) {
    const result = simCheckExits(trade, p);
    console.log(`  Price $${p.toFixed(2)} → ${result.action}`);
  }
}

console.log("\n========================================");
console.log("SCENARIO 3: BTC SHORT — straight SL hit");
console.log("========================================");
{
  const entry = 84500;
  const trade: SimTrade = {
    id: 3, coin: "BTC", side: "short", entryPrice: entry,
    stopLoss: entry * 1.005,     // +0.5% = $84922.50
    takeProfit1: entry * 0.9957, // -0.43% = $84136.65
    szDecimals: 5,
  };
  console.log(`Entry: $${entry} | SL: $${trade.stopLoss.toFixed(2)} | TP: $${trade.takeProfit1.toFixed(2)}`);
  
  const prices = [84500, 84550, 84700, 84900, 84922.5];
  for (const p of prices) {
    const result = simCheckExits(trade, p);
    console.log(`  Price $${p.toFixed(2)} → ${result.action}`);
  }
}

console.log("\n==========================================");
console.log("SCENARIO 4: ETH LONG — BE move then TP");
console.log("==========================================");
{
  const entry = 2400;
  const trade: SimTrade = {
    id: 4, coin: "ETH", side: "long", entryPrice: entry,
    stopLoss: entry * 0.995,     // -0.5% = $2388
    takeProfit1: entry * 1.0043, // +0.43% = $2410.32
    szDecimals: 4,
  };
  console.log(`Entry: $${entry} | SL: $${trade.stopLoss.toFixed(2)} | TP: $${trade.takeProfit1.toFixed(2)}`);
  
  const prices = [2400, 2402, 2404, 2404.8, 2406, 2408, 2410, 2410.32];
  for (const p of prices) {
    const result = simCheckExits(trade, p);
    console.log(`  Price $${p.toFixed(2)} → ${result.action}`);
  }
}

console.log("\n✅ All scenarios completed successfully");
