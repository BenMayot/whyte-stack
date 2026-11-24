// Call log (Nov 17, 2026). Every hour the operator's full view (spine calls + site rules) is compared with the last
// snapshot and the differences are written down: an ad's call changed, an ad was paused or switched on (and whether that
// followed the call), the budget call changed, a daily budget changed. Checks then look for likely mistakes.
// Read-only on Meta: this only reads the operator view.
import { getStore } from "@netlify/blobs";
import { r2 } from "./extra.mjs";
import { ruleKey, score } from "./learn.mjs";

const store = () => getStore({ name: "oplog", consistency: "strong" });
const MAX_EVENTS = 5000;
const H = 3600e3;

function adSnap(a) {
  const scale = a.lane !== "test";
  const w = scale ? (a.call?.basis === "d7" ? a.windows.d7 : a.windows.c7 || a.windows.d7) : a.windows.life;
  return { name: a.we_id || a.creator || a.id, full: a.name, product: a.product || null, lane: a.lane, adset: a.adset || null,
    status: a.paused ? "off" : "on", action: a.call?.action || null, rule: a.call?.rule || null, why: a.call?.why || "",
    win: scale ? (a.call?.basis === "d7" ? "7 days incl. today" : "7 full days") : "lifetime",
    spend: r2(w?.spend || 0), purchases: w?.purchases || 0, cpa: w?.cpa ?? null, be: a.breakeven?.cpa ?? null, line: a.line ?? null,
    // context for the learning layer: how old the ad was and what it had done when the call was made
    ctx: { first_day: a.first_day || null, life_days: a.windows.life?.days ?? null, today: { spend: r2(a.windows.today?.spend || 0), purchases: a.windows.today?.purchases || 0 },
      before_today: { spend: r2((a.windows.life?.spend || 0) - (a.windows.today?.spend || 0)), purchases: (a.windows.life?.purchases || 0) - (a.windows.today?.purchases || 0) } },
    rule_key: ruleKey({ lane: a.lane, action: a.call?.action, rule: a.call?.rule, why: a.call?.why }),
    last_full: (() => { const c = a.windows.c7; return c ? { spend: r2(c.spend), purchases: c.purchases, cpa: c.cpa } : null; })() };
}

export function snapshot(d) {
  const at = d.as_of || new Date().toISOString();
  const ads = {}; for (const a of d.ads || []) ads[a.id] = adSnap(a);
  const B = d.budget_call || {};
  const budget = { action: B.action || null, pct: B.pct ?? null, why: B.why || "", rule: B.rule || null, lines: B.lines ? { raise: B.lines.raise, hold: B.lines.hold, floor: B.lines.floor } : null, would: B.would || null, scale: d.account?.daily_budget?.scale ?? null, test: d.account?.daily_budget?.test ?? null };
  return { at, ads, budget };
}

// What changed between two snapshots.
export function diff(prev, cur) {
  const { at, ads, budget } = cur, events = [];
  if (prev) {
    for (const [id, a] of Object.entries(ads)) {
      const p = prev.ads[id];
      if (!p) { events.push({ at, kind: "new", id, ...a }); continue; }
      if (p.status !== a.status) {
        const was = p.action; // the call at the last snapshot, before the change
        const followed = a.status === "off" ? (was === "kill" || was === "cut") : !(was === "kill" || was === "cut");
        events.push({ at, kind: "you", id, did: a.status === "off" ? "paused" : "switched on", call_then: was, why_then: p.why, followed, ...a, snap_then: p });
      }
      if (p.action !== a.action && a.status === "on") events.push({ at, kind: "call", id, from: p.action, ...a });
    }
    if (prev.budget.action !== budget.action) events.push({ at, kind: "budget_call", from: prev.budget.action, ...budget });
    if (prev.budget.scale !== budget.scale || prev.budget.test !== budget.test) {
      const was = prev.budget.action, up = (budget.scale ?? 0) > (prev.budget.scale ?? 0), down = (budget.scale ?? 0) < (prev.budget.scale ?? 0);
      const followed = up ? was === "raise" : down ? (was === "cut" || was === "revert") : null;
      events.push({ at, kind: "budget_change", from_scale: prev.budget.scale, to_scale: budget.scale, from_test: prev.budget.test, to_test: budget.test, call_then: was, why_then: prev.budget.why, followed });
    }
  } else events.push({ at, kind: "start", note: "Logging started. Changes are recorded from here on." });
  return events;
}

export async function record(d) {
  const s = store();
  const prev = await s.get("state.json", { type: "json" });
  const cur = snapshot(d), events = diff(prev, cur), { at } = cur;
  if (events.length) {
    const log = (await s.get("events.json", { type: "json" })) || [];
    await s.setJSON("events.json", [...log, ...events].slice(-MAX_EVENTS));
  }
  await s.setJSON("state.json", cur);
  return { at, events: events.length };
}

