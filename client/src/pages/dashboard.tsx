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
  const brStrat = strategyData?.strategies?.find((s: any) => s.strategy === "breakout");
  const obosStrat = strategyData?.strategies?.find((s: any) => s.strategy === "obos");
  const oilStrat = strategyData?.strategies?.find((s: any) => s.strategy === "oil_news");
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

  const sessionInfo = getSessionInfo();
  const raceDays = raceHours >= 24 ? `${(raceHours / 24).toFixed(1)}d` : `${raceHours.toFixed(1)}h`;

  const brOpen = status?.strategyStats?.breakout?.openPositions || 0;
  const obosOpenCount = status?.strategyStats?.obos?.openPositions || 0;
  const oilOpenCount = status?.strategyStats?.oil_news?.openPositions || 0;
  const totalOpen = (status?.openPositions || 0);

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Dashboard</h2>
          <div className="flex items-center gap-3 mt-0.5">
            <p className="text-sm text-muted-foreground">v15.1 — B&R + OBOS (BTC) + Oil News (WTI)</p>
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
              {totalOpen} / 3
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              B&R: {brOpen}/1 | OBOS: {obosOpenCount}/1 | Oil: {oilOpenCount}/1
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

      {/* ========== TRIPLE STRATEGY STATS ========== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* B&R Strategy */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm font-medium">Breakout & Retest</CardTitle>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  BTC | LONG | TV Webhook | SL -0.35% | TP +0.35%
                </p>
              </div>
              <Badge variant="outline" className="text-[10px] px-2 py-0.5 bg-blue-500/10 text-blue-400 border-blue-500/30">
                B&R
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              <div className="p-2 rounded bg-blue-500/5 border border-blue-500/20">
                <div className="text-[9px] text-muted-foreground mb-0.5">Trades</div>
                <div className="text-sm font-semibold font-mono text-blue-400">
                  {brStrat?.totalTrades || 0}
                </div>
                <div className="text-[8px] text-muted-foreground">{brStrat?.wins || 0}W / {brStrat?.losses || 0}L</div>
              </div>
              <div className="p-2 rounded bg-blue-500/5 border border-blue-500/20">
                <div className="text-[9px] text-muted-foreground mb-0.5">Win Rate</div>
                <div className="text-sm font-semibold font-mono text-blue-400">
                  {brStrat?.winRate || 0}%
                </div>
                <div className="text-[8px] text-muted-foreground">PF: {(brStrat?.profitFactor || 0) >= 999 ? "∞" : (brStrat?.profitFactor || 0).toFixed(2)}</div>
              </div>
              <div className="p-2 rounded bg-blue-500/5 border border-blue-500/20">
                <div className="text-[9px] text-muted-foreground mb-0.5">Total P&L</div>
                <div className={cn(
                  "text-sm font-semibold font-mono",
                  (brStrat?.totalPnlUsd || 0) >= 0 ? "text-emerald-400" : "text-red-400"
                )}>
                  {(brStrat?.totalPnlUsd || 0) >= 0 ? "+" : ""}${(brStrat?.totalPnlUsd || 0).toFixed(2)}
                </div>
                <div className="text-[8px] text-muted-foreground">
                  {(brStrat?.totalPnlPct || 0) >= 0 ? "+" : ""}{(brStrat?.totalPnlPct || 0).toFixed(2)}% AUM
                </div>
              </div>
              <div className="p-2 rounded bg-blue-500/5 border border-blue-500/20">
                <div className="text-[9px] text-muted-foreground mb-0.5">Avg / Trade</div>
                <div className={cn(
                  "text-sm font-semibold font-mono",
                  (brStrat?.avgPnlPerTrade || 0) >= 0 ? "text-emerald-400" : "text-red-400"
                )}>
                  {(brStrat?.avgPnlPerTrade || 0) >= 0 ? "+" : ""}${(brStrat?.avgPnlPerTrade || 0).toFixed(2)}
                </div>
                <div className="text-[8px] text-muted-foreground">{brStrat?.bestWinStreak || 0}W / {brStrat?.worstLossStreak || 0}L streak</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* OBOS Strategy */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm font-medium">Overbought / Oversold</CardTitle>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  BTC | L+S | RSI ≤15/≥88 | SL -0.5% | TP +0.45% | BE
                </p>
              </div>
              <Badge variant="outline" className="text-[10px] px-2 py-0.5 bg-amber-500/10 text-amber-400 border-amber-500/30">
                OBOS
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              <div className="p-2 rounded bg-amber-500/5 border border-amber-500/20">
                <div className="text-[9px] text-muted-foreground mb-0.5">Trades</div>
                <div className="text-sm font-semibold font-mono text-amber-400">
                  {obosStrat?.totalTrades || 0}
                </div>
                <div className="text-[8px] text-muted-foreground">{obosStrat?.wins || 0}W / {obosStrat?.losses || 0}L</div>
              </div>
              <div className="p-2 rounded bg-amber-500/5 border border-amber-500/20">
                <div className="text-[9px] text-muted-foreground mb-0.5">Win Rate</div>
                <div className="text-sm font-semibold font-mono text-amber-400">
                  {obosStrat?.winRate || 0}%
                </div>
                <div className="text-[8px] text-muted-foreground">PF: {(obosStrat?.profitFactor || 0) >= 999 ? "∞" : (obosStrat?.profitFactor || 0).toFixed(2)}</div>
              </div>
              <div className="p-2 rounded bg-amber-500/5 border border-amber-500/20">
                <div className="text-[9px] text-muted-foreground mb-0.5">Total P&L</div>
                <div className={cn(
                  "text-sm font-semibold font-mono",
                  (obosStrat?.totalPnlUsd || 0) >= 0 ? "text-emerald-400" : "text-red-400"
                )}>
                  {(obosStrat?.totalPnlUsd || 0) >= 0 ? "+" : ""}${(obosStrat?.totalPnlUsd || 0).toFixed(2)}
                </div>
                <div className="text-[8px] text-muted-foreground">
                  {(obosStrat?.totalPnlPct || 0) >= 0 ? "+" : ""}{(obosStrat?.totalPnlPct || 0).toFixed(2)}% AUM
                </div>
              </div>
              <div className="p-2 rounded bg-amber-500/5 border border-amber-500/20">
                <div className="text-[9px] text-muted-foreground mb-0.5">Avg / Trade</div>
                <div className={cn(
                  "text-sm font-semibold font-mono",
                  (obosStrat?.avgPnlPerTrade || 0) >= 0 ? "text-emerald-400" : "text-red-400"
                )}>
                  {(obosStrat?.avgPnlPerTrade || 0) >= 0 ? "+" : ""}${(obosStrat?.avgPnlPerTrade || 0).toFixed(2)}
                </div>
                <div className="text-[8px] text-muted-foreground">{obosStrat?.bestWinStreak || 0}W / {obosStrat?.worstLossStreak || 0}L streak</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Oil News Strategy */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm font-medium">Oil News Sentiment</CardTitle>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  WTI | L+S | Sonar 15m | $100 | SL -2% | TP +5%
                </p>
              </div>
              <Badge variant="outline" className="text-[10px] px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
                OIL
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              <div className="p-2 rounded bg-emerald-500/5 border border-emerald-500/20">
                <div className="text-[9px] text-muted-foreground mb-0.5">Trades</div>
                <div className="text-sm font-semibold font-mono text-emerald-400">
                  {oilStrat?.totalTrades || 0}
                </div>
                <div className="text-[8px] text-muted-foreground">{oilStrat?.wins || 0}W / {oilStrat?.losses || 0}L</div>
              </div>
              <div className="p-2 rounded bg-emerald-500/5 border border-emerald-500/20">
                <div className="text-[9px] text-muted-foreground mb-0.5">Win Rate</div>
                <div className="text-sm font-semibold font-mono text-emerald-400">
                  {oilStrat?.winRate || 0}%
                </div>
                <div className="text-[8px] text-muted-foreground">PF: {(oilStrat?.profitFactor || 0) >= 999 ? "∞" : (oilStrat?.profitFactor || 0).toFixed(2)}</div>
              </div>
              <div className="p-2 rounded bg-emerald-500/5 border border-emerald-500/20">
                <div className="text-[9px] text-muted-foreground mb-0.5">Total P&L</div>
                <div className={cn(
                  "text-sm font-semibold font-mono",
                  (oilStrat?.totalPnlUsd || 0) >= 0 ? "text-emerald-400" : "text-red-400"
                )}>
                  {(oilStrat?.totalPnlUsd || 0) >= 0 ? "+" : ""}${(oilStrat?.totalPnlUsd || 0).toFixed(2)}
                </div>
                <div className="text-[8px] text-muted-foreground">
                  {(oilStrat?.totalPnlPct || 0) >= 0 ? "+" : ""}{(oilStrat?.totalPnlPct || 0).toFixed(2)}% AUM
                </div>
              </div>
              <div className="p-2 rounded bg-emerald-500/5 border border-emerald-500/20">
                <div className="text-[9px] text-muted-foreground mb-0.5">Avg / Trade</div>
                <div className={cn(
                  "text-sm font-semibold font-mono",
                  (oilStrat?.avgPnlPerTrade || 0) >= 0 ? "text-emerald-400" : "text-red-400"
                )}>
                  {(oilStrat?.avgPnlPerTrade || 0) >= 0 ? "+" : ""}${(oilStrat?.avgPnlPerTrade || 0).toFixed(2)}
                </div>
                <div className="text-[8px] text-muted-foreground">{oilStrat?.bestWinStreak || 0}W / {oilStrat?.worstLossStreak || 0}L streak</div>
              </div>
            </div>
            {status?.lastOilSentiment && (
              <div className="mt-2 p-2 rounded bg-muted/50 border border-border">
                <div className="text-[9px] text-muted-foreground mb-0.5">Last Sentiment</div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={cn(
                    "text-[9px] px-1 py-0",
                    status.lastOilSentiment.direction === "LONG" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" :
                    status.lastOilSentiment.direction === "SHORT" ? "bg-red-500/10 text-red-400 border-red-500/30" :
                    "bg-muted text-muted-foreground border-border"
                  )}>
                    {status.lastOilSentiment.direction}
                  </Badge>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    Confidence: {status.lastOilSentiment.confidence}/10
                  </span>
                </div>
                <p className="text-[9px] text-muted-foreground mt-1 truncate">
                  {status.lastOilSentiment.reasoning}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Charts Row — Equity Curve */}
      <div className="grid grid-cols-1 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Equity Curve</CardTitle>
            <p className="text-[10px] text-muted-foreground">Starting from ${parseFloat(status?.startingEquity || "329").toFixed(2)} USDC baseline (v15.1) | {raceDays} running</p>
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
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Open Positions</CardTitle>
        </CardHeader>
        <CardContent>
          {openTrades.length > 0 ? (
            <div className="space-y-2">
              {openTrades.map((trade: any) => {
                const isBreakout = trade.strategy === "breakout" || trade.strategy === "trendline";
                const isOilNews = trade.strategy === "oil_news";
                const stratLabel = isOilNews ? "OIL" : (isBreakout ? "B&R" : "OBOS");
                const badgeBg = isOilNews
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                  : isBreakout
                    ? "bg-blue-500/10 text-blue-400 border-blue-500/30"
                    : "bg-amber-500/10 text-amber-400 border-amber-500/30";
                const isLong = trade.side === "long";
                return (
                  <div
                    key={trade.id}
                    className="flex items-center justify-between p-2.5 rounded-md bg-muted/50 border border-border"
                    data-testid={`card-position-${trade.id}`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Badge
                        variant="default"
                        className={cn(
                          "text-[10px] px-1.5 py-0 uppercase",
                          isLong ? "bg-emerald-600" : "bg-red-600"
                        )}
                      >
                        {trade.side.toUpperCase()}
                      </Badge>
                      <div>
                        <span className="text-sm font-medium">{trade.coin}</span>
                        <span className="text-xs text-muted-foreground ml-2">{trade.leverage}x</span>
                        <Badge variant="outline" className={cn("ml-2 text-[9px] px-1 py-0", badgeBg)}>
                          {stratLabel}
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
                          ${trade.entryPrice?.toFixed(trade.entryPrice < 10 ? 4 : 2)}
                        </span>
                        {trade.stopLoss > 0 && trade.entryPrice > 0 && (
                          isLong ? trade.stopLoss >= trade.entryPrice * 0.999 : trade.stopLoss <= trade.entryPrice * 1.001
                        ) && (
                          <Badge className="text-[8px] px-1 py-0 bg-amber-500/20 text-amber-400 border-0">
                            BE SL
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="h-[80px] flex items-center justify-center text-sm text-muted-foreground">
              No open positions
            </div>
          )}
        </CardContent>
      </Card>

      {/* Trade History */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Trade History</CardTitle>
        </CardHeader>
        <CardContent>
          {(closedTrades as any[]).filter((t: any) => {
            // Only show trades from v15.0+ onwards
            return t.strategy === "breakout" || t.strategy === "obos" || t.strategy === "trendline" || t.strategy === "oil_news";
          }).length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="text-left py-1.5 px-1 font-medium">Date/Time</th>
                    <th className="text-left py-1.5 px-1 font-medium">Asset</th>
                    <th className="text-left py-1.5 px-1 font-medium">Side</th>
                    <th className="text-left py-1.5 px-1 font-medium">Strategy</th>
                    <th className="text-right py-1.5 px-1 font-medium">Entry</th>
                    <th className="text-right py-1.5 px-1 font-medium">Exit</th>
                    <th className="text-right py-1.5 px-1 font-medium">P&L (USDC)</th>
                    <th className="text-left py-1.5 px-1 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {(closedTrades as any[])
                    .filter((t: any) => t.strategy === "breakout" || t.strategy === "obos" || t.strategy === "trendline" || t.strategy === "oil_news")
                    .sort((a: any, b: any) => (b.closedAt || "").localeCompare(a.closedAt || ""))
                    .slice(0, 30)
                    .map((trade: any) => {
                    const net = trade.hlPnlUsd ?? 0;
                    const openDate = trade.openedAt ? new Date(trade.openedAt) : null;
                    const closeDate = trade.closedAt ? new Date(trade.closedAt) : null;
                    const isBreakout = trade.strategy === "breakout" || trade.strategy === "trendline";
                    const isOilTrade = trade.strategy === "oil_news";
                    const isLong = trade.side === "long";
                    const reason = (trade.closeReason || "")
                      .replace(/\[(B&R|OBOS|OIL)\]\s*/g, "")
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
                            variant="outline"
                            className={cn(
                              "text-[9px] px-1 py-0",
                              isLong ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : "bg-red-500/10 text-red-400 border-red-500/30"
                            )}
                          >
                            {trade.side.toUpperCase()}
                          </Badge>
                        </td>
                        <td className="py-1.5 px-1">
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[9px] px-1 py-0",
                              isOilTrade ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                                : isBreakout ? "bg-blue-500/10 text-blue-400 border-blue-500/30"
                                : "bg-amber-500/10 text-amber-400 border-amber-500/30"
                            )}
                          >
                            {isOilTrade ? "OIL" : isBreakout ? "B&R" : "OBOS"}
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
            <div className="h-[80px] flex items-center justify-center text-sm text-muted-foreground">
              No closed trades yet — fresh start
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
