/**
 * HyperTrader — Learning Engine v2
 * 
 * Continuously improves trading by analyzing every decision and outcome.
 * All storage calls are async (PostgreSQL).
 * 
 * NEW: 24-hour deep review cycle
 *   - Runs every 24h automatically
 *   - Reviews ALL trades (not just unreviewed)
 *   - Identifies patterns, mistakes, and winning strategies
 *   - Generates/updates insights per strategy, asset, session, exit type
 *   - Stores full review summary in learning_reviews table
 *   - Bot gets progressively smarter over time
 */

import { storage } from "./storage";
import { log } from "./index";
import type { Trade, TradeDecision, LearningInsight } from "@shared/schema";

const MIN_SAMPLE_SIZE = 5;
const HIGH_CONFIDENCE_SAMPLE = 15;

// ============ DECISION LOGGING ============

export async function logDecision(params: {
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
  strategy?: string;
}) {
  const now = new Date();
  
  try {
    await storage.createDecision({
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
      strategy: params.strategy || "confluence",
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

export async function reviewClosedTrades() {
  try {
    const unreviewedDecisions = await storage.getUnreviewedDecisions(50);
    let reviewed = 0;

    for (const decision of unreviewedDecisions) {
      if (!decision.tradeId) continue;
      
      const trade = await storage.getTradeById(decision.tradeId);
      if (!trade || trade.status === "open") continue;
      
      const pnlPct = trade.pnl || 0;
      const outcome = pnlPct > 0.1 ? "win" : pnlPct < -0.1 ? "loss" : "breakeven";
      
      let holdDurationMins: number | null = null;
      if (trade.openedAt && trade.closedAt) {
        const open = new Date(trade.openedAt).getTime();
        const close = new Date(trade.closedAt).getTime();
        holdDurationMins = Math.round((close - open) / 60000);
      }
      
      let exitType = "unknown";
      const closeReason = (trade.closeReason || "").toLowerCase();
      if (closeReason.includes("tp2")) exitType = "tp2";
      else if (closeReason.includes("tp1")) exitType = "tp1";
      else if (closeReason.includes("trailing")) exitType = "trailing";
      else if (closeReason.includes("sl") || closeReason.includes("stop loss")) exitType = "sl";
      else if (closeReason.includes("breakeven")) exitType = "sl_breakeven";
      else if (closeReason.includes("rsi recover")) exitType = "rsi_recovery";
      else if (closeReason.includes("manual")) exitType = "manual";
      else if (closeReason.includes("quick profit")) exitType = "quick_profit";
      
      const strategy = trade.strategy || "confluence";
      let wasGoodDecision = false;
      let reviewNotes = "";
      
      if (outcome === "win") {
        wasGoodDecision = true;
        if (strategy === "extreme_rsi") {
          if (exitType === "tp2") {
            reviewNotes = `[EXTREME_RSI] Full TP2 hit (+1%). Perfect execution. P&L: ${pnlPct.toFixed(2)}%`;
          } else if (exitType === "sl_breakeven") {
            reviewNotes = `[EXTREME_RSI] TP1 hit, closed at breakeven. Good risk management — capital preserved after partial profit.`;
          } else {
            reviewNotes = `[EXTREME_RSI] Win via ${exitType}. P&L: ${pnlPct.toFixed(2)}%`;
          }
        } else {
          if (exitType === "sl") {
            reviewNotes = `[CONFLUENCE] Win on SL — price reversed after stop, consider wider SL. P&L: ${pnlPct.toFixed(2)}%`;
          } else if (exitType === "tp1" || exitType === "tp2") {
            reviewNotes = `[CONFLUENCE] Clean ${exitType.toUpperCase()} exit. Confluence ${decision.confluenceScore}/7 confirmed. P&L: ${pnlPct.toFixed(2)}%`;
          } else if (exitType === "trailing") {
            const peakPnl = trade.peakPnlPct || 0;
            const captureRatio = peakPnl > 0 ? (pnlPct / peakPnl * 100) : 100;
            reviewNotes = `[CONFLUENCE] Trailing captured ${captureRatio.toFixed(0)}% of peak (${peakPnl.toFixed(2)}% peak → ${pnlPct.toFixed(2)}% exit)`;
            if (captureRatio < 50) reviewNotes += ". Consider tighter trailing or earlier TP.";
          } else if (exitType === "quick_profit") {
            reviewNotes = `[CONFLUENCE] Quick profit banked. P&L: ${pnlPct.toFixed(2)}%. Scalp strategy working.`;
          } else {
            reviewNotes = `[CONFLUENCE] Win via ${exitType}. P&L: ${pnlPct.toFixed(2)}%`;
          }
        }
      } else if (outcome === "loss") {
        const maxRisk = 0.25;
        if (Math.abs(pnlPct) <= maxRisk * 1.5) {
          wasGoodDecision = true;
          reviewNotes = `[${strategy.toUpperCase()}] Controlled loss within risk budget. SL worked correctly. P&L: ${pnlPct.toFixed(2)}%`;
        } else {
          wasGoodDecision = false;
          reviewNotes = `[${strategy.toUpperCase()}] Loss exceeded risk budget (${pnlPct.toFixed(2)}%). `;
          if (strategy === "extreme_rsi") {
            reviewNotes += `Extreme RSI entry at ${trade.rsiAtEntry?.toFixed(1)} may have been a false signal. Check if multiple TFs confirmed. `;
          } else {
            if (decision.confluenceScore && decision.confluenceScore < 4) {
              reviewNotes += `Low confluence (${decision.confluenceScore}/7) — should require higher score. `;
            }
          }
          if (holdDurationMins && holdDurationMins < 5) {
            reviewNotes += `Very short hold (${holdDurationMins}min) — possible whipsaw. `;
          }
        }
      } else {
        wasGoodDecision = true;
        reviewNotes = `[${strategy.toUpperCase()}] Breakeven — capital preserved. ${exitType}`;
      }
      
      const equityAtEntry = decision.equity || 1000;
      const posSize = decision.positionSizeUsd || (equityAtEntry * 0.1);
      const pnlUsd = posSize * (pnlPct / 100);
      
      await storage.updateDecision(decision.id, {
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

export async function generateInsights() {
  try {
    const allDecisionsRaw = await storage.getAllDecisions(500);
    const allDecisions = allDecisionsRaw.filter(d => d.outcome != null && d.action === "entry");
    
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
      let description = `${coin}: ${(winRate * 100).toFixed(0)}% win rate over ${decisions.length} trades. Avg P&L: ${avgPnl.toFixed(2)}%. `;
      if (winRate < 0.35) description += "UNDERPERFORMING — consider reducing allocation. ";
      if (winRate > 0.65) description += "STRONG PERFORMER — increase allocation. ";
      await upsertInsight({ category: "asset", rule, description, sampleSize: decisions.length, winRate, avgPnlPct: avgPnl, avgPnlWinPct: avgWinPnl, avgPnlLossPct: avgLossPnl, confidence, isActive: true });
    }

    // === PER-STRATEGY ANALYSIS (NEW) ===
    const byStrategy = groupBy(allDecisions, d => d.strategy || "confluence");
    for (const [strategy, decisions] of Object.entries(byStrategy)) {
      if (decisions.length < 3) continue;
      const winRate = decisions.filter(d => d.outcome === "win").length / decisions.length;
      const avgPnl = avg(decisions.map(d => d.outcomePnlPct || 0));
      const rule = `strategy_${strategy}`;
      const confidence = Math.min(1, decisions.length / HIGH_CONFIDENCE_SAMPLE);
      let description = `${strategy}: ${(winRate * 100).toFixed(0)}% win rate (${decisions.length} trades). Avg P&L: ${avgPnl.toFixed(2)}%. `;
      if (strategy === "extreme_rsi") {
        const avgHold = avg(decisions.filter(d => d.holdDurationMins != null).map(d => d.holdDurationMins || 0));
        description += `Avg hold: ${avgHold.toFixed(0)}min. `;
      }
      if (winRate < 0.35) description += "UNDERPERFORMING strategy. ";
      if (winRate > 0.65) description += "HIGH-PERFORMING strategy. ";
      await upsertInsight({ category: "strategy", rule, description, sampleSize: decisions.length, winRate, avgPnlPct: avgPnl, avgPnlWinPct: avg(decisions.filter(d => d.outcome === "win").map(d => d.outcomePnlPct || 0)), avgPnlLossPct: avg(decisions.filter(d => d.outcome === "loss").map(d => d.outcomePnlPct || 0)), confidence, isActive: true });
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
      await upsertInsight({ category: "session", rule, description, sampleSize: decisions.length, winRate, avgPnlPct: avgPnl, avgPnlWinPct: avg(decisions.filter(d => d.outcome === "win").map(d => d.outcomePnlPct || 0)), avgPnlLossPct: avg(decisions.filter(d => d.outcome === "loss").map(d => d.outcomePnlPct || 0)), confidence, isActive: true });
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
      if (score <= 2 && winRate < 0.4) description += "LOW CONFLUENCE = LOW WIN RATE. Increase min filter. ";
      if (score >= 5 && winRate > 0.6) description += "HIGH CONFLUENCE CONFIRMED profitable. ";
      await upsertInsight({ category: "confluence", rule, description, sampleSize: decisions.length, winRate, avgPnlPct: avgPnl, avgPnlWinPct: avg(decisions.filter(d => d.outcome === "win").map(d => d.outcomePnlPct || 0)), avgPnlLossPct: avg(decisions.filter(d => d.outcome === "loss").map(d => d.outcomePnlPct || 0)), confidence: Math.min(1, decisions.length / HIGH_CONFIDENCE_SAMPLE), isActive: true });
    }

    // === SIDE ANALYSIS ===
    const bySide = groupBy(allDecisions, d => `${d.coin}_${d.side}`);
    for (const [key, decisions] of Object.entries(bySide)) {
      if (decisions.length < MIN_SAMPLE_SIZE) continue;
      const winRate = decisions.filter(d => d.outcome === "win").length / decisions.length;
      const avgPnl = avg(decisions.map(d => d.outcomePnlPct || 0));
      const rule = `side_${key.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`;
      const [coin, side] = key.split("_");
      let description = `${coin} ${side}s: ${(winRate * 100).toFixed(0)}% win rate (${decisions.length} trades). `;
      if (winRate < 0.3) description += `AVOID ${side}ing this asset. `;
      await upsertInsight({ category: "pattern", rule, description, sampleSize: decisions.length, winRate, avgPnlPct: avgPnl, avgPnlWinPct: avg(decisions.filter(d => d.outcome === "win").map(d => d.outcomePnlPct || 0)), avgPnlLossPct: avg(decisions.filter(d => d.outcome === "loss").map(d => d.outcomePnlPct || 0)), confidence: Math.min(1, decisions.length / HIGH_CONFIDENCE_SAMPLE), isActive: true });
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
      if (exitType === "sl_breakeven") description += "Breakeven stops protecting capital after TP1. ";
      if (exitType === "trailing" && avgPnl > 0.3) description += "Trailing stop capturing good profits. ";
      if (exitType === "quick_profit") description += "Quick profit scalps contributing consistently. ";
      await upsertInsight({ category: "exit", rule, description, sampleSize: decisions.length, winRate: decisions.filter(d => d.outcome === "win").length / decisions.length, avgPnlPct: avgPnl, avgPnlWinPct: avg(decisions.filter(d => d.outcome === "win").map(d => d.outcomePnlPct || 0)), avgPnlLossPct: avg(decisions.filter(d => d.outcome === "loss").map(d => d.outcomePnlPct || 0)), confidence: Math.min(1, decisions.length / HIGH_CONFIDENCE_SAMPLE), isActive: true });
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
      await upsertInsight({ category: "session", rule, description, sampleSize: decisions.length, winRate, avgPnlPct: avgPnl, avgPnlWinPct: avg(decisions.filter(d => d.outcome === "win").map(d => d.outcomePnlPct || 0)), avgPnlLossPct: avg(decisions.filter(d => d.outcome === "loss").map(d => d.outcomePnlPct || 0)), confidence: Math.min(1, decisions.length / HIGH_CONFIDENCE_SAMPLE), isActive: true });
    }

    log(`Generated/updated insights from ${allDecisions.length} reviewed decisions`, "learning");
  } catch (e) {
    log(`Insight generation error: ${e}`, "learning");
  }
}

// ============ 24-HOUR DEEP LEARNING REVIEW ============

export async function run24hReview() {
  try {
    log("=== 24-HOUR DEEP LEARNING REVIEW STARTING ===", "learning");

    // 1. First, review any unreviewed closed trades
    const reviewed = await reviewClosedTrades();

    // 2. Get all entry decisions with outcomes
    const allDecisionsRaw = await storage.getAllDecisions(1000);
    const entryDecisions = allDecisionsRaw.filter(d => d.outcome != null && d.action === "entry");
    
    if (entryDecisions.length === 0) {
      log("24h review: No trades to analyze yet", "learning");
      await storage.createReview({
        reviewType: "24h_cycle",
        tradesAnalyzed: 0, wins: 0, losses: 0, totalPnlPct: 0,
        insightsGenerated: 0, insightsUpdated: 0,
        summary: "No trades to analyze yet. Bot is collecting data.",
        mistakesIdentified: "", improvementsApplied: "",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const wins = entryDecisions.filter(d => d.outcome === "win");
    const losses = entryDecisions.filter(d => d.outcome === "loss");
    const breakevens = entryDecisions.filter(d => d.outcome === "breakeven");
    const totalPnl = avg(entryDecisions.map(d => d.outcomePnlPct || 0)) * entryDecisions.length;

    // 3. Per-strategy breakdown
    const confluenceDecisions = entryDecisions.filter(d => (d.strategy || "confluence") === "confluence");
    const extremeDecisions = entryDecisions.filter(d => d.strategy === "extreme_rsi");

    // 4. Identify MISTAKES
    const mistakes: string[] = [];
    
    // Losses with low confluence
    const lowConfLosses = losses.filter(d => (d.strategy || "confluence") === "confluence" && (d.confluenceScore || 0) < 4);
    if (lowConfLosses.length > 0) {
      mistakes.push(`${lowConfLosses.length} losses with low confluence (<4/7) — consider raising minimum confluence`);
    }

    // Losses in specific sessions
    const lossBySession = groupBy(losses, d => d.session || "unknown");
    for (const [session, sessionLosses] of Object.entries(lossBySession)) {
      const sessionTotal = entryDecisions.filter(d => d.session === session).length;
      const lossRate = sessionLosses.length / Math.max(1, sessionTotal);
      if (lossRate > 0.65 && sessionTotal >= 3) {
        mistakes.push(`${session} session: ${(lossRate * 100).toFixed(0)}% loss rate (${sessionLosses.length}/${sessionTotal}) — avoid trading in this session`);
      }
    }

    // Whipsaw losses (very short hold times)
    const whipsaws = losses.filter(d => (d.holdDurationMins || 999) < 3);
    if (whipsaws.length > 0) {
      mistakes.push(`${whipsaws.length} whipsaw losses (held <3min) — entries may be too aggressive or SL too tight`);
    }

    // Extreme RSI false signals
    const extremeLosses = losses.filter(d => d.strategy === "extreme_rsi");
    if (extremeLosses.length > 0 && extremeDecisions.length > 0) {
      const extremeLossRate = extremeLosses.length / extremeDecisions.length;
      if (extremeLossRate > 0.6) {
        mistakes.push(`Extreme RSI strategy: ${(extremeLossRate * 100).toFixed(0)}% loss rate — RSI extremes may not be reversing as expected`);
      }
    }

    // Large losses (exceeded risk budget)
    const largeLosses = losses.filter(d => Math.abs(d.outcomePnlPct || 0) > 5);
    if (largeLosses.length > 0) {
      mistakes.push(`${largeLosses.length} trades exceeded 5% loss — SL may not be executing properly or slippage is high`);
    }

    // 5. Identify IMPROVEMENTS based on wins
    const improvements: string[] = [];
    
    const winsByExit = groupBy(wins, d => d.exitType || "unknown");
    for (const [exitType, exitWins] of Object.entries(winsByExit)) {
      const avgWinPnl = avg(exitWins.map(d => d.outcomePnlPct || 0));
      if (exitWins.length >= 3) {
        improvements.push(`${exitType} exits averaging +${avgWinPnl.toFixed(2)}% over ${exitWins.length} wins — keep this exit strategy`);
      }
    }

    // Best performing confluence scores
    const highConfWins = wins.filter(d => (d.confluenceScore || 0) >= 5);
    if (highConfWins.length > 0) {
      improvements.push(`High confluence (5+/7) wins: ${highConfWins.length} — these setups are the most reliable`);
    }

    // Quick profit effectiveness
    const quickProfits = wins.filter(d => d.exitType === "quick_profit");
    if (quickProfits.length >= 3) {
      improvements.push(`Quick profit exits: ${quickProfits.length} wins averaging +${avg(quickProfits.map(d => d.outcomePnlPct || 0)).toFixed(2)}% — scalp approach working`);
    }

    // Breakeven stops
    const beStops = entryDecisions.filter(d => d.exitType === "sl_breakeven");
    if (beStops.length > 0) {
      improvements.push(`Breakeven stops saved ${beStops.length} positions from turning into losses — TP1→BE strategy is effective`);
    }

    // 6. Generate updated insights
    const insightsBefore = (await storage.getAllInsights()).length;
    await generateInsights();
    const insightsAfter = (await storage.getAllInsights()).length;
    const newInsights = insightsAfter - insightsBefore;

    // 7. Build comprehensive summary
    const summary = [
      `=== 24-HOUR DEEP LEARNING REVIEW ===`,
      `Total trades analyzed: ${entryDecisions.length}`,
      `Wins: ${wins.length} | Losses: ${losses.length} | Breakeven: ${breakevens.length}`,
      `Overall win rate: ${(wins.length / entryDecisions.length * 100).toFixed(1)}%`,
      `Average P&L per trade: ${avg(entryDecisions.map(d => d.outcomePnlPct || 0)).toFixed(2)}%`,
      ``,
      `--- Strategy Breakdown ---`,
      `Confluence: ${confluenceDecisions.length} trades, ${confluenceDecisions.filter(d => d.outcome === "win").length} wins (${confluenceDecisions.length > 0 ? (confluenceDecisions.filter(d => d.outcome === "win").length / confluenceDecisions.length * 100).toFixed(0) : 0}%)`,
      `Extreme RSI: ${extremeDecisions.length} trades, ${extremeDecisions.filter(d => d.outcome === "win").length} wins (${extremeDecisions.length > 0 ? (extremeDecisions.filter(d => d.outcome === "win").length / extremeDecisions.length * 100).toFixed(0) : 0}%)`,
      ``,
      `--- Mistakes Identified ---`,
      mistakes.length > 0 ? mistakes.join("\n") : "No significant mistakes identified.",
      ``,
      `--- Improvements & Strengths ---`,
      improvements.length > 0 ? improvements.join("\n") : "Not enough data for improvement analysis.",
      ``,
      `Insights: ${newInsights} new, ${insightsAfter} total active`,
    ].join("\n");

    // 8. Store the review
    await storage.createReview({
      reviewType: "24h_cycle",
      tradesAnalyzed: entryDecisions.length,
      wins: wins.length,
      losses: losses.length,
      totalPnlPct: totalPnl,
      insightsGenerated: newInsights,
      insightsUpdated: insightsAfter - newInsights,
      summary,
      mistakesIdentified: mistakes.join(" | "),
      improvementsApplied: improvements.join(" | "),
      timestamp: new Date().toISOString(),
    });

    log(`=== 24h REVIEW COMPLETE: ${entryDecisions.length} trades, ${wins.length}W/${losses.length}L, ${mistakes.length} mistakes, ${improvements.length} improvements ===`, "learning");
    
  } catch (e) {
    log(`24h review error: ${e}`, "learning");
  }
}

// ============ APPLYING LEARNED RULES ============

export async function checkInsights(params: {
  coin: string;
  side: "long" | "short";
  session: string;
  confluenceScore: number;
  dayOfWeek: number;
}): Promise<{
  shouldBlock: boolean;
  blockReason: string;
  warnings: string[];
  boosts: string[];
  confidenceAdjustment: number;
}> {
  const insights = await storage.getActiveInsights();
  const warnings: string[] = [];
  const boosts: string[] = [];
  let confidenceAdjustment = 0;
  let shouldBlock = false;
  let blockReason = "";

  for (const insight of insights) {
    if (insight.confidence < 0.3) continue;
    if ((insight.sampleSize || 0) < MIN_SAMPLE_SIZE) continue;

    const wr = insight.winRate || 0;

    // Asset-specific rule
    if (insight.category === "asset") {
      const assetKey = `asset_${params.coin.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`;
      if (insight.rule === assetKey) {
        if (wr < 0.25 && insight.confidence > 0.5 && (insight.sampleSize || 0) >= 8) {
          shouldBlock = true;
          blockReason = `LEARNED: ${params.coin} has ${(wr * 100).toFixed(0)}% win rate over ${insight.sampleSize} trades — blocking entry`;
          break;
        }
        if (wr < 0.35) { warnings.push(`${params.coin}: low ${(wr * 100).toFixed(0)}% win rate (${insight.sampleSize} trades)`); confidenceAdjustment -= 1; }
        if (wr > 0.65) { boosts.push(`${params.coin}: strong ${(wr * 100).toFixed(0)}% win rate`); confidenceAdjustment += 1; }
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
        if (wr < 0.3) { warnings.push(`${params.side}ing ${params.coin}: only ${(wr * 100).toFixed(0)}% win rate`); confidenceAdjustment -= 1; }
      }
    }

    // Session rule
    if (insight.category === "session" && insight.rule === `session_${params.session}`) {
      if (wr < 0.25 && insight.confidence > 0.6) { warnings.push(`${params.session} session: ${(wr * 100).toFixed(0)}% win rate historically`); confidenceAdjustment -= 1; }
      if (wr > 0.65) { boosts.push(`${params.session}: strong ${(wr * 100).toFixed(0)}% historical win rate`); confidenceAdjustment += 1; }
    }

    // Day of week rule
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    if (insight.category === "session" && insight.rule === `day_${dayNames[params.dayOfWeek]}`) {
      if (wr < 0.3 && insight.confidence > 0.5) { warnings.push(`${dayNames[params.dayOfWeek]}: weak day (${(wr * 100).toFixed(0)}% win rate)`); confidenceAdjustment -= 1; }
    }
  }

  return { shouldBlock, blockReason, warnings, boosts, confidenceAdjustment };
}

/**
 * Get learning stats for the dashboard.
 */
export async function getLearningStats(): Promise<{
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
  lastReviewTime: string | null;
}> {
  const allDecisions = await storage.getAllDecisions(1000);
  const reviewed = allDecisions.filter(d => d.outcome != null);
  const allInsights = await storage.getAllInsights();
  const active = allInsights.filter(i => i.isActive);
  
  const entryDecisions = reviewed.filter(d => d.action === "entry");
  const overallWinRate = entryDecisions.length > 0
    ? entryDecisions.filter(d => d.outcome === "win").length / entryDecisions.length
    : 0;
  const overallAvgPnl = entryDecisions.length > 0
    ? avg(entryDecisions.map(d => d.outcomePnlPct || 0))
    : 0;

  const assetInsights = active.filter(i => i.category === "asset" && (i.sampleSize || 0) >= MIN_SAMPLE_SIZE);
  const sortedAssets = [...assetInsights].sort((a, b) => (b.winRate || 0) - (a.winRate || 0));
  const bestAsset = sortedAssets.length > 0
    ? { coin: sortedAssets[0].rule.replace("asset_", "").toUpperCase(), winRate: sortedAssets[0].winRate || 0 }
    : null;
  const worstAsset = sortedAssets.length > 0
    ? { coin: sortedAssets[sortedAssets.length - 1].rule.replace("asset_", "").toUpperCase(), winRate: sortedAssets[sortedAssets.length - 1].winRate || 0 }
    : null;

  const sessionInsights = active.filter(i => i.category === "session" && i.rule.startsWith("session_") && (i.sampleSize || 0) >= MIN_SAMPLE_SIZE);
  const bestSession = sessionInsights.length > 0
    ? (() => {
        const sorted = [...sessionInsights].sort((a, b) => (b.winRate || 0) - (a.winRate || 0));
        return { session: sorted[0].rule.replace("session_", ""), winRate: sorted[0].winRate || 0 };
      })()
    : null;

  const lastReviewTime = await storage.getLastReviewTime();

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
    lastReviewTime,
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

async function upsertInsight(data: {
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
  const existing = await storage.getInsightByRule(data.rule);
  const now = new Date().toISOString();
  
  if (existing) {
    await storage.updateInsight(existing.id, { ...data, updatedAt: now });
  } else {
    await storage.createInsight({ ...data, tradesAffected: 0, createdAt: now, updatedAt: now });
  }
}
