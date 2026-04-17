/**
 * AIWEEKLY — 3-Model Consensus AI Researcher
 * 
 * Pipeline:
 * 1. Sonar gathers real-time research (SEC filings, news, Twitter, 10K, macro)
 * 2. Claude Opus 4.6 independently ranks & picks
 * 3. GPT 5.4 independently ranks & picks
 * 4. Consensus filter: only positions where ≥2 models agree
 * 
 * All routed through Perplexity Agent API (single API key).
 */

const PPLX_API_URL = "https://api.perplexity.ai/v1/responses";

// HL xyz available tech stocks (>$1M vol)
export const AIWEEKLY_STOCKS = [
  { coin: "xyz:TSLA", name: "Tesla", maxLev: 10, szDec: 3 },
  { coin: "xyz:NVDA", name: "NVIDIA", maxLev: 20, szDec: 3 },
  { coin: "xyz:ORCL", name: "Oracle", maxLev: 10, szDec: 3 },
  { coin: "xyz:GOOGL", name: "Alphabet", maxLev: 10, szDec: 3 },
  { coin: "xyz:COIN", name: "Coinbase", maxLev: 10, szDec: 3 },
  { coin: "xyz:MSFT", name: "Microsoft", maxLev: 10, szDec: 3 },
  { coin: "xyz:INTC", name: "Intel", maxLev: 10, szDec: 2 },
  { coin: "xyz:NFLX", name: "Netflix", maxLev: 10, szDec: 3 },
  { coin: "xyz:PLTR", name: "Palantir", maxLev: 10, szDec: 3 },
  { coin: "xyz:MU", name: "Micron", maxLev: 10, szDec: 3 },
  { coin: "xyz:AMZN", name: "Amazon", maxLev: 10, szDec: 3 },
  { coin: "xyz:AMD", name: "AMD", maxLev: 10, szDec: 3 },
  { coin: "xyz:META", name: "Meta", maxLev: 10, szDec: 3 },
  { coin: "xyz:AAPL", name: "Apple", maxLev: 20, szDec: 3 },
  { coin: "xyz:BABA", name: "Alibaba", maxLev: 10, szDec: 3 },
  { coin: "xyz:TSM", name: "TSMC", maxLev: 10, szDec: 3 },
  { coin: "xyz:MSTR", name: "MicroStrategy", maxLev: 10, szDec: 3 },
  { coin: "xyz:HOOD", name: "Robinhood", maxLev: 10, szDec: 3 },
  { coin: "xyz:HIMS", name: "Hims & Hers", maxLev: 10, szDec: 2 },
];

export const AIWEEKLY_COMMODITIES = [
  { coin: "xyz:GOLD", name: "Gold", maxLev: 25, szDec: 4 },
  { coin: "xyz:SILVER", name: "Silver", maxLev: 25, szDec: 2 },
  { coin: "xyz:CL", name: "WTI Crude Oil", maxLev: 20, szDec: 3 },
  { coin: "xyz:BRENTOIL", name: "Brent Oil", maxLev: 20, szDec: 2 },
];

const STOCK_TICKERS = AIWEEKLY_STOCKS.map(s => `${s.name} (${s.coin.replace("xyz:", "")})`).join(", ");
const COMMODITY_LIST = AIWEEKLY_COMMODITIES.map(c => `${c.name} (${c.coin.replace("xyz:", "")})`).join(", ");

export interface AiweeklyPicks {
  longs: string[];   // coin names e.g. ["xyz:TSLA", "xyz:NVDA"]
  shorts: string[];  // coin names
  commodities: { coin: string; side: "long" | "short"; reasoning: string }[];
  reasoning: string;
}

export interface ConsensusResult {
  longs: { coin: string; votes: number; models: string[] }[];
  shorts: { coin: string; votes: number; models: string[] }[];
  commodities: { coin: string; side: "long" | "short"; votes: number; models: string[] }[];
  sonarPicks: AiweeklyPicks;
  claudePicks: AiweeklyPicks;
  gptPicks: AiweeklyPicks;
  timestamp: string;
}

function log(msg: string) {
  console.log(`[AIWEEKLY] ${msg}`);
}

/**
 * Call Perplexity Agent API with a specific model.
 * Uses OpenAI-compatible /v1/responses endpoint.
 */
async function callPplxAgent(
  apiKey: string,
  model: string,
  prompt: string,
  systemPrompt: string,
  tools?: any[],
): Promise<string> {
  const body: any = {
    model,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    max_output_tokens: 4096,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const res = await fetch(PPLX_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`PPLX API error (${model}): ${res.status} ${errText.slice(0, 500)}`);
  }

  const data: any = await res.json();

  // Extract text from Agent API response format
  if (data.output && Array.isArray(data.output)) {
    for (const block of data.output) {
      if (block.type === "message" && block.content) {
        for (const c of block.content) {
          if (c.type === "output_text") return c.text;
        }
      }
    }
  }
  // Fallback
  if (data.output_text) return data.output_text;
  throw new Error(`No output from ${model}: ${JSON.stringify(data).slice(0, 300)}`);
}

