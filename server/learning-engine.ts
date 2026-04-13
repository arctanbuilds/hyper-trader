/**
 * HyperTrader — Learning Engine
 * 
 * Continuously improves trading by analyzing every decision and outcome.
 * 
 * How it works:
 *   1. Every entry, skip, and exit is logged with full market context + reasoning
 *   2. After trades close, it reviews outcomes and marks decisions as good/bad
 *   3. It builds statistical patterns: which assets/sessions/setups win or lose
 *   4. Active insights are checked before every new trade as "learned rules"
 *   5. Rules auto-deactivate if they stop being predictive
 * 
 * Pattern categories:
 *   - asset: Per-asset win rates, best/worst conditions
 *   - session: Which trading sessions produce best results
 *   - confluence: Which confluence levels actually predict wins
 *   - exit: Which exit types capture most profit
 *   - sizing: Whether smaller or larger positions perform better
 *   - pattern: Specific RSI/EMA/funding combinations that work
 */

import { storage } from "./storage";
import { log } from "./index";
import type { Trade, TradeDecision, LearningInsight } from "@shared/schema";

// Minimum trades before a pattern is considered reliable
const MIN_SAMPLE_SIZE = 5;
const HIGH_CONFIDENCE_SAMPLE = 15;

// ============ DECISION LOGGING ============

export function logDecision(params: {
  tradeId?: number;
  coin: string;
  action: "entry" | "skip" | "exit" | "tp1_hit" | "circuit_breaker";
  side?: "long" | "short";
  price: number;
  rsi1h?: number;
  rsi4h?: number;
  rsi1d?: number;
  ema10?: number;
  ema21?: number;
  ema50?: number;
  volume24h?: number;
  change24h?: number;
  fundingRate?: number;
  openInterest?: number;
  confluenceScore?: number;
  confluenceDetails?: string;
  riskRewardRatio?: number;
  reasoning: string;
  equity?: number;
  leverage?: number;
  positionSizeUsd?: number;
}) {
  const now = new Date();
  
  try {
    storage.createDecision({
      tradeId: params.tradeId || null,
      coin: params.coin,
      action: params.action,
      side: params.side || null,
      price: params.price,
      rsi1h: params.rsi1h ?? null,
      rsi4h: params.rsi4h ?? null,
      rsi1d: params.rsi1d ?? null,
      ema10: params.ema10 ?? null,
      ema21: params.ema21 ?? null,
      ema50: params.ema50 ?? null,
      volume24h: params.volume24h ?? null,
      change24h: params.change24h ?? null,
      fundingRate: params.fundingRate ?? null,
      openInterest: params.openInterest ?? null,
      confluenceScore: params.confluenceScore ?? null,
      confluenceDetails: params.confluenceDetails ?? null,
      riskRewardRatio: params.riskRewardRatio ?? null,
      reasoning: params.reasoning,
      equity: params.equity ?? null,
      leverage: params.leverage ?? null,
      positionSizeUsd: params.positionSizeUsd ?? null,
      session: getSession(),
      dayOfWeek: now.getUTCDay(),
      hourUtc: now.getUTCHours(),
      outcome: null,
      outcomePnlPct: null,
      outcomePnlUsd: null,
      holdDurationMins: null,
      exitType: null,
      wasGoodDecision: null,
      reviewNotes: null,
      timestamp: now.toISOString(),
    });
  } catch (e) {
    log(`Decision log error: ${e}`, "learning");
  }
}

function getSession(): string {
  const h = new Date().getUTCHours();
  if (h >= 0 && h < 8) return "asia";
  if (h >= 8 && h < 13) return "london";
  if (h >= 13 && h < 16) return "overlap";
  if (h >= 16 && h < 20) return "ny";
  return "afterhours";
}

// ============ OUTCOME REVIEW ============

/**
 * Called periodically to fill in outcomes for closed trades.
 * Matches trade_decisions entries to their closed trade data.
 */
