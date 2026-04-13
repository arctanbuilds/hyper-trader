import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  LayoutDashboard,
  ArrowLeftRight,
  ScanSearch,
  Settings,
  ScrollText,
  Play,
  Square,
  Zap,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const navItems = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/trades", label: "Trades", icon: ArrowLeftRight },
  { path: "/scanner", label: "Scanner", icon: ScanSearch },
  { path: "/settings", label: "Settings", icon: Settings },
  { path: "/logs", label: "Logs", icon: ScrollText },
];

export default function Sidebar() {
  const [location] = useLocation();

  const { data: status } = useQuery({
    queryKey: ["/api/status"],
    refetchInterval: 5000,
  });

  const startBot = useMutation({
    mutationFn: () => apiRequest("POST", "/api/bot/start"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/status"] }),
  });

  const stopBot = useMutation({
    mutationFn: () => apiRequest("POST", "/api/bot/stop"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/status"] }),
  });

  const isRunning = status?.isRunning;

  return (
    <aside className="w-64 h-screen flex flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border shrink-0">
      {/* Logo */}
      <div className="p-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <Zap className="w-4 h-4 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight">HyperTrader</h1>
            <p className="text-xs text-muted-foreground">Hyperliquid Bot</p>
          </div>
        </div>
      </div>

      {/* Bot Status & Control */}
      <div className="p-3 border-b border-sidebar-border">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className={cn(
              "w-2 h-2 rounded-full",
              isRunning ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"
            )} />
            <span className="text-xs font-medium">
              {isRunning ? "Running" : "Stopped"}
            </span>
          </div>
          <Badge variant={isRunning ? "default" : "secondary"} className="text-[10px] px-1.5 py-0">
            {status?.openPositions || 0} open
          </Badge>
        </div>
        <Button
          size="sm"
          className="w-full text-xs"
          variant={isRunning ? "destructive" : "default"}
          onClick={() => isRunning ? stopBot.mutate() : startBot.mutate()}
          disabled={startBot.isPending || stopBot.isPending}
          data-testid={isRunning ? "button-stop-bot" : "button-start-bot"}
        >
          {isRunning ? (
            <><Square className="w-3 h-3 mr-1.5" /> Stop Bot</>
          ) : (
            <><Play className="w-3 h-3 mr-1.5" /> Start Bot</>
          )}
        </Button>
      </div>

      {/* Quick Stats */}
      <div className="p-3 border-b border-sidebar-border space-y-1">
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Total P&L</span>
          <span className={cn(
            "font-mono font-medium",
            parseFloat(status?.combinedPnl || "0") >= 0 ? "text-emerald-500" : "text-red-500"
          )}>
            {parseFloat(status?.combinedPnl || "0") >= 0 ? "+" : ""}{status?.combinedPnl || "0.00"}%
          </span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Win Rate</span>
          <span className="font-mono font-medium">{status?.winRate || "0.0"}%</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Trades</span>
          <span className="font-mono font-medium">{status?.totalTrades || 0}</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2 space-y-0.5">
        {navItems.map((item) => {
          const isActive = location === item.path;
          return (
            <Link key={item.path} href={item.path}>
              <div
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm cursor-pointer transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                )}
                data-testid={`nav-${item.label.toLowerCase()}`}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </div>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-sidebar-border">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <TrendingUp className="w-3 h-3" />
          <span>v1.0 — Hyperliquid Perps</span>
        </div>
      </div>
    </aside>
  );
}
