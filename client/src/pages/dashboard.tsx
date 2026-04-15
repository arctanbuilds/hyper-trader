import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  TrendingUp, TrendingDown, DollarSign, Target,
  BarChart3, Activity, RefreshCw, ArrowUpRight, ArrowDownRight, Wallet,
  Shield, Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

// Display-friendly asset names
const ASSET_DISPLAY: Record<string, string> = {
  "BTC": "Bitcoin",
  "ETH": "Ethereum",
  "SOL": "Solana",
  "xyz:GOLD": "Gold",
  "xyz:SILVER": "Silver",
  "xyz:CL": "Oil WTI",
  "xyz:BRENTOIL": "Oil Brent",
  "xyz:SP500": "S&P 500",
  "xyz:EUR": "EUR/USD",
};

function getAssetLabel(coin: string): string {
  return ASSET_DISPLAY[coin] || coin;
}

function getSessionInfo(): { session: string; color: string } {
  const now = new Date();
  const utcHour = now.getUTCHours();
  // London: 07-16 UTC, NY: 13-21 UTC, overlap: 13-16 UTC, Asia: 23-08 UTC
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

  const { data: pnlData = [] } = useQuery({
    queryKey: ["/api/pnl"],
    queryFn: () => apiRequest("GET", "/api/pnl").then(r => r.json()),
    refetchInterval: 30000,
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

  const pnlChartData = [...(pnlData || [])].reverse().slice(-50).map((p: any) => ({
    time: new Date(p.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    pnl: p.totalPnlPct,
    equity: p.totalEquity,
  }));

  const sessionInfo = getSessionInfo();

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Dashboard</h2>
          <div className="flex items-center gap-3 mt-0.5">
            <p className="text-sm text-muted-foreground">Real-time trading overview</p>
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
              {status?.openPositions || 0}
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
              <span className="text-xs text-muted-foreground font-medium">Win Rate / Pace</span>
              <Target className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="text-lg font-semibold font-mono" data-testid="text-win-rate">
              {status?.winRate || "0.0"}%
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {status?.closedTrades || 0} closed | Today: {status?.dailyTradeCount || 0}/{status?.dailyTradeTarget || 20}
            </p>
            <p className={cn(
              "text-[10px] font-mono mt-0.5",
              parseFloat(status?.drawdownPct || "0") > 30 ? "text-red-400" : parseFloat(status?.drawdownPct || "0") > 15 ? "text-amber-400" : "text-muted-foreground"
            )}>
              DD: {status?.drawdownPct || "0.00"}% ({fmtUsd(-(parseFloat(status?.drawdownUsd || "0")))}) {status?.drawdownPaused ? "⏸ PAUSED" : ""}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Strategy Stats */}
      {status?.strategyStats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-zinc-500/10 text-zinc-400 border-zinc-500/30">LEGACY (CONF)</Badge>
              </div>
              <div className="space-y-1 mt-2">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-muted-foreground">{status.strategyStats.confluence.trades} trades</span>
                  <span>{status.strategyStats.confluence.winRate}% WR</span>
                </div>
                <div className={cn("text-sm font-mono font-medium", parseFloat(status.strategyStats.confluence.pnlUsd || "0") >= 0 ? "text-emerald-400" : "text-red-400")}>
                  {parseFloat(status.strategyStats.confluence.pnlUsd || "0") >= 0 ? "+" : ""}{parseFloat(status.strategyStats.confluence.pnlUsd || "0").toFixed(2)} USDC
                </div>
                <div className="text-[10px] text-muted-foreground">disabled</div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-zinc-500/10 text-zinc-400 border-zinc-500/30">LEGACY (RSI)</Badge>
              </div>
              <div className="space-y-1 mt-2">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-muted-foreground">{status.strategyStats.extreme_rsi.trades} trades</span>
                  <span>{status.strategyStats.extreme_rsi.winRate}% WR</span>
                </div>
                <div className={cn("text-sm font-mono font-medium", parseFloat(status.strategyStats.extreme_rsi.pnlUsd || "0") >= 0 ? "text-emerald-400" : "text-red-400")}>
                  {parseFloat(status.strategyStats.extreme_rsi.pnlUsd || "0") >= 0 ? "+" : ""}{parseFloat(status.strategyStats.extreme_rsi.pnlUsd || "0").toFixed(2)} USDC
                </div>
                <div className="text-[10px] text-muted-foreground">{status.strategyStats.extreme_rsi.openPositions} open</div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-emerald-500/10 text-emerald-400 border-emerald-500/30">REVERSAL</Badge>
              </div>
              <div className="space-y-1 mt-2">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-muted-foreground">{status.strategyStats.bb_rsi_reversion?.trades || 0} trades</span>
                  <span>{status.strategyStats.bb_rsi_reversion?.winRate || "0.0"}% WR</span>
                </div>
                <div className={cn("text-sm font-mono font-medium", parseFloat(status.strategyStats.bb_rsi_reversion?.pnlUsd || "0") >= 0 ? "text-emerald-400" : "text-red-400")}>
                  {parseFloat(status.strategyStats.bb_rsi_reversion?.pnlUsd || "0") >= 0 ? "+" : ""}{parseFloat(status.strategyStats.bb_rsi_reversion?.pnlUsd || "0").toFixed(2)} USDC
                </div>
                <div className="text-[10px] text-muted-foreground">{status.strategyStats.bb_rsi_reversion?.openPositions || 0} open</div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-blue-500/10 text-blue-400 border-blue-500/30">RETEST</Badge>
              </div>
              <div className="space-y-1 mt-2">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-muted-foreground">{status.strategyStats.breakout_retest?.trades || 0} trades</span>
                  <span>{status.strategyStats.breakout_retest?.winRate || "0.0"}% WR</span>
                </div>
                <div className={cn("text-sm font-mono font-medium", parseFloat(status.strategyStats.breakout_retest?.pnlUsd || "0") >= 0 ? "text-emerald-400" : "text-red-400")}>
                  {parseFloat(status.strategyStats.breakout_retest?.pnlUsd || "0") >= 0 ? "+" : ""}{parseFloat(status.strategyStats.breakout_retest?.pnlUsd || "0").toFixed(2)} USDC
                </div>
                <div className="text-[10px] text-muted-foreground">{status.strategyStats.breakout_retest?.openPositions || 0} open</div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* S/R Levels */}
      {status?.srLevels && Object.keys(status.srLevels).length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Shield className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">Support / Resistance Levels</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {Object.entries(status.srLevels).map(([coin, sr]: [string, any]) => (
                <div key={coin} className="space-y-2">
                  <span className="text-xs font-semibold text-muted-foreground uppercase">{getAssetLabel(coin)}</span>
                  {sr.nearestSupport && (
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        <span className="text-emerald-400">Support</span>
                      </div>
                      <span className="font-mono">
                        ${sr.nearestSupport.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        <span className="text-muted-foreground ml-1">str:{sr.nearestSupport.strength} t:{sr.nearestSupport.touches}</span>
                        {sr.atSupport && <Badge className="ml-1 text-[8px] px-1 py-0 bg-emerald-500/20 text-emerald-400 border-0">AT</Badge>}
                      </span>
                    </div>
                  )}
                  {sr.nearestResistance && (
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
                        <span className="text-red-400">Resistance</span>
                      </div>
                      <span className="font-mono">
                        ${sr.nearestResistance.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        <span className="text-muted-foreground ml-1">str:{sr.nearestResistance.strength} t:{sr.nearestResistance.touches}</span>
                        {sr.atResistance && <Badge className="ml-1 text-[8px] px-1 py-0 bg-red-500/20 text-red-400 border-0">AT</Badge>}
                      </span>
                    </div>
                  )}
                  {sr.levels && sr.levels.length > 2 && (
                    <div className="text-[10px] text-muted-foreground">
                      {sr.levels.slice(0, 4).map((l: any, i: number) => (
                        <span key={i} className="mr-2">
                          <span className={l.type === "support" ? "text-emerald-400/60" : "text-red-400/60"}>{l.type === "support" ? "S" : "R"}</span>
                          ${l.price.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          <span className="text-muted-foreground/60">({l.strength})</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* P&L Chart */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Equity Curve</CardTitle>
          </CardHeader>
          <CardContent>
            {pnlChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={pnlChartData}>
                  <defs>
                    <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(142, 70%, 45%)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(142, 70%, 45%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 15%, 15%)" />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} stroke="hsl(220, 10%, 40%)" />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(220, 10%, 40%)" />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(225, 18%, 10%)",
                      border: "1px solid hsl(220, 15%, 15%)",
                      borderRadius: "6px",
                      fontSize: "12px",
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="pnl"
                    stroke="hsl(142, 70%, 45%)"
                    fill="url(#pnlGrad)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">
                No data yet — start the bot to begin trading
              </div>
            )}
          </CardContent>
        </Card>

        {/* Open Positions */}
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
                        variant={trade.side === "long" ? "default" : "destructive"}
                        className="text-[10px] px-1.5 py-0 uppercase"
                      >
                        {trade.side}
                      </Badge>
                      <div>
                        <span className="text-sm font-medium">{getAssetLabel(trade.coin)}</span>
                        <span className="text-xs text-muted-foreground ml-2">{trade.leverage}x</span>
                        {trade.strategy === "bb_rsi_reversion" && (
                          <Badge variant="outline" className="ml-2 text-[9px] px-1 py-0 bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
                            Reversal
                          </Badge>
                        )}
                        {trade.strategy === "breakout_retest" && (
                          <Badge variant="outline" className="ml-2 text-[9px] px-1 py-0 bg-blue-500/10 text-blue-400 border-blue-500/30">
                            Retest
                          </Badge>
                        )}
                        {(trade.strategy === "extreme_rsi" || trade.strategy === "confluence" || (!trade.strategy && trade.confluenceScore != null)) && (
                          <Badge variant="outline" className="ml-2 text-[9px] px-1 py-0 bg-zinc-500/10 text-zinc-400 border-zinc-500/30">
                            Legacy
                          </Badge>
                        )}
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
                      </div>
                      <div className="flex items-center gap-1.5 justify-end">
                        <span className="text-[10px] text-muted-foreground font-mono">
                          ${trade.entryPrice?.toFixed(2)}
                        </span>
                        {trade.tp1Hit && (
                          <Badge className="text-[8px] px-1 py-0 bg-emerald-500/20 text-emerald-400 border-0">
                            TP1
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
                  log.type === "circuit_breaker" && "bg-orange-500",
                  log.type === "learning" && "bg-cyan-500",
                  log.type === "learning_24h" && "bg-cyan-400",
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
