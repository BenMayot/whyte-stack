// Learning layer (Nov 17, 2026). Scores every kill, cut and graduate call in the log against what the ad did afterwards,
// then rolls the results up per rule. Pure functions: outcomes are recomputed from the log + Meta ad rows on every read,
// so the scoring can change later without losing history. It only reports. It never changes a rule.
//
// To add a rule to the scorecard: give it a key in ruleKey() and a label in LABELS. To score a new kind of call: add a
// branch in outcome(). Thresholds are named constants below.
export const MIN_SCORED = 8;        // scored calls a rule needs before its record means anything
const TAKEN_WITHIN_H = 48;          // paused within this many hours of the call = the call was followed
const HORIZON_DAYS = 7;             // full days after the call that are judged
const MIN_DAYS = 2, MIN_SPEND = 30; // evidence needed before a not-followed kill/cut is scored
const GRAD_MIN_SPEND = 100;

const etDay = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
const addDays = (day, n) => { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const r2 = (x) => Math.round(x * 100) / 100;

export const LABELS = {
  "test:kill:66": "Test kill: $66 of full days, no purchase", "test:kill:110": "Test kill: $110 of full days, 0 or 1 purchase", "test:kill:far": "Test kill: more than 50% over at $132+", "test:kill:220": "Test kill: over by more than 15% at $220", "test:kill:300": "Test kill: hard stop at $300", "test:kill:44": "Old rule: $44 spent, no purchase", "test:kill:88": "Test kill: $88 spent, 1 purchase or none", "test:kill:over": "Test kill: over the line after $132",
  "test:kill:cap": "Test kill: day cap in testing", "test:kill:none": "Test kill: no purchase, past $44", "test:kill:floor": "Test kill: over the $28 floor", "test:kill:other": "Test kill: other", "test:graduate": "Graduate to scaling",
  "scale:cut:slide": "Scaling cut: 3-day slide", "scale:cut:floor": "Scaling cut: over the $28 floor", "scale:cut:zombie": "Scaling cut: low delivery",
  "scale:cut:breakeven": "Scaling cut: over break-even, 7 full days", "scale:cut:other": "Scaling cut: other" };
// Which rule made this call. Works from the call's lane, action, site-rule tag and wording.
export function ruleKey(e) {
  const lane = e.lane === "test" ? "test" : "scale", w = e.why || "";
  if (e.action === "graduate") return "test:graduate";
  if (lane === "test" && e.action === "kill") return /^\$66 spent, no purchase/.test(w) ? "test:kill:66" : /^\$110 spent/.test(w) ? "test:kill:110" : /Hard stop at \$300/.test(w) ? "test:kill:300" : /More than 50% over/.test(w) ? "test:kill:far" : /at \$220\+$/.test(w) ? "test:kill:220" : /^\$44 spent, no purchase/.test(w) ? "test:kill:44" : /^\$88/.test(w) ? "test:kill:88" : /^\$\d+ spent, (no|0) purchase/.test(w) ? "test:kill:none" : /days in test/i.test(w) ? "test:kill:cap" : /^Over the \$\d+ floor/.test(w) ? "test:kill:floor" : /over \$/.test(w) ? "test:kill:over" : "test:kill:other";
  if (e.action === "cut" || e.action === "kill") return e.rule === "slide" ? "scale:cut:slide" : /low delivery|zombie/i.test(w) ? "scale:cut:zombie" : /floor/i.test(w) ? "scale:cut:floor" : /break-even/i.test(w) ? "scale:cut:breakeven" : "scale:cut:other";
  return null;
}

// What happened after one call. rowsByAd: { ad_id: [{ day, spend, purchases }] } of closed days.
function outcome(e, events, rowsByAd, closedThrough, state) {
  const callDay = etDay(e.at), be = e.be ?? e.line ?? null;
  const pause = events.find((x) => x.kind === "you" && x.id === e.id && x.did === "paused" && Date.parse(x.at) > Date.parse(e.at));
  const hoursToPause = pause ? (Date.parse(pause.at) - Date.parse(e.at)) / 3600e3 : null;
  const followed = pause != null && hoursToPause <= TAKEN_WITHIN_H;
  const end = [addDays(callDay, HORIZON_DAYS), closedThrough, pause ? etDay(pause.at) : "9999"].sort()[0];
  const a = { days: 0, spend: 0, purchases: 0 };
  for (const r of rowsByAd[e.id] || []) if (r.day > callDay && r.day <= end) { a.days++; a.spend += r.spend || 0; a.purchases += r.purchases || 0; }
  const cpa = a.purchases ? r2(a.spend / a.purchases) : null, paid = be != null && a.purchases > 0 && cpa <= be;
  const net = be != null ? Math.round(a.purchases * be - a.spend) : null;   // contribution earned minus spend, after the call
  const closed = closedThrough >= addDays(callDay, HORIZON_DAYS) || (pause != null && !followed);
  let result;
  if (e.action === "graduate") result = a.spend < GRAD_MIN_SPEND ? "open" : paid ? "right" : "wrong";
  else if (followed) result = "followed";                                   // the ad stopped: no way to know what it would have done
  else if ((a.days < MIN_DAYS && !closed) || a.spend < MIN_SPEND) result = closed && a.spend < MIN_SPEND ? "no_evidence" : "open";
  else result = paid ? "wrong" : "right";                                   // kept running and paid back = the call was wrong
  return { followed, paused_at: pause?.at || null, still_on: state?.ads?.[e.id]?.status === "on", days: a.days, spend: Math.round(a.spend), purchases: a.purchases, cpa, net, result, final: closed || followed };
}

export function score(events, rows, closedThrough, state) {
  const rowsByAd = {}; for (const r of rows || []) (rowsByAd[r.ad_id] ||= []).push(r);
  const asc = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const calls = [], by = {};
  for (const e of asc) {
    if (e.kind !== "call" || !["kill", "cut", "graduate"].includes(e.action)) continue;
    const key = e.rule_key || ruleKey(e); if (!key) continue;
    const o = outcome(e, asc, rowsByAd, closedThrough, state);
    calls.push({ at: e.at, id: e.id, name: e.name, product: e.product || null, lane: e.lane, action: e.action, rule: key, rule_label: LABELS[key] || key, why: e.why,
      at_call: { spend: e.spend, purchases: e.purchases, cpa: e.cpa, breakeven: e.be ?? null, ctx: e.ctx || null }, ...o });
    const g = (by[key] ||= { rule: key, label: LABELS[key] || key, calls: 0, followed: 0, open: 0, right: 0, wrong: 0, no_evidence: 0, net_left_on: 0 });
    g.calls++; g[o.result] = (g[o.result] || 0) + 1;
    if (!o.followed && e.action !== "graduate" && o.net != null) g.net_left_on += o.net;
  }
  const rules = Object.values(by).map((g) => { const scored = g.right + g.wrong; return { ...g, scored, right_pct: scored ? Math.round(g.right / scored * 100) : null, ready: scored >= MIN_SCORED, need: Math.max(0, MIN_SCORED - scored) }; })
    .sort((a, b) => b.calls - a.calls);
  return { min_scored: MIN_SCORED, horizon_days: HORIZON_DAYS, closed_through: closedThrough, rules, calls: calls.reverse() };
}
