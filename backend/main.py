import asyncio
import json
import re
import copy
import random
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── AGENT DEFINITIONS ────────────────────────────────────────────────────────
AGENTS_TEMPLATE = [
    {"id": "hospital",   "name": "Hospital",        "priority": 10, "min_need": 18, "max_need": 30, "depends_on": ["emergency"]},
    {"id": "emergency",  "name": "Emergency Svcs",  "priority": 9,  "min_need": 12, "max_need": 20, "depends_on": []},
    {"id": "power",      "name": "Power Grid",      "priority": 8,  "min_need": 15, "max_need": 25, "depends_on": []},
    {"id": "water",      "name": "Water Plant",     "priority": 7,  "min_need": 10, "max_need": 18, "depends_on": ["power"]},
    {"id": "shelter",    "name": "Shelter Network", "priority": 5,  "min_need": 6,  "max_need": 14, "depends_on": ["power"]},
]

# ── DISASTER EVENTS ──────────────────────────────────────────────────────────
EVENTS = [
    {"tick": 0,  "name": "Earthquake M6.8",         "type": "supply", "delta": 0,   "desc": "Grid at full capacity."},
    {"tick": 8,  "name": "Aftershock + Grid Damage", "type": "supply", "delta": -20, "desc": "Supply drops 20 MW."},
    {"tick": 16, "name": "Hospital Surge",           "type": "demand", "agent": "hospital",  "boost": 8, "desc": "Hospital min need +8 MW."},
    {"tick": 24, "name": "Power Plant Failure",      "type": "supply", "delta": -15, "desc": "Further supply drop."},
    {"tick": 32, "name": "Water Main Break",         "type": "demand", "agent": "water",     "boost": 5, "desc": "Water demand spike."},
    {"tick": 40, "name": "Emergency Deployment",     "type": "demand", "agent": "emergency", "boost": 4, "desc": "Emergency demand rises."},
    {"tick": 50, "name": "Backup Generator Online",  "type": "supply", "delta": 10,  "desc": "Partial supply restored."},
    {"tick": 60, "name": "Secondary Fire Outbreak",  "type": "supply", "delta": -10, "desc": "Grid rerouted for fires."},
    {"tick": 72, "name": "National Grid Assist",     "type": "supply", "delta": 20,  "desc": "Emergency transfer +20 MW."},
]

# ── SIMULATION STATE ─────────────────────────────────────────────────────────
def fresh_state():
    return {
        "supply":      100,
        "tick":        0,
        "neg_round":   0,
        "disruptions": 0,
        "mode":        "priority",
        "agents":      copy.deepcopy(AGENTS_TEMPLATE),
        "feed":        [],
        "history":     [],
        "active_event": None,
    }

sim = fresh_state()
connected_clients = set()

# ── NEGOTIATION ENGINE ───────────────────────────────────────────────────────
def negotiate(supply, agents, mode):
    allocs = {a["id"]: 0.0 for a in agents}
    if mode == "equal":
        share = supply / len(agents)
        for a in agents:
            allocs[a["id"]] = min(share, a["max_need"])
    else:
        sorted_agents = sorted(agents, key=lambda x: -x["priority"])
        remaining = supply
        for a in sorted_agents:
            give = min(a["min_need"], remaining)
            allocs[a["id"]] = give
            remaining -= give
            remaining = max(0, remaining)
        if remaining > 0:
            for a in sorted_agents:
                gap = a["max_need"] - allocs[a["id"]]
                if gap > 0:
                    extra = min(gap, remaining / len(sorted_agents))
                    allocs[a["id"]] += extra
                    remaining -= extra
    return allocs

def get_status(allocated, min_need):
    if min_need == 0:
        return "nominal"
    ratio = allocated / min_need
    if ratio >= 0.95:   return "nominal"
    elif ratio >= 0.70: return "degraded"
    else:               return "critical"

def check_cascades(agents):
    cascades = []
    critical_ids = {a["id"] for a in agents if a["status"] == "critical"}
    for a in agents:
        for dep in a["depends_on"]:
            if dep in critical_ids and a["status"] != "critical":
                cascades.append({
                    "from": next(x["name"] for x in agents if x["id"] == dep),
                    "to":   a["name"]
                })
    return cascades