export function reviewClosedTrades() {
  try {
    const unreviewedDecisions = storage.getUnreviewedDecisions(50);
    let reviewed = 0;

    for (const decision of unreviewedDecisions) {
      if (!decision.tradeId) continue;
      
      const trade = storage.getTradeById(decision.tradeId);
      if (!trade || trade.status === "open") continue;
      
      // Trade is closed — fill in outcome
      const pnlPct = trade.pnl || 0;
      const outcome = pnlPct > 0.1 ? "win" : pnlPct < -0.1 ? "loss" : "breakeven";
      
      // Calculate hold duration
      let holdDurationMins: number | null = null;
      if (trade.openedAt && trade.closedAt) {
        const open = new Date(trade.openedAt).getTime();
        const close = new Date(trade.closedAt).getTime();
        holdDurationMins = Math.round((close - open) / 60000);
      }
      
      // Determine exit type
      let exitType = "unknown";
      const closeReason = (trade.closeReason || "").toLowerCase();
      if (closeReason.includes("tp2")) exitType = "tp2";
      else if (closeReason.includes("tp1")) exitType = "tp1";
      else if (closeReason.includes("trailing")) exitType = "trailing";
      else if (closeReason.includes("stop loss")) exitType = "sl";
      else if (closeReason.includes("rsi recover")) exitType = "rsi_recovery";
      else if (closeReason.includes("manual")) exitType = "manual";
      
      // Was this a good decision?
      // Good = win OR small loss within risk parameters
      // Bad = large loss, or win where we left too much on the table
      let wasGoodDecision = false;
      let reviewNotes = "";
      
      if (outcome === "win") {
        wasGoodDecision = true;
        if (exitType === "sl") {
          reviewNotes = `Win on SL — price reversed after stop, consider wider SL. P&L: ${pnlPct.toFixed(2)}%`;
        } else if (exitType === "tp1" || exitType === "tp2") {
          reviewNotes = `Clean ${exitType.toUpperCase()} exit. Confluence ${decision.confluenceScore}/7 confirmed. P&L: ${pnlPct.toFixed(2)}%`;
        } else if (exitType === "trailing") {
          const peakPnl = trade.peakPnlPct || 0;
          const captureRatio = peakPnl > 0 ? (pnlPct / peakPnl * 100) : 100;
          reviewNotes = `Trailing captured ${captureRatio.toFixed(0)}% of peak (${peakPnl.toFixed(2)}% peak → ${pnlPct.toFixed(2)}% exit)`;
          if (captureRatio < 50) {
            reviewNotes += ". Consider tighter trailing or earlier TP.";
          }
        } else {
          reviewNotes = `Win via ${exitType}. P&L: ${pnlPct.toFixed(2)}%`;
        }
      } else if (outcome === "loss") {
        const maxRisk = 0.25; // config default
        if (Math.abs(pnlPct) <= maxRisk * 1.5) {
          wasGoodDecision = true; // Controlled loss within risk parameters
          reviewNotes = `Controlled loss within risk budget. SL worked correctly. P&L: ${pnlPct.toFixed(2)}%`;
        } else {
          wasGoodDecision = false;
          reviewNotes = `Loss exceeded risk budget (${pnlPct.toFixed(2)}%). `;
          if (decision.confluenceScore && decision.confluenceScore < 4) {
            reviewNotes += `Low confluence (${decision.confluenceScore}/7) — should require higher score. `;
          }
          if (holdDurationMins && holdDurationMins < 5) {
            reviewNotes += `Very short hold (${holdDurationMins}min) — possible whipsaw. `;
          }
        }
      } else {
        wasGoodDecision = true;
        reviewNotes = `Breakeven — capital preserved. ${exitType}`;
      }
      
      // Estimate USD P&L
      const equityAtEntry = decision.equity || 1000;
      const posSize = decision.positionSizeUsd || (equityAtEntry * 0.1);
      const pnlUsd = posSize * (pnlPct / 100);
      
      storage.updateDecision(decision.id, {
        outcome,
        outcomePnlPct: pnlPct,
        outcomePnlUsd: pnlUsd,
        holdDurationMins,
        exitType,
        wasGoodDecision,
        reviewNotes,
      });
      
      reviewed++;
    }
    
    if (reviewed > 0) {
      log(`Reviewed ${reviewed} closed trade decisions`, "learning");
    }
    
    return reviewed;
  } catch (e) {
    log(`Review error: ${e}`, "learning");
    return 0;
  }
}

