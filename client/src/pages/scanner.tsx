import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { RefreshCw, ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

function getRSIColor(rsi: number): string {
  if (rsi <= 20) return "text-emerald-400";
  if (rsi <= 30) return "text-emerald-500/70";
  if (rsi >= 80) return "text-red-400";
  if (rsi >= 70) return "text-red-500/70";
  return "text-muted-foreground";
}

function getRSIBg(rsi: number): string {
  if (rsi <= 20) return "bg-emerald-500/10";
  if (rsi <= 30) return "bg-emerald-500/5";
  if (rsi >= 80) return "bg-red-500/10";
  if (rsi >= 70) return "bg-red-500/5";
  return "";
}

export default function Scanner() {
  const { data: scans = [], isLoading } = useQuery({
    queryKey: ["/api/scans"],
    queryFn: () => apiRequest("GET", "/api/scans").then(r => r.json()),
    refetchInterval: 30000,
  });

  const { data: signals = [] } = useQuery({
    queryKey: ["/api/scans/signals"],
    queryFn: () => apiRequest("GET", "/api/scans/signals").then(r => r.json()),
    refetchInterval: 30000,
  });

  const triggerScan = useMutation({
    mutationFn: () => apiRequest("POST", "/api/bot/scan"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/scans"] });
    },
  });

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Market Scanner</h2>
          <p className="text-sm text-muted-foreground">
            RSI-based signal detection across all Hyperliquid perps
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

      {/* Active Signals */}
      {signals.length > 0 && (
        <Card className="border-primary/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              Active Signals ({signals.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {signals.map((sig: any) => (
                <div
                  key={sig.coin}
                  className={cn(
                    "p-3 rounded-md border",
                    sig.signal === "oversold_long" ? "border-emerald-500/20 bg-emerald-500/5" : "border-red-500/20 bg-red-500/5"
                  )}
                  data-testid={`card-signal-${sig.coin}`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-medium text-sm">{sig.coin}</span>
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
                  <div className="grid grid-cols-2 gap-1 text-[10px]">
                    <div>
                      <span className="text-muted-foreground">RSI: </span>
                      <span className={cn("font-mono font-medium", getRSIColor(sig.rsi || 50))}>
                        {sig.rsi?.toFixed(1)}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Price: </span>
                      <span className="font-mono">${parseFloat(sig.price || 0).toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">24h: </span>
                      <span className={cn(
                        "font-mono",
                        (sig.change24h || 0) >= 0 ? "text-emerald-500" : "text-red-500"
                      )}>
                        {(sig.change24h || 0) >= 0 ? "+" : ""}{(sig.change24h || 0).toFixed(1)}%
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Funding: </span>
                      <span className="font-mono">
                        {((sig.fundingRate || 0) * 100).toFixed(4)}%
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Full Market Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">All Scanned Assets ({scans.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Asset</TableHead>
                  <TableHead className="text-xs">Price</TableHead>
                  <TableHead className="text-xs">RSI (1h)</TableHead>
                  <TableHead className="text-xs">24h Change</TableHead>
                  <TableHead className="text-xs">Volume 24h</TableHead>
                  <TableHead className="text-xs">Funding</TableHead>
                  <TableHead className="text-xs">Signal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scans.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">
                      {isLoading ? "Loading..." : "No scan data — run a scan first"}
                    </TableCell>
                  </TableRow>
                ) : (
                  scans.map((scan: any) => (
                    <TableRow key={scan.coin} className={getRSIBg(scan.rsi || 50)}>
                      <TableCell className="font-medium text-xs">{scan.coin}</TableCell>
                      <TableCell className="font-mono text-xs">
                        ${parseFloat(scan.price || 0).toFixed(2)}
                      </TableCell>
                      <TableCell className={cn("font-mono text-xs font-medium", getRSIColor(scan.rsi || 50))}>
                        {scan.rsi?.toFixed(1) || "—"}
                      </TableCell>
                      <TableCell className={cn(
                        "font-mono text-xs",
                        (scan.change24h || 0) >= 0 ? "text-emerald-500" : "text-red-500"
                      )}>
                        {(scan.change24h || 0) >= 0 ? "+" : ""}{(scan.change24h || 0).toFixed(2)}%
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        ${(scan.volume24h / 1e6).toFixed(1)}M
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {((scan.fundingRate || 0) * 100).toFixed(4)}%
                      </TableCell>
                      <TableCell>
                        {scan.signal === "oversold_long" ? (
                          <Badge variant="default" className="text-[10px] px-1.5 py-0">
                            <ArrowUpRight className="w-3 h-3 mr-0.5" /> LONG
                          </Badge>
                        ) : scan.signal === "overbought_short" ? (
                          <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                            <ArrowDownRight className="w-3 h-3 mr-0.5" /> SHORT
                          </Badge>
                        ) : (
                          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                            <Minus className="w-3 h-3" /> Neutral
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
