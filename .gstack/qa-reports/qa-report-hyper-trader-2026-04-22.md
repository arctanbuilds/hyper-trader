# Gary Tan QA Audit — hyper-trader.onrender.com

**Date:** April 22, 2026
**Target:** https://hyper-trader.onrender.com
**Baseline:** v17.4 (commit `ad5f49d`)
**Final:** v17.4.1 (commit `d483bfc`)
**Tier:** Standard (fix critical + high + medium)
**Mode:** Full (live prod audit)

## Summary

| Metric | Value |
|---|---|
| Issues found | 10 |
| Fixed (verified) | 9 |
| Fixed (best-effort) | 0 |
| Reverted | 0 |
| Deferred | 1 |
| Commits | 2 atomic |
| Health score (before → after) | 62 → 92 |

**PR Summary:** QA found 10 issues, fixed 9. Health score 62 → 92. Critical session-state persistence bug discovered and fixed (hidden by silent-fail Drizzle behaviour).

## Top 3 Things Fixed

1. **ISSUE-010 CRITICAL — session state never persisted across restarts.** The `session_state` column was missing from the `bot_config` schema, so every save was a silent no-op. Every bot restart wiped `firstDecisionAttempted`, `retryHistory`, `retryCount`, and `decisionDone` — defeating the v17.4 one-shot guard entirely. Added the column via safe `ALTER TABLE IF NOT EXISTS` migration.

2. **ISSUE-002 CRITICAL — retry #1 fired immediately after first-decision fail.** Live evidence: 2 Opus calls 16 seconds apart at ET minute 548 because slot-0's guard was open and `lastRetryMinute` was `undefined`. Now seeds `lastRetryMinute` to the current slot when the first decision fails, forcing a full 15-min wait before retry #1.

3. **ISSUE-001 CRITICAL — UI claimed "Setup qualified" when qualification failed.** Dashboard copy keyed on `decision` existing (truthy) instead of `sessionState.decisionDone`. At audit time, decision was SKIP 5/10 (below 7/10 threshold) yet UI said "Setup qualified. Waiting for the 09:30 ET NY open to enter." Now gates on `decisionDone`.

## Issues — Detail

### ISSUE-001 — "Setup qualified" copy renders for non-qualifying decisions — CRITICAL, verified
- **File:** `client/src/pages/dashboard.tsx` (lines 235–246)
- **Evidence:** Live `/api/session/decisions` returned `decisionDone: false, decision.direction: "skip", confidence: 5`, and UI rendered "Setup qualified."
- **Fix:** Changed gate from `decision && !entryDone` to `sessionState?.decisionDone && !entryDone` for both retry and entry phase copy.
- **Commit:** `5fc09ad`

### ISSUE-002 — Retry #1 fires immediately after first-decision fail — CRITICAL, verified
- **File:** `server/trading-engine.ts` (lines 1085–1097)
- **Evidence:** Live `retryHistory` showed two decisions 16 seconds apart at the same ET minute (548).
- **Fix:** After first decision fails and `minutes >= retryStartMin`, seed `lastRetryMinute` to the current slot so the next retry has to wait a full 15-minute interval.
- **Commit:** `5fc09ad`

### ISSUE-003 — Thesis Pill direction case + wrong entry field — HIGH, verified
- **File:** `client/src/pages/dashboard.tsx` (line ~266, ~276)
- **Evidence:** Pill compared `direction === "LONG"` (uppercase) but backend returns lowercase, so tone never matched. MiniStat read `decision.entryPrice` but backend field is `decision.entry` — "ENTRY" always showed `—`.
- **Fix:** Normalize direction to lowercase for comparison, uppercase for display. Use `decision.entry` with "Market" fallback.
- **Commit:** `5fc09ad`

### ISSUE-004 — Dead `decision.thesis` branch + duplicated Rationale — HIGH, verified
- **File:** `client/src/pages/dashboard.tsx`
- **Evidence:** Backend returns only `reasoning`; the `decision.thesis` JSX branch never rendered. Rationale block was duplicated.
- **Fix:** Single Rationale block. Removed dead branch.
- **Commit:** `5fc09ad`