def compute_metrics(agents, supply):
    allocs    = [a["allocated"] for a in agents]
    mean      = sum(allocs) / len(allocs) if allocs else 0
    variance  = sum((v - mean) ** 2 for v in allocs) / len(allocs) if allocs else 0
    fairness  = max(0, 1 - variance / 400)
    total_min   = sum(a["min_need"] for a in agents)
    total_alloc = sum(allocs)
    efficiency  = min(1.0, total_alloc / total_min) if total_min > 0 else 1.0
    critical_agents = [a for a in agents if a["status"] == "critical"]
    lives_risk = sum(
        3 if a["priority"] >= 9 else 1 if a["priority"] >= 7 else 0
        for a in critical_agents
    )
    return {
        "fairness":   round(fairness * 100, 1),
        "efficiency": round(efficiency * 100, 1),
        "lives_risk": lives_risk,
    }

# ── SIMULATION TICK ──────────────────────────────────────────────────────────
def sim_tick():
    global sim

    active_event = None
    for ev in EVENTS:
        if ev["tick"] == sim["tick"]:
            active_event = ev
            if ev["type"] == "supply":
                sim["supply"] = max(20, sim["supply"] + ev["delta"])
            elif ev["type"] == "demand":
                for a in sim["agents"]:
                    if a["id"] == ev["agent"]:
                        a["min_need"] = min(a["max_need"], a["min_need"] + ev["boost"])

    sim["neg_round"] += 1
    allocs = negotiate(sim["supply"], sim["agents"], sim["mode"])

    for a in sim["agents"]:
        prev_status     = a.get("status", "nominal")
        a["allocated"]  = round(allocs[a["id"]], 1)
        a["satisfaction"] = round(min(1.0, a["allocated"] / a["min_need"]) * 100, 0)
        a["status"]     = get_status(a["allocated"], a["min_need"])
        if a["status"] != "nominal" and prev_status == "nominal":
            sim["disruptions"] += 1

    cascades = check_cascades(sim["agents"])
    metrics  = compute_metrics(sim["agents"], sim["supply"])

    feed_entry = None
    if active_event:
        feed_entry = {"type": "alert", "msg": f"EVENT: {active_event['name']} — {active_event['desc']}"}
    else:
        critical = [a["name"] for a in sim["agents"] if a["status"] == "critical"]
        degraded = [a["name"] for a in sim["agents"] if a["status"] == "degraded"]
        if critical:
            feed_entry = {"type": "alert",   "msg": f"CRITICAL: {', '.join(critical)} below minimum threshold"}
        elif degraded:
            feed_entry = {"type": "warning", "msg": f"DEGRADED: {', '.join(degraded)} operating below capacity"}
        elif sim["tick"] % 6 == 0:
            feed_entry = {"type": "ok",      "msg": f"Round {sim['neg_round']}: All agents nominal. System stable."}

    if feed_entry:
        sim["feed"].append({"tick": sim["tick"], **feed_entry})
        if len(sim["feed"]) > 40:
            sim["feed"] = sim["feed"][-40:]

    snap = {a["id"]: a["allocated"] for a in sim["agents"]}
    sim["history"].append(snap)
    if len(sim["history"]) > 60:
        sim["history"] = sim["history"][-60:]

    sim["tick"]        += 1
    sim["active_event"] = active_event["name"] if active_event else None

    return {
        "tick":         sim["tick"],
        "supply":       sim["supply"],
        "neg_round":    sim["neg_round"],
        "disruptions":  sim["disruptions"],
        "mode":         sim["mode"],
        "agents":       sim["agents"],
        "cascades":     cascades,
        "metrics":      metrics,
        "feed":         sim["feed"][-10:],
        "history":      sim["history"],
        "active_event": sim["active_event"],
    }

# ── AI ANALYZE ENDPOINT (MOCK) ────────────────────────────────────────────────
class AnalyzeRequest(BaseModel):
    supply:   int
    tick:     int
    agents:   list
    cascades: list
    mode:     str

