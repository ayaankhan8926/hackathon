import { useEffect, useRef, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";

const COLORS: Record<string, string> = {
  hospital:  "#ff4d4d",
  emergency: "#22d3a0",
  power:     "#f59e0b",
  water:     "#60a5fa",
  shelter:   "#a78bfa",
};

interface Agent {
  id: string; name: string; priority: number;
  min_need: number; max_need: number;
  allocated: number; satisfaction: number; status: string;
}
interface Metric   { fairness: number; efficiency: number; lives_risk: number; }
interface FeedItem { tick: number; type: string; msg: string; }
interface Cascade  { from: string; to: string; }
interface SimState {
  tick: number; supply: number; neg_round: number;
  disruptions: number; mode: string;
  agents: Agent[]; cascades: Cascade[];
  metrics: Metric; feed: FeedItem[];
  history: Record<string, number>[];
  active_event: string | null;
}
interface AIResult {
  reasoning: string;
  recommendations: Record<string, number>;
  confidence: number;
  key_insight: string;
}
interface ForecastItem {
  tick_offset: number; agent: string; agent_id: string;
  from_status: string; to_status: string;
  confidence: number; supply_at: number;
  cascade_from?: string;
}
interface ForecastResult {
  forecast: ForecastItem[];
  recommendation: string;
  severity: string;
  ticks_ahead: number;
  supply_now: number;
}

export default function App() {
  const [state,          setState]          = useState<SimState | null>(null);
  const [paused,         setPaused]         = useState(false);
  const [aiLoading,      setAiLoading]      = useState(false);
  const [aiResult,       setAiResult]       = useState<AIResult | null>(null);
  const [aiError,        setAiError]        = useState<string | null>(null);
  const [forecast,       setForecast]       = useState<ForecastResult | null>(null);
  const [forecastLoading,setForecastLoading]= useState(false);
  const ws      = useRef<WebSocket | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const socket = new WebSocket("ws://localhost:8000/ws");
    ws.current   = socket;
    socket.onmessage = (e) => setState(JSON.parse(e.data));
    return () => socket.close();
  }, []);

  useEffect(() => {
    if (feedRef.current)
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [state?.feed]);

  // Auto-refresh forecast every 5 ticks
  useEffect(() => {
    if (!state) return;
    if (state.tick % 5 === 0) fetchForecast();
  }, [state?.tick]);

  const send = (msg: object) =>
    ws.current?.send(JSON.stringify(msg));

  const fetchForecast = async () => {
    setForecastLoading(true);
    try {
      const res  = await fetch("http://localhost:8000/forecast");
      const data = await res.json();
      setForecast(data);
    } catch (e) {}
    setForecastLoading(false);
  };

  const analyzeWithAI = async () => {
    if (!state || aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    setAiResult(null);
    try {
      const res = await fetch("http://localhost:8000/analyze", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supply:   state.supply,
          tick:     state.tick,
          agents:   state.agents,
          cascades: state.cascades,
          mode:     state.mode,
        }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data: AIResult = await res.json();
      setAiResult(data);
    } catch (e: any) {
      setAiError(e.message || "Analysis failed");
    }
    setAiLoading(false);
  };

  const applyAIPriorities = () => {
    if (!aiResult) return;
    send({ action: "set_priorities", value: aiResult.recommendations });
    setAiResult(null);
  };

  if (!state) return (
    <div style={S.loading}>
      <div style={S.loadingText}>CONNECTING TO NEGOTIATION ENGINE...</div>
    </div>
  );

  const {
    agents, metrics, feed, history, cascades,
    tick, supply, neg_round, disruptions, mode, active_event,
  } = state;

  return (
    <div style={S.app}>

      {/* ── HEADER ── */}
      <div style={S.header}>
        <div>
          <div style={S.headerTitle}>
            CRISIS RESOURCE ALLOCATION — NEGOTIATION SIM
          </div>
          <div style={S.headerSub}>
            Multi-agent coordination under constrained power supply
          </div>
        </div>
        <div style={S.headerBadges}>
          <Badge label={`T+${tick}s`} />
          <Badge label={`Supply: ${supply} MW`} />
          <Badge label={`Round: ${neg_round}`} />
          <div style={{ ...S.dot, background: paused ? "#f59e0b" : "#22d3a0" }} />
        </div>
      </div>

      {/* ── EVENT BANNER ── */}
      {active_event && (
        <div style={S.eventBanner}>⚠ ACTIVE EVENT: {active_event}</div>
      )}

      <div style={S.main}>

        {/* ══ LEFT COLUMN ══ */}
        <div style={S.leftCol}>

          {/* POWER BARS */}
          <div style={S.section}>
            <div style={S.sectionLabel}>Power Allocation (MW)</div>
            {agents.map(a => (
              <div key={a.id} style={S.barWrap}>
                <div style={S.barLabel}>
                  <span style={{ color: COLORS[a.id] }}>{a.name}</span>
                  <span style={S.barValue}>{a.allocated} / {a.min_need} MW min</span>
                </div>
                <div style={S.barTrack}>
                  <div style={{
                    ...S.barFill,
                    width:      `${Math.min(100, (a.allocated / supply) * 100)}%`,
                    background: COLORS[a.id],
                  }} />
                </div>
              </div>
            ))}
            <div style={S.barFooter}>
              <span>Total: {agents.reduce((s, a) => s + a.allocated, 0).toFixed(1)} MW</span>
              <span>Available: {supply} MW</span>
            </div>
          </div>

          {/* TIMELINE CHART */}
          <div style={S.section}>
            <div style={S.sectionLabel}>Allocation History</div>
            <ResponsiveContainer width="100%" height={100}>
              <LineChart data={history}>
                <XAxis hide />
                <YAxis hide domain={[0, 40]} />
                <Tooltip
                  contentStyle={{ background: "#111318", border: "1px solid #252932", fontSize: 10 }}
                  labelFormatter={() => ""}
                />
                {agents.map(a => (
                  <Line key={a.id} type="monotone" dataKey={a.id}
                    stroke={COLORS[a.id]} strokeWidth={1.5} dot={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* AGENT CARDS */}
          <div style={S.section}>
            <div style={S.sectionLabel}>Agent Status</div>
            <div style={S.agentGrid}>
              {agents.map(a => (
                <div key={a.id} style={{
                  ...S.agentCard,
                  borderColor: a.status === "critical" ? COLORS[a.id]
                    : a.status === "degraded" ? "#f59e0b" : "#252932",
                  animation: a.status === "critical" ? "flash 1s infinite" : "none",
                }}>
                  <div style={S.agentName}>
                    <div style={{ ...S.agentDot, background: COLORS[a.id] }} />
                    <span style={{ flex: 1 }}>{a.name}</span>
                    <span style={{
                      ...S.statusBadge,
                      background: a.status === "nominal"  ? "rgba(34,211,160,0.15)"
                        : a.status === "degraded" ? "rgba(245,158,11,0.15)"
                        : "rgba(255,77,77,0.15)",
                      color: a.status === "nominal"  ? "#22d3a0"
                        : a.status === "degraded" ? "#f59e0b" : "#ff4d4d",
                    }}>
                      {a.status.toUpperCase()}
                    </span>
                  </div>
                  <AgentRow label="Allocated"    value={`${a.allocated} MW`} color={COLORS[a.id]} />
                  <AgentRow label="Min Need"     value={`${a.min_need} MW`} />
                  <AgentRow label="Priority"     value={`${a.priority}/10`} />
                  <AgentRow label="Satisfaction" value={`${a.satisfaction}%`} />
                </div>
              ))}
            </div>
          </div>

          {/* NEGOTIATION FEED */}
          <div style={S.section}>
            <div style={S.sectionLabel}>Negotiation Feed</div>
            <div style={S.feed} ref={feedRef}>
              {feed.map((f, i) => (
                <div key={i} style={{
                  ...S.feedLine,
                  borderLeftColor: f.type === "alert"   ? "#ff4d4d"
                    : f.type === "warning" ? "#f59e0b" : "#22d3a0",
                }}>
                  <span style={{ color: "#60a5fa" }}>[T+{f.tick}s]</span> {f.msg}
                </div>
              ))}
            </div>
          </div>

          {/* ══ AI PRIORITY ADJUSTMENT PANEL ══ */}
          <div style={S.aiPanel}>
            <div style={S.aiPanelHeader}>
              <div style={S.aiPanelTitle}>
                <div style={S.aiDot} />
                AI PRIORITY ADJUSTMENT
                <span style={S.aiBadge}>CLAUDE-POWERED</span>
              </div>
              <div style={S.aiStatusText}>
                {aiLoading ? "Analyzing with Claude..."
                  : aiResult ? "Recommendation ready"
                  : aiError  ? "Error — try again"
                  : "Standby"}
              </div>
            </div>

            <div style={S.aiBody}>
              {!aiResult && !aiLoading && !aiError && (
                <div style={S.aiHint}>
                  Click <span style={{ color: "#a78bfa" }}>ANALYZE WITH AI</span> to
                  let Claude evaluate the current crisis state and recommend optimal
                  priority weight adjustments for each agent.
                </div>
              )}

              {aiLoading && (
                <div style={S.aiLoading}>
                  <div style={{ ...S.aiLoadingDot, animationDelay: "0s" }} />
                  <div style={{ ...S.aiLoadingDot, animationDelay: "0.2s" }} />
                  <div style={{ ...S.aiLoadingDot, animationDelay: "0.4s" }} />
                  <span style={{ color: "#5a6070", fontSize: 10 }}>
                    Claude is analyzing the scenario...
                  </span>
                </div>
              )}

              {aiError && (
                <div style={S.aiError}>
                  ⚠ {aiError}. Make sure your API key is set in main.py.
                </div>
              )}

              {aiResult && (
                <div>
                  <div style={S.aiReasoningBox}>
                    <div style={S.aiReasoningLabel}>AI REASONING</div>
                    <div style={S.aiReasoningText}>{aiResult.reasoning}</div>
                    <div style={S.aiInsight}>⚡ {aiResult.key_insight}</div>
                  </div>

                  <div style={S.aiRecsLabel}>RECOMMENDED PRIORITY WEIGHTS</div>
                  <div style={S.aiRecs}>
                    {agents.map(a => {
                      const rec   = aiResult.recommendations[a.id];
                      const delta = rec - a.priority;
                      return (
                        <div key={a.id} style={{
                          ...S.aiRecRow,
                          borderColor: delta !== 0 ? "#f59e0b" : "#252932",
                        }}>
                          <div style={{ ...S.agentDot, background: COLORS[a.id] }} />
                          <span style={S.aiRecName}>{a.name}</span>
                          <div style={S.aiRecBarWrap}>
                            <div style={{
                              ...S.aiRecBarFill,
                              width:      `${rec * 10}%`,
                              background: COLORS[a.id],
                            }} />
                          </div>
                          <span style={{ ...S.aiRecNum, color: COLORS[a.id] }}>{rec}</span>
                          <span style={{
                            ...S.aiDeltaBadge,
                            background: delta > 0 ? "rgba(34,211,160,0.15)"
                              : delta < 0 ? "rgba(255,77,77,0.15)" : "rgba(42,47,58,1)",
                            color: delta > 0 ? "#22d3a0" : delta < 0 ? "#ff4d4d" : "#5a6070",
                          }}>
                            {delta > 0 ? `+${delta}` : delta === 0 ? "—" : delta}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div style={S.aiConfRow}>
                    <span style={S.aiConfLabel}>Confidence</span>
                    <div style={S.aiConfTrack}>
                      <div style={{ ...S.aiConfFill, width: `${aiResult.confidence}%` }} />
                    </div>
                    <span style={S.aiConfVal}>{aiResult.confidence}%</span>
                  </div>
                </div>
              )}
            </div>

            <div style={S.aiControls}>
              <button style={{
                ...S.btn, borderColor: "#a78bfa", color: "#a78bfa",
                opacity: aiLoading ? 0.5 : 1,
              }} onClick={analyzeWithAI} disabled={aiLoading}>
                ⚙ ANALYZE WITH AI
              </button>
              {aiResult && (
                <button style={{ ...S.btn, borderColor: "#22d3a0", color: "#22d3a0" }}
                  onClick={applyAIPriorities}>
                  ✓ APPLY TO ENGINE
                </button>
              )}
              {aiResult && (
                <button style={S.btn} onClick={() => setAiResult(null)}>
                  ✕ DISMISS
                </button>
              )}
            </div>
          </div>

          {/* ══ PREDICTIVE DAMAGE FORECAST PANEL ══ */}
          <div style={S.forecastPanel}>
            <div style={S.forecastHeader}>
              <div style={S.forecastTitle}>
                <div style={S.forecastDot} />
                PREDICTIVE DAMAGE FORECAST
                <span style={S.forecastBadge}>NEXT 10 TICKS</span>
              </div>
              <button style={{
                ...S.btn, fontSize: 8, padding: "2px 8px",
                borderColor: "#60a5fa", color: "#60a5fa",
              }} onClick={fetchForecast}>
                ↻ REFRESH
              </button>
            </div>

            <div style={S.forecastBody}>
              {/* Recommendation banner */}
              {forecast && (
                <div style={{
                  ...S.forecastRec,
                  background: forecast.severity === "critical" ? "rgba(255,77,77,0.08)"
                    : forecast.severity === "warning" ? "rgba(245,158,11,0.08)"
                    : "rgba(34,211,160,0.08)",
                  border: `1px solid ${
                    forecast.severity === "critical" ? "rgba(255,77,77,0.25)"
                    : forecast.severity === "warning" ? "rgba(245,158,11,0.25)"
                    : "rgba(34,211,160,0.25)"
                  }`,
                  color: forecast.severity === "critical" ? "#ff4d4d"
                    : forecast.severity === "warning" ? "#f59e0b" : "#22d3a0",
                }}>
                  ⚡ {forecast.recommendation}
                </div>
              )}

              {/* Empty state */}
              {forecast && forecast.forecast.length === 0 && (
                <div style={{ fontSize: 9, color: "#5a6070", padding: "4px 0" }}>
                  No state changes predicted in next 10 ticks. System stable.
                </div>
              )}

              {/* Forecast rows */}
              {forecast && forecast.forecast.map((f, i) => (
                <div key={i} style={{
                  ...S.forecastRow,
                  border: `1px solid ${
                    f.to_status === "critical"     ? "rgba(255,77,77,0.3)"
                    : f.to_status === "cascade_risk" ? "rgba(245,158,11,0.3)"
                    : "rgba(96,165,250,0.2)"
                  }`,
                }}>
                  <span style={S.forecastTick}>+{f.tick_offset}s</span>
                  <div style={{ ...S.agentDot, background: COLORS[f.agent_id] || "#5a6070" }} />
                  <span style={{ fontSize: 9, color: "#e8eaf0", flex: 1 }}>
                    {f.agent}
                    <span style={{ color: "#5a6070" }}> → </span>
                    <span style={{
                      color: f.to_status === "critical"      ? "#ff4d4d"
                        : f.to_status === "cascade_risk"  ? "#f59e0b"
                        : f.to_status === "degraded"      ? "#f59e0b" : "#22d3a0",
                      fontWeight: 700, textTransform: "uppercase" as const, fontSize: 8,
                    }}>
                      {f.to_status === "cascade_risk"
                        ? `CASCADE RISK (via ${f.cascade_from})`
                        : f.to_status}
                    </span>
                  </span>
                  <div style={S.forecastConfTrack}>
                    <div style={{
                      ...S.forecastConfFill,
                      width: `${f.confidence}%`,
                      background: f.to_status === "critical"     ? "#ff4d4d"
                        : f.to_status === "cascade_risk" ? "#f59e0b" : "#60a5fa",
                    }} />
                  </div>
                  <span style={S.forecastConfVal}>{f.confidence}%</span>
                </div>
              ))}

              {/* Loading */}
              {forecastLoading && (
                <div style={{ fontSize: 9, color: "#5a6070", padding: "4px 0" }}>
                  Computing forecast...
                </div>
              )}

              {/* Pre-empt button */}
              {forecast && forecast.severity !== "ok" && (
                <button style={{
                  ...S.btn, marginTop: 8, width: "100%",
                  borderColor: forecast.severity === "critical" ? "#ff4d4d" : "#f59e0b",
                  color:       forecast.severity === "critical" ? "#ff4d4d" : "#f59e0b",
                  fontSize: 9,
                }} onClick={() => { send({ action: "crisis_preempt" }); setForecast(null); }}>
                  ⚡ PRE-EMPT: INJECT BUFFER + ADJUST PRIORITIES
                </button>
              )}
            </div>
          </div>

        </div>{/* end leftCol */}

        {/* ══ RIGHT COLUMN ══ */}
        <div style={S.rightCol}>

          {/* METRICS */}
          <div style={S.panel}>
            <div style={S.sectionLabel}>System Metrics</div>
            <MetricRow label="Fairness Index" value={`${metrics.fairness}%`}
              color={metrics.fairness >= 80 ? "#22d3a0" : metrics.fairness >= 60 ? "#f59e0b" : "#ff4d4d"} />
            <MetricRow label="Efficiency" value={`${metrics.efficiency}%`}
              color={metrics.efficiency >= 80 ? "#22d3a0" : metrics.efficiency >= 60 ? "#f59e0b" : "#ff4d4d"} />
            <MetricRow label="Disruptions" value={String(disruptions)}
              color={disruptions === 0 ? "#22d3a0" : disruptions < 3 ? "#f59e0b" : "#ff4d4d"} />
            <MetricRow label="Lives at Risk"
              value={metrics.lives_risk > 0 ? `${metrics.lives_risk} HIGH` : "LOW"}
              color={metrics.lives_risk === 0 ? "#22d3a0" : "#ff4d4d"} />
            <MetricRow label="Neg. Rounds" value={String(neg_round)} color="#60a5fa" />
          </div>

          {/* CASCADE RISK */}
          <div style={S.panel}>
            <div style={S.sectionLabel}>Cascade Risk</div>
            {cascades.length === 0
              ? <div style={S.cascadeItem}>No active cascade risks</div>
              : cascades.map((c, i) => (
                <div key={i} style={{ ...S.cascadeItem, ...S.cascadeAlert }}>
                  {c.from} → {c.to} at risk
                </div>
              ))}
          </div>

          {/* DISASTER EVENTS */}
          <div style={S.panel}>
            <div style={S.sectionLabel}>Disaster Timeline</div>
            {[
              { t: 0,  n: "Earthquake M6.8" },
              { t: 8,  n: "Aftershock + Grid Damage" },
              { t: 16, n: "Hospital Surge" },
              { t: 24, n: "Power Plant Failure" },
              { t: 32, n: "Water Main Break" },
              { t: 40, n: "Emergency Deployment" },
              { t: 50, n: "Backup Generator Online" },
              { t: 60, n: "Secondary Fire Outbreak" },
              { t: 72, n: "National Grid Assist" },
            ].map(ev => (
              <div key={ev.t} style={{
                ...S.eventItem,
                color:       ev.t === tick - 1 ? "#f59e0b" : ev.t < tick ? "#2a2f3a" : "#5a6070",
                borderColor: ev.t === tick - 1 ? "rgba(245,158,11,0.3)" : "transparent",
                background:  ev.t === tick - 1 ? "rgba(245,158,11,0.08)" : "transparent",
              }}>
                T+{ev.t}s — {ev.n}
              </div>
            ))}
          </div>

        </div>
      </div>

      {/* ── CONTROLS ── */}
      <div style={S.controls}>
        <button style={{ ...S.btn, ...S.btnGreen }} onClick={handlePause}>
          {paused ? "▶ PLAY" : "⏸ PAUSE"}
        </button>
        <button style={{ ...S.btn, ...S.btnRed }}
          onClick={() => send({ action: "crisis" })}>
          ⚡ INJECT CRISIS
        </button>
        <button style={S.btn}
          onClick={() => {
            send({ action: "reset" });
            setPaused(false);
            setAiResult(null);
            setForecast(null);
          }}>
          ↺ RESET
        </button>
        <div style={S.modeWrap}>
          <span style={{ color: "#5a6070", fontSize: 10 }}>Mode:</span>
          {["priority", "equal"].map(m => (
            <button key={m} style={{
              ...S.modeBtn,
              borderColor: mode === m ? "#60a5fa" : "#2a2f3a",
              color:       mode === m ? "#60a5fa" : "#5a6070",
              background:  mode === m ? "rgba(96,165,250,0.1)" : "transparent",
            }} onClick={() => send({ action: "mode", value: m })}>
              {m.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0a0c10; font-family: 'JetBrains Mono', monospace; }
        @keyframes flash  { 0%,100%{opacity:1} 50%{opacity:0.6} }
        @keyframes pulse  { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes dots   { 0%,20%{opacity:0} 50%{opacity:1} 80%,100%{opacity:0} }
      `}</style>
    </div>
  );

  function handlePause() {
    const next = !paused;
    setPaused(next);
    send({ action: "pause", value: !next });
  }
}

// ── SMALL COMPONENTS ──────────────────────────────────────────────────────────
function Badge({ label }: { label: string }) {
  return <div style={S.badge}>{label}</div>;
}
function AgentRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={S.agentRow}>
      <span style={{ color: "#5a6070" }}>{label}</span>
      <span style={{ color: color || "#e8eaf0" }}>{value}</span>
    </div>
  );
}
function MetricRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={S.metricRow}>
      <span style={{ color: "#5a6070", fontSize: 10 }}>{label}</span>
      <span style={{ color, fontSize: 16, fontWeight: 700 }}>{value}</span>
    </div>
  );
}

// ── STYLES ────────────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  app:          { background: "#0a0c10", minHeight: "100vh", color: "#e8eaf0", display: "flex", flexDirection: "column" },
  loading:      { background: "#0a0c10", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center" },
  loadingText:  { color: "#5a6070", fontFamily: "monospace", letterSpacing: "0.1em" },
  header:       { padding: "10px 16px", borderBottom: "1px solid #252932", background: "#111318", display: "flex", alignItems: "center", justifyContent: "space-between" },
  headerTitle:  { fontSize: 13, fontWeight: 700, letterSpacing: "0.05em" },
  headerSub:    { fontSize: 10, color: "#5a6070", marginTop: 2 },
  headerBadges: { display: "flex", alignItems: "center", gap: 8 },
  badge:        { background: "#1e2128", border: "1px solid #252932", borderRadius: 4, padding: "2px 8px", fontSize: 10, color: "#e8eaf0" },
  dot:          { width: 8, height: 8, borderRadius: "50%" },
  eventBanner:  { background: "rgba(255,77,77,0.12)", borderBottom: "1px solid rgba(255,77,77,0.3)", padding: "5px 16px", fontSize: 10, color: "#ff4d4d", letterSpacing: "0.05em" },
  main:         { display: "flex", flex: 1, overflow: "hidden" },
  leftCol:      { flex: 1, display: "flex", flexDirection: "column", borderRight: "1px solid #252932", overflowY: "auto" },
  rightCol:     { width: 240, display: "flex", flexDirection: "column", overflowY: "auto" },
  section:      { padding: "10px 14px", borderBottom: "1px solid #252932" },
  panel:        { padding: "10px 14px", borderBottom: "1px solid #252932" },
  sectionLabel: { fontSize: 8, letterSpacing: "0.1em", color: "#5a6070", textTransform: "uppercase" as const, marginBottom: 8 },
  barWrap:      { marginBottom: 6 },
  barLabel:     { display: "flex", justifyContent: "space-between", marginBottom: 3, fontSize: 10 },
  barValue:     { color: "#5a6070", fontSize: 9 },
  barTrack:     { height: 5, background: "#1e2128", borderRadius: 3, overflow: "hidden" },
  barFill:      { height: "100%", borderRadius: 3, transition: "width 0.8s ease" },
  barFooter:    { display: "flex", justifyContent: "space-between", fontSize: 9, color: "#5a6070", marginTop: 4 },
  agentGrid:    { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 },
  agentCard:    { background: "#181b22", border: "1px solid #252932", borderRadius: 6, padding: "7px 9px", transition: "border-color 0.3s" },
  agentName:    { display: "flex", alignItems: "center", gap: 5, marginBottom: 5, fontSize: 10, fontWeight: 700 },
  agentDot:     { width: 6, height: 6, borderRadius: "50%", flexShrink: 0 },
  statusBadge:  { fontSize: 7, padding: "1px 4px", borderRadius: 3, fontWeight: 700 },
  agentRow:     { display: "flex", justifyContent: "space-between", fontSize: 9, marginBottom: 2 },
  feed:         { maxHeight: 140, overflowY: "auto" as const, display: "flex", flexDirection: "column" as const, gap: 3 },
  feedLine:     { fontSize: 9.5, borderLeft: "2px solid #2a2f3a", paddingLeft: 7, lineHeight: 1.5, color: "#5a6070" },
  metricRow:    { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, paddingBottom: 6, borderBottom: "1px solid #1e2128" },
  cascadeItem:  { fontSize: 9, color: "#5a6070", padding: "3px 5px", background: "#1e2128", borderRadius: 3, marginBottom: 3 },
  cascadeAlert: { background: "rgba(255,77,77,0.1)", color: "#ff4d4d" },
  eventItem:    { fontSize: 9, marginBottom: 3, padding: "3px 5px", borderRadius: 3, border: "1px solid transparent" },
  controls:     { padding: "8px 14px", borderTop: "1px solid #252932", background: "#111318", display: "flex", gap: 8, alignItems: "center" },
  btn:          { fontFamily: "monospace", fontSize: 10, padding: "4px 12px", border: "1px solid #252932", borderRadius: 4, cursor: "pointer", background: "#181b22", color: "#e8eaf0" },
  btnGreen:     { borderColor: "#22d3a0", color: "#22d3a0" },
  btnRed:       { borderColor: "#ff4d4d", color: "#ff4d4d" },
  modeWrap:     { marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 },
  modeBtn:      { fontFamily: "monospace", fontSize: 9, padding: "2px 8px", border: "1px solid", borderRadius: 3, cursor: "pointer" },

  // AI Panel
  aiPanel:        { borderTop: "1px solid rgba(167,139,250,0.25)", background: "rgba(167,139,250,0.04)" },
  aiPanelHeader:  { padding: "8px 14px", borderBottom: "1px solid rgba(167,139,250,0.15)", background: "rgba(167,139,250,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" },
  aiPanelTitle:   { display: "flex", alignItems: "center", gap: 7, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", color: "#e8eaf0" },
  aiDot:          { width: 7, height: 7, borderRadius: "50%", background: "#a78bfa", animation: "pulse 2s infinite" },
  aiBadge:        { background: "rgba(167,139,250,0.15)", border: "1px solid rgba(167,139,250,0.3)", borderRadius: 3, padding: "1px 6px", fontSize: 7, color: "#a78bfa", letterSpacing: "0.1em" },
  aiStatusText:   { fontSize: 9, color: "#5a6070" },
  aiBody:         { padding: "10px 14px" },
  aiHint:         { fontSize: 10, color: "#5a6070", lineHeight: 1.6 },
  aiLoading:      { display: "flex", alignItems: "center", gap: 8, padding: "8px 0" },
  aiLoadingDot:   { width: 5, height: 5, borderRadius: "50%", background: "#a78bfa", animation: "dots 1.2s infinite" },
  aiError:        { fontSize: 10, color: "#ff4d4d", padding: "6px 0", lineHeight: 1.5 },
  aiReasoningBox: { background: "#111318", border: "1px solid #252932", borderRadius: 5, padding: "8px 10px", marginBottom: 10 },
  aiReasoningLabel:{ fontSize: 7, letterSpacing: "0.1em", color: "#5a6070", textTransform: "uppercase" as const, marginBottom: 5 },
  aiReasoningText: { fontSize: 10, color: "#e8eaf0", lineHeight: 1.65, marginBottom: 6 },
  aiInsight:      { fontSize: 9, color: "#a78bfa", borderLeft: "2px solid #a78bfa", paddingLeft: 7, lineHeight: 1.5 },
  aiRecsLabel:    { fontSize: 7, letterSpacing: "0.1em", color: "#5a6070", textTransform: "uppercase" as const, marginBottom: 6 },
  aiRecs:         { display: "flex", flexDirection: "column" as const, gap: 4, marginBottom: 10 },
  aiRecRow:       { display: "flex", alignItems: "center", gap: 7, background: "#111318", border: "1px solid #252932", borderRadius: 4, padding: "5px 8px", transition: "border-color 0.3s" },
  aiRecName:      { fontSize: 9, color: "#e8eaf0", width: 100, flexShrink: 0 },
  aiRecBarWrap:   { flex: 1, height: 4, background: "#1e2128", borderRadius: 2, overflow: "hidden" },
  aiRecBarFill:   { height: "100%", borderRadius: 2, transition: "width 0.8s ease" },
  aiRecNum:       { fontSize: 11, fontWeight: 700, minWidth: 20, textAlign: "right" as const },
  aiDeltaBadge:   { fontSize: 8, padding: "1px 5px", borderRadius: 3, minWidth: 28, textAlign: "center" as const },
  aiConfRow:      { display: "flex", alignItems: "center", gap: 8 },
  aiConfLabel:    { fontSize: 9, color: "#5a6070", width: 70, flexShrink: 0 },
  aiConfTrack:    { flex: 1, height: 4, background: "#1e2128", borderRadius: 2, overflow: "hidden" },
  aiConfFill:     { height: "100%", borderRadius: 2, background: "#a78bfa", transition: "width 0.8s ease" },
  aiConfVal:      { fontSize: 9, color: "#a78bfa", minWidth: 30, textAlign: "right" as const },
  aiControls:     { padding: "8px 14px", borderTop: "1px solid rgba(167,139,250,0.15)", display: "flex", gap: 6 },

  // Forecast Panel
  forecastPanel:    { borderTop: "1px solid rgba(96,165,250,0.25)", background: "rgba(96,165,250,0.03)" },
  forecastHeader:   { padding: "8px 14px", borderBottom: "1px solid rgba(96,165,250,0.15)", background: "rgba(96,165,250,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" },
  forecastTitle:    { display: "flex", alignItems: "center", gap: 7, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", color: "#e8eaf0" },
  forecastDot:      { width: 7, height: 7, borderRadius: "50%", background: "#60a5fa", animation: "pulse 2s infinite" },
  forecastBadge:    { background: "rgba(96,165,250,0.15)", border: "1px solid rgba(96,165,250,0.3)", borderRadius: 3, padding: "1px 6px", fontSize: 7, color: "#60a5fa", letterSpacing: "0.1em" },
  forecastBody:     { padding: "10px 14px" },
  forecastRec:      { padding: "7px 10px", borderRadius: 4, marginBottom: 10, fontSize: 9.5, lineHeight: 1.6 },
  forecastRow:      { display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", marginBottom: 4, borderRadius: 4, background: "#111318" },
  forecastTick:     { fontSize: 8, color: "#60a5fa", minWidth: 32, fontWeight: 700 },
  forecastConfTrack:{ width: 40, height: 3, background: "#1e2128", borderRadius: 2, overflow: "hidden" },
  forecastConfFill: { height: "100%", borderRadius: 2, transition: "width 0.6s ease" },
  forecastConfVal:  { fontSize: 8, color: "#5a6070", minWidth: 28, textAlign: "right" as const },
};