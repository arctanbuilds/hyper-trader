import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Brain, RefreshCw, TrendingUp, TrendingDown, Target, Lightbulb,
  CheckCircle, XCircle, AlertTriangle, ArrowUpRight, ArrowDownRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

export default function Learning() {
  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ["/api/learning/stats"],
    queryFn: () => apiRequest("GET", "/api/learning/stats").then(r => r.json()),
    refetchInterval: 30000,
  });

  const { data: insights = [] } = useQuery({
    queryKey: ["/api/learning/insights"],
    queryFn: () => apiRequest("GET", "/api/learning/insights").then(r => r.json()),
    refetchInterval: 30000,
  });

  const { data: decisions = [] } = useQuery({
    queryKey: ["/api/learning/decisions"],
    queryFn: () => apiRequest("GET", "/api/learning/decisions?limit=50").then(r => r.json()),
    refetchInterval: 15000,
  });

  const triggerReview = useMutation({
    mutationFn: () => apiRequest("POST", "/api/learning/review"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/learning/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/learning/insights"] });
      queryClient.invalidateQueries({ queryKey: ["/api/learning/decisions"] });
    },
  });

  const overallWinRate = (stats?.overallWinRate || 0) * 100;

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <Brain className="w-5 h-5" /> Learning Engine
          </h2>
          <p className="text-sm text-muted-foreground">
            Self-improving trading intelligence — every decision is logged, reviewed, and used to get better
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => triggerReview.mutate()}
          disabled={triggerReview.isPending}
        >
          <RefreshCw className={cn("w-3.5 h-3.5 mr-1.5", triggerReview.isPending && "animate-spin")} />
          {triggerReview.isPending ? "Reviewing..." : "Force Review"}
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground font-medium">Decisions Logged</span>
              <Brain className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="text-lg font-semibold font-mono">{stats?.totalDecisions || 0}</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {stats?.reviewedDecisions || 0} reviewed
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground font-medium">Overall Win Rate</span>
              <Target className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className={cn(
              "text-lg font-semibold font-mono",
              overallWinRate >= 50 ? "text-emerald-500" : overallWinRate > 0 ? "text-yellow-500" : ""
            )}>
              {overallWinRate.toFixed(1)}%
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              Avg P&L: {(stats?.overallAvgPnl || 0).toFixed(2)}%
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground font-medium">Active Insights</span>
              <Lightbulb className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="text-lg font-semibold font-mono">{stats?.activeInsights || 0}</div>
            <p className="text-[10px] text-muted-foreground mt-1">
              of {stats?.totalInsights || 0} total
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground font-medium">Best Asset</span>
              <TrendingUp className="w-4 h-4 text-emerald-500" />
            </div>
            <div className="text-sm font-semibold">
              {stats?.bestAsset?.coin || "—"}
            </div>
            <p className="text-[10px] text-emerald-500 font-mono mt-1">
              {stats?.bestAsset ? `${(stats.bestAsset.winRate * 100).toFixed(0)}% win rate` : "Not enough data"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground font-medium">Worst Asset</span>
              <TrendingDown className="w-4 h-4 text-red-500" />
            </div>
            <div className="text-sm font-semibold">
              {stats?.worstAsset?.coin || "—"}
            </div>
            <p className="text-[10px] text-red-500 font-mono mt-1">
              {stats?.worstAsset ? `${(stats.worstAsset.winRate * 100).toFixed(0)}% win rate` : "Not enough data"}
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="insights">
        <TabsList>
          <TabsTrigger value="insights">Learned Insights ({insights.length})</TabsTrigger>
          <TabsTrigger value="decisions">Decision Log ({decisions.length})</TabsTrigger>
        </TabsList>

        {/* Insights Tab */}
        <TabsContent value="insights">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Active Learning Rules</CardTitle>
              <CardDescription className="text-xs">
                Patterns the bot has discovered from past trades. High-confidence rules actively filter entries.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Category</TableHead>
                      <TableHead className="text-xs">Rule</TableHead>
                      <TableHead className="text-xs">Description</TableHead>
                      <TableHead className="text-xs">Win Rate</TableHead>
                      <TableHead className="text-xs">Avg P&L</TableHead>
                      <TableHead className="text-xs">Samples</TableHead>
                      <TableHead className="text-xs">Confidence</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {insights.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-8">
                          No insights yet — the bot needs more trades to learn patterns
                        </TableCell>
                      </TableRow>
                    ) : (
                      insights.map((insight: any) => (
                        <TableRow key={insight.id}>
                          <TableCell>
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 capitalize">
                              {insight.category}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-[10px]">{insight.rule}</TableCell>
                          <TableCell className="text-xs max-w-[300px]">{insight.description}</TableCell>
                          <TableCell className={cn(
                            "font-mono text-xs font-medium",
                            (insight.winRate || 0) >= 0.5 ? "text-emerald-500" : "text-red-500"
                          )}>
                            {((insight.winRate || 0) * 100).toFixed(0)}%
                          </TableCell>
                          <TableCell className={cn(
                            "font-mono text-xs",
                            (insight.avgPnlPct || 0) >= 0 ? "text-emerald-500" : "text-red-500"
                          )}>
                            {(insight.avgPnlPct || 0).toFixed(2)}%
                          </TableCell>
                          <TableCell className="font-mono text-xs">{insight.sampleSize || 0}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <div className="w-12 h-1.5 rounded-full bg-muted overflow-hidden">
                                <div
                                  className={cn(
                                    "h-full rounded-full",
                                    (insight.confidence || 0) > 0.7 ? "bg-emerald-500" :
                                    (insight.confidence || 0) > 0.4 ? "bg-yellow-500" : "bg-red-500"
                                  )}
                                  style={{ width: `${(insight.confidence || 0) * 100}%` }}
                                />
                              </div>
                              <span className="text-[10px] font-mono">{((insight.confidence || 0) * 100).toFixed(0)}%</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            {insight.isActive ? (
                              <Badge className="text-[9px] px-1 py-0 bg-emerald-500/20 text-emerald-400 border-0">Active</Badge>
                            ) : (
                              <Badge variant="secondary" className="text-[9px] px-1 py-0">Inactive</Badge>
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
        </TabsContent>

        {/* Decision Log Tab */}
        <TabsContent value="decisions">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Decision History</CardTitle>
              <CardDescription className="text-xs">
                Every entry, skip, and exit decision with full reasoning. The brain of the learning loop.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Time</TableHead>
                      <TableHead className="text-xs">Asset</TableHead>
                      <TableHead className="text-xs">Action</TableHead>
                      <TableHead className="text-xs">Side</TableHead>
                      <TableHead className="text-xs">Price</TableHead>
                      <TableHead className="text-xs">C.Score</TableHead>
                      <TableHead className="text-xs">Outcome</TableHead>
                      <TableHead className="text-xs">P&L</TableHead>
                      <TableHead className="text-xs">Good?</TableHead>
                      <TableHead className="text-xs max-w-[300px]">Reasoning</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {decisions.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={10} className="text-center text-sm text-muted-foreground py-8">
                          No decisions yet — start the bot to begin logging
                        </TableCell>
                      </TableRow>
                    ) : (
                      decisions.map((d: any) => (
                        <TableRow key={d.id}>
                          <TableCell className="text-[10px] text-muted-foreground whitespace-nowrap">
                            {new Date(d.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </TableCell>
                          <TableCell className="font-medium text-xs">{d.coin}</TableCell>
                          <TableCell>
                            <Badge
                              variant={d.action === "entry" ? "default" : d.action === "skip" ? "secondary" : "outline"}
                              className="text-[10px] px-1.5 py-0 uppercase"
                            >
                              {d.action}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {d.side ? (
                              <span className={cn("text-xs font-medium", d.side === "long" ? "text-emerald-500" : "text-red-500")}>
                                {d.side === "long" ? <ArrowUpRight className="w-3 h-3 inline" /> : <ArrowDownRight className="w-3 h-3 inline" />}
                                {d.side}
                              </span>
                            ) : "—"}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            ${d.price?.toFixed(2) || "—"}
                          </TableCell>
                          <TableCell>
                            {d.confluenceScore != null ? (
                              <Badge variant="outline" className="text-[10px] px-1 py-0">
                                {d.confluenceScore}/7
                              </Badge>
                            ) : "—"}
                          </TableCell>
                          <TableCell>
                            {d.outcome ? (
                              <Badge
                                className={cn(
                                  "text-[10px] px-1.5 py-0 border-0",
                                  d.outcome === "win" ? "bg-emerald-500/20 text-emerald-400" :
                                  d.outcome === "loss" ? "bg-red-500/20 text-red-400" :
                                  "bg-yellow-500/20 text-yellow-400"
                                )}
                              >
                                {d.outcome}
                              </Badge>
                            ) : (
                              <span className="text-[10px] text-muted-foreground">pending</span>
                            )}
                          </TableCell>
                          <TableCell className={cn(
                            "font-mono text-xs",
                            (d.outcomePnlPct || 0) >= 0 ? "text-emerald-500" : "text-red-500"
                          )}>
                            {d.outcomePnlPct != null ? `${d.outcomePnlPct.toFixed(2)}%` : "—"}
                          </TableCell>
                          <TableCell>
                            {d.wasGoodDecision != null ? (
                              d.wasGoodDecision ? (
                                <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                              ) : (
                                <XCircle className="w-3.5 h-3.5 text-red-500" />
                              )
                            ) : (
                              <AlertTriangle className="w-3.5 h-3.5 text-muted-foreground" />
                            )}
                          </TableCell>
                          <TableCell className="text-[10px] text-muted-foreground max-w-[300px] truncate" title={d.reasoning}>
                            {d.reviewNotes || d.reasoning?.slice(0, 100) || "—"}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
