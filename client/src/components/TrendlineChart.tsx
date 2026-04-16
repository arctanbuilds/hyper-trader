import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type LineData,
  type SeriesType,
  type ISeriesMarkersPluginApi,
  type Time,
} from "lightweight-charts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, TrendingUp, TrendingDown, Ban, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

interface TrendlineData {
  type: "ascending" | "descending";
  touches: number;
  strength: number;
  span: number;
  startTime: number;
  endTime: number;
  startPrice: number;
  endPrice: number;
  touchPoints: { idx: number; price: number; time: number }[];
  broken: boolean;
  breakoutTime: number | null;
  breakoutPrice: number | null;
  currentTLValue: number;
  distFromPrice: number;
  blacklisted: boolean;
}

interface APIResponse {
  candles: { time: number; open: number; high: number; low: number; close: number }[];
  trendlines: TrendlineData[];
  currentPrice: number;
}

export function TrendlineChart() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const tlSeriesRefs = useRef<ISeriesApi<SeriesType>[]>([]);
  const markerPluginRefs = useRef<ISeriesMarkersPluginApi<Time>[]>([]);

  const { data, isLoading, refetch, isFetching } = useQuery<APIResponse>({
    queryKey: ["/api/trendlines"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/trendlines");
      return res.json() as Promise<APIResponse>;
    },
    refetchInterval: 30000,
    staleTime: 15000,
  });

  // Initialize chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "hsl(225, 18%, 7%)" },
        textColor: "hsl(220, 10%, 55%)",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "hsl(220, 15%, 12%)" },
        horzLines: { color: "hsl(220, 15%, 12%)" },
      },
      width: chartContainerRef.current.clientWidth,
      height: 420,
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: "hsl(220, 15%, 15%)",
      },
      rightPriceScale: {
        borderColor: "hsl(220, 15%, 15%)",
      },
      crosshair: {
        horzLine: { color: "hsl(220, 10%, 30%)", style: 2 },
        vertLine: { color: "hsl(220, 10%, 30%)", style: 2 },
      },
    });

    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e80",
      wickDownColor: "#ef444480",
    });

    candleSeriesRef.current = candleSeries;

    // Handle resize
    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Update data
  useEffect(() => {
    if (!data || !chartRef.current || !candleSeriesRef.current) return;

    const chart = chartRef.current;

    // Remove old marker plugins
    for (const mp of markerPluginRefs.current) {
      try { mp.detach(); } catch {}
    }
    markerPluginRefs.current = [];

    // Remove old TL series
    for (const s of tlSeriesRefs.current) {
      try { chart.removeSeries(s); } catch {}
    }
    tlSeriesRefs.current = [];

    // Set candle data
    if (data.candles.length > 0) {
      const candleData: CandlestickData[] = data.candles.map((c: any) => ({
        time: c.time as any,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      candleSeriesRef.current.setData(candleData);
    }

    // Draw trendlines
    for (const tl of data.trendlines) {
      // TL line color: descending = cyan, ascending = orange, blacklisted = grey/striped
      let color = tl.type === "descending" ? "#06b6d4" : "#f97316"; // cyan / orange
      if (tl.blacklisted) color = "#6b7280"; // grey for blacklisted
      if (tl.broken) color = tl.type === "descending" ? "#06b6d480" : "#f9731680"; // fade if broken

      const lineSeries = chart.addSeries(LineSeries, {
        color,
        lineWidth: tl.blacklisted ? 1 : 2,
        lineStyle: tl.blacklisted ? 2 : 0, // dashed if blacklisted
        pointMarkersVisible: false,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
      });

      const lineData: LineData[] = [
        { time: tl.startTime as any, value: tl.startPrice },
        { time: tl.endTime as any, value: tl.endPrice },
      ];
      lineSeries.setData(lineData);
      tlSeriesRefs.current.push(lineSeries);

      // Draw touch point markers using createSeriesMarkers (v5 API)
      if (tl.touchPoints.length > 0) {
        const markerSeries = chart.addSeries(LineSeries, {
          color: "transparent",
          lineWidth: 0,
          pointMarkersVisible: false,
          crosshairMarkerVisible: false,
          lastValueVisible: false,
          priceLineVisible: false,
        });

        const markerData: LineData[] = tl.touchPoints.map((tp: any) => ({
          time: tp.time as any,
          value: tp.price,
        }));
        markerSeries.setData(markerData);

        const markers = tl.touchPoints.map((tp: any) => ({
          time: tp.time as any,
          position: tl.type === "descending" ? "aboveBar" as const : "belowBar" as const,
          color: tl.blacklisted ? "#6b7280" : (tl.type === "descending" ? "#06b6d4" : "#f97316"),
          shape: "circle" as const,
          size: 1,
        }));

        const markerPlugin = createSeriesMarkers(markerSeries, markers);
        markerPluginRefs.current.push(markerPlugin);
        tlSeriesRefs.current.push(markerSeries);
      }

      // Draw breakout marker
      if (tl.broken && tl.breakoutTime && tl.breakoutPrice) {
        const brkSeries = chart.addSeries(LineSeries, {
          color: "transparent",
          lineWidth: 0,
          pointMarkersVisible: false,
          crosshairMarkerVisible: false,
          lastValueVisible: false,
          priceLineVisible: false,
        });

        brkSeries.setData([{ time: tl.breakoutTime as any, value: tl.breakoutPrice }]);

        const brkPlugin = createSeriesMarkers(brkSeries, [{
          time: tl.breakoutTime as any,
          position: tl.type === "descending" ? "aboveBar" as const : "belowBar" as const,
          color: "#facc15", // yellow for breakout
          shape: "arrowUp" as const,
          size: 2,
          text: "BRK",
        }]);
        markerPluginRefs.current.push(brkPlugin);
        tlSeriesRefs.current.push(brkSeries);
      }
    }

    chart.timeScale().fitContent();
  }, [data]);

  return (
    <div className="space-y-3">
      {/* Chart */}
      <div className="relative">
        <div ref={chartContainerRef} className="rounded-md overflow-hidden border border-border" />
        <div className="absolute top-2 right-2 z-10">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 bg-background/80 backdrop-blur-sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={cn("w-3 h-3", isFetching && "animate-spin")} />
          </Button>
        </div>
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50 rounded-md">
            <span className="text-sm text-muted-foreground">Loading 5m candles...</span>
          </div>
        )}
      </div>

      {/* TL Legend */}
      {data && data.trendlines.length > 0 && (
        <div className="space-y-1.5">
          {data.trendlines.map((tl, i) => (
            <div
              key={i}
              className={cn(
                "flex items-center justify-between px-3 py-2 rounded-md text-xs border",
                tl.blacklisted
                  ? "bg-zinc-900/50 border-zinc-800 opacity-60"
                  : tl.broken
                    ? "bg-yellow-500/5 border-yellow-500/20"
                    : "bg-muted/30 border-border"
              )}
            >
              <div className="flex items-center gap-2">
                {tl.type === "descending" ? (
                  <TrendingDown className="w-3.5 h-3.5 text-cyan-400" />
                ) : (
                  <TrendingUp className="w-3.5 h-3.5 text-orange-400" />
                )}
                <span className="font-medium">
                  {tl.type === "descending" ? "Descending" : "Ascending"} TL
                </span>
                <Badge variant="outline" className="text-[9px] px-1 py-0">
                  {tl.touches} touches
                </Badge>
                <Badge variant="outline" className="text-[9px] px-1 py-0">
                  {tl.span} bars
                </Badge>
                <Badge variant="outline" className="text-[9px] px-1 py-0">
                  str:{tl.strength}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                {tl.blacklisted && (
                  <Badge className="text-[9px] px-1.5 py-0 bg-zinc-700 text-zinc-300 border-0">
                    <Ban className="w-2.5 h-2.5 mr-0.5" />
                    Blacklisted
                  </Badge>
                )}
                {tl.broken && !tl.blacklisted && (
                  <Badge className="text-[9px] px-1.5 py-0 bg-yellow-500/20 text-yellow-400 border-0">
                    <Zap className="w-2.5 h-2.5 mr-0.5" />
                    Broken
                  </Badge>
                )}
                <span className={cn(
                  "font-mono text-[10px]",
                  Math.abs(tl.distFromPrice) < 0.1 ? "text-emerald-400" : "text-muted-foreground"
                )}>
                  {tl.distFromPrice > 0 ? "+" : ""}{tl.distFromPrice.toFixed(3)}% from price
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {data && data.trendlines.length === 0 && !isLoading && (
        <div className="text-center py-4 text-sm text-muted-foreground">
          No qualifying trendlines detected (need 20+ candles, 2+ touches)
        </div>
      )}
    </div>
  );
}