// ============ PATTERN ANALYSIS & INSIGHT GENERATION ============

/**
 * Analyze all reviewed decisions and generate/update learning insights.
 * Called periodically (every ~10 scan cycles).
 */
export function generateInsights() {
  try {
    const allDecisions = storage.getAllDecisions(500)
      .filter(d => d.outcome != null && d.action === "entry");
    
    if (allDecisions.length < MIN_SAMPLE_SIZE) {
      log(`Not enough data for insights (${allDecisions.length}/${MIN_SAMPLE_SIZE})`, "learning");
      return;
    }

    // === PER-ASSET ANALYSIS ===
    const byCoin = groupBy(allDecisions, d => d.coin);
    for (const [coin, decisions] of Object.entries(byCoin)) {
      if (decisions.length < MIN_SAMPLE_SIZE) continue;
      
      const wins = decisions.filter(d => d.outcome === "win");
      const losses = decisions.filter(d => d.outcome === "loss");
      const winRate = wins.length / decisions.length;
      const avgPnl = avg(decisions.map(d => d.outcomePnlPct || 0));
      const avgWinPnl = wins.length > 0 ? avg(wins.map(d => d.outcomePnlPct || 0)) : 0;
      const avgLossPnl = losses.length > 0 ? avg(losses.map(d => d.outcomePnlPct || 0)) : 0;
      
      const rule = `asset_${coin.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`;
      const confidence = Math.min(1, decisions.length / HIGH_CONFIDENCE_SAMPLE);
      
      let description = `${coin}: ${(winRate * 100).toFixed(0)}% win rate over ${decisions.length} trades. `;
      description += `Avg P&L: ${avgPnl.toFixed(2)}%. `;
      if (winRate < 0.35) description += "UNDERPERFORMING — consider reducing allocation or tightening filters. ";
      if (winRate > 0.65) description += "STRONG PERFORMER — consider increasing allocation. ";
      
      upsertInsight({
        category: "asset",
        rule,
        description,
        sampleSize: decisions.length,
        winRate,
        avgPnlPct: avgPnl,
        avgPnlWinPct: avgWinPnl,
        avgPnlLossPct: avgLossPnl,
        confidence,
        isActive: true,
      });
    }

    // === SESSION ANALYSIS ===
    const bySession = groupBy(allDecisions, d => d.session || "unknown");
    for (const [session, decisions] of Object.entries(bySession)) {
      if (decisions.length < MIN_SAMPLE_SIZE) continue;
      
      const winRate = decisions.filter(d => d.outcome === "win").length / decisions.length;
      const avgPnl = avg(decisions.map(d => d.outcomePnlPct || 0));
      const confidence = Math.min(1, decisions.length / HIGH_CONFIDENCE_SAMPLE);
      
      const rule = `session_${session}`;
      let description = `${session} session: ${(winRate * 100).toFixed(0)}% win rate (${decisions.length} trades). Avg P&L: ${avgPnl.toFixed(2)}%. `;
      if (winRate < 0.35) description += "AVOID trading in this session. ";
      if (winRate > 0.65) description += "Best session for entries. ";
      
      upsertInsight({
        category: "session",
        rule,
        description,
        sampleSize: decisions.length,
        winRate,
        avgPnlPct: avgPnl,
        avgPnlWinPct: avg(decisions.filter(d => d.outcome === "win").map(d => d.outcomePnlPct || 0)),
        avgPnlLossPct: avg(decisions.filter(d => d.outcome === "loss").map(d => d.outcomePnlPct || 0)),
        confidence,
        isActive: true,
      });
    }

    // === CONFLUENCE SCORE ANALYSIS ===
    const byConfluence = groupBy(allDecisions, d => String(d.confluenceScore || 0));
    for (const [scoreStr, decisions] of Object.entries(byConfluence)) {
      if (decisions.length < 3) continue;
      
      const score = parseInt(scoreStr);
      const winRate = decisions.filter(d => d.outcome === "win").length / decisions.length;
      const avgPnl = avg(decisions.map(d => d.outcomePnlPct || 0));
      
      const rule = `confluence_${score}`;
      let description = `Confluence ${score}/7: ${(winRate * 100).toFixed(0)}% win rate (${decisions.length} trades). `;
      if (score <= 2 && winRate < 0.4) description += "LOW CONFLUENCE = LOW WIN RATE. Increase min confluence filter. ";
      if (score >= 5 && winRate > 0.6) description += "HIGH CONFLUENCE CONFIRMED profitable. Prioritize these setups. ";
      
      upsertInsight({
        category: "confluence",
        rule,
        description,
        sampleSize: decisions.length,
        winRate,
        avgPnlPct: avgPnl,
        avgPnlWinPct: avg(decisions.filter(d => d.outcome === "win").map(d => d.outcomePnlPct || 0)),
        avgPnlLossPct: avg(decisions.filter(d => d.outcome === "loss").map(d => d.outcomePnlPct || 0)),
        confidence: Math.min(1, decisions.length / HIGH_CONFIDENCE_SAMPLE),
        isActive: true,
      });
    }

    // === SIDE ANALYSIS (long vs short per asset) ===
    const bySide = groupBy(allDecisions, d => `${d.coin}_${d.side}`);
    for (const [key, decisions] of Object.entries(bySide)) {
      if (decisions.length < MIN_SAMPLE_SIZE) continue;
      
      const winRate = decisions.filter(d => d.outcome === "win").length / decisions.length;
      const avgPnl = avg(decisions.map(d => d.outcomePnlPct || 0));
      
      const rule = `side_${key.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`;
      const [coin, side] = key.split("_");
      let description = `${coin} ${side}s: ${(winRate * 100).toFixed(0)}% win rate (${decisions.length} trades). `;
      if (winRate < 0.3) description += `AVOID ${side}ing this asset. `;
      
      upsertInsight({
        category: "pattern",
        rule,
        description,
        sampleSize: decisions.length,
        winRate,
        avgPnlPct: avgPnl,
        avgPnlWinPct: avg(decisions.filter(d => d.outcome === "win").map(d => d.outcomePnlPct || 0)),
        avgPnlLossPct: avg(decisions.filter(d => d.outcome === "loss").map(d => d.outcomePnlPct || 0)),
        confidence: Math.min(1, decisions.length / HIGH_CONFIDENCE_SAMPLE),
        isActive: true,
      });
    }

    // === EXIT TYPE ANALYSIS ===
    const reviewedWithExit = allDecisions.filter(d => d.exitType);
    const byExit = groupBy(reviewedWithExit, d => d.exitType || "unknown");
    for (const [exitType, decisions] of Object.entries(byExit)) {
      if (decisions.length < 3) continue;
      
      const avgPnl = avg(decisions.map(d => d.outcomePnlPct || 0));
      const rule = `exit_${exitType}`;
      let description = `Exit via ${exitType}: avg P&L ${avgPnl.toFixed(2)}% (${decisions.length} trades). `;
      if (exitType === "sl" && avgPnl < -0.5) description += "Stop losses working but consider tighter SL. ";
      if (exitType === "trailing" && avgPnl > 0.3) description += "Trailing stop capturing good profits. ";
      
      upsertInsight({
        category: "exit",
        rule,
        description,
        sampleSize: decisions.length,
        winRate: decisions.filter(d => d.outcome === "win").length / decisions.length,
        avgPnlPct: avgPnl,
        avgPnlWinPct: avg(decisions.filter(d => d.outcome === "win").map(d => d.outcomePnlPct || 0)),
        avgPnlLossPct: avg(decisions.filter(d => d.outcome === "loss").map(d => d.outcomePnlPct || 0)),
        confidence: Math.min(1, decisions.length / HIGH_CONFIDENCE_SAMPLE),
        isActive: true,
      });
    }

    // === DAY OF WEEK ANALYSIS ===
    const byDay = groupBy(allDecisions, d => String(d.dayOfWeek ?? 0));
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    for (const [dayStr, decisions] of Object.entries(byDay)) {
      if (decisions.length < 3) continue;
      
      const day = parseInt(dayStr);
      const winRate = decisions.filter(d => d.outcome === "win").length / decisions.length;
      const avgPnl = avg(decisions.map(d => d.outcomePnlPct || 0));
      
      const rule = `day_${dayNames[day]?.toLowerCase() || day}`;
      let description = `${dayNames[day] || day}: ${(winRate * 100).toFixed(0)}% win rate (${decisions.length} trades). Avg P&L: ${avgPnl.toFixed(2)}%. `;
      if (winRate < 0.3) description += "WEAK day — reduce exposure. ";
      if (winRate > 0.65) description += "STRONG day — increase confidence. ";
      
      upsertInsight({
        category: "session",
        rule,
        description,
        sampleSize: decisions.length,
        winRate,
        avgPnlPct: avgPnl,
        avgPnlWinPct: avg(decisions.filter(d => d.outcome === "win").map(d => d.outcomePnlPct || 0)),
        avgPnlLossPct: avg(decisions.filter(d => d.outcome === "loss").map(d => d.outcomePnlPct || 0)),
        confidence: Math.min(1, decisions.length / HIGH_CONFIDENCE_SAMPLE),
        isActive: true,
      });
    }

    log(`Generated/updated insights from ${allDecisions.length} reviewed decisions`, "learning");
  } catch (e) {
    log(`Insight generation error: ${e}`, "learning");
  }
}

