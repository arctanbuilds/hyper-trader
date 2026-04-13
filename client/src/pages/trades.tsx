import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { X, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

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
            <TableHead className="text-xs">TP</TableHead>
            <TableHead className="text-xs text-right">P&L</TableHead>
            <TableHead className="text-xs">Reason</TableHead>
            {showClose && <TableHead className="text-xs w-10"></TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {trades.length === 0 ? (
            <TableRow>
              <TableCell colSpan={showClose ? 11 : 11} className="text-center text-sm text-muted-foreground py-8">
                No trades
              </TableCell>
            </TableRow>
          ) : (
            trades.map((trade: any) => (
              <TableRow key={trade.id} data-testid={`row-trade-${trade.id}`}>
                <TableCell className="font-medium text-xs">{trade.coin}</TableCell>
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
                <TableCell className="font-mono text-xs">${trade.entryPrice?.toFixed(2)}</TableCell>
                {!showClose && (
                  <TableCell className="font-mono text-xs">
                    {trade.exitPrice ? `$${trade.exitPrice.toFixed(2)}` : "—"}
                  </TableCell>
                )}
                <TableCell className="font-mono text-xs">{trade.size}%</TableCell>
                <TableCell className="font-mono text-xs">{trade.leverage}x</TableCell>
                <TableCell className="font-mono text-xs">
                  <span className={cn(
                    (trade.rsiAtEntry || 50) < 30 ? "text-emerald-500" :
                    (trade.rsiAtEntry || 50) > 70 ? "text-red-500" : ""
                  )}>
                    {trade.rsiAtEntry?.toFixed(1) || "—"}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs text-red-400">
                  ${trade.stopLoss?.toFixed(2) || "—"}
                </TableCell>
                <TableCell className="font-mono text-xs text-emerald-400">
                  ${trade.takeProfit?.toFixed(2) || "—"}
                </TableCell>
                <TableCell className={cn(
                  "font-mono text-xs font-medium text-right",
                  (trade.pnl || 0) >= 0 ? "text-emerald-500" : "text-red-500"
                )}>
                  {(trade.pnl || 0) >= 0 ? "+" : ""}{(trade.pnl || 0).toFixed(2)}%
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
        <p className="text-sm text-muted-foreground">Manage open positions and view trade history</p>
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
