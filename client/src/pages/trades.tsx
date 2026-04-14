import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { X, ArrowUpRight, ArrowDownRight, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

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

function formatPrice(price: number | null | undefined): string {
  if (price == null) return "—";
  if (price >= 1000) return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (price >= 1) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(4)}`;
}

export default function Trades() {
  const { toast } = useToast();

  const { data: allTrades = [] } = useQuery({
    queryKey: ["/api/trades"],
    queryFn: () => apiRequest("GET", "/api/trades").then(r => r.json()),
    refetchInterval: 10000,
  });

  const closeTrade = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/trades/${id}/close`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({ title: "Trade closed", description: "Position has been closed." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to close trade.", variant: "destructive" });
    },
  });

  const openTrades = allTrades.filter((t: any) => t.status === "open");
  const closedTrades = allTrades.filter((t: any) => t.status !== "open");

  const TradeTable = ({ trades, showClose = false }: { trades: any[]; showClose?: boolean }) => (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">Asset</TableHead>
            <TableHead className="text-xs">Side</TableHead>
            <TableHead className="text-xs">Entry</TableHead>
            {!showClose && <TableHead className="text-xs">Exit</TableHead>}
            <TableHead className="text-xs">Size</TableHead>
            <TableHead className="text-xs">Lev</TableHead>
            <TableHead className="text-xs">RSI</TableHead>
            <TableHead className="text-xs">SL</TableHead>
            <TableHead className="text-xs">TP1</TableHead>
            <TableHead className="text-xs">TP2</TableHead>
            <TableHead className="text-xs">C.Score</TableHead>
            <TableHead className="text-xs">R:R</TableHead>
            <TableHead className="text-xs text-right">ROI/AUM</TableHead>
            <TableHead className="text-xs text-right">P&L USDC</TableHead>
            <TableHead className="text-xs">Reason</TableHead>
            {showClose && <TableHead className="text-xs w-10"></TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {trades.length === 0 ? (
            <TableRow>
              <TableCell colSpan={showClose ? 16 : 16} className="text-center text-sm text-muted-foreground py-8">
                No trades
              </TableCell>
            </TableRow>
          ) : (
            trades.map((trade: any) => (
              <TableRow key={trade.id} data-testid={`row-trade-${trade.id}`}>
                <TableCell className="font-medium text-xs">
                  <div className="flex items-center gap-1">
                    {getAssetLabel(trade.coin)}
                    {trade.strategy === "extreme_rsi" ? (
                      <Badge variant="outline" className="text-[8px] px-1 py-0 bg-amber-500/10 text-amber-400 border-amber-500/30">
                        E.RSI
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[8px] px-1 py-0 bg-blue-500/10 text-blue-400 border-blue-500/30">
                        CONF
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={trade.side === "long" ? "default" : "destructive"}
                    className="text-[10px] px-1.5 py-0 uppercase"
                  >
                    {trade.side === "long" ? (
                      <ArrowUpRight className="w-3 h-3 mr-0.5" />
                    ) : (
                      <ArrowDownRight className="w-3 h-3 mr-0.5" />
                    )}
                    {trade.side}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{formatPrice(trade.entryPrice)}</TableCell>
                {!showClose && (
                  <TableCell className="font-mono text-xs">
                    {trade.exitPrice ? formatPrice(trade.exitPrice) : "—"}
                  </TableCell>
                )}
                <TableCell className="font-mono text-xs">{trade.size}%</TableCell>
                <TableCell className="font-mono text-xs">{trade.leverage}x</TableCell>
                <TableCell className="font-mono text-xs">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className={cn(
                          (trade.rsiAtEntry || 50) < 30 ? "text-emerald-500" :
                          (trade.rsiAtEntry || 50) > 70 ? "text-red-500" : ""
                        )}>
                          {trade.rsiAtEntry?.toFixed(1) || "—"}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="text-xs">
                        <div>1h: {trade.rsiAtEntry?.toFixed(1) || "—"}</div>
                        <div>4h: {trade.rsi4h?.toFixed(1) || "—"}</div>
                        <div>1d: {trade.rsi1d?.toFixed(1) || "—"}</div>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </TableCell>
                <TableCell className="font-mono text-xs text-red-400">
                  {formatPrice(trade.stopLoss)}
                </TableCell>
                <TableCell className="font-mono text-xs text-emerald-400">
                  <span className={cn(trade.tp1Hit && "line-through opacity-50")}>
                    {formatPrice(trade.takeProfit1)}
                  </span>
                  {trade.tp1Hit && (
                    <Badge className="ml-1 text-[8px] px-1 py-0 bg-emerald-500/20 text-emerald-400 border-0">
                      HIT
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs text-emerald-400">
                  {formatPrice(trade.takeProfit2)}
                </TableCell>
                <TableCell>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] px-1.5 py-0",
                            (trade.confluenceScore || 0) >= 5 ? "border-emerald-500/50 text-emerald-400" :
                            (trade.confluenceScore || 0) >= 3 ? "border-yellow-500/50 text-yellow-400" :
                            "border-muted-foreground/50"
                          )}
                        >
                          {trade.confluenceScore ?? 0}/7
                        </Badge>
                      </TooltipTrigger>
                      {trade.confluenceDetails && (
                        <TooltipContent className="text-xs max-w-[250px]">
                          {trade.confluenceDetails}
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {trade.riskRewardRatio ? `1:${trade.riskRewardRatio.toFixed(1)}` : "—"}
                </TableCell>
                <TableCell className={cn(
                  "font-mono text-xs font-medium text-right",
                  (trade.pnlOfAum || 0) >= 0 ? "text-emerald-500" : "text-red-500"
                )}>
                  {(trade.pnlOfAum || 0) >= 0 ? "+" : ""}{(trade.pnlOfAum || 0).toFixed(3)}%
                </TableCell>
                <TableCell className={cn(
                  "font-mono text-xs font-medium text-right",
                  (trade.pnlUsd || 0) >= 0 ? "text-emerald-500" : "text-red-500"
                )}>
                  {(trade.pnlUsd || 0) >= 0 ? "+" : ""}{(trade.pnlUsd || 0).toFixed(2)}
                </TableCell>
                <TableCell className="text-[10px] text-muted-foreground max-w-[200px] truncate">
                  {trade.status === "open" ? trade.reason : trade.closeReason}
                </TableCell>
                {showClose && (
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                      onClick={() => closeTrade.mutate(trade.id)}
                      disabled={closeTrade.isPending}
                      data-testid={`button-close-trade-${trade.id}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Trades</h2>
        <p className="text-sm text-muted-foreground">Manage open positions and view trade history — dual TP, confluence scores, and R:R ratios</p>
      </div>

      <Tabs defaultValue="open">
        <TabsList>
          <TabsTrigger value="open" data-testid="tab-open-trades">
            Open ({openTrades.length})
          </TabsTrigger>
          <TabsTrigger value="closed" data-testid="tab-closed-trades">
            History ({closedTrades.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="open">
          <Card>
            <CardContent className="p-0">
              <TradeTable trades={openTrades} showClose />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="closed">
          <Card>
            <CardContent className="p-0">
              <TradeTable trades={closedTrades} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