// ============ APPLYING LEARNED RULES ============

/**
 * Check all active insights before entering a trade.
 * Returns warnings, boosts, or blocks based on learned patterns.
 */
export function checkInsights(params: {
  coin: string;
  side: "long" | "short";
  session: string;
  confluenceScore: number;
  dayOfWeek: number;
}): {
  shouldBlock: boolean;
  blockReason: string;
  warnings: string[];
  boosts: string[];
  confidenceAdjustment: number; // Add/subtract from confluence score
} {
  const insights = storage.getActiveInsights();
  const warnings: string[] = [];
  const boosts: string[] = [];
  let confidenceAdjustment = 0;
  let shouldBlock = false;
  let blockReason = "";

  for (const insight of insights) {
    if (insight.confidence < 0.3) continue; // Skip low-confidence insights
    if ((insight.sampleSize || 0) < MIN_SAMPLE_SIZE) continue;

    const wr = insight.winRate || 0;
    const avgPnl = insight.avgPnlPct || 0;

    // Asset-specific rule
    if (insight.category === "asset") {
      const assetKey = `asset_${params.coin.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`;
      if (insight.rule === assetKey) {
        if (wr < 0.25 && insight.confidence > 0.5 && (insight.sampleSize || 0) >= 8) {
          shouldBlock = true;
          blockReason = `LEARNED: ${params.coin} has ${(wr * 100).toFixed(0)}% win rate over ${insight.sampleSize} trades — blocking entry`;
          break;
        }
        if (wr < 0.35) {
          warnings.push(`${params.coin}: low ${(wr * 100).toFixed(0)}% win rate (${insight.sampleSize} trades)`);
          confidenceAdjustment -= 1;
        }
        if (wr > 0.65) {
          boosts.push(`${params.coin}: strong ${(wr * 100).toFixed(0)}% win rate`);
          confidenceAdjustment += 1;
        }
      }
    }

    // Side-specific rule
    if (insight.category === "pattern") {
      const sideKey = `side_${params.coin.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}_${params.side}`;
      if (insight.rule === sideKey) {
        if (wr < 0.2 && insight.confidence > 0.5 && (insight.sampleSize || 0) >= 8) {
          shouldBlock = true;
          blockReason = `LEARNED: ${params.coin} ${params.side}s have ${(wr * 100).toFixed(0)}% win rate — blocking`;
          break;
        }
        if (wr < 0.3) {
          warnings.push(`${params.side}ing ${params.coin}: only ${(wr * 100).toFixed(0)}% win rate`);
          confidenceAdjustment -= 1;
        }
      }
    }

    // Session rule
    if (insight.category === "session" && insight.rule === `session_${params.session}`) {
      if (wr < 0.25 && insight.confidence > 0.6) {
        warnings.push(`${params.session} session: ${(wr * 100).toFixed(0)}% win rate historically`);
        confidenceAdjustment -= 1;
      }
      if (wr > 0.65) {
        boosts.push(`${params.session}: strong ${(wr * 100).toFixed(0)}% historical win rate`);
        confidenceAdjustment += 1;
      }
    }

    // Day of week rule
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    if (insight.category === "session" && insight.rule === `day_${dayNames[params.dayOfWeek]}`) {
      if (wr < 0.3 && insight.confidence > 0.5) {
        warnings.push(`${dayNames[params.dayOfWeek]}: weak day (${(wr * 100).toFixed(0)}% win rate)`);
        confidenceAdjustment -= 1;
      }
    }
  }

  return { shouldBlock, blockReason, warnings, boosts, confidenceAdjustment };
}