@app.post("/analyze")
async def analyze_priorities(req: AnalyzeRequest):
    critical = [a for a in req.agents if a.get("status") == "critical"]
    degraded = [a for a in req.agents if a.get("status") == "degraded"]

    recs = {}
    for a in req.agents:
        pid = a["id"]
        if pid == "hospital":
            recs[pid] = 10
        elif pid == "emergency":
            recs[pid] = 10 if critical else 9
        elif pid == "power":
            cascade_ids = [c["from"] for c in req.cascades]
            recs[pid] = 9 if "Power Grid" in cascade_ids else 8
        elif pid == "water":
            recs[pid] = 8 if any(a["id"] == "water" for a in critical) else 7
        elif pid == "shelter":
            recs[pid] = 4 if (critical or degraded) else 5
        else:
            recs[pid] = a["priority"]

    supply_pct = round((req.supply / 100) * 100)

    if supply_pct < 70:
        reasoning   = (f"Supply critically low at {req.supply} MW — {100 - supply_pct}% below baseline. Prioritizing Hospital and Emergency Services to protect life-safety systems. Shelter Network deprioritized to free allocation headroom for critical agents.")
        insight     = "Life-safety agents protected under severe supply constraint."
        confidence  = 96
    elif critical:
        crit_names  = ", ".join(a["name"] for a in critical)
        reasoning   = (f"{len(critical)} agent(s) in CRITICAL state at T+{req.tick}s: {crit_names}. Elevating dependency-chain priorities to prevent cascade propagation. Non-essential priorities reduced to compensate.")
        insight     = "Cascade risk drives emergency priority rebalancing now."
        confidence  = 88
    elif degraded:
        deg_names   = ", ".join(a["name"] for a in degraded)
        reasoning   = (f"{len(degraded)} agent(s) DEGRADED at T+{req.tick}s: {deg_names}. Supply at {req.supply} MW is sufficient but unevenly distributed. Adjusting weights to pull degraded agents back toward nominal before critical threshold.")
        insight     = "Early intervention prevents degraded agents hitting critical."
        confidence  = 91
    elif req.supply >= 85:
        reasoning   = (f"System fully stable at T+{req.tick}s with {req.supply} MW — all agents NOMINAL. No emergency adjustments required. Returning Shelter Network to baseline priority 5 to maximize fairness index.")
        insight     = "Stable supply — fairness-first allocation is optimal now."
        confidence  = 98
    else:
        reasoning   = (f"System stable at T+{req.tick}s with {req.supply} MW. Priority order well-balanced for this supply level. Minor adjustments applied to optimize fairness index without compromising life-safety guarantees.")
        insight     = "System stable — priorities optimized for fairness."
        confidence  = 94

    return {
        "reasoning":       reasoning,
        "recommendations": recs,
        "confidence":      confidence,
        "key_insight":     insight,
    }

