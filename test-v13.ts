/**
 * v13.2 Logic Test — validates TP/SL calculations, BE move, and close labels
 */

// === TEST 1: TP and SL price calculations ===
console.log("=== TEST 1: TP/SL Price Calculations ===");

function testTPSL(side: "long" | "short", entryPrice: number) {
  const tp = side === "long" ? entryPrice * 1.0043 : entryPrice * 0.9957;
  const sl = side === "long" ? entryPrice * 0.995 : entryPrice * 1.005;
  const tpPct = side === "long" 
    ? ((tp - entryPrice) / entryPrice * 100) 
    : ((entryPrice - tp) / entryPrice * 100);
  const slPct = side === "long"
    ? ((entryPrice - sl) / entryPrice * 100)
    : ((sl - entryPrice) / entryPrice * 100);
  console.log(`  ${side.toUpperCase()} @ $${entryPrice}`);
  console.log(`    TP: $${tp.toFixed(2)} (+${tpPct.toFixed(3)}%) — should be +0.430%`);
  console.log(`    SL: $${sl.toFixed(2)} (-${slPct.toFixed(3)}%) — should be -0.500%`);
  console.log(`    TP correct: ${Math.abs(tpPct - 0.43) < 0.001 ? "✅" : "❌"}`);
  console.log(`    SL correct: ${Math.abs(slPct - 0.50) < 0.001 ? "✅" : "❌"}`);
  return { tp, sl };
}

const btcLong = testTPSL("long", 84500);
const btcShort = testTPSL("short", 84500);
const ethLong = testTPSL("long", 2400);
const ethShort = testTPSL("short", 2400);

// === TEST 2: Breakeven SL Move Logic ===
console.log("\n=== TEST 2: Breakeven SL Move Logic ===");

function testBEMove(side: "long" | "short", entryPrice: number, currentPrice: number, currentSL: number) {
  const rawPricePct = side === "long"
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;
  
  const isStillOriginalSL = side === "long"
    ? currentSL < entryPrice * 0.999
    : currentSL > entryPrice * 1.001;
  
  const shouldMoveToBE = rawPricePct >= 0.002 && isStillOriginalSL;
  
  console.log(`  ${side.toUpperCase()} entry=$${entryPrice} current=$${currentPrice} SL=$${currentSL.toFixed(2)}`);
  console.log(`    Price move: ${(rawPricePct * 100).toFixed(3)}%`);
  console.log(`    Original SL? ${isStillOriginalSL}`);
  console.log(`    Move to BE? ${shouldMoveToBE ? "✅ YES" : "⬜ NO"}`);
  return shouldMoveToBE;
}

// BTC LONG: price up +0.15% — should NOT move to BE (under 0.2%)
const t2a = testBEMove("long", 84500, 84500 * 1.0015, 84500 * 0.995);
console.log(`    Expected: NO — ${!t2a ? "✅" : "❌"}`);

// BTC LONG: price up +0.20% — SHOULD move to BE
const t2b = testBEMove("long", 84500, 84500 * 1.002, 84500 * 0.995);
console.log(`    Expected: YES — ${t2b ? "✅" : "❌"}`);

// BTC LONG: price up +0.30% but SL already at BE — should NOT move again
const t2c = testBEMove("long", 84500, 84500 * 1.003, 84500); // SL = entry = BE
console.log(`    Expected: NO (already BE) — ${!t2c ? "✅" : "❌"}`);

// ETH SHORT: price down +0.25% — SHOULD move to BE
const t2d = testBEMove("short", 2400, 2400 * 0.9975, 2400 * 1.005);
console.log(`    Expected: YES — ${t2d ? "✅" : "❌"}`);

// ETH SHORT: price UP (wrong direction) — should NOT move
const t2e = testBEMove("short", 2400, 2400 * 1.001, 2400 * 1.005);
console.log(`    Expected: NO — ${!t2e ? "✅" : "❌"}`);

// === TEST 3: Close Reason Labels ===
console.log("\n=== TEST 3: Close Reason Labels ===");

function testCloseLabel(slHit: boolean, tpHit: boolean, isBE: boolean) {
  let label = "";
  if (tpHit) label = "TP +0.43%";
  else if (slHit) label = isBE ? "SL @ BE" : "SL -0.5%";
  return label;
}

console.log(`  TP hit: "${testCloseLabel(false, true, false)}" — ${testCloseLabel(false, true, false) === "TP +0.43%" ? "✅" : "❌"}`);
console.log(`  SL hit (original): "${testCloseLabel(true, false, false)}" — ${testCloseLabel(true, false, false) === "SL -0.5%" ? "✅" : "❌"}`);
console.log(`  SL hit (BE): "${testCloseLabel(true, false, true)}" — ${testCloseLabel(true, false, true) === "SL @ BE" ? "✅" : "❌"}`);

// === TEST 4: Edge Cases ===
console.log("\n=== TEST 4: Edge Cases ===");

// Exactly at 0.2% threshold
const t4a = testBEMove("long", 84500, 84500 * 1.002, 84500 * 0.995);
console.log(`    Exactly +0.2%: ${t4a ? "✅ moves" : "❌ doesn't move"}`);

// Just under 0.2%
const t4b = testBEMove("long", 84500, 84500 * 1.00199, 84500 * 0.995);
console.log(`    Just under +0.2% (0.199%): ${!t4b ? "✅ stays" : "❌ moved"}`);

// Price at +0.2% but SL already moved
const t4c = testBEMove("short", 2400, 2400 * 0.998, 2400); // SL at entry already
console.log(`    +0.2% but SL already at entry: ${!t4c ? "✅ no double-move" : "❌ moved again"}`);

console.log("\n=== ALL TESTS COMPLETE ===");
