import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { RefreshCw, ArrowUpRight, ArrowDownRight, Minus, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

// Display-friendly asset names
const ASSET_DISPLAY: Record<string, string> = {
  "BTC": "Bitcoin",
  "ETH": "Ethereum",
  "SOL": "Solana",
  "XRP": "XRP",
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

// Color based on proximity to trade thresholds (25 long / 85 short)
function getRSIColor(rsi: number): string {
  if (rsi <= 25) return "text-emerald-400 font-bold";
  if (rsi <= 30) return "text-emerald-500/80";
  if (rsi >= 85) return "text-red-400 font-bold";
  if (rsi >= 80) return "text-red-500/80";
  if (rsi <= 35) return "text-emerald-500/50";
  if (rsi >= 75) return "text-red-500/50";
  return "text-muted-foreground";
}

// Row background for triggered signals
function getRowBg(signal: string): string {
  if (signal === "oversold_long") return "bg-emerald-500/8";
  if (signal === "overbought_short") return "bg-red-500/8";
  return "";
}

function formatPrice(price: number | null | undefined): string {
  if (price == null) return "—";
  if (price >= 10000) return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (price >= 100) return `$${price.toFixed(2)}`;
  if (price >= 1) return `$${price.toFixed(3)}`;
  return `$${price.toFixed(4)}`;
}

// Distance to nearest trigger threshold
function getDistanceToTrigger(rsi5m: number, rsi15m: number): { dist: number; label: string; side: string } {
  const distLong5m = rsi5m - 25;
  const distLong15m = rsi15m - 25;
  const distShort5m = 85 - rsi5m;
  const distShort15m = 85 - rsi15m;
  const allDists = [
    { dist: distLong5m, label: `5m→25`, side: "long" },
    { dist: distLong15m, label: `15m→25`, side: "long" },
    { dist: distShort5m, label: `5m→85`, side: "short" },
    { dist: distShort15m, label: `15m→85`, side: "short" },
  ];
  const nearest = allDists.reduce((a, b) => (Math.abs(a.dist) < Math.abs(b.dist) ? a : b));
  return nearest;
}

export default function Scanner() {
  const { data: scans = [], isLoading } = useQuery({
    queryKey: ["/api/scans"],
    queryFn: () => apiRequest("GET", "/api/scans").then(r => r.json()),
    refetchInterval: 10000,
  });

  const { data: signals = [] } = useQuery({
    queryKey: ["/api/scans/signals"],
    queryFn: () => apiRequest("GET", "/api/scans/signals").then(r => r.json()),
    refetchInterval: 10000,
  });

  const triggerScan = useMutation({
    mutationFn: () => apiRequest("POST", "/api/bot/scan"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/scans"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scans/signals"] });
    },
  });

  // Sort: signals first, then by proximity to trigger
  const sortedScans = [...scans].sort((a: any, b: any) => {
    // Signals first
    if (a.signal !== "neutral" && b.signal === "neutral") return -1;
    if (a.signal === "neutral" && b.signal !== "neutral") return 1;
    // Then by name
    return (getAssetLabel(a.coin) || "").localeCompare(getAssetLabel(b.coin) || "");
  });

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">RSI Reversal Scanner</h2>
          <p className="text-sm text-muted-foreground">
            Strategy: SHORT when 5m/15m RSI ≥ 85 · LONG when ≤ 25 · Loosened to 80/30 with double top/bottom
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => triggerScan.mutate()}
          disabled={triggerScan.isPending}
          data-testid="button-scan-markets"
        >
          <RefreshCw className={cn("w-3.5 h-3.5 mr-1.5", triggerScan.isPending && "animate-spin")} />
          {triggerScan.isPending ? "Scanning..." : "Scan Now"}
        </Button>
      </div>

      {/* Active Trade Signals — only shows when RSI actually hits 25/85 */}
      {signals.length > 0 && (
        <Card className="border-primary/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Zap className="w-4 h-4 text-yellow-400" />
              Trade Signals ({signals.length}) — Ready to Execute
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {signals.map((sig: any) => (
                <div
                  key={sig.coin}
                  className={cn(
                    "p-3 rounded-md border",
                    sig.signal === "oversold_long" ? "border-emerald-500/30 bg-emerald-500/8" : "border-red-500/30 bg-red-500/8"
                  )}
                  data-testid={`card-signal-${sig.coin}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-sm">{getAssetLabel(sig.coin)}</span>
                    <Badge
                      variant={sig.signal === "oversold_long" ? "default" : "destructive"}
                      className="text-[10px] px-1.5 py-0"
                    >
                      {sig.signal === "oversold_long" ? (
                        <><ArrowUpRight className="w-3 h-3 mr-0.5" /> LONG</>
                      ) : (
                        <><ArrowDownRight className="w-3 h-3 mr-0.5" /> SHORT</>
                      )}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                    <div>
                      <span className="text-muted-foreground">RSI 5m: </span>
                      <span className={cn("font-mono font-bold", getRSIColor(sig.rsi5m || 50))}>
                        {sig.rsi5m?.toFixed(1) || "—"}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">RSI 15m: </span>
                      <span className={cn("font-mono font-bold", getRSIColor(sig.rsi15m || 50))}>
                        {sig.rsi15m?.toFixed(1) || "—"}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">RSI 1h: </span>
                      <span className={cn("font-mono", getRSIColor(sig.rsi || 50))}>
                        {sig.rsi?.toFixed(1) || "—"}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Price: </span>
                      <span className="font-mono">{formatPrice(sig.price)}</span>
                    </div>
                  </div>
                  {sig.confluenceDetails && (
                    <div className="mt-1.5 text-[9px] text-muted-foreground">{sig.confluenceDetails}</div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* All Assets Table — RSI Reversal focused */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">All Assets ({scans.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Asset</TableHead>
                  <TableHead className="text-xs">Price</TableHead>
                  <TableHead className="text-xs">RSI 5m</TableHead>
                  <TableHead className="text-xs">RSI 15m</TableHead>
                  <TableHead className="text-xs">RSI 1h</TableHead>
                  <TableHead className="text-xs">RSI 4h</TableHead>
                  <TableHead className="text-xs">RSI 1d</TableHead>
                  <TableHead className="text-xs">24h</TableHead>
                  <TableHead className="text-xs">Distance</TableHead>
                  <TableHead className="text-xs">Signal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedScans.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-sm text-muted-foreground py-8">
                      {isLoading ? "Loading..." : "No scan data — run a scan first"}
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedScans.map((scan: any) => {
                    const r5m = scan.rsi5m ?? 50;
                    const r15m = scan.rsi15m ?? 50;
                    const trigger = getDistanceToTrigger(r5m, r15m);
                    return (
                      <TableRow key={scan.coin} className={getRowBg(scan.signal)}>
                        <TableCell className="font-medium text-xs">{getAssetLabel(scan.coin)}</TableCell>
                        <TableCell className="font-mono text-xs">{formatPrice(scan.price)}</TableCell>
                        <TableCell className={cn("font-mono text-xs", getRSIColor(r5m))}>
                          {scan.rsi5m?.toFixed(1) || "—"}
                        </TableCell>
                        <TableCell className={cn("font-mono text-xs", getRSIColor(r15m))}>
                          {scan.rsi15m?.toFixed(1) || "—"}
                        </TableCell>
                        <TableCell className={cn("font-mono text-xs", getRSIColor(scan.rsi || 50))}>
                          {scan.rsi?.toFixed(1) || "—"}
                        </TableCell>
                        <TableCell className={cn("font-mono text-xs", getRSIColor(scan.rsi4h || 50))}>
                          {scan.rsi4h?.toFixed(1) || "—"}
                        </TableCell>
                        <TableCell className={cn("font-mono text-xs", getRSIColor(scan.rsi1d || 50))}>
                          {scan.rsi1d?.toFixed(1) || "—"}
                        </TableCell>
                        <TableCell className={cn(
                          "font-mono text-xs",
                          (scan.change24h || 0) >= 0 ? "text-emerald-500" : "text-red-500"
                        )}>
                          {(scan.change24h || 0) >= 0 ? "+" : ""}{(scan.change24h || 0).toFixed(2)}%
                        </TableCell>
                        <TableCell>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className={cn(
                                  "font-mono text-[10px]",
                                  Math.abs(trigger.dist) <= 5 ? (trigger.side === "long" ? "text-emerald-400" : "text-red-400") :
                                  Math.abs(trigger.dist) <= 10 ? "text-yellow-500" :
                                  "text-muted-foreground"
                                )}>
                                  {Math.abs(trigger.dist).toFixed(1)} pts
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="text-xs">
                                {scan.confluenceDetails || `${trigger.label}: ${Math.abs(trigger.dist).toFixed(1)} pts away`}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </TableCell>
                        <TableCell>
                          {scan.signal === "oversold_long" ? (
                            <Badge variant="default" className="text-[10px] px-1.5 py-0 bg-emerald-600">
                              <ArrowUpRight className="w-3 h-3 mr-0.5" /> LONG
                            </Badge>
                          ) : scan.signal === "overbought_short" ? (
                            <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                              <ArrowDownRight className="w-3 h-3 mr-0.5" /> SHORT
                            </Badge>
                          ) : (
                            <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                              <Minus className="w-3 h-3" /> —
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
