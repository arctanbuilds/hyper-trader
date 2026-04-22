import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";

/* ───────────── helpers ───────────── */

function getNyParts(): { hour: number; minute: number; weekday: string; dateStr: string; timeStr: string } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    month: "long",
    day: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value || "";
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  return {
    hour, minute,
    weekday: get("weekday"),
    dateStr: `${get("month")} ${get("day")}`,
    timeStr: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function getPhase(hour: number, minute: number, weekday: string) {
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  if (!isWeekday) return { key: "weekend", label: "Weekend", next: "Monday 08:30 ET", active: -1 };
  const mins = hour * 60 + minute;
  if (mins < 8 * 60 + 30) return { key: "pre", label: "Pre-session", next: "News · 08:30 ET", active: 0 };
  if (mins < 8 * 60 + 45) return { key: "news", label: "News fetch", next: "Decision · 08:45 ET", active: 1 };
  if (mins < 9 * 60) return { key: "decision", label: "First decision", next: "Retry window · 09:00 ET", active: 2 };
  if (mins < 9 * 60 + 30) return { key: "retry", label: "Qualification retry", next: "Entry · 09:30 ET", active: 3 };
  if (mins < 10 * 60 + 45) return { key: "entry", label: "Entry window", next: "Cutoff · 10:45 ET", active: 4 };
  return { key: "closed", label: "Session closed", next: "Tomorrow 08:30 ET", active: 5 };
}

function fmtUsd0(v: number) {
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtSignedUsd(v: number) {
  const sign = v >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(v: number, digits = 2) {
  const sign = v >= 0 ? "+" : "−";
  return `${sign}${Math.abs(v).toFixed(digits)}%`;
}

/* ───────────── component ───────────── */

export default function Dashboard() {
  const { data: status } = useQuery<any>({
    queryKey: ["/api/status"],
    refetchInterval: 5000,
  });

  const { data: openTrades = [] } = useQuery<any[]>({
    queryKey: ["/api/trades", "open"],
    queryFn: () => apiRequest("GET", "/api/trades?status=open").then(r => r.json()),
    refetchInterval: 10000,
  });

  const { data: closedTrades = [] } = useQuery<any[]>({
    queryKey: ["/api/trades", "closed"],
    queryFn: () => apiRequest("GET", "/api/trades?status=closed").then(r => r.json()),
    refetchInterval: 15000,
  });

  const { data: equityCurve = [] } = useQuery<any[]>({
    queryKey: ["/api/equity-curve"],
    refetchInterval: 15000,
  });

  const { data: account } = useQuery<any>({
    queryKey: ["/api/account"],
    queryFn: () => apiRequest("GET", "/api/account").then(r => r.json()),
    refetchInterval: 30000,
  });

  const { data: strategyData } = useQuery<any>({
    queryKey: ["/api/strategies"],
    queryFn: () => apiRequest("GET", "/api/strategies").then(r => r.json()),
    refetchInterval: 15000,
  });

  const btcStrat = strategyData?.strategies?.find((s: any) => s.strategy === "btc_session");

  const ny = getNyParts();
  const phase = getPhase(ny.hour, ny.minute, ny.weekday);

  const accountBalance = account?.marginSummary?.accountValue
    ? parseFloat(account.marginSummary.accountValue)
    : parseFloat(status?.equity || "0");

  const combinedPnl = parseFloat(status?.combinedPnl || "0");
  const combinedPnlUsd = parseFloat(status?.combinedPnlUsd || "0");

  const sessionState: any = status?.sessionState || {};
  const decision = sessionState?.decision;
  const entryDone = sessionState?.entryDone;
  const sessionResult = sessionState?.sessionResult;
  const newsSummary = sessionState?.newsSummary;
  const retryCount: number = sessionState?.retryCount || 0;
  const retriesExhausted: boolean = !!sessionState?.retriesExhausted;

  const todayClosedTrades = (closedTrades || []).filter((t: any) => {
    if (!t.closedAt || t.strategy !== "btc_session") return false;
    const d = new Date(t.closedAt);
    const todayEt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "numeric" }).format(new Date());
    const tradeEt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "numeric" }).format(d);
    return todayEt === tradeEt;
  });

  const recentTrades = (closedTrades || [])
    .filter((t: any) => t.strategy === "btc_session")
    .sort((a: any, b: any) => (b.closedAt || "").localeCompare(a.closedAt || ""))
    .slice(0, 8);

  const equityChartData = (equityCurve || []).map((p: any) => {
    const d = new Date(p.timestamp);
    return {
      time: `${d.getMonth() + 1}/${d.getDate()}`,
      equity: p.equity,
      trade: p.trade,
      pnl: p.pnl,
    };
  });

  const greeting = ny.hour < 12 ? "Good morning" : ny.hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1180px] mx-auto px-10 py-10 space-y-10">

        {/* ──────── Hero headline ──────── */}
        <header className="space-y-3">
          <div className="flex items-start justify-between gap-8">
            <div className="space-y-2 flex-1">
              <p className="text-xs text-muted-foreground">{greeting}, Operator</p>
              <h1 className="display-serif text-[42px] md:text-[48px] leading-[1.05] max-w-[780px]">
                {phase.key === "weekend" ? (
                  <>Markets are closed. <span className="italic text-muted-foreground">The board rests.</span></>
                ) : !decision && phase.key === "pre" ? (
                  <>Today&apos;s session opens at <span className="italic">09:30 ET</span>.</>
                ) : !decision && (phase.key === "news" || phase.key === "decision") ? (
                  <>The committee is <span className="italic">deliberating</span>…</>
                ) : decision && !entryDone ? (
                  <>Today we&apos;re <span className="italic">{decision.direction?.toLowerCase()}</span> on Bitcoin.</>
                ) : entryDone && sessionResult === "tp" ? (
                  <>Target hit. <span className="italic text-[hsl(var(--positive))]">Re-entry open.</span></>
                ) : entryDone && sessionResult === "sl" ? (
                  <>Stop taken. <span className="italic text-muted-foreground">Session closed.</span></>
                ) : (
                  <>Your portfolio is <span className="italic">{combinedPnl >= 0 ? "up" : "down"} {Math.abs(combinedPnl).toFixed(2)}%</span> today.</>
                )}
              </h1>
              <p className="text-sm text-muted-foreground">
                {ny.weekday}, {ny.dateStr} · {ny.timeStr} ET · {phase.next}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0 pt-1">
              <Pill active={status?.isRunning}>{status?.isRunning ? "Live" : "Paused"}</Pill>
            </div>
          </div>
        </header>

        {/* ──────── KPI row ──────── */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <StatCard
            label="Account value"
            value={fmtUsd0(accountBalance)}
            subline={status?.openPositions > 0 ? `${status.openPositions} position open` : "No open position"}
          />
          <StatCard
            label="Total ROI · AUM"
            value={fmtPct(combinedPnl)}
            valueClass={combinedPnl >= 0 ? "text-[hsl(var(--positive))]" : "text-[hsl(var(--negative))]"}
            subline={fmtSignedUsd(combinedPnlUsd)}
            sublineClass={combinedPnlUsd >= 0 ? "text-[hsl(var(--positive))]" : "text-[hsl(var(--negative))]"}
          />
          <StatCard
            label="Win rate · 30 days"
            value={`${status?.winRate || "0.0"}%`}
            subline={`${status?.closedTrades || 0} closed · today ${todayClosedTrades.length}`}
          />
        </section>

        {/* ──────── Session briefing (hero card) ──────── */}
        <section className="rounded-[14px] bg-card border border-card-border shadow-[var(--shadow-sm)] overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-[1.15fr_1fr]">
            {/* Left: Today's session */}
            <div className="p-8 space-y-6 border-b lg:border-b-0 lg:border-r border-card-border">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="label-mono mb-2">Today&apos;s session</p>
                  <h2 className="font-serif text-[22px] tracking-tight leading-tight">
                    {ny.weekday}, {ny.dateStr}
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  {retryCount > 0 && !entryDone && !retriesExhausted && (
                    <Pill tone="neutral">Retry {retryCount}/8</Pill>
                  )}
                  <Pill tone={phase.key === "entry" ? "positive" : phase.key === "closed" ? "muted" : "neutral"}>
                    {phase.label}
                  </Pill>
                </div>
              </div>

              {/* Timeline */}
              <Timeline activeIdx={phase.active} />

              {/* Result / state */}
              <div className="pt-2 border-t border-dashed border-border text-[13px] leading-relaxed">
                {phase.key === "weekend" && (
                  <p className="text-muted-foreground">The bot idles through the weekend. The next news fetch runs Monday at 08:30 ET.</p>
                )}
                {phase.key === "pre" && (
                  <p className="text-muted-foreground">Standing by for the 08:30 ET news sweep. Sonar will pull overnight macro and crypto headlines first.</p>
                )}
                {phase.key === "news" && (
                  <p className="text-muted-foreground">Fetching overnight news via Perplexity Sonar. The decision engine fires at 08:45 ET.</p>
                )}
                {phase.key === "decision" && !decision && (
                  <p className="text-muted-foreground">Claude Opus 4.7 is reading the tape and composing today&apos;s trade thesis.</p>
                )}
                {phase.key === "retry" && !decision && (
                  <p className="text-muted-foreground">Qualification gate didn&apos;t pass. Retrying every 15 minutes with fresh news and a fresh decision until 10:45 ET.</p>
                )}
                {phase.key === "retry" && decision && !entryDone && (
                  <p className="text-muted-foreground">Setup qualified. Waiting for the 09:30 ET NY open to enter.</p>
                )}
                {phase.key === "entry" && !entryDone && (
                  <p className="text-muted-foreground">Entry window is live. Limit rests for one minute, then promotes to market if unfilled. Cutoff is 10:45 ET.</p>
                )}
                {entryDone && sessionResult === "tp" && (
                  <p className="text-[hsl(var(--positive))]">Take-profit captured. Re-entry is permitted within this session window.</p>
                )}
                {entryDone && sessionResult === "sl" && (
                  <p className="text-muted-foreground">Stop triggered. This setup is retired for the day — no retries.</p>
                )}
                {phase.key === "closed" && !entryDone && (
                  <p className="text-muted-foreground">Session closed without a qualifying setup. We pass on the day.</p>
                )}
              </div>
            </div>

            {/* Right: Opus 4.7 thesis */}
            <div className="p-8 bg-panel-soft/40 space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="label-mono mb-2">The thesis</p>
                  <h3 className="font-serif text-[18px] tracking-tight">Claude Opus 4.7</h3>
                </div>
                {decision?.direction && (
                  <Pill tone={decision.direction === "LONG" ? "positive" : decision.direction === "SHORT" ? "negative" : "muted"}>
                    {decision.direction}
                  </Pill>
                )}
              </div>

              {decision ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-4 pb-4 border-b border-dashed border-border">
                    <MiniStat label="Entry" value={decision.entryPrice ? `$${Number(decision.entryPrice).toLocaleString()}` : "—"} />
                    <MiniStat label="Confidence" value={`${decision.confidence || 0}/10`} tone={(decision.confidence || 0) >= 7 ? "positive" : "muted"} />
                    <MiniStat label="Timing" value="NY Open" />
                  </div>

                  {decision.thesis && (
                    <div className="space-y-1.5">
                      <p className="label-mono">Read</p>
                      <p className="text-[13px] leading-relaxed text-foreground/85">{decision.thesis}</p>
                    </div>
                  )}

                  {decision.reasoning && (
                    <div className="space-y-1.5">
                      <p className="label-mono">Rationale</p>
                      <p className="text-[13px] leading-relaxed text-muted-foreground">{decision.reasoning}</p>
                    </div>
                  )}

                  {newsSummary && (
                    <div className="space-y-1.5 pt-3 border-t border-dashed border-border">
                      <p className="label-mono">Overnight brief · Sonar</p>
                      <p className="text-[12px] leading-relaxed text-muted-foreground line-clamp-3">{newsSummary}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="py-8 flex flex-col items-center justify-center text-center gap-2">
                  <div className="w-10 h-10 rounded-full border border-dashed border-border flex items-center justify-center">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-muted-foreground">
                      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.2" />
                      <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                  </div>
                  <p className="text-[13px] text-muted-foreground">No thesis yet — runs at 08:45 ET.</p>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ──────── Equity curve + Strategy snapshot ──────── */}
        <section className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-5">
          {/* Equity */}
          <div className="rounded-[14px] bg-card border border-card-border shadow-[var(--shadow-sm)] p-6">
            <div className="flex items-start justify-between mb-5">
              <div>
                <p className="label-mono mb-1">Equity</p>
                <h3 className="numeric-display text-[32px]">{fmtUsd0(accountBalance)}</h3>
                <p className={cn(
                  "text-[12px] mt-1 font-mono",
                  combinedPnlUsd >= 0 ? "text-[hsl(var(--positive))]" : "text-[hsl(var(--negative))]"
                )}>
                  {fmtSignedUsd(combinedPnlUsd)} · {fmtPct(combinedPnl)} since inception
                </p>
              </div>
            </div>
            <div className="h-[220px]">
              {equityChartData.length > 1 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={equityChartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(142 30% 38%)" stopOpacity={0.22} />
                        <stop offset="100%" stopColor="hsl(142 30% 38%)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))", fontFamily: "var(--font-mono)" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      hide
                      domain={["dataMin - 10", "dataMax + 10"]}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                        fontSize: 12,
                        fontFamily: "var(--font-mono)",
                        boxShadow: "0 4px 10px -2px hsl(30 15% 12% / 0.1)",
                      }}
                      formatter={(v: number) => [fmtUsd0(v), "Equity"]}
                    />
                    <Area
                      type="monotone"
                      dataKey="equity"
                      stroke="hsl(142 30% 38%)"
                      strokeWidth={1.75}
                      fill="url(#eqGrad)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center gap-1">
                  <p className="font-serif italic text-[15px] text-muted-foreground">A fresh page.</p>
                  <p className="text-[12px] text-muted-foreground">Equity curve builds trade by trade.</p>
                </div>
              )}
            </div>
          </div>

          {/* Strategy snapshot */}
          <div className="rounded-[14px] bg-card border border-card-border shadow-[var(--shadow-sm)] p-6 space-y-5">
            <div>
              <p className="label-mono mb-1">Strategy</p>
              <h3 className="font-serif text-[18px] tracking-tight">BTC · NY Open Session</h3>
              <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
                One disciplined session per weekday. Sonar reads the tape. Opus decides.
                80% AUM, 20× leverage, ±1% bracket, break-even lock at +0.5%.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-dashed border-border">
              <MiniStat label="Trades" value={`${btcStrat?.totalTrades || 0}`} />
              <MiniStat label="Win rate" value={`${btcStrat?.winRate || 0}%`} />
              <MiniStat
                label="Realized P&L"
                value={(btcStrat?.totalPnlUsd || 0) >= 0 ? `+$${(btcStrat?.totalPnlUsd || 0).toFixed(2)}` : `−$${Math.abs(btcStrat?.totalPnlUsd || 0).toFixed(2)}`}
                tone={(btcStrat?.totalPnlUsd || 0) >= 0 ? "positive" : (btcStrat?.totalPnlUsd || 0) < 0 ? "negative" : "muted"}
              />
              <MiniStat label="Avg · trade" value={(btcStrat?.avgPnlPerTrade || 0) >= 0 ? `+$${(btcStrat?.avgPnlPerTrade || 0).toFixed(2)}` : `−$${Math.abs(btcStrat?.avgPnlPerTrade || 0).toFixed(2)}`} />
            </div>
          </div>
        </section>

        {/* ──────── Open position ──────── */}
        {openTrades.length > 0 && (
          <section className="rounded-[14px] bg-card border border-card-border shadow-[var(--shadow-sm)] p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="label-mono mb-1">Open position</p>
                <h3 className="font-serif text-[18px] tracking-tight">Live on Hyperliquid</h3>
              </div>
            </div>
            <div className="space-y-2">
              {openTrades.map((t: any) => {
                const isLong = t.side === "long";
                return (
                  <div key={t.id} className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-4 py-3 border-b border-dashed border-border last:border-b-0">
                    <span className={cn(
                      "font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded",
                      isLong ? "bg-positive-soft text-[hsl(var(--positive))]" : "bg-negative-soft text-[hsl(var(--negative))]"
                    )}>
                      {isLong ? "Long" : "Short"}
                    </span>
                    <div>
                      <div className="font-serif text-[15px]">{t.coin}</div>
                      <div className="text-[11px] text-muted-foreground font-mono">
                        {t.leverage}× · entry ${t.entryPrice?.toFixed(t.entryPrice < 10 ? 4 : 2)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={cn(
                        "numeric-mono text-[14px] font-medium",
                        (t.pnlUsd || 0) >= 0 ? "text-[hsl(var(--positive))]" : "text-[hsl(var(--negative))]"
                      )}>
                        {fmtSignedUsd(t.pnlUsd || 0)}
                      </div>
                      <div className={cn(
                        "text-[11px] font-mono",
                        (t.pnlOfAum || 0) >= 0 ? "text-[hsl(var(--positive))]" : "text-[hsl(var(--negative))]"
                      )}>
                        {fmtPct(t.pnlOfAum || 0, 3)} AUM
                      </div>
                    </div>
                    <div className="text-right text-[11px] text-muted-foreground font-mono min-w-[80px]">
                      {t.stopLoss > 0 && t.entryPrice > 0 && (
                        isLong ? t.stopLoss >= t.entryPrice * 1.001 : t.stopLoss <= t.entryPrice * 0.999
                      ) ? (
                        <span className="text-[hsl(var(--positive))]">BE+ locked</span>
                      ) : (
                        <span>SL ${t.stopLoss?.toFixed(t.stopLoss < 10 ? 4 : 2)}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ──────── Recent activity ──────── */}
        <section className="pb-12">
          <div className="flex items-center justify-between mb-5">
            <div>
              <p className="label-mono mb-1">Activity</p>
              <h3 className="font-serif text-[18px] tracking-tight">Recent sessions</h3>
            </div>
            <span className="text-[11px] text-muted-foreground font-mono">
              {recentTrades.length} of {closedTrades.length}
            </span>
          </div>

          {recentTrades.length > 0 ? (
            <div className="space-y-0">
              {recentTrades.map((t: any) => {
                const net = t.hlPnlUsd ?? 0;
                const d = t.closedAt ? new Date(t.closedAt) : null;
                const dateStr = d ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit" }).format(d) : "—";
                const timeStr = d ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(d) : "";
                const isLong = t.side === "long";
                const reason = (t.closeReason || "")
                  .replace(/\[(SESSION|BTC)\]\s*/g, "")
                  .replace(/\s*\|\s*HL P&L.*$/g, "")
                  .replace(/Position closed on HL \(sync\)\s*\|?\s*/g, "Sync")
                  .replace(/P&L:.*$/g, "")
                  .trim() || "—";
                return (
                  <div key={t.id} className="grid grid-cols-[70px_auto_1fr_auto] items-center gap-4 py-3 border-b border-dashed border-border hover:bg-panel-soft/30 -mx-2 px-2 rounded-md transition-colors">
                    <span className="font-mono text-[11px] text-muted-foreground tracking-wide">{timeStr || dateStr}</span>
                    <span className={cn(
                      "font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded",
                      isLong ? "bg-positive-soft text-[hsl(var(--positive))]" : "bg-negative-soft text-[hsl(var(--negative))]"
                    )}>
                      {isLong ? "Long" : "Short"}
                    </span>
                    <div className="min-w-0">
                      <div className="font-serif text-[14px]">{t.coin}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{reason}</div>
                    </div>
                    <div className={cn(
                      "numeric-mono text-[13px] text-right",
                      net >= 0 ? "text-[hsl(var(--positive))]" : "text-[hsl(var(--negative))]"
                    )}>
                      {fmtSignedUsd(net)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-10 text-center">
              <p className="font-serif italic text-[15px] text-muted-foreground">No sessions recorded yet.</p>
              <p className="text-[12px] text-muted-foreground mt-1">Your first trade will appear here once it closes.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/* ───────────── sub-components ───────────── */

function StatCard({
  label, value, subline, valueClass, sublineClass,
}: {
  label: string; value: string; subline?: string;
  valueClass?: string; sublineClass?: string;
}) {
  return (
    <div className="rounded-[14px] bg-card border border-card-border shadow-[var(--shadow-sm)] px-6 py-5">
      <p className="label-mono mb-2">{label}</p>
      <div className={cn("numeric-display text-[26px] leading-none", valueClass)}>{value}</div>
      {subline && (
        <p className={cn("text-[11px] mt-2 font-mono text-muted-foreground", sublineClass)}>{subline}</p>
      )}
    </div>
  );
}

function MiniStat({
  label, value, tone,
}: {
  label: string; value: string; tone?: "positive" | "negative" | "muted";
}) {
  const cls = tone === "positive" ? "text-[hsl(var(--positive))]"
            : tone === "negative" ? "text-[hsl(var(--negative))]"
            : "";
  return (
    <div>
      <p className="label-mono mb-1">{label}</p>
      <p className={cn("numeric-mono text-[14px] font-medium", cls)}>{value}</p>
    </div>
  );
}

function Pill({
  children, tone, active,
}: {
  children: React.ReactNode;
  tone?: "positive" | "negative" | "muted" | "neutral";
  active?: boolean;
}) {
  const cls =
    tone === "positive" ? "bg-positive-soft text-[hsl(var(--positive))] border-[hsl(var(--positive)/0.25)]"
    : tone === "negative" ? "bg-negative-soft text-[hsl(var(--negative))] border-[hsl(var(--negative)/0.25)]"
    : tone === "muted" ? "bg-muted text-muted-foreground border-border"
    : active !== undefined
      ? (active ? "bg-positive-soft text-[hsl(var(--positive))] border-[hsl(var(--positive)/0.25)]" : "bg-muted text-muted-foreground border-border")
      : "bg-panel-soft text-foreground/80 border-border";
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 text-[10px] font-mono tracking-wider uppercase px-2.5 py-1 rounded-full border",
      cls,
    )}>
      {active !== undefined && (
        <span className={cn("w-1 h-1 rounded-full", active ? "bg-[hsl(var(--positive))] animate-pulse" : "bg-muted-foreground/50")} />
      )}
      {children}
    </span>
  );
}

function Timeline({ activeIdx }: { activeIdx: number }) {
  const steps = [
    { time: "08:30", label: "News" },
    { time: "08:45", label: "Decision" },
    { time: "09:00", label: "Retry" },
    { time: "09:30", label: "Entry" },
    { time: "10:45", label: "Cutoff" },
  ];
  return (
    <div className="relative flex items-center justify-between pt-2">
      {/* Line */}
      <div className="absolute left-[6px] right-[6px] top-[14px] h-px bg-border" aria-hidden />
      {steps.map((s, i) => {
        const done = activeIdx > i;
        const current = activeIdx === i;
        return (
          <div key={s.label} className="relative flex flex-col items-center gap-1.5 z-10 bg-card px-2">
            <div className={cn(
              "w-3 h-3 rounded-full border-2 transition-colors",
              done ? "bg-[hsl(var(--positive))] border-[hsl(var(--positive))]"
                : current ? "bg-background border-[hsl(var(--positive))]"
                : "bg-background border-border"
            )}>
              {done && (
                <svg viewBox="0 0 12 12" className="w-full h-full text-primary-foreground">
                  <path d="M3 6l2 2 4-4" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
            <div className="text-center">
              <div className={cn(
                "font-mono text-[10px] tracking-wider",
                current ? "text-foreground font-medium" : done ? "text-[hsl(var(--positive))]" : "text-muted-foreground"
              )}>{s.time}</div>
              <div className={cn(
                "text-[10px] mt-0.5",
                current ? "text-foreground font-medium" : "text-muted-foreground"
              )}>{s.label}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
