import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  TrendingUp, TrendingDown, DollarSign, Target,
  BarChart3, Activity, RefreshCw, ArrowUpRight, ArrowDownRight, Wallet,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  LineChart, Line, Legend,
} from "recharts";

function getSessionInfo(): { session: string; color: string } {
  const now = new Date();
  const utcHour = now.getUTCHours();
  if (utcHour >= 13 && utcHour < 16) return { session: "London/NY Overlap", color: "text-emerald-400" };
  if (utcHour >= 7 && utcHour < 16) return { session: "London Session", color: "text-blue-400" };
  if (utcHour >= 13 && utcHour < 21) return { session: "New York Session", color: "text-yellow-400" };
  if (utcHour >= 23 || utcHour < 8) return { session: "Asia Session", color: "text-purple-400" };
  return { session: "Off-Session", color: "text-muted-foreground" };
}

export default function Dashboard() {
  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ["/api/status"],
    refetchInterval: 5000,
  });

  const { data: openTrades = [] } = useQuery({
    queryKey: ["/api/trades", "open"],
    queryFn: () => apiRequest("GET", "/api/trades?status=open").then(r => r.json()),
    refetchInterval: 10000,
  });

  const { data: closedTrades = [] } = useQuery({
    queryKey: ["/api/trades", "closed"],
    queryFn: () => apiRequest("GET", "/api/trades?status=closed").then(r => r.json()),
    refetchInterval: 15000,
  });

  const { data: pnlData = [] } = useQuery({
    queryKey: ["/api/pnl"],
    queryFn: () => apiRequest("GET", "/api/pnl").then(r => r.json()),
    refetchInterval: 30000,
  });

  const { data: equityCurve = [] } = useQuery<any[]>({
    queryKey: ["/api/equity-curve"],
    refetchInterval: 15000,
  });

  const { data: account } = useQuery({
    queryKey: ["/api/account"],
    queryFn: () => apiRequest("GET", "/api/account").then(r => r.json()),
    refetchInterval: 30000,
  });

  const { data: logs = [] } = useQuery({
    queryKey: ["/api/logs"],
    queryFn: () => apiRequest("GET", "/api/logs?limit=10").then(r => r.json()),
    refetchInterval: 10000,
  });

  const { data: strategyData } = useQuery<{ raceStartedAt: string; raceHours: number; strategies: any[] }>({
    queryKey: ["/api/strategies"],
    queryFn: () => apiRequest("GET", "/api/strategies").then(r => r.json()),
    refetchInterval: 15000,
  });
  const degenStrategy = strategyData?.strategies?.[0];
  const raceHours = strategyData?.raceHours || 0;

  const triggerScan = useMutation({
    mutationFn: () => apiRequest("POST", "/api/bot/scan"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/scans"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
    },
  });

  const combinedPnl = parseFloat(status?.combinedPnl || "0");
  const combinedPnlUsd = parseFloat(status?.combinedPnlUsd || "0");
  const totalPnlUsd = parseFloat(status?.totalPnlUsd || "0");
  const openPnlUsd = parseFloat(status?.openPnlUsd || "0");
  const accountBalance = account?.marginSummary?.accountValue
    ? parseFloat(account.marginSummary.accountValue)
    : 0;

  const fmtUsd = (v: number) => {
    const sign = v >= 0 ? "+" : "";
    return `${sign}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
  };

  // Equity curve from actual trade P&L (ground truth)
  const equityChartData = (equityCurve || []).map((p: any) => {
    const d = new Date(p.timestamp);
    return {
      time: `${d.getMonth()+1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      equity: p.equity,
      trade: p.trade,
      pnl: p.pnl,
    };
  });

  // DEGEN_RSI P&L line chart
  const degenChartData = (degenStrategy?.cumPnlSeries || []).map((p: any) => {
    const d = new Date(p.timestamp);
    return {
      time: `${d.getMonth()+1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      pnl: p.cumPnl,
      tradeNum: p.tradeNum,
    };
  });

  const sessionInfo = getSessionInfo();
  const raceDays = raceHours >= 24 ? `${(raceHours / 24).toFixed(1)}d` : `${raceHours.toFixed(1)}h`;

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Dashboard</h2>
          <div className="flex items-center gap-3 mt-0.5">
            <p className="text-sm text-muted-foreground">v14.0 DEGEN_RSI — Real-time overview</p>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-1">
              <Clock className="w-3 h-3" />
              <span className={sessionInfo.color}>{sessionInfo.session}</span>
            </Badge>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => triggerScan.mutate()}
          disabled={triggerScan.isPending}
          data-testid="button-trigger-scan"
        >
          <RefreshCw className={cn("w-3.5 h-3.5 mr-1.5", triggerScan.isPending && "animate-spin")} />
          {triggerScan.isPending ? "Scanning..." : "Force Scan"}
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground font-medium">Account Balance</span>
              <Wallet className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="text-lg font-semibold font-mono" data-testid="text-balance">
              ${accountBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {account?.connected ? "Connected" : "Not connected"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground font-medium">Total ROI / AUM</span>
              {combinedPnl >= 0 ? (
                <TrendingUp className="w-4 h-4 text-emerald-500" />
              ) : (
                <TrendingDown className="w-4 h-4 text-red-500" />
              )}
            </div>
            <div className={cn(
              "text-lg font-semibold font-mono",
              combinedPnl >= 0 ? "text-emerald-500" : "text-red-500"
            )} data-testid="text-total-pnl">
              {combinedPnl >= 0 ? "+" : ""}{combinedPnl.toFixed(2)}%
            </div>
            <p className={cn(
              "text-[11px] font-mono mt-0.5",
              combinedPnlUsd >= 0 ? "text-emerald-400/70" : "text-red-400/70"
            )}>
              {fmtUsd(combinedPnlUsd)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground font-medium">Open Positions</span>
              <Activity className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="text-lg font-semibold font-mono" data-testid="text-open-positions">
              {status?.openPositions || 0} / 1
            </div>
            <p className={cn(
              "text-[10px] font-mono mt-1",
              parseFloat(status?.openPnl || "0") >= 0 ? "text-emerald-400/70" : "text-red-400/70"
            )}>
              {parseFloat(status?.openPnl || "0") >= 0 ? "+" : ""}{status?.openPnl || "0.00"}% ({fmtUsd(openPnlUsd)})
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground font-medium">Win Rate / Trades</span>
              <Target className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="text-lg font-semibold font-mono" data-testid="text-win-rate">
              {status?.winRate || "0.0"}%
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {status?.closedTrades || 0} closed | Today: {status?.dailyTradeCount || 0}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ========== DEGEN RSI v14.0 Strategy Card ========== */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm font-medium">DEGEN RSI — v14.0</CardTitle>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                BTC only | LONG | RSI ≤25 (5m+15m) | 90% equity | 40x | SL -0.5% | TP +0.43% | BE @ +0.25% | {raceDays} running
              </p>
            </div>
            <Badge variant="outline" className="text-[10px] px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
              Active
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <div className="p-2.5 rounded bg-emerald-500/5 border border-emerald-500/20">
              <div className="text-[10px] text-muted-foreground mb-1">Trades</div>
              <div className="text-base font-semibold font-mono text-emerald-400">
                {degenStrategy?.totalTrades || 0}
              </div>
              <div className="text-[9px] text-muted-foreground">{degenStrategy?.wins || 0}W / {degenStrategy?.losses || 0}L</div>
            </div>
            <div className="p-2.5 rounded bg-emerald-500/5 border border-emerald-500/20">
              <div className="text-[10px] text-muted-foreground mb-1">Win Rate</div>
              <div className="text-base font-semibold font-mono text-emerald-400">
                {degenStrategy?.winRate || 0}%
              </div>
              <div className="text-[9px] text-muted-foreground">Streak: {degenStrategy?.bestWinStreak || 0}W / {degenStrategy?.worstLossStreak || 0}L</div>
            </div>
            <div className="p-2.5 rounded bg-emerald-500/5 border border-emerald-500/20">
              <div className="text-[10px] text-muted-foreground mb-1">Total P&L</div>
              <div className={cn(
                "text-base font-semibold font-mono",
                (degenStrategy?.totalPnlUsd || 0) >= 0 ? "text-emerald-400" : "text-red-400"
              )}>
                {(degenStrategy?.totalPnlUsd || 0) >= 0 ? "+" : ""}${(degenStrategy?.totalPnlUsd || 0).toFixed(2)}
              </div>
              <div className="text-[9px] text-muted-foreground">
                {(degenStrategy?.totalPnlPct || 0) >= 0 ? "+" : ""}{(degenStrategy?.totalPnlPct || 0).toFixed(2)}% AUM
              </div>
            </div>
            <div className="p-2.5 rounded bg-emerald-500/5 border border-emerald-500/20">
              <div className="text-[10px] text-muted-foreground mb-1">Avg / Trade</div>
              <div className={cn(
                "text-base font-semibold font-mono",
                (degenStrategy?.avgPnlPerTrade || 0) >= 0 ? "text-emerald-400" : "text-red-400"
              )}>
                {(degenStrategy?.avgPnlPerTrade || 0) >= 0 ? "+" : ""}${(degenStrategy?.avgPnlPerTrade || 0).toFixed(2)}
              </div>
              <div className="text-[9px] text-muted-foreground">
                Best: +${(degenStrategy?.bestTradeUsd || 0).toFixed(2)} | Worst: ${(degenStrategy?.worstTradeUsd || 0).toFixed(2)}
              </div>
            </div>
          </div>

          {/* Additional stats row */}
          <div className="grid grid-cols-3 gap-2 mb-4">
            <div className="p-2 rounded bg-muted/30 border border-border/50 text-center">
              <div className="text-[9px] text-muted-foreground mb-0.5">Max Drawdown</div>
              <div className="text-xs font-mono text-red-400">-${(degenStrategy?.maxDrawdownUsd || 0).toFixed(2)}</div>
            </div>
            <div className="p-2 rounded bg-muted/30 border border-border/50 text-center">
              <div className="text-[9px] text-muted-foreground mb-0.5">Profit Factor</div>
              <div className="text-xs font-mono">
                {(degenStrategy?.profitFactor || 0) >= 999 ? "∞" : (degenStrategy?.profitFactor || 0).toFixed(2)}
              </div>
            </div>
            <div className="p-2 rounded bg-muted/30 border border-border/50 text-center">
              <div className="text-[9px] text-muted-foreground mb-0.5">Open Positions</div>
              <div className="text-xs font-mono text-emerald-400">{degenStrategy?.openPositions || 0} / 1</div>
            </div>
          </div>

          {/* DEGEN_RSI Cumulative P&L chart */}
          {degenChartData.length > 1 ? (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={degenChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 15%, 15%)" />
                <XAxis dataKey="time" tick={{ fontSize: 9 }} stroke="hsl(220, 10%, 40%)" />
                <YAxis
                  tick={{ fontSize: 10 }} stroke="hsl(220, 10%, 40%)"
                  tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                />
                <Tooltip
                  contentStyle={{
                    background: "hsl(225, 18%, 10%)",
                    border: "1px solid hsl(220, 15%, 15%)",
                    borderRadius: "6px",
                    fontSize: "11px",
                  }}
                  formatter={(value: number) => [
                    `${value >= 0 ? "+" : ""}$${value.toFixed(2)}`, "Cumulative P&L"
                  ]}
                  labelFormatter={(label: string, payload: any[]) => {
                    const item = payload?.[0]?.payload;
                    return item ? `Trade #${item.tradeNum} — ${label}` : label;
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="pnl"
                  stroke="hsl(145, 65%, 50%)"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "hsl(145, 65%, 50%)", stroke: "hsl(225, 18%, 10%)", strokeWidth: 1 }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[180px] flex items-center justify-center text-sm text-muted-foreground">
              P&L chart builds as trades close
            </div>
          )}
        </CardContent>
      </Card>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-1 gap-4">
        {/* Equity Curve */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Equity Curve</CardTitle>
            <p className="text-[10px] text-muted-foreground">Starting from ${parseFloat(status?.startingEquity || "658").toFixed(2)} USDC baseline (v14.0)</p>
          </CardHeader>
          <CardContent>
            {equityChartData.length > 1 ? (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={equityChartData}>
                  <defs>
                    <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(142, 70%, 45%)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(142, 70%, 45%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 15%, 15%)" />
                  <XAxis dataKey="time" tick={{ fontSize: 9 }} stroke="hsl(220, 10%, 40%)" />
                  <YAxis
                    tick={{ fontSize: 10 }} stroke="hsl(220, 10%, 40%)"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                    padding={{ top: 10, bottom: 10 }}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(225, 18%, 10%)",
                      border: "1px solid hsl(220, 15%, 15%)",
                      borderRadius: "6px",
                      fontSize: "12px",
                    }}
                    formatter={(value: number, name: string) => [
                      `$${value.toFixed(2)}`, name === "equity" ? "Equity" : name
                    ]}
                    labelFormatter={(label: string, payload: any[]) => {
                      const item = payload?.[0]?.payload;
                      if (item?.trade && item.trade !== "Baseline" && item.trade !== "Now") {
                        const sign = item.pnl >= 0 ? "+" : "";
                        return `${label} | ${item.trade} (${sign}$${item.pnl.toFixed(2)})`;
                      }
                      return label;
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="equity"
                    stroke="hsl(142, 70%, 45%)"
                    fill="url(#eqGrad)"
                    strokeWidth={2}
                    dot={{ r: 3, fill: "hsl(142, 70%, 45%)", stroke: "hsl(225, 18%, 10%)", strokeWidth: 1 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">
                No trades yet — equity curve builds as trades close
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Open Positions */}
      <div className="grid grid-cols-1 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Open Positions</CardTitle>
          </CardHeader>
          <CardContent>
            {openTrades.length > 0 ? (
              <div className="space-y-2">
                {openTrades.map((trade: any) => (
                  <div
                    key={trade.id}
                    className="flex items-center justify-between p-2.5 rounded-md bg-muted/50 border border-border"
                    data-testid={`card-position-${trade.id}`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Badge
                        variant="default"
                        className="text-[10px] px-1.5 py-0 uppercase"
                      >
                        LONG
                      </Badge>
                      <div>
                        <span className="text-sm font-medium">{trade.coin}</span>
                        <span className="text-xs text-muted-foreground ml-2">{trade.leverage}x</span>
                        <Badge variant="outline" className="ml-2 text-[9px] px-1 py-0 bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
                          DEGEN RSI
                        </Badge>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={cn(
                        "text-sm font-mono font-medium",
                        (trade.pnlOfAum || 0) >= 0 ? "text-emerald-500" : "text-red-500"
                      )}>
                        {(trade.pnlOfAum || 0) >= 0 ? "+" : ""}{(trade.pnlOfAum || 0).toFixed(3)}% AUM
                      </div>
                      <div className={cn(
                        "text-[10px] font-mono",
                        (trade.pnlUsd || 0) >= 0 ? "text-emerald-400/60" : "text-red-400/60"
                      )}>
                        {fmtUsd(trade.pnlUsd || 0)}
                        {trade.hlPnlUsd !== null && trade.hlPnlUsd !== undefined && (
                          <span className="text-[8px] text-muted-foreground ml-1">HL</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 justify-end">
                        <span className="text-[10px] text-muted-foreground font-mono">
                          ${trade.entryPrice?.toFixed(2)}
                        </span>
                        {trade.stopLoss > 0 && (
                          <Badge className="text-[8px] px-1 py-0 bg-amber-500/20 text-amber-400 border-0">
                            BE SL
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">
                No open positions
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Trade History */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Trade History</CardTitle>
        </CardHeader>
        <CardContent>
          {(closedTrades as any[]).length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="text-left py-1.5 px-1 font-medium">Date/Time</th>
                    <th className="text-left py-1.5 px-1 font-medium">Asset</th>
                    <th className="text-left py-1.5 px-1 font-medium">Side</th>
                    <th className="text-right py-1.5 px-1 font-medium">Entry</th>
                    <th className="text-right py-1.5 px-1 font-medium">Exit</th>
                    <th className="text-right py-1.5 px-1 font-medium">P&L (USDC)</th>
                    <th className="text-left py-1.5 px-1 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {(closedTrades as any[]).sort((a: any, b: any) => (b.closedAt || "").localeCompare(a.closedAt || "")).slice(0, 30).map((trade: any) => {
                    const net = (trade.hlPnlUsd || 0) - (trade.hlCloseFee || 0);
                    const openDate = trade.openedAt ? new Date(trade.openedAt) : null;
                    const closeDate = trade.closedAt ? new Date(trade.closedAt) : null;
                    const reason = (trade.closeReason || "")
                      .replace(/\[DEGEN_RSI\]\s*/g, "")
                      .replace(/\s*\|\s*HL P&L.*$/g, "")
                      .replace(/Position closed on HL \(sync\)\s*\|?\s*/g, "Sync")
                      .replace(/P&L:.*$/g, "")
                      .trim();
                    return (
                      <tr key={trade.id} className="border-b border-border/30 hover:bg-muted/30">
                        <td className="py-1.5 px-1 font-mono text-muted-foreground whitespace-nowrap">
                          <div>{openDate ? openDate.toLocaleDateString([], { month: "short", day: "numeric" }) : "-"}</div>
                          <div className="text-[10px]">
                            {openDate ? openDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                            {closeDate ? " → " + closeDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                          </div>
                        </td>
                        <td className="py-1.5 px-1 font-medium">{trade.coin}</td>
                        <td className="py-1.5 px-1">
                          <Badge
                            variant="default"
                            className="text-[9px] px-1 py-0 uppercase"
                          >
                            {trade.side}
                          </Badge>
                        </td>
                        <td className="py-1.5 px-1 text-right font-mono">${trade.entryPrice?.toFixed(trade.entryPrice < 10 ? 4 : 2)}</td>
                        <td className="py-1.5 px-1 text-right font-mono">${trade.exitPrice?.toFixed(trade.exitPrice < 10 ? 4 : 2)}</td>
                        <td className={cn(
                          "py-1.5 px-1 text-right font-mono font-medium",
                          net >= 0 ? "text-emerald-400" : "text-red-400"
                        )}>
                          {net >= 0 ? "+" : ""}{net.toFixed(2)}
                        </td>
                        <td className="py-1.5 px-1 text-muted-foreground truncate max-w-[120px]">{reason || "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="h-[100px] flex items-center justify-center text-sm text-muted-foreground">
              No closed trades yet
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Activity */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5">
            {(logs as any[]).slice(0, 8).map((log: any) => (
              <div
                key={log.id}
                className="flex items-start gap-2.5 py-1.5 border-b border-border/50 last:border-0"
              >
                <div className={cn(
                  "w-1.5 h-1.5 rounded-full mt-1.5 shrink-0",
                  log.type === "trade_open" && "bg-emerald-500",
                  log.type === "trade_close" && "bg-blue-500",
                  log.type === "error" && "bg-red-500",
                  log.type === "scan" && "bg-yellow-500",
                  log.type === "system" && "bg-muted-foreground",
                  log.type === "config_change" && "bg-purple-500",
                  log.type === "learning" && "bg-cyan-500",
                  log.type === "learning_24h" && "bg-cyan-400",
                  log.type === "order_error" && "bg-red-400",
                  log.type === "order_unfilled" && "bg-orange-400",
                )} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs truncate">{log.message}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {new Date(log.timestamp).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
            {logs.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No activity yet</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