/**
 * Step 1: Sonar gathers research for all stocks + commodities.
 * Uses web_search tool for real-time grounded data.
 */
async function runSonarResearch(apiKey: string): Promise<string> {
  log("Step 1: Sonar research starting...");

  const systemPrompt = `You are an elite equity research analyst. Your job is to research stocks and commodities to identify the best long and short opportunities for the next 3 days.

Focus on:
- Recent SEC filings (10-K, 10-Q, 8-K) and earnings reports
- Breaking news and market-moving events
- Social media sentiment (Twitter/X, Reddit)
- Technical momentum and recent price action
- Macro indicators affecting commodities (Fed policy, CPI, employment, geopolitical)
- Insider buying/selling, institutional flow
- Upcoming catalysts (earnings dates, product launches, regulatory decisions)

Be thorough. Search for each stock individually. Return FACTUAL findings with sources.`;

  const prompt = `Research all of these stocks for the next 3-day trading outlook. For each stock, find the most important recent developments:

STOCKS: ${STOCK_TICKERS}

COMMODITIES: ${COMMODITY_LIST}

For each asset, provide:
1. Key recent news/developments (last 7 days)
2. Earnings/SEC filing highlights if any
3. Social sentiment (bullish/bearish/neutral)
4. Technical momentum (trending up/down/sideways)
5. Upcoming catalysts
6. Overall 3-day outlook: BULLISH / BEARISH / NEUTRAL with confidence (1-10)

Be specific with facts, dates, and numbers. Use web search for each.`;

  const result = await callPplxAgent(
    apiKey,
    "perplexity/sonar",
    prompt,
    systemPrompt,
    [{ type: "web_search" }],
  );

  log(`Sonar research complete: ${result.length} chars`);
  return result;
}

/**
 * Step 2/3: Ask a model to independently pick 5 longs + 5 shorts + commodity direction.
 */
async function getModelPicks(
  apiKey: string,
  model: string,
  modelLabel: string,
  research: string,
): Promise<AiweeklyPicks> {
  log(`Step 2/3: ${modelLabel} analyzing picks...`);

  const systemPrompt = `You are a senior portfolio manager at a top quantitative hedge fund. You must analyze the research provided and make decisive picks.

RULES:
- Pick exactly 5 stocks to LONG (strongest upside potential over 3 days)
- Pick exactly 5 stocks to SHORT (strongest downside potential over 3 days)
- For commodities (Gold, Silver, Oil), pick a direction (long/short) or skip if no clear signal
- Use ONLY these stock tickers: ${AIWEEKLY_STOCKS.map(s => s.coin).join(", ")}
- Use ONLY these commodity tickers: ${AIWEEKLY_COMMODITIES.map(c => c.coin).join(", ")}
- A stock CANNOT appear in both longs and shorts
- Rank by conviction (highest first)

RESPOND IN EXACTLY THIS JSON FORMAT (no markdown, no explanation outside JSON):
{
  "longs": ["xyz:TICKER1", "xyz:TICKER2", "xyz:TICKER3", "xyz:TICKER4", "xyz:TICKER5"],
  "shorts": ["xyz:TICKER6", "xyz:TICKER7", "xyz:TICKER8", "xyz:TICKER9", "xyz:TICKER10"],
  "commodities": [
    {"coin": "xyz:GOLD", "side": "long", "reasoning": "brief reason"},
    {"coin": "xyz:SILVER", "side": "short", "reasoning": "brief reason"}
  ],
  "reasoning": "2-3 sentence overall thesis"
}`;

  const prompt = `Based on this research, pick your 5 best longs, 5 best shorts, and commodity directions for the next 3 days:

${research}

Respond with ONLY the JSON object. No markdown code blocks.`;

  const raw = await callPplxAgent(apiKey, model, prompt, systemPrompt);

  // Parse JSON from response (strip any markdown wrapping)
  let jsonStr = raw.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  try {
    const parsed = JSON.parse(jsonStr);
    // Validate structure
    if (!Array.isArray(parsed.longs) || !Array.isArray(parsed.shorts)) {
      throw new Error("Invalid picks format: missing longs/shorts arrays");
    }
    // Filter to valid tickers only
    const validStocks = new Set(AIWEEKLY_STOCKS.map(s => s.coin));
    const validCommodities = new Set(AIWEEKLY_COMMODITIES.map(c => c.coin));

    parsed.longs = parsed.longs.filter((t: string) => validStocks.has(t)).slice(0, 5);
    parsed.shorts = parsed.shorts.filter((t: string) => validStocks.has(t)).slice(0, 5);
    parsed.commodities = (parsed.commodities || []).filter((c: any) =>
      validCommodities.has(c.coin) && (c.side === "long" || c.side === "short")
    );

    log(`${modelLabel} picks: ${parsed.longs.length}L / ${parsed.shorts.length}S / ${parsed.commodities.length} commodities`);
    return parsed as AiweeklyPicks;
  } catch (e) {
    log(`${modelLabel} JSON parse error: ${e}. Raw: ${raw.slice(0, 500)}`);
    // Return empty picks on parse failure — consensus will handle
    return { longs: [], shorts: [], commodities: [], reasoning: `Parse error: ${e}` };
  }
}

