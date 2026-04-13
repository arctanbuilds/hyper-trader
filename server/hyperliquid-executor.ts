/**
 * Hyperliquid Order Executor
 * 
 * Signs and submits real orders to Hyperliquid using EIP-712 typed data signing.
 * API wallets (agent wallets) can only trade — they CANNOT withdraw funds.
 */

import { ethers } from "ethers";

const HL_EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

// EIP-712 domain for Hyperliquid L1 actions (agent-signed)
const PHANTOM_AGENT_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

// Type definitions for order signing
const AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
};

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
 * Create a Hyperliquid executor that signs and sends real orders.
 * 
 * @param apiSecret - The private key from the API wallet (NOT your main wallet key)
 * @param walletAddress - Your main account wallet address (the master account)
 */
export function createExecutor(apiSecret: string, walletAddress: string): HyperliquidExecutor {
  const agentWallet = new ethers.Wallet(apiSecret);

  // Cache asset indices to avoid repeated lookups
  const assetIndexCache: Record<string, { index: number; dex: string }> = {};

  async function getAssetIndex(coin: string): Promise<number> {
    if (assetIndexCache[coin]) return assetIndexCache[coin].index;

    // Determine which dex to query
    // HIP-3 assets use "xyz" dex and keep the full "xyz:NAME" format in the universe
    const dex = coin.startsWith("xyz:") ? "xyz" : "";
    const lookupName = coin; // keep full name — xyz dex universe uses "xyz:NAME" format

    const body: any = { type: "meta" };
    if (dex) body.dex = dex;
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const meta: any = await res.json();
    const universe = meta?.universe || [];
    const idx = universe.findIndex((a: any) => a.name === lookupName);
    if (idx === -1) throw new Error(`Asset ${coin} (lookup: ${lookupName}, dex: ${dex || "main"}) not found on Hyperliquid`);
    
    // HIP-3 assets have indices offset by 10000
    const actualIndex = dex === "xyz" ? 10000 + idx : idx;
    assetIndexCache[coin] = { index: actualIndex, dex };
    return actualIndex;
  }

  function floatToWire(x: number, szDecimals: number): string {
    return x.toFixed(szDecimals);
  }

  function orderTypeToWire(orderType: any): any {
    if (orderType.limit) {
      return { limit: { tif: orderType.limit.tif } };
    }
    if (orderType.trigger) {
      return {
        trigger: {
          triggerPx: orderType.trigger.triggerPx,
          isMarket: orderType.trigger.isMarket,
          tpsl: orderType.trigger.tpsl,
        },
      };
    }
    return orderType;
  }

  async function signL1Action(action: any, nonce: number): Promise<{ action: any; nonce: number; signature: any; vaultAddress?: null }> {
    // Compute the connection ID (hash of action)
    const actionHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(JSON.stringify(action) + String(nonce))
    );

    // Sign as phantom agent
    const agentMessage = {
      source: walletAddress.toLowerCase() === agentWallet.address.toLowerCase() ? "a" : "b",
      connectionId: actionHash,
    };

    const signature = await agentWallet._signTypedData(
      PHANTOM_AGENT_DOMAIN,
      AGENT_TYPES,
      agentMessage
    );

    const { r, s, v } = ethers.utils.splitSignature(signature);

    return {
      action,
      nonce,
      signature: { r, s, v },
      vaultAddress: null,
    };
  }

  async function sendRequest(payload: any): Promise<any> {
    const res = await fetch(HL_EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  }

  return {
    async placeOrder(params: OrderParams) {
      const assetIndex = await getAssetIndex(params.coin);
      
      // Get size decimals from correct dex meta
      const dex = params.coin.startsWith("xyz:") ? "xyz" : "";
      const metaBody: any = { type: "meta" };
      if (dex) metaBody.dex = dex;
      const metaRes = await fetch(HL_INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metaBody),
      });
      const meta: any = await metaRes.json();
      // For HIP-3, index in universe is assetIndex - 10000
      const universeIdx = dex === "xyz" ? assetIndex - 10000 : assetIndex;
      const szDecimals = meta.universe[universeIdx]?.szDecimals ?? 4;

      const orderWire = {
        a: assetIndex,
        b: params.isBuy,
        p: params.limitPx.toString(),
        s: floatToWire(params.sz, szDecimals),
        r: params.reduceOnly || false,
        t: orderTypeToWire(params.orderType),
        c: params.cloid || undefined,
      };

      const action = {
        type: "order",
        orders: [orderWire],
        grouping: "na",
      };

      const nonce = Date.now();
      const signed = await signL1Action(action, nonce);
      return await sendRequest(signed);
    },

    async cancelOrder(coin: string, oid: number) {
      const assetIndex = await getAssetIndex(coin);
      const action = {
        type: "cancel",
        cancels: [{ a: assetIndex, o: oid }],
      };
      const nonce = Date.now();
      const signed = await signL1Action(action, nonce);
      return await sendRequest(signed);
    },

    async cancelAllOrders() {
      // First get all open orders
      const orders = await this.getOpenOrders();
      if (!orders || orders.length === 0) return { status: "ok", msg: "No orders to cancel" };

      const cancels = orders.map((o: any) => ({
        a: o.coin, // need asset index
        o: o.oid,
      }));

      // Cancel one by one for simplicity
      const results = [];
      for (const order of orders) {
        const result = await this.cancelOrder(order.coin, order.oid);
        results.push(result);
      }
      return results;
    },

    async setLeverage(coin: string, leverage: number, isCross: boolean = true) {
      const assetIndex = await getAssetIndex(coin);
      const action = {
        type: "updateLeverage",
        asset: assetIndex,
        isCross,
        leverage,
      };
      const nonce = Date.now();
      const signed = await signL1Action(action, nonce);
      return await sendRequest(signed);
    },

    async getPositions() {
      const res = await fetch(HL_INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "clearinghouseState",
          user: walletAddress,
        }),
      });
      const data: any = await res.json();
      return data?.assetPositions || [];
    },

    async getOpenOrders() {
      const res = await fetch(HL_INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "openOrders",
          user: walletAddress,
        }),
      });
      return await res.json();
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
      
      // Check perps balance first (standard mode)
      const perpsEquity = parseFloat(perpsData?.marginSummary?.accountValue || "0");
      
      // Check spot USDC balance (unified account mode)
      const spotBalances = spotData?.balances || [];
      const usdcBalance = spotBalances.find((b: any) => b.coin === "USDC");
      const spotEquity = parseFloat(usdcBalance?.total || "0");
      
      // Use whichever is higher — unified mode shows balance in spot
      const equity = Math.max(perpsEquity, spotEquity);
      const availableBalance = perpsEquity > 0 
        ? parseFloat(perpsData?.marginSummary?.totalRawUsd || "0")
        : spotEquity;
      
      return { equity, availableBalance };
    },
  };
}
