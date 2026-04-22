import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Circle, Diamond, Gem, Minus, FileText, Settings2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { path: "/", label: "Dashboard", icon: Circle },
  { path: "/trades", label: "Trades", icon: Diamond },
  { path: "/scanner", label: "Scanner", icon: Gem },
  { path: "/logs", label: "Activity", icon: Minus },
  { path: "/learning", label: "Learning", icon: FileText },
  { path: "/settings", label: "Settings", icon: Settings2 },
];

export default function Sidebar() {
  const [location] = useLocation();

  const { data: status } = useQuery<any>({
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
    <aside className="w-60 min-h-screen flex flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border shrink-0">
      {/* Brand */}
      <div className="px-6 pt-8 pb-6">
        <div className="flex items-center gap-2">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-sidebar-foreground">
            <path d="M12 3L22 20H2L12 3Z" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
          <span className="font-serif text-[17px] tracking-tight">HyperTrader</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 space-y-0.5">
        {navItems.map((item) => {
          const isActive = location === item.path;
          const Icon = item.icon;
          return (
            <Link key={item.path} href={item.path}>
              <div
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-[13px] cursor-pointer transition-colors",
                  isActive
                    ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                    : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/60"
                )}
                data-testid={`nav-${item.label.toLowerCase()}`}
              >
                <Icon className="w-3 h-3" strokeWidth={1.5} />
                <span>{item.label}</span>
              </div>
            </Link>
          );
        })}
      </nav>

      {/* Bot control — minimal inline */}
      <div className="px-6 py-4 space-y-3 border-t border-sidebar-border">
        <button
          onClick={() => (isRunning ? stopBot.mutate() : startBot.mutate())}
          disabled={startBot.isPending || stopBot.isPending}
          className="w-full text-left text-[11px] tracking-wide flex items-center justify-between group"
          data-testid={isRunning ? "button-stop-bot" : "button-start-bot"}
        >
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full",
                isRunning ? "bg-[hsl(var(--positive))] animate-pulse" : "bg-muted-foreground/40"
              )}
            />
            <span className="text-foreground/80">{isRunning ? "Bot running" : "Bot stopped"}</span>
          </span>
          <span className="text-muted-foreground group-hover:text-foreground transition-colors">
            {isRunning ? "stop" : "start"} →
          </span>
        </button>
      </div>

      {/* Footer */}
      <div className="px-6 pb-6">
        <div className="text-[11px] leading-tight">
          <div className="font-medium text-foreground/80">Operator</div>
          <div className="text-muted-foreground">v17.1 · BTC Session</div>
        </div>
      </div>
    </aside>
  );
}
