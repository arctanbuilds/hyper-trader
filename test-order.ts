import { ethers } from "ethers";

const HL_EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

const PHANTOM_AGENT_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

const AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
};

const apiSecret = "0x7b389a1804358eaf21bd447d4c285ccac48b3d01c5f82079854a3c7b3a2c9e58";
const walletAddress = "0xD781FE5A5F666096E7cb61FE081D15e4816F5aDc";
const agentWallet = new ethers.Wallet(apiSecret);

console.log("Agent wallet address:", agentWallet.address);
console.log("Master wallet:", walletAddress);
console.log("Source:", walletAddress.toLowerCase() === agentWallet.address.toLowerCase() ? "a" : "b");

// Test 1: Try setLeverage first
async function testSetLeverage() {
  const action = {
    type: "updateLeverage",
    asset: 0, // BTC index on main
    isCross: true,
    leverage: 40,
  };
  const nonce = Date.now();
  const actionHash = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(JSON.stringify(action) + String(nonce))
  );
  const agentMessage = {
    source: walletAddress.toLowerCase() === agentWallet.address.toLowerCase() ? "a" : "b",
    connectionId: actionHash,
  };
  const signature = await agentWallet._signTypedData(PHANTOM_AGENT_DOMAIN, AGENT_TYPES, agentMessage);
  const { r, s, v } = ethers.utils.splitSignature(signature);
  
  const payload = { action, nonce, signature: { r, s, v }, vaultAddress: null };
  console.log("\n=== SET LEVERAGE REQUEST ===");
  console.log("Payload:", JSON.stringify(payload).slice(0, 300));
  
  const res = await fetch(HL_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  console.log("Response:", JSON.stringify(data));
  return data;
}

// Test 2: Place a tiny BTC order
async function testOrder() {
  // BTC is asset 0, szDecimals=5
  // Place a tiny short IOC at 1% below market
  const midRes = await fetch(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  const mids: any = await midRes.json();
  const btcPrice = parseFloat(mids["BTC"]);
  console.log("\nBTC price:", btcPrice);
  
  // Minimum BTC size: 0.00001 (szDecimals=5)
  // At $72k that's $0.72 notional - probably below minimum
  // Try 0.001 = ~$72 notional
  const sz = 0.001;
  const limitPx = Math.round(btcPrice * 0.99 * 10) / 10; // 1% below, rounded to 1 decimal
  
  const orderWire = {
    a: 0, // BTC
    b: false, // sell (short)
    p: limitPx.toString(),
    s: sz.toFixed(5),
    r: false,
    t: { limit: { tif: "Ioc" } },
  };

  const action = {
    type: "order",
    orders: [orderWire],
    grouping: "na",
  };

  const nonce = Date.now();
  const actionHash = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(JSON.stringify(action) + String(nonce))
  );
  const agentMessage = {
    source: walletAddress.toLowerCase() === agentWallet.address.toLowerCase() ? "a" : "b",
    connectionId: actionHash,
  };
  const signature = await agentWallet._signTypedData(PHANTOM_AGENT_DOMAIN, AGENT_TYPES, agentMessage);
  const { r, s, v } = ethers.utils.splitSignature(signature);
  
  const payload = { action, nonce, signature: { r, s, v }, vaultAddress: null };
  console.log("\n=== ORDER REQUEST ===");
  console.log("Order:", JSON.stringify(orderWire));
  console.log("Notional:", (sz * btcPrice).toFixed(2));
  
  const res = await fetch(HL_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  console.log("Full Response:", JSON.stringify(data, null, 2));
  return data;
}

async function main() {
  try {
    await testSetLeverage();
    await testOrder();
  } catch (e) {
    console.error("Error:", e);
  }
}

main();