// Checks: things a person should look at. Each has a plain reason.
export function checks(events, state) {
  const out = [], now = Date.now(), ago = (e) => (now - Date.parse(e.at)) / H;
  const calls = events.filter((e) => e.kind === "call");
  // 1. The rule changed its mind: a kill/cut call reversed within 48 hours.
  for (const e of calls) if ((e.from === "kill" || e.from === "cut") && e.action !== "kill" && e.action !== "cut") {
    const first = [...calls].reverse().find((x) => x.id === e.id && (x.action === "kill" || x.action === "cut") && Date.parse(x.at) <= Date.parse(e.at));
    if (first && Date.parse(e.at) - Date.parse(first.at) <= 48 * H && ago(e) <= 14 * 24)
      out.push({ type: "flip", at: e.at, id: e.id, name: e.name, text: `${e.name}: the operator said ${first.action} at ${first.at.slice(5, 16).replace("T", " ")} UTC and took it back within ${Math.round((Date.parse(e.at) - Date.parse(first.at)) / H)}h (now ${e.action}). If you acted on the first call, check whether it was right.` });
  }
  // 2. Paused while paying back on full days.
  for (const e of events.filter((x) => x.kind === "you" && x.did === "paused" && ago(x) <= 14 * 24)) {
    const t = e.snap_then || {}, lf = t.last_full;
    if (lf && lf.cpa != null && t.be != null && lf.cpa <= t.be && lf.spend >= 100)
      out.push({ type: "paused_paying", at: e.at, id: e.id, name: e.name, text: `${e.name} was paused while its last 7 full days were $${lf.cpa.toFixed(2)} on $${Math.round(lf.spend)}, at or under its $${t.be.toFixed(2)} break-even${e.followed ? " (the operator had said " + e.call_then + ")" : ""}.` });
  }
  // 3. Cut or kill not taken: what the ad did since.
  for (const e of calls.filter((x) => (x.action === "kill" || x.action === "cut") && ago(x) >= 48 && ago(x) <= 14 * 24)) {
    const cur = state?.ads?.[e.id]; if (!cur || cur.status !== "on") continue;
    const later = calls.find((x) => x.id === e.id && Date.parse(x.at) > Date.parse(e.at) && x.action !== e.action);
    if (cur.action === "kill" || cur.action === "cut") out.push({ type: "ignored", at: e.at, id: e.id, name: e.name, text: `${e.name}: ${e.action} call from ${e.at.slice(5, 10)} still not taken, and still ${cur.action} (${cur.cpa != null ? "$" + cur.cpa.toFixed(2) : "no purchases"} on $${Math.round(cur.spend)}, ${cur.win}).` });
    else if (later) out.push({ type: "recovered", at: e.at, id: e.id, name: e.name, text: `${e.name}: ${e.action} call from ${e.at.slice(5, 10)} was not taken, and it is now ${cur.action} (${cur.cpa != null ? "$" + cur.cpa.toFixed(2) : "–"} on $${Math.round(cur.spend)}, ${cur.win}). The rule may have been too quick.` });
  }
  // 4. Budget call changed direction within 3 days.
  const bc = events.filter((x) => x.kind === "budget_call" && ago(x) <= 14 * 24);
  for (let i = 1; i < bc.length; i++) {
    const a = bc[i - 1], b = bc[i], dir = (x) => (x === "raise" ? 1 : x === "cut" || x === "revert" ? -1 : 0);
    if (dir(a.action) && dir(b.action) && dir(a.action) !== dir(b.action) && Date.parse(b.at) - Date.parse(a.at) <= 72 * H)
      out.push({ type: "budget_flip", at: b.at, text: `Budget call went from ${a.action} to ${b.action} within ${Math.round((Date.parse(b.at) - Date.parse(a.at)) / H)}h.` });
  }
  // 5. Budget moved against the call.
  for (const e of events.filter((x) => x.kind === "budget_change" && x.followed === false && ago(x) <= 14 * 24))
    out.push({ type: "budget_override", at: e.at, text: `Scaling budget moved $${e.from_scale} → $${e.to_scale} while the call was ${e.call_then}. Fine if on purpose; it is logged so the review can see it.` });
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

// A note typed into the log by a person: context the numbers can't carry ("leaving these on purpose to test the $44 kill").
export async function addNote(text, by = "Ben") {
  const s = store(), log = (await s.get("events.json", { type: "json" })) || [];
  const ev = { at: new Date().toISOString(), kind: "note", note: String(text).replace(/\s+/g, " ").trim().slice(0, 600), by };
  if (!ev.note) return null;
  await s.setJSON("events.json", [...log, ev].slice(-MAX_EVENTS));
  return ev;
}

export async function read(days = 21, rows = null, closedThrough = null) {
  const s = store();
  const [log, state] = await Promise.all([s.get("events.json", { type: "json" }), s.get("state.json", { type: "json" })]);
  const since = Date.now() - days * 24 * H, ev = (log || []).filter((e) => Date.parse(e.at) >= since);
  const slim = ev.map(({ snap_then, full, ...e }) => e);
  let learning = null;
  try { if (rows && closedThrough) learning = score(ev, rows, closedThrough, state); } catch (e) { learning = { error: String(e.message || e).slice(0, 200) }; }
  return { last_run: state?.at || null, events: slim.reverse(), checks: checks(ev, state), learning };
}