/**
 * Get a summary of what the bot has learned — for the dashboard.
 */
export function getLearningStats(): {
  totalDecisions: number;
  reviewedDecisions: number;
  totalInsights: number;
  activeInsights: number;
  topInsights: Array<{ rule: string; description: string; winRate: number; sampleSize: number; confidence: number }>;
  overallWinRate: number;
  overallAvgPnl: number;
  bestAsset: { coin: string; winRate: number } | null;
  worstAsset: { coin: string; winRate: number } | null;
  bestSession: { session: string; winRate: number } | null;
} {
  const allDecisions = storage.getAllDecisions(1000);
  const reviewed = allDecisions.filter(d => d.outcome != null);
  const allInsights = storage.getAllInsights();
  const active = allInsights.filter(i => i.isActive);
  
  const entryDecisions = reviewed.filter(d => d.action === "entry");
  const overallWinRate = entryDecisions.length > 0
    ? entryDecisions.filter(d => d.outcome === "win").length / entryDecisions.length
    : 0;
  const overallAvgPnl = entryDecisions.length > 0
    ? avg(entryDecisions.map(d => d.outcomePnlPct || 0))
    : 0;

  // Find best/worst assets
  const assetInsights = active.filter(i => i.category === "asset" && (i.sampleSize || 0) >= MIN_SAMPLE_SIZE);
  const sortedAssets = [...assetInsights].sort((a, b) => (b.winRate || 0) - (a.winRate || 0));
  const bestAsset = sortedAssets.length > 0
    ? { coin: sortedAssets[0].rule.replace("asset_", "").toUpperCase(), winRate: sortedAssets[0].winRate || 0 }
    : null;
  const worstAsset = sortedAssets.length > 0
    ? { coin: sortedAssets[sortedAssets.length - 1].rule.replace("asset_", "").toUpperCase(), winRate: sortedAssets[sortedAssets.length - 1].winRate || 0 }
    : null;

  // Find best session
  const sessionInsights = active.filter(i => i.category === "session" && i.rule.startsWith("session_") && (i.sampleSize || 0) >= MIN_SAMPLE_SIZE);
  const bestSession = sessionInsights.length > 0
    ? (() => {
        const sorted = [...sessionInsights].sort((a, b) => (b.winRate || 0) - (a.winRate || 0));
        return { session: sorted[0].rule.replace("session_", ""), winRate: sorted[0].winRate || 0 };
      })()
    : null;

  return {
    totalDecisions: allDecisions.length,
    reviewedDecisions: reviewed.length,
    totalInsights: allInsights.length,
    activeInsights: active.length,
    topInsights: active.slice(0, 10).map(i => ({
      rule: i.rule,
      description: i.description,
      winRate: i.winRate || 0,
      sampleSize: i.sampleSize || 0,
      confidence: i.confidence || 0,
    })),
    overallWinRate,
    overallAvgPnl,
    bestAsset,
    worstAsset,
    bestSession,
  };
}

// ============ HELPERS ============

function groupBy<T>(arr: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const key = keyFn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function upsertInsight(data: {
  category: string;
  rule: string;
  description: string;
  sampleSize: number;
  winRate: number;
  avgPnlPct: number;
  avgPnlWinPct: number;
  avgPnlLossPct: number;
  confidence: number;
  isActive: boolean;
}) {
  const existing = storage.getInsightByRule(data.rule);
  const now = new Date().toISOString();
  
  if (existing) {
    storage.updateInsight(existing.id, {
      ...data,
      updatedAt: now,
    });
  } else {
    storage.createInsight({
      ...data,
      tradesAffected: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
}
