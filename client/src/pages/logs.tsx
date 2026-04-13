import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const typeConfig: Record<string, { label: string; color: string; variant: "default" | "secondary" | "destructive" }> = {
  trade_open: { label: "OPEN", color: "text-emerald-500", variant: "default" },
  trade_close: { label: "CLOSE", color: "text-blue-500", variant: "secondary" },
  scan: { label: "SCAN", color: "text-yellow-500", variant: "secondary" },
  error: { label: "ERROR", color: "text-red-500", variant: "destructive" },
  system: { label: "SYSTEM", color: "text-muted-foreground", variant: "secondary" },
  config_change: { label: "CONFIG", color: "text-purple-500", variant: "secondary" },
  withdrawal: { label: "WITHDRAW", color: "text-orange-500", variant: "secondary" },
};

export default function Logs() {
  const { data: logs = [], isLoading } = useQuery({
    queryKey: ["/api/logs"],
    queryFn: () => apiRequest("GET", "/api/logs?limit=500").then(r => r.json()),
    refetchInterval: 5000,
  });

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Activity Log</h2>
        <p className="text-sm text-muted-foreground">Complete bot activity history</p>
      </div>

      <Card>
        <CardContent className="p-0">
          <ScrollArea className="h-[calc(100vh-180px)]">
            <div className="divide-y divide-border">
              {isLoading ? (
                <div className="p-8 text-center text-sm text-muted-foreground">Loading...</div>
              ) : logs.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  No activity yet — start the bot to begin
                </div>
              ) : (
                (logs as any[]).map((log: any) => {
                  const cfg = typeConfig[log.type] || typeConfig.system;
                  return (
                    <div
                      key={log.id}
                      className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors"
                      data-testid={`log-entry-${log.id}`}
                    >
                      <Badge
                        variant={cfg.variant}
                        className="text-[9px] px-1.5 py-0 mt-0.5 shrink-0 w-14 justify-center font-mono"
                      >
                        {cfg.label}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs leading-relaxed">{log.message}</p>
                        {log.data && log.data !== "" && (
                          <p className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate">
                            {log.data}
                          </p>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0 font-mono">
                        {new Date(log.timestamp).toLocaleString([], {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
