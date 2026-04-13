import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { Save, Shield, Zap, Target, Gauge, ExternalLink, Wallet } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";

export default function Settings() {
  const { toast } = useToast();
  const { data: config, isLoading } = useQuery({
    queryKey: ["/api/config"],
    queryFn: () => apiRequest("GET", "/api/config").then(r => r.json()),
  });

  const [form, setForm] = useState<any>({});

  useEffect(() => {
    if (config) setForm(config);
  }, [config]);

  const saveConfig = useMutation({
    mutationFn: (data: any) => apiRequest("PATCH", "/api/config", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/config"] });
      toast({ title: "Settings saved", description: "Configuration updated successfully." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save settings.", variant: "destructive" });
    },
  });

  const handleSave = () => {
    const { id, updatedAt, ...data } = form;
    saveConfig.mutate(data);
  };

  if (isLoading) return <div className="p-6">Loading...</div>;

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Settings</h2>
          <p className="text-sm text-muted-foreground">Configure bot behavior, risk parameters, and API connection</p>
        </div>
        <Button onClick={handleSave} disabled={saveConfig.isPending} data-testid="button-save-settings">
          <Save className="w-3.5 h-3.5 mr-1.5" />
          {saveConfig.isPending ? "Saving..." : "Save All"}
        </Button>
      </div>

      {/* API Connection */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="w-4 h-4" /> Hyperliquid Connection
          </CardTitle>
          <CardDescription className="text-xs">
            Connect your Hyperliquid wallet. API keys can only trade — they cannot withdraw funds.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-xs">Wallet Address</Label>
            <Input
              value={form.walletAddress || ""}
              onChange={(e) => setForm({ ...form, walletAddress: e.target.value })}
              placeholder="0x..."
              className="font-mono text-xs"
              data-testid="input-wallet-address"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">API Secret Key</Label>
            <Input
              type="password"
              value={form.apiSecret || ""}
              onChange={(e) => setForm({ ...form, apiSecret: e.target.value })}
              placeholder="Your Hyperliquid API private key"
              className="font-mono text-xs"
              data-testid="input-api-secret"
            />
            <p className="text-[10px] text-muted-foreground">
              Generate from Hyperliquid → More → API. Max 180-day expiry.
            </p>
          </div>
          <a
            href="https://app.hyperliquid.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary flex items-center gap-1 hover:underline"
          >
            Open Hyperliquid <ExternalLink className="w-3 h-3" />
          </a>
        </CardContent>
      </Card>

      {/* Strategy Parameters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Target className="w-4 h-4" /> Strategy Parameters
          </CardTitle>
          <CardDescription className="text-xs">
            RSI thresholds and signal configuration
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">RSI Oversold (Long Signal)</Label>
              <div className="flex items-center gap-3">
                <Slider
                  value={[form.rsiOversoldThreshold || 20]}
                  onValueChange={([v]) => setForm({ ...form, rsiOversoldThreshold: v })}
                  min={5}
                  max={40}
                  step={1}
                  className="flex-1"
                />
                <span className="text-xs font-mono w-8 text-right text-emerald-500">
                  {form.rsiOversoldThreshold || 20}
                </span>
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">RSI Overbought (Short Signal)</Label>
              <div className="flex items-center gap-3">
                <Slider
                  value={[form.rsiOverboughtThreshold || 80]}
                  onValueChange={([v]) => setForm({ ...form, rsiOverboughtThreshold: v })}
                  min={60}
                  max={95}
                  step={1}
                  className="flex-1"
                />
                <span className="text-xs font-mono w-8 text-right text-red-500">
                  {form.rsiOverboughtThreshold || 80}
                </span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Min 24h Volume (USD)</Label>
              <Input
                type="number"
                value={form.minVolume24h || 1000000}
                onChange={(e) => setForm({ ...form, minVolume24h: parseFloat(e.target.value) })}
                className="font-mono text-xs"
                data-testid="input-min-volume"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Scan Interval (seconds)</Label>
              <Input
                type="number"
                value={form.scanIntervalSecs || 60}
                onChange={(e) => setForm({ ...form, scanIntervalSecs: parseInt(e.target.value) })}
                className="font-mono text-xs"
                data-testid="input-scan-interval"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Risk Management */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Gauge className="w-4 h-4" /> Risk Management
          </CardTitle>
          <CardDescription className="text-xs">
            Leverage, position sizing, and stop/TP configuration
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Max Leverage</Label>
              <div className="flex items-center gap-3">
                <Slider
                  value={[form.maxLeverage || 20]}
                  onValueChange={([v]) => setForm({ ...form, maxLeverage: v })}
                  min={1}
                  max={50}
                  step={1}
                  className="flex-1"
                />
                <span className="text-xs font-mono w-8 text-right font-medium">{form.maxLeverage || 20}x</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Max Open Positions</Label>
              <div className="flex items-center gap-3">
                <Slider
                  value={[form.maxPositions || 5]}
                  onValueChange={([v]) => setForm({ ...form, maxPositions: v })}
                  min={1}
                  max={20}
                  step={1}
                  className="flex-1"
                />
                <span className="text-xs font-mono w-8 text-right">{form.maxPositions || 5}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Trade Size (% of capital)</Label>
              <Input
                type="number"
                value={form.tradeAmountPct || 10}
                onChange={(e) => setForm({ ...form, tradeAmountPct: parseFloat(e.target.value) })}
                className="font-mono text-xs"
                data-testid="input-trade-size"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Stop Loss %</Label>
              <Input
                type="number"
                value={form.stopLossPct || 2}
                onChange={(e) => setForm({ ...form, stopLossPct: parseFloat(e.target.value) })}
                className="font-mono text-xs"
                data-testid="input-stop-loss"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Take Profit %</Label>
              <Input
                type="number"
                value={form.takeProfitPct || 5}
                onChange={(e) => setForm({ ...form, takeProfitPct: parseFloat(e.target.value) })}
                className="font-mono text-xs"
                data-testid="input-take-profit"
              />
            </div>
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs">Trailing Stop Loss</Label>
              <p className="text-[10px] text-muted-foreground">Auto-trail stop as profit grows</p>
            </div>
            <Switch
              checked={form.useTrailingStop ?? true}
              onCheckedChange={(v) => setForm({ ...form, useTrailingStop: v })}
              data-testid="switch-trailing-stop"
            />
          </div>

          {form.useTrailingStop && (
            <div className="space-y-2">
              <Label className="text-xs">Trailing Stop %</Label>
              <Input
                type="number"
                value={form.trailingStopPct || 1.5}
                onChange={(e) => setForm({ ...form, trailingStopPct: parseFloat(e.target.value) })}
                className="font-mono text-xs"
                data-testid="input-trailing-stop"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Target */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Zap className="w-4 h-4" /> Performance Target
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Weekly Target (%)</Label>
              <Input
                type="number"
                value={form.weeklyTargetPct || 50}
                onChange={(e) => setForm({ ...form, weeklyTargetPct: parseFloat(e.target.value) })}
                className="font-mono text-xs"
                data-testid="input-weekly-target"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Max Drawdown (%)</Label>
              <Input
                type="number"
                value={form.maxDrawdownPct || 10}
                onChange={(e) => setForm({ ...form, maxDrawdownPct: parseFloat(e.target.value) })}
                className="font-mono text-xs"
                data-testid="input-max-drawdown"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Capital Management Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Wallet className="w-4 h-4" /> Capital & Withdrawals
          </CardTitle>
          <CardDescription className="text-xs">
            Manage your capital directly on Hyperliquid
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Your funds stay in your Hyperliquid wallet at all times. The bot uses API keys that can only trade — they cannot withdraw.
            To add capital or withdraw profits, use the Hyperliquid interface directly.
          </p>
          <div className="flex gap-2">
            <a
              href="https://app.hyperliquid.xyz/portfolio"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button size="sm" variant="outline" className="text-xs" data-testid="button-open-portfolio">
                <Wallet className="w-3 h-3 mr-1.5" /> Open Portfolio
                <ExternalLink className="w-3 h-3 ml-1" />
              </Button>
            </a>
            <a
              href="https://app.hyperliquid.xyz/trade"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button size="sm" variant="outline" className="text-xs">
                <ExternalLink className="w-3 h-3 mr-1.5" /> Trade Interface
              </Button>
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