# ── FORECAST ENGINE ──────────────────────────────────────────────────────────
def forecast_next_ticks(agents, supply, mode, ticks_ahead=10):
    forecast     = []
    sim_agents   = copy.deepcopy(agents)
    sim_supply   = supply
    current_tick = sim["tick"]

    upcoming_events = [
        ev for ev in EVENTS
        if current_tick <= ev["tick"] < current_tick + ticks_ahead
    ]

    for i in range(1, ticks_ahead + 1):
        future_tick = current_tick + i

        for ev in upcoming_events:
            if ev["tick"] == future_tick:
                if ev["type"] == "supply":
                    sim_supply = max(20, sim_supply + ev["delta"])
                elif ev["type"] == "demand":
                    for a in sim_agents:
                        if a["id"] == ev["agent"]:
                            a["min_need"] = min(a["max_need"], a["min_need"] + ev["boost"])

        allocs = negotiate(sim_supply, sim_agents, mode)

        for a in sim_agents:
            prev_status  = a.get("status", "nominal")
            a["allocated"] = round(allocs[a["id"]], 1)
            new_status   = get_status(a["allocated"], a["min_need"])

            if new_status != prev_status:
                ratio = a["allocated"] / a["min_need"] if a["min_need"] else 1
                confidence = round(min(97, max(60,
                    95 if ratio < 0.5 else 80 if ratio < 0.7 else 65
                ) + random.randint(-3, 3)))
                forecast.append({
                    "tick_offset": i,
                    "agent":       a["name"],
                    "agent_id":    a["id"],
                    "from_status": prev_status,
                    "to_status":   new_status,
                    "confidence":  confidence,
                    "supply_at":   sim_supply,
                })
                a["status"] = new_status

        proj_cascades = check_cascades(sim_agents)
        for c in proj_cascades:
            already = any(
                f["agent"] == c["to"] and f["to_status"] == "cascade_risk"
                for f in forecast
            )
            if not already:
                forecast.append({
                    "tick_offset":  i,
                    "agent":        c["to"],
                    "agent_id":     "",
                    "from_status":  "nominal",
                    "to_status":    "cascade_risk",
                    "confidence":   78,
                    "supply_at":    sim_supply,
                    "cascade_from": c["from"],
                })

    critical_forecast = [f for f in forecast if f["to_status"] == "critical"]
    cascade_forecast  = [f for f in forecast if f["to_status"] == "cascade_risk"]

    if critical_forecast:
        first = critical_forecast[0]
        recommendation = (
            f"Pre-emptive action required: {first['agent']} will reach CRITICAL "
            f"in {first['tick_offset']} tick(s). Recommend injecting +15 MW buffer "
            f"or elevating priority now to prevent failure."
        )
        severity = "critical"
    elif cascade_forecast:
        first = cascade_forecast[0]
        recommendation = (
            f"Cascade risk detected: {first['agent']} vulnerable in "
            f"{first['tick_offset']} tick(s) via {first.get('cascade_from', 'dependency')}. "
            f"Recommend elevating Power Grid priority pre-emptively."
        )
        severity = "warning"
    else:
        recommendation = (
            f"No failures predicted in next {ticks_ahead} ticks. "
            f"System trajectory stable at current supply of {supply} MW."
        )
        severity = "ok"

    return {
        "forecast":       forecast,
        "recommendation": recommendation,
        "severity":       severity,
        "ticks_ahead":    ticks_ahead,
        "supply_now":     supply,
    }

@app.get("/forecast")
async def get_forecast():
    return forecast_next_ticks(sim["agents"], sim["supply"], sim["mode"])

# ── WEBSOCKET ENDPOINT ───────────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)
    running = True

    try:
        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=0.05)
                msg  = json.loads(data)

                if msg.get("action") == "reset":
                    sim.update(fresh_state())

                elif msg.get("action") == "crisis":
                    sim["supply"] = max(20, sim["supply"] - 15)
                    sim["feed"].append({
                        "tick": sim["tick"], "type": "alert",
                        "msg": "MANUAL CRISIS: Supply shock −15 MW injected."
                    })

                elif msg.get("action") == "mode":
                    sim["mode"] = msg.get("value", "priority")
                    sim["feed"].append({
                        "tick": sim["tick"], "type": "warning",
                        "msg": f"MODE SWITCH: Negotiation set to {sim['mode'].upper()}"
                    })

                elif msg.get("action") == "pause":
                    running = msg.get("value", True)

                elif msg.get("action") == "set_priorities":
                    new_priorities = msg.get("value", {})
                    for a in sim["agents"]:
                        if a["id"] in new_priorities:
                            a["priority"] = int(new_priorities[a["id"]])
                    sim["feed"].append({
                        "tick": sim["tick"], "type": "ok",
                        "msg": "AI ADJUSTMENT: Priority weights updated by AI engine."
                    })

                elif msg.get("action") == "crisis_preempt":
                    sim["supply"] = min(100, sim["supply"] + 15)
                    for a in sim["agents"]:
                        if a["id"] == "power":
                            a["priority"] = min(10, a["priority"] + 1)
                        if a["id"] == "shelter":
                            a["priority"] = max(1, a["priority"] - 1)
                    sim["feed"].append({
                        "tick": sim["tick"], "type": "ok",
                        "msg": "PRE-EMPT: AI injected +15 MW buffer and rebalanced priorities before cascade."
                    })

            except asyncio.TimeoutError:
                pass

            if running:
                state = sim_tick()
                await websocket.send_text(json.dumps(state))

            await asyncio.sleep(1.2)

    except WebSocketDisconnect:
        connected_clients.discard(websocket)