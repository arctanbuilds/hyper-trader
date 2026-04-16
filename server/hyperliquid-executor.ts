/**
 * Hyperliquid Order Executor
 * 
 * Uses the @nktkas/hyperliquid SDK for proper L1 action signing.
 * API wallets (agent wallets) can only trade — they CANNOT withdraw funds.
 */

import { ExchangeClient, InfoClient, HttpTransport } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

interface OrderParams {
  coin: string;
  isBuy: boolean;
  sz: number;
  limitPx: number;
  orderType: { limit: { tif: "Gtc" | "Ioc" | "Alo" } } | { trigger: { triggerPx: string; isMarket: boolean; tpsl: "tp" | "sl" } };
  reduceOnly?: boolean;
  cloid?: string;
}

interface HyperliquidExecutor {
  placeOrder(params: OrderParams): Promise<any>;
  cancelOrder(coin: string, oid: number): Promise<any>;
  cancelAllOrders(): Promise<any>;
  setLeverage(coin: string, leverage: number, isCross: boolean): Promise<any>;
  getPositions(): Promise<any>;
  getOpenOrders(): Promise<any>;
  getAccountValue(): Promise<{ equity: number; availableBalance: number }>;
}

/**
 * Create a Hyperliquid executor using the official SDK for signing.
 * 
 * @param apiSecret - The private key from the API wallet (NOT your main wallet key)
 * @param walletAddress - Your main account wallet address (the master account)
 */
export function createExecutor(apiSecret: string, walletAddress: string): HyperliquidExecutor {
  const agentAccount = privateKeyToAccount(apiSecret as `0x${string}`);
  const transport = new HttpTransport();
  const exchange = new ExchangeClient({ transport, wallet: agentAccount });
  const info = new InfoClient({ transport });

  // Cache asset indices to avoid repeated lookups
  const assetIndexCache: Record<string, { index: number; dex: string }> = {};

  // HIP-3 perp_dex_index lookup (from allPerpMetas): xyz = 1
  // Formula: asset_id = 100000 + perp_dex_index * 10000 + index_in_meta
  const PERP_DEX_INDEX: Record<string, number> = { "xyz": 1 };

  async function getAssetIndex(coin: string): Promise<number> {
    if (assetIndexCache[coin]) return assetIndexCache[coin].index;

    const dex = coin.includes(":") ? coin.split(":")[0] : "";
    const lookupName = coin;

    const body: any = { type: "meta" };
    if (dex) body.dex = dex;
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const meta: any = await res.json();
    if (!meta || !meta.universe) {
      throw new Error(`Failed to fetch meta for dex=${dex || "main"}: ${JSON.stringify(meta)?.slice(0, 200)}`);
    }
    const universe = meta.universe || [];
    const idx = universe.findIndex((a: any) => a.name === lookupName);
    if (idx === -1) throw new Error(`Asset ${coin} (lookup: ${lookupName}, dex: ${dex || "main"}) not found in ${universe.length} assets`);
    
    // HIP-3 assets: 100000 + perp_dex_index * 10000 + index_in_meta
    // Standard perps: just the index
    let actualIndex: number;
    if (dex && PERP_DEX_INDEX[dex] !== undefined) {
      actualIndex = 100000 + PERP_DEX_INDEX[dex] * 10000 + idx;
      console.log(`[HL] HIP-3 asset ${coin}: dex=${dex}, perp_dex_index=${PERP_DEX_INDEX[dex]}, idx=${idx}, asset_id=${actualIndex}`);
    } else {
      actualIndex = idx;
    }
    assetIndexCache[coin] = { index: actualIndex, dex };
    return actualIndex;
  }

  return {
    async placeOrder(params: OrderParams) {
      const assetIndex = await getAssetIndex(params.coin);
      
      // Price and size are already properly formatted by the trading engine
      // using formatHLPrice() and formatHLSize() — no re-formatting here.
      // This avoids extra meta API calls and prevents double-rounding.
      const orderWire: any = {
        a: assetIndex,
        b: params.isBuy,
        p: String(params.limitPx),
        s: String(params.sz),
        r: params.reduceOnly || false,
        t: params.orderType,
      };
      if (params.cloid) {
        orderWire.c = params.cloid;
      }

      console.log(`[HL] Placing order: ${params.coin} ${params.isBuy ? "BUY" : "SELL"} sz=${orderWire.s} @ $${orderWire.p} asset=${assetIndex}`);

      try {
        const result = await exchange.order({
          orders: [orderWire],
          grouping: "na",
        });
        
        console.log(`[HL] Order result:`, JSON.stringify(result).substring(0, 300));
        
        // Normalize response to match our expected format
        if (result?.status === "ok") {
          return result;
        }
        // The SDK might throw on errors, but just in case:
        return result;
      } catch (err: any) {
        console.error(`[HL] Order error:`, err.message?.substring(0, 300));
        // Return error in the format our engine expects
        return { status: "err", response: err.message || String(err) };
      }
    },

    async cancelOrder(coin: string, oid: number) {
      const assetIndex = await getAssetIndex(coin);
      try {
        const result = await exchange.cancel({
          cancels: [{ a: assetIndex, o: oid }],
        });
        return result;
      } catch (err: any) {
        return { status: "err", response: err.message || String(err) };
      }
    },

    async cancelAllOrders() {
      const orders = await this.getOpenOrders();
      if (!orders || orders.length === 0) return { status: "ok", msg: "No orders to cancel" };

      const results = [];
      for (const order of orders) {
        const result = await this.cancelOrder(order.coin, order.oid);
        results.push(result);
      }
      return results;
    },

    async setLeverage(coin: string, leverage: number, isCross: boolean = true) {
      const assetIndex = await getAssetIndex(coin);
      console.log(`[HL] Setting leverage: ${coin} asset=${assetIndex} leverage=${leverage}x isCross=${isCross}`);
      try {
        const result = await exchange.updateLeverage({
          asset: assetIndex,
          isCross,
          leverage,
        });
        console.log(`[HL] Leverage result:`, JSON.stringify(result));
        return result;
      } catch (err: any) {
        console.error(`[HL] Leverage error:`, err.message?.substring(0, 200));
        return { status: "err", response: err.message || String(err) };
      }
    },

    async getPositions() {
      // Query both main perps and HIP-3 xyz dex positions
      const [mainRes, xyzRes] = await Promise.all([
        fetch(HL_INFO_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "clearinghouseState", user: walletAddress }),
        }),
        fetch(HL_INFO_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "clearinghouseState", user: walletAddress, dex: "xyz" }),
        }),
      ]);
      const mainData: any = await mainRes.json();
      const xyzData: any = await xyzRes.json();
      const positions = [...(mainData?.assetPositions || []), ...(xyzData?.assetPositions || [])];
      return positions;
    },

    async getOpenOrders() {
      // Query both main perps and HIP-3 xyz dex orders
      const [mainRes, xyzRes] = await Promise.all([
        fetch(HL_INFO_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "openOrders", user: walletAddress }),
        }),
        fetch(HL_INFO_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "openOrders", user: walletAddress, dex: "xyz" }),
        }),
      ]);
      const mainOrders: any = await mainRes.json();
      const xyzOrders: any = await xyzRes.json();
      return [...(Array.isArray(mainOrders) ? mainOrders : []), ...(Array.isArray(xyzOrders) ? xyzOrders : [])];
    },

    async getAccountValue() {
      // Query both perps clearinghouse AND spot clearinghouse
      // Unified account mode reports balances in spotClearinghouseState
      const [perpsRes, spotRes] = await Promise.all([
        fetch(HL_INFO_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "clearinghouseState",
            user: walletAddress,
          }),
        }),
        fetch(HL_INFO_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "spotClearinghouseState",
            user: walletAddress,
          }),
        }),
      ]);
      
      const perpsData: any = await perpsRes.json();
      const spotData: any = await spotRes.json();
      
      const perpsEquity = parseFloat(perpsData?.marginSummary?.accountValue || "0");
      const spotBalances = spotData?.balances || [];
      const usdcBalance = spotBalances.find((b: any) => b.coin === "USDC");
      const spotEquity = parseFloat(usdcBalance?.total || "0");
      
      const equity = Math.max(perpsEquity, spotEquity);
      const availableBalance = perpsEquity > 0 
        ? parseFloat(perpsData?.marginSummary?.totalRawUsd || "0")
        : spotEquity;
      
      return { equity, availableBalance };
    },
  };
}
