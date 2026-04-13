import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Save, Shield, Zap, Target, Gauge, ExternalLink, Wallet, BarChart3, Clock, TrendingUp, Layers } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";

const ALLOWED_ASSETS = [
  { id: "BTC", label: "Bitcoin", ticker: "BTC", maxLev: 40 },
  { id: "ETH", label: "Ethereum", ticker: "ETH", maxLev: 25 },
  { id: "SOL", label: "Solana", ticker: "SOL", maxLev: 20 },
  { id: "GOLD", label: "Gold", ticker: "xyz:GOLD", maxLev: 25 },
  { id: "SILVER", label: "Silver", ticker: "xyz:SILVER", maxLev: 25 },
  { id: "OIL", label: "Oil WTI", ticker: "xyz:CL", maxLev: 20 },
  { id: "SP500", label: "S&P 500", ticker: "xyz:SP500", maxLev: 50 },
  { id: "EURUSD", label: "EUR/USD", ticker: "xyz:EUR", maxLev: 50 },
];

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

      {/* Asset Selection */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Layers className="w-4 h-4" /> Tradeable Assets
          </CardTitle>
          <CardDescription className="text-xs">
            Select which assets the bot can trade. Includes main perps and HIP-3 commodity/forex perps.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {ALLOWED_ASSETS.map((asset) => {
              // For now all assets are enabled — the engine uses the full whitelist
              return (
                <div
                  key={asset.id}
                  className="flex items-center justify-between p-2.5 rounded-md border border-border bg-muted/30"
                >
                  <div>
                    <span className="text-xs font-medium">{asset.label}</span>
                    <p className="text-[10px] text-muted-foreground font-mono">{asset.ticker}</p>
                  </div>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    {asset.maxLev}x
                  </Badge>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">
            Max leverage shown is per-asset Hyperliquid limit. Bot uses max available for each.
          </p>
        </CardContent>
      </Card>

      {/* Strategy Parameters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Target className="w-4 h-4" /> Strategy Parameters
          </CardTitle>
          <CardDescription className="text-xs">
            Multi-timeframe RSI thresholds and signal configuration
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

          <Separator />

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Min Confluence Score (1–7)</Label>
              <div className="flex items-center gap-3">
                <Slider
                  value={[form.minConfluenceScore || 3]}
                  onValueChange={([v]) => setForm({ ...form, minConfluenceScore: v })}
                  min={1}
                  max={7}
                  step={1}
                  className="flex-1"
                />
                <span className="text-xs font-mono w-8 text-right text-primary">
                  {form.minConfluenceScore || 3}/7
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground">Higher = stricter signal filtering</p>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Min Risk:Reward Ratio</Label>
              <div className="flex items-center gap-3">
                <Slider
                  value={[form.minRiskRewardRatio || 1.0]}
                  onValueChange={([v]) => setForm({ ...form, minRiskRewardRatio: v })}
                  min={0.5}
                  max={5.0}
                  step={0.1}
                  className="flex-1"
                />
                <span className="text-xs font-mono w-12 text-right text-primary">
                  1:{(form.minRiskRewardRatio || 1.0).toFixed(1)}
                </span>
              </div>
            </div>
          </div>

          <Separator />

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

      {/* Confluence Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <BarChart3 className="w-4 h-4" /> Confluence Filters
          </CardTitle>
          <CardDescription className="text-xs">
            Toggle individual confluence checks. Each adds +1 to the score.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs">EMA Trend Filter</Label>
              <p className="text-[10px] text-muted-foreground">Require price above/below EMA stack</p>
            </div>
            <Switch
              checked={form.useEmaFilter ?? true}
              onCheckedChange={(v) => setForm({ ...form, useEmaFilter: v })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs">Session Timing Filter</Label>
              <p className="text-[10px] text-muted-foreground">Only trade during London/NY sessions</p>
            </div>
            <Switch
              checked={form.useSessionFilter ?? true}
              onCheckedChange={(v) => setForm({ ...form, useSessionFilter: v })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs">Macro Trend Filter</Label>
              <p className="text-[10px] text-muted-foreground">Multi-timeframe RSI alignment</p>
            </div>
            <Switch
              checked={form.useMacroFilter ?? true}
              onCheckedChange={(v) => setForm({ ...form, useMacroFilter: v })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs">Liquidation Zone Filter</Label>
              <p className="text-[10px] text-muted-foreground">Avoid entry near liquidation clusters</p>
            </div>
            <Switch
              checked={form.useLiquidationFilter ?? true}
              onCheckedChange={(v) => setForm({ ...form, useLiquidationFilter: v })}
            />
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
            Leverage, position sizing, dual take profit, and stop/loss configuration
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Max Leverage</Label>
              <div className="flex items-center gap-3">
                <Slider
                  value={[form.maxLeverage || 50]}
                  onValueChange={([v]) => setForm({ ...form, maxLeverage: v })}
                  min={1}
                  max={50}
                  step={1}
                  className="flex-1"
                />
                <span className="text-xs font-mono w-8 text-right font-medium">{form.maxLeverage || 50}x</span>
              </div>
              <p className="text-[10px] text-muted-foreground">Uses max available per asset</p>
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

          <div className="grid grid-cols-2 gap-4">
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
              <Label className="text-xs">Max Risk Per Trade (%)</Label>
              <Input
                type="number"
                value={form.maxRiskPerTradePct ?? 0.25}
                onChange={(e) => setForm({ ...form, maxRiskPerTradePct: parseFloat(e.target.value) })}
                className="font-mono text-xs"
                step="0.05"
              />
              <p className="text-[10px] text-muted-foreground">Hard max loss per position</p>
            </div>
          </div>

          <Separator />

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Stop Loss %</Label>
              <Input
                type="number"
                value={form.stopLossPct ?? 0.35}
                onChange={(e) => setForm({ ...form, stopLossPct: parseFloat(e.target.value) })}
                className="font-mono text-xs"
                step="0.05"
                data-testid="input-stop-loss"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Take Profit 1 %</Label>
              <Input
                type="number"
                value={form.takeProfitPct ?? 0.5}
                onChange={(e) => setForm({ ...form, takeProfitPct: parseFloat(e.target.value) })}
                className="font-mono text-xs"
                step="0.1"
                data-testid="input-take-profit-1"
              />
              <p className="text-[10px] text-muted-foreground">Close 50% at TP1</p>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Take Profit 2 %</Label>
              <Input
                type="number"
                value={form.takeProfit2Pct ?? 1.0}
                onChange={(e) => setForm({ ...form, takeProfit2Pct: parseFloat(e.target.value) })}
                className="font-mono text-xs"
                step="0.1"
                data-testid="input-take-profit-2"
              />
              <p className="text-[10px] text-muted-foreground">Close remaining at TP2</p>
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
                value={form.trailingStopPct ?? 0.3}
                onChange={(e) => setForm({ ...form, trailingStopPct: parseFloat(e.target.value) })}
                className="font-mono text-xs"
                step="0.05"
                data-testid="input-trailing-stop"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Circuit Breakers */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="w-4 h-4" /> Circuit Breakers
          </CardTitle>
          <CardDescription className="text-xs">
            Daily and weekly loss limits to protect capital
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs">Max Daily Loss (%)</Label>
              <Input
                type="number"
                value={form.maxDailyLossPct ?? 0.75}
                onChange={(e) => setForm({ ...form, maxDailyLossPct: parseFloat(e.target.value) })}
                className="font-mono text-xs"
                step="0.1"
              />
              <p className="text-[10px] text-muted-foreground">Bot pauses if daily loss exceeds this</p>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Max Weekly Loss (%)</Label>
              <Input
                type="number"
                value={form.maxWeeklyLossPct ?? 1.5}
                onChange={(e) => setForm({ ...form, maxWeeklyLossPct: parseFloat(e.target.value) })}
                className="font-mono text-xs"
                step="0.1"
              />
              <p className="text-[10px] text-muted-foreground">Bot pauses if weekly loss exceeds this</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Performance Target */}
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