/**
 * Step 4: Consensus filter — only positions where ≥2 of 3 models agree.
 * 3/3 agreement = full conviction, 2/3 = standard conviction.
 */
export function buildConsensus(
  sonar: AiweeklyPicks,
  claude: AiweeklyPicks,
  gpt: AiweeklyPicks,
): ConsensusResult {
  log("Step 4: Building consensus...");

  // Count votes for longs
  const longVotes: Record<string, string[]> = {};
  for (const coin of sonar.longs) { longVotes[coin] = [...(longVotes[coin] || []), "sonar"]; }
  for (const coin of claude.longs) { longVotes[coin] = [...(longVotes[coin] || []), "claude"]; }
  for (const coin of gpt.longs) { longVotes[coin] = [...(longVotes[coin] || []), "gpt"]; }

  // Count votes for shorts
  const shortVotes: Record<string, string[]> = {};
  for (const coin of sonar.shorts) { shortVotes[coin] = [...(shortVotes[coin] || []), "sonar"]; }
  for (const coin of claude.shorts) { shortVotes[coin] = [...(shortVotes[coin] || []), "claude"]; }
  for (const coin of gpt.shorts) { shortVotes[coin] = [...(shortVotes[coin] || []), "gpt"]; }

  // Count commodity votes
  const commodityVotes: Record<string, { long: string[]; short: string[] }> = {};
  for (const picks of [
    { data: sonar.commodities, label: "sonar" },
    { data: claude.commodities, label: "claude" },
    { data: gpt.commodities, label: "gpt" },
  ]) {
    for (const c of picks.data) {
      if (!commodityVotes[c.coin]) commodityVotes[c.coin] = { long: [], short: [] };
      commodityVotes[c.coin][c.side].push(picks.label);
    }
  }

  // Filter: ≥2 votes required
  const consensusLongs = Object.entries(longVotes)
    .filter(([_, models]) => models.length >= 2)
    .map(([coin, models]) => ({ coin, votes: models.length, models }))
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 5);

  const consensusShorts = Object.entries(shortVotes)
    .filter(([_, models]) => models.length >= 2)
    .map(([coin, models]) => ({ coin, votes: models.length, models }))
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 5);

  const consensusCommodities: ConsensusResult["commodities"] = [];
  for (const [coin, sides] of Object.entries(commodityVotes)) {
    if (sides.long.length >= 2) {
      consensusCommodities.push({ coin, side: "long", votes: sides.long.length, models: sides.long });
    } else if (sides.short.length >= 2) {
      consensusCommodities.push({ coin, side: "short", votes: sides.short.length, models: sides.short });
    }
  }

  log(`Consensus: ${consensusLongs.length}L / ${consensusShorts.length}S / ${consensusCommodities.length} commodities`);

  return {
    longs: consensusLongs,
    shorts: consensusShorts,
    commodities: consensusCommodities,
    sonarPicks: sonar,
    claudePicks: claude,
    gptPicks: gpt,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Full research pipeline: Sonar → Claude + GPT (parallel) → Consensus.
 */
export async function runFullResearch(apiKey: string): Promise<ConsensusResult> {
  log("=== AIWEEKLY RESEARCH CYCLE STARTING ===");
  const startTime = Date.now();

  // Step 1: Sonar gathers raw research
  const research = await runSonarResearch(apiKey);

  // Step 2+3: Claude and GPT analyze in parallel
  const [claudePicks, gptPicks] = await Promise.all([
    getModelPicks(apiKey, "anthropic/claude-opus-4-6", "Claude Opus 4.6", research),
    getModelPicks(apiKey, "openai/gpt-5.4", "GPT 5.4", research),
  ]);

  // Sonar also picks (from its own research output)
  const sonarPicks = await getModelPicks(apiKey, "perplexity/sonar", "Sonar", research);

  // Step 4: Consensus
  const consensus = buildConsensus(sonarPicks, claudePicks, gptPicks);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`=== RESEARCH COMPLETE in ${elapsed}s ===`);
  log(`Final picks: ${consensus.longs.map(l => l.coin).join(",")} LONG | ${consensus.shorts.map(s => s.coin).join(",")} SHORT`);

  return consensus;
}
