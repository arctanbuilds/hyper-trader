/**
 * AI Trendline Analyzer — v14.3
 *
 * Sends BTC 5m OHLCV data to Claude Haiku via Perplexity Agent API.
 * Returns structured JSON with trendline breakout+retest signals.
 *
 * Endpoint: POST https://api.perplexity.ai/v1/responses
 * Model: anthropic/claude-haiku-4-5 (~$0.003/request, ~$30/day @ 8s scan)
 * Env: PERPLEXITY_API_KEY
 */

import { log } from "./index";

// ============ TYPES ============

export interface TrendlineSignal {
  signal: "LONG" | "SHORT" | "NONE";
  confidence: number; // 1-10
  entry_price: number;
  invalidation_price: number;
  reason: string;
  trendline?: {
    type: "descending_resistance" | "ascending_support";
    touch_count: number;
    slope_per_candle: number;
    price_range_pct: number;
  };
  breakout?: {
    candle_index: number;
    close_beyond_tl_pct: number;
  };
  retest?: {
    candle_index: number;
    distance_to_tl_pct: number;
    rejection_type: string;
  };
}

export interface OHLCVCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ============ SYSTEM PROMPT ============

const SYSTEM_PROMPT = `You are an institutional-grade BTC/USDT technical analyst specializing in trendline breakout detection on 5-minute perpetual futures charts. Your sole task is to analyze OHLCV candle data and identify actionable trendline break+retest setups.

## CORE METHODOLOGY

### Step 1 — Identify Swing Points
Scan the candle array for significant swing highs and swing lows:
- A SWING HIGH is a candle whose high is greater than the highs of at least 3 candles on each side (lookback=3).
- A SWING LOW is a candle whose low is less than the lows of at least 3 candles on each side (lookback=3).
- Filter out noise: ignore swings with a range (high-low) smaller than 0.15% of price.
- Label each swing with its index and price.

### Step 2 — Construct Candidate Trendlines
From the identified swings, construct candidate trendlines:

**Descending Resistance Trendlines** (for potential LONG setups):
- Connect 2+ swing HIGHS where each successive high is LOWER than the previous.
- The line must slope downward.
- Each touch point must come within 0.1% of the trendline's interpolated price at that candle index.
- The minimum price range from highest to lowest touch must be >= 0.3% of current price.

**Ascending Support Trendlines** (for potential SHORT setups):
- Connect 2+ swing LOWS where each successive low is HIGHER than the previous.
- The line must slope upward.
- Same touch tolerance (0.1%) and minimum price range (0.3%) rules apply.

### Step 3 — Validate Trendlines (Quality Score)
For each candidate trendline, evaluate:
1. Touch Count (minimum 2, more = stronger).
2. Time Span: must span at least 15 candles (75 minutes on 5m). Longer = more significant.
3. Respect Quality: Between touch points, price should clearly move AWAY from the line (at least 0.2% away) before returning.
4. Recency: The most recent touch should be within the last 15 candles.
5. Slope Consistency: The angle should be roughly consistent.

### Step 4 — Detect Breakout
A valid breakout occurs when:
- A candle CLOSES beyond the trendline (not just a wick).
- The breakout candle's body size should be meaningful (> 0.05% of price).
- For descending resistance (LONG): candle closes ABOVE the trendline.
- For ascending support (SHORT): candle closes BELOW the trendline.

### Step 5 — Detect Retest (CRITICAL — entry trigger)
After the breakout, price must return to the trendline area and show rejection:
- Retest window: 1-10 candles after the breakout.
- Retest zone: Price must return within 0.15% of the trendline's projected value.
- Rejection evidence: pin bar, doji, engulfing, or consecutive bounce away from trendline.
- Failed retest (DO NOT TRADE): Price closes back through the trendline.

### Step 6 — Generate Signal
ONLY if Steps 1-5 all pass, generate a trade signal.

## OUTPUT RULES

Respond with ONLY a valid JSON object. No markdown, no commentary.

If NO valid setup exists (most common case — be very selective), return:
{"signal": "NONE", "reason": "brief explanation"}

If a valid setup exists, return:
{
  "signal": "LONG" or "SHORT",
  "confidence": 1-10,
  "entry_price": ideal entry price near the trendline retest,
  "trendline": {
    "type": "descending_resistance" or "ascending_support",
    "touch_count": number,
    "slope_per_candle": price change per candle,
    "price_range_pct": percentage range from first to last touch
  },
  "breakout": {
    "candle_index": index of breakout candle,
    "close_beyond_tl_pct": how far close was beyond trendline (%)
  },
  "retest": {
    "candle_index": index of retest candle,
    "distance_to_tl_pct": how close price got to trendline (%),
    "rejection_type": "pin_bar" | "doji" | "engulfing" | "consecutive_bounce"
  },
  "invalidation_price": price where setup is invalidated (just beyond TL on wrong side),
  "reason": "1-2 sentence explanation"
}

## CRITICAL RULES

1. Be extremely selective. Most scans should return NONE. Only signal confidence >= 6.
2. Never connect random swing points that happen to align. The trendline must represent REAL structural price compression.
3. Ranging/choppy markets have NO valid trendlines. Return NONE.
4. The breakout must be CLEAR — not barely closing on the other side.
5. The retest must show REJECTION — price touching and continuing through is NOT a retest.
6. The entire setup should be visible in the last ~20 candles.
7. LONG = descending TL break. SHORT = ascending TL break.
8. If multiple setups exist, return only the highest confidence one.
9. Trendline price range must be >= 0.3% of current price.
10. If the breakout candle has notably low volume compared to average, reduce confidence by 2.`;