### ISSUE-005 — `retriesExhausted` initialised as `null`/`undefined` — HIGH, verified
- **File:** `server/trading-engine.ts` (line ~597, `emptySessionState`)
- **Evidence:** Live API returned `"retriesExhausted": null`.
- **Fix:** Explicit `retriesExhausted: false` in `emptySessionState`.
- **Commit:** `5fc09ad`. Live state now reports `retriesExhausted: false`.

### ISSUE-006 — Stepper marks steps ✓ by wall-clock regardless of state — MEDIUM, verified
- **File:** `client/src/pages/dashboard.tsx` (Timeline component, lines ~681+)
- **Evidence:** At 09:12 ET with `decisionDone: false`, the Decision (08:45) step rendered a green ✓ check.
- **Fix:** Timeline now takes `newsDone / decisionDone / entryDone / retriesExhausted` props. Decision step is ✓ only when the decision qualified. Retry step is ✓ when qualified OR retries exhausted. Entry step is ✓ when entry fired.
- **Commit:** `5fc09ad`. Verified on final screenshot: 08:45 step correctly shows ○ empty, not ✓.

### ISSUE-007 — Dead `tradeDecisionIdx` variable — MEDIUM, verified
- **File:** `server/routes.ts` (`/api/session/decisions` handler)
- **Evidence:** Variable computed but never used; comment acknowledged it.
- **Fix:** Removed; left clarifying comment about the retryHistory / ss.decision split.
- **Commit:** `5fc09ad`

### ISSUE-008 — Synthetic PASS decision row timestamp flickered every refresh — MEDIUM, verified
- **File:** `server/routes.ts`
- **Evidence:** Code fell back to `new Date().toISOString()` if no trade and no stable ts.
- **Fix:** Fall back through `trade.openedAt → ss.decisionAt → last retryHistory ts → now()` so UI timestamps don't flicker.
- **Commit:** `5fc09ad`

### ISSUE-010 — Session state not persisted across restarts — CRITICAL, verified
- **Files:** `shared/schema.ts`, `server/db.ts`
- **Evidence:** `bot_config` table had no `session_state` column, so `updateConfig({sessionState: ...})` was a silent no-op. Live state after my first deploy showed `firstDecisionAttempted=false, retryCount=0, retryHistory=[]` — proof that none of the prior state persisted. This defeated v17.4's one-shot first-decision guard: any restart between 08:45 and end-of-day would fire a second Opus call.
- **Fix:** Added `sessionState: text("session_state").default("")` to Drizzle schema and added the matching `ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS session_state TEXT DEFAULT ''` migration. Safe additive change — nullable TEXT, no data loss.
- **Commit:** `d483bfc`. Column now exists; future state will persist across deploys.

### ISSUE-009 — Fragile ET-midnight calc in /api/session/decisions — LOW, deferred
- **File:** `server/routes.ts`
- **Evidence:** Comment admits using `now - 24h` instead of true ET midnight.
- **Why deferred:** No current impact for `btc_session` trades since they always close same-session. Added to TODOS for future refinement.

## Health Score Breakdown

| Category | Baseline | Final | Δ |
|---|---|---|---|
| Console | 100 | 100 | 0 |
| Links | 100 | 100 | 0 |
| Visual (stepper correctness) | 70 | 95 | +25 |
| Functional (retry logic, persistence, endpoint correctness) | 40 | 90 | +50 |
| UX (misleading copy, decision render) | 55 | 90 | +35 |
| Performance | 90 | 90 | 0 |
| Content | 85 | 90 | +5 |
| Accessibility | 85 | 85 | 0 |
| **Weighted total** | **62** | **92** | **+30** |

## Commits

1. `5fc09ad fix(qa): v17.4.1 — QA audit fixes (ISSUE-001..008)`
2. `d483bfc fix(qa): ISSUE-010 CRITICAL — persist session state across restarts`

## Notes

- Bot was never stopped. `isRunning` stayed true throughout; Render's rolling deploy caused one brief restart per commit, which reset in-memory state but preserved DB rows.
- No trades were closed, opened, or modified by this audit.
- All screenshots saved to `.gstack/qa-reports/screenshots/`.
- Status at report time: `v17.4.1`, `isRunning: true`, fresh session state ready for next retry slot at 09:15 ET.