// ============ API CALL ============

const PERPLEXITY_AGENT_URL = "https://api.perplexity.ai/v1/responses";

export async function analyzeTrendlines(
  candles: OHLCVCandle[],
  currentPrice: number,
): Promise<TrendlineSignal> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    log("[TRENDLINE AI] No PERPLEXITY_API_KEY set — skipping", "engine");
    return { signal: "NONE", confidence: 0, entry_price: 0, invalidation_price: 0, reason: "No API key" };
  }

  // Format candles as compact text
  const candleLines = candles.map((c, i) => {
    return `[${i}] O:${c.open.toFixed(1)} H:${c.high.toFixed(1)} L:${c.low.toFixed(1)} C:${c.close.toFixed(1)} V:${(c.volume / 1000).toFixed(0)}k`;
  }).join("\n");

  const userMessage = `Analyze these BTC/USDT 5-minute candles for trendline breakout+retest setups.

Current time: ${new Date().toISOString()}
Current price: ${currentPrice.toFixed(1)}

OHLCV data (oldest → newest, index 0 = oldest):
${candleLines}

Respond with JSON only.`;

  try {
    const res = await fetch(PERPLEXITY_AGENT_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        input: userMessage,
        instructions: SYSTEM_PROMPT,
        max_output_tokens: 500,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      log(`[TRENDLINE AI] API error ${res.status}: ${errText.slice(0, 300)}`, "engine");
      return { signal: "NONE", confidence: 0, entry_price: 0, invalidation_price: 0, reason: `API error ${res.status}` };
    }

    const data: any = await res.json();

    // Extract text from Agent API response format
    let responseText = "";
    if (data.output_text) {
      responseText = data.output_text;
    } else if (data.output && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === "message" && item.content) {
          for (const c of item.content) {
            if (c.type === "output_text" && c.text) {
              responseText = c.text;
              break;
            }
          }
        }
      }
    } else if (data.choices?.[0]?.message?.content) {
      // Fallback: OpenAI-compatible format
      responseText = data.choices[0].message.content;
    }

    if (!responseText) {
      log(`[TRENDLINE AI] Empty response: ${JSON.stringify(data).slice(0, 300)}`, "engine");
      return { signal: "NONE", confidence: 0, entry_price: 0, invalidation_price: 0, reason: "Empty AI response" };
    }

    // Parse JSON from response (strip markdown fences if any)
    let jsonStr = responseText.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(jsonStr);

    // Validate minimum fields
    if (!parsed.signal) {
      return { signal: "NONE", confidence: 0, entry_price: 0, invalidation_price: 0, reason: "Invalid AI response format" };
    }

    // Only accept confidence >= 6
    if (parsed.signal !== "NONE" && (parsed.confidence || 0) < 6) {
      log(`[TRENDLINE AI] Low confidence ${parsed.confidence}: ${parsed.reason}`, "engine");
      return { signal: "NONE", confidence: parsed.confidence || 0, entry_price: 0, invalidation_price: 0, reason: `Confidence ${parsed.confidence} < 6: ${parsed.reason}` };
    }

    // Log cost if available
    if (data.usage?.cost) {
      const cost = data.usage.cost;
      log(`[TRENDLINE AI] Cost: $${(cost.total_cost || 0).toFixed(4)} (in=${data.usage.input_tokens} out=${data.usage.output_tokens})`, "engine");
    }

    log(`[TRENDLINE AI] Result: ${parsed.signal} conf=${parsed.confidence || 0} | ${parsed.reason || ""}`, "engine");

    return {
      signal: parsed.signal,
      confidence: parsed.confidence || 0,
      entry_price: parsed.entry_price || currentPrice,
      invalidation_price: parsed.invalidation_price || 0,
      reason: parsed.reason || "",
      trendline: parsed.trendline,
      breakout: parsed.breakout,
      retest: parsed.retest,
    };
  } catch (err) {
    log(`[TRENDLINE AI] Error: ${err}`, "engine");
    return { signal: "NONE", confidence: 0, entry_price: 0, invalidation_price: 0, reason: `Error: ${err}` };
  }
}
