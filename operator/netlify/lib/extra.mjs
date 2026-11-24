// Rules the operator site applies on top of the data spine's calls. Shared by /api/data (the page) and the hourly call logger,
// so both always run the same logic.
const SLIDE_DAYS = 3, SLIDE_MIN_SPEND = 300, SLIDE_OVER = 0.10;
const UNDO_MIN_TODAY_SPEND = 1000;
export const r2 = (x) => Math.round(x * 100) / 100;
export const addDays = (day, n) => { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const fmtDay = (s) => { const p = s.split("-"); return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+p[1] - 1] + " " + +p[2]; };

// rows: closed-day ad rows from the spine ({ ad_id, day, spend, purchases }).
export function applySlide(d, rows) {
  const by = {};
  for (const r of rows) { const a = (by[r.ad_id] ||= { spend: 0, purchases: 0 }); a.spend += r.spend || 0; a.purchases += r.purchases || 0; }
  const from = addDays(d.closed_through, -(SLIDE_DAYS - 1)), to = d.closed_through;
  let n = 0;
  for (const a of d.ads || []) {
    if (a.lane !== "scale" || a.paused) continue;
    const s = by[a.id]; if (!s || s.spend < SLIDE_MIN_SPEND) continue;
    const be = a.breakeven?.cpa; if (!be) continue;
    const cpa = s.purchases ? s.spend / s.purchases : null;
    const over = cpa === null ? null : (cpa - be) / be;
    a.slide = { from, to, spend: r2(s.spend), purchases: s.purchases, cpa: cpa === null ? null : r2(cpa), over_pct: over === null ? null : Math.round(over * 100) };
    if (cpa !== null && over < SLIDE_OVER) continue;
    if (a.call?.action === "cut" || a.call?.action === "kill") continue;
    const lbl = a.breakeven.own ? "its own break-even" : "break-even";
    a.call = { action: "cut", recheck: false, rule: "slide", was: a.call,
      why: cpa === null
        ? `Slide: no purchase on $${Math.round(s.spend)} over the last ${SLIDE_DAYS} closed days (${fmtDay(from)}–${fmtDay(to)})`
        : `Slide: last ${SLIDE_DAYS} closed days (${fmtDay(from)}–${fmtDay(to)}) $${cpa.toFixed(2)} on $${Math.round(s.spend)}, ${Math.round(over * 100)}% over ${lbl} ($${be.toFixed(2)})` };
    n++;
  }
  const counts = {}; for (const a of d.ads || []) if (!a.paused) counts[a.call.action] = (counts[a.call.action] || 0) + 1;
  d.counts = counts;
  return n;
}

export function applyEarlyUndo(d) {
  const B = d.budget_call; if (!B || !B.last_change || B.last_change.dir !== "up") return false;
  if (B.action === "revert" || B.action === "cut") return false;
  const BE = B.undo_line ?? B.breakeven ?? d.rules?.breakeven_cpa; if (!BE) return false;
  const after = (B.days || []).filter((x) => x.day > B.last_change.day);
  if (after.length !== 1) return false;                              // only between the 1st and 2nd closed day; the spine's undo takes the 2nd
  const day1 = after[0]; if (day1.cpa != null && day1.cpa <= BE) return false;
  const t = (d.ads || []).filter((a) => a.lane === "scale").reduce((x, a) => { x.s += a.windows.today.spend; x.p += a.windows.today.purchases; return x; }, { s: 0, p: 0 });
  if (t.s < UNDO_MIN_TODAY_SPEND) return false;
  const tc = t.p ? t.s / t.p : null; if (tc !== null && tc <= BE) return false;
  const n = B.now || {}, prev = B.last_change.prev_scale;
  d.budget_call = { ...B, action: "revert", rule: "early_undo", spine_action: B.action, spine_why: B.why, pct: n.scale ? Math.round((prev - n.scale) / n.scale * 100) : 0,
    plan: { new_scale: prev, new_weekly: (prev + (n.test || 0)) * 7 },
    today: { spend: r2(t.s), purchases: t.p, cpa: tc === null ? null : r2(tc) },
    why: `Early undo: the raise on ${fmtDay(B.last_change.day)} closed its first day at ${day1.cpa != null ? "$" + day1.cpa.toFixed(2) : "no purchases"}, over the $${BE} ${B.undo_line ? "hold line" : "break-even"}, and today is at ${tc != null ? "$" + tc.toFixed(2) : "no purchases"} on $${Math.round(t.s)} of scaling spend. Go back to $${prev.toLocaleString("en-US")} now instead of waiting for a 2nd bad day` };
  return true;
}

// 3. Carrier guard (Nov 17): an ad carrying 15%+ of the scaling lane's spend over the last 7 full days is never cut for
//    being over its own break-even (the 7-day break-even cut or the slide). It is cut only at the $28 floor, or for no purchases.
//    Why: Nov 12-16 the break-even cut paused WE0349 then WE0443, which together carried most of the lane. Their budget went to
//    small ads that couldn't take it, and the lane went from $22 to $41 per purchase in two days.
//    One carrier at a time: if a carrier was paused in the last 3 days, or another carrier is already cut in this read, a further
//    carrier floor cut waits, unless that ad is 50%+ over the floor.
const CARRIER_SHARE = 0.15, CARRIER_FAR = 1.5;
export function applyCarrier(d) {
  const FLOOR = d.rules?.floor_cpa || 28;
  const scale = (d.ads || []).filter((a) => a.lane === "scale");
  const tot = scale.reduce((x, a) => x + (a.windows?.c7?.spend || 0), 0);
  const out = { held: 0, waiting: 0, carriers: [] };
  if (!tot) return out;
  const share = (a) => (a.windows?.c7?.spend || 0) / tot;
  const pct = (a) => Math.round(share(a) * 100);
  const recentOff = scale.filter((a) => a.paused && share(a) >= CARRIER_SHARE && (a.windows?.d3?.spend || 0) > 0);
  const live = scale.filter((a) => !a.paused && share(a) >= CARRIER_SHARE);
  out.carriers = live.map((a) => ({ id: a.id, name: a.we_id || a.creator || a.id, share_pct: pct(a) }));
  const floorCuts = [];
  for (const a of live) {
    if (a.call?.action !== "cut") continue;
    const w = a.call.basis === "c7" ? a.windows.c7 : a.windows.d7;
    const cpa = w && w.purchases ? w.spend / w.purchases : null;
    const floorish = a.call.rule !== "slide" && !a.call.zombie && (cpa === null || cpa > FLOOR);
    a.carrier = { share_pct: pct(a), lane_spend_c7: r2(tot) };
    if (!floorish) {
      a.call = { action: "watch", rule: "carrier", recheck: false, was: a.call,
        why: `Carries ${pct(a)}% of scaling spend over the last 7 full days, so it is not cut for being over break-even (${a.call.why.replace(/^Slide: /, "slide: ")}). A carrier is cut only at the $${FLOOR} floor. If the lane is over break-even, trim the scaling budget instead` };
      out.held++;
    } else floorCuts.push({ a, cpa });
  }
  floorCuts.sort((x, y) => (y.cpa ?? Infinity) - (x.cpa ?? Infinity));
  let allowed = recentOff.length ? 0 : 1;
  for (const { a, cpa } of floorCuts) {
    const far = cpa === null || cpa > FLOOR * CARRIER_FAR;
    if (allowed > 0 || far) { allowed--; continue; }
    a.call = { action: "watch", rule: "carrier_wait", recheck: false, was: a.call,
      why: `Over the $${FLOOR} floor, but it carries ${pct(a)}% of scaling spend and ${recentOff.length ? `another carrier (${recentOff.map((x) => x.we_id || x.creator).join(", ")}) came off in the last 3 days` : "another carrier is already cut"}. One carrier at a time: cut it once the lane has absorbed that, unless it goes 50%+ over the floor` };
    out.waiting++;
  }
  const counts = {}; for (const a of d.ads || []) if (!a.paused) counts[a.call.action] = (counts[a.call.action] || 0) + 1;
  d.counts = counts;
  return out;
}

// 4. Cut cooldown (Nov 17): the spine checks its emergency floor rule (last 2 closed days over $28 = -30%) BEFORE its
//    cooldown, so after a cut it kept asking for another -30% off the same closed days, which ran at the old budget.
//    After a cut, the budget call only judges closed days at the new budget: 0 so far = wait; 1-2 closed days that blend over
//    the floor (each $300+) = the spine's cut stands; otherwise wait until 3 closed days, then the normal ladder applies.
const COOLDOWN_DAYS = 3, JUDGED_DAY = 300;
export function applyCutCooldown(d) {
  const B = d.budget_call; if (!B || B.action !== "cut" || !B.last_change || B.last_change.dir !== "down") return false;
  const since = (B.days || []).filter((x) => x.day > B.last_change.day);
  if (since.length >= COOLDOWN_DAYS) return false;
  const FLOOR = B.floor ?? d.rules?.floor_cpa ?? 28;
  const sp = since.reduce((x, y) => x + y.spend, 0), pu = since.reduce((x, y) => x + y.purchases, 0);
  if (since.length && since.every((x) => x.spend >= JUDGED_DAY) && (pu === 0 || sp / pu > FLOOR)) return false;
  const lc = B.last_change, left = COOLDOWN_DAYS - since.length;
  d.budget_call = { ...B, action: "wait", pct: 0, plan: null, rule: "cut_cooldown", spine_action: B.action, spine_why: B.why,
    why: `Scaling was cut on ${fmtDay(lc.day)} ($${lc.prev_scale.toLocaleString("en-US")} → $${lc.new_scale.toLocaleString("en-US")} a day). The days behind the spine's "${B.why}" ran at the old budget. ${since.length ? `${since.length} closed day${since.length > 1 ? "s" : ""} at the new budget so far, under the $${FLOOR} floor` : "No closed day at the new budget yet"}. ${left} more before the next move, unless the new budget's closed days blend over $${FLOOR}` };
  return true;
}

// 5. Budget rule v3 (Nov 24, 2026). Replaces the spine's budget ladder (v2), which raised under $22 and trimmed from $22.62
//    while the scaling lane's normal day is $22.69: it trimmed on a normal day and almost never raised.
//    Lines (scaling lane, Meta's count): raise at or under $23.50, hold to $25, floor $28. Each is what a new customer earns
//    back: $23.50 and $25 inside about 30 days, $28 inside 90 days (store level, testing included).
//    Ladder on the last 3 closed days blended: <= raise = +20% (50+ purchases); <= hold = hold; <= floor = hold, and -10% only if
//    the last 7 closed days are over the hold line too; over the floor = -20%. Last 2 closed days over the floor = -20%.
//    Budget floor: scaling never goes under $1,450 a day unless the 7 days are over the floor.
//    Settle: 3 closed days after any change; the card still says what the call would be.
//    Moving lines: once a week the lines shift with what new customers are worth, from last Mon-Sun's share of new web customers
//    who started on subscription and who bought a bundle, against the mix the lines were set on. Capped at $1 either way.
//    Bundle +10 points = +$1.86 on every line. Subscription +10 points = +$0.43 on raise and hold (30 days), +$1.36 on the floor.
export const V3 = { SET: "2026-11-24", RAISE: 23.5, HOLD: 25, FLOOR: 28, REF_SUB: 0.16, REF_BUNDLE: 0.16, K_BUNDLE: 18.57, K_SUB_30: 4.34, K_SUB_90: 13.56,
  CAP: 1, MIN_SCALE: 1450, RAISE_PCT: 20, TRIM_PCT: 10, CUT_PCT: 20, SETTLE: 3, MIN_PURCHASES: 50, MIN_WEEK_CUSTOMERS: 300 };
const clamp = (x, c) => Math.max(-c, Math.min(c, x));
const usd0 = (x) => "$" + Math.round(x).toLocaleString("en-US");

// rows: the spine's daily rows ({ day, web: { new_customers, sub_first, new_by_family: { both } } }).
export function v3Lines(rows, closedThrough) {
  const fixed = (why) => ({ raise: V3.RAISE, hold: V3.HOLD, floor: V3.FLOOR, source: "fixed", note: why, set: V3.SET });
  if (!closedThrough || !Array.isArray(rows)) return fixed("no daily rows");
  let end = closedThrough; for (let i = 0; i < 7 && new Date(end + "T00:00:00Z").getUTCDay() !== 0; i++) end = addDays(end, -1);
  const from = addDays(end, -6);
  const wk = rows.filter((r) => r.day >= from && r.day <= end && r.web);
  const n = wk.reduce((x, r) => x + (r.web.new_customers || 0), 0);
  if (wk.length < 7 || n < V3.MIN_WEEK_CUSTOMERS) return fixed(`last full week (${fmtDay(from)}–${fmtDay(end)}) has ${wk.length} days and ${n} new customers`);
  const sub = wk.reduce((x, r) => x + (r.web.sub_first || 0), 0) / n, bun = wk.reduce((x, r) => x + (r.web.new_by_family?.both || 0), 0) / n;
  const b = (bun - V3.REF_BUNDLE) * V3.K_BUNDLE;
  const s30 = clamp(b + (sub - V3.REF_SUB) * V3.K_SUB_30, V3.CAP), s90 = clamp(b + (sub - V3.REF_SUB) * V3.K_SUB_90, V3.CAP);
  return { raise: r2(V3.RAISE + s30), hold: r2(V3.HOLD + s30), floor: r2(V3.FLOOR + s90), source: "mix", set: V3.SET,
    week: { from, to: end, new_customers: n }, sub_share: r2(sub * 100), bundle_share: r2(bun * 100), shift_30: r2(s30), shift_90: r2(s90),
    base: { raise: V3.RAISE, hold: V3.HOLD, floor: V3.FLOOR, sub_share: V3.REF_SUB * 100, bundle_share: V3.REF_BUNDLE * 100 } };
}

export function applyBudgetV3(d, L) {
  const B = d.budget_call; if (!B || !Array.isArray(B.days) || !B.days.length || !B.now || !B.now.scale) return false;
  const blend = (a) => { const s = a.reduce((x, y) => x + (y.spend || 0), 0), p = a.reduce((x, y) => x + (y.purchases || 0), 0); return { days: a.length, spend: r2(s), purchases: p, cpa: p ? r2(s / p) : null }; };
  const over = (w, line) => (w.cpa === null ? w.spend > 0 : w.cpa > line);
  const m = (x) => (x === null ? "no purchases" : "$" + x.toFixed(2));
  const d3 = B.days.slice(-3), w3 = blend(d3), w7 = blend(B.days.slice(-7)), w2 = blend(B.days.slice(-2));
  const span = `${fmtDay(d3[0].day)}–${fmtDay(d3[d3.length - 1].day)}`;
  const n = B.now, scale = n.scale, test = n.test || 0;
  const lead = `Last 3 closed days (${span}): ${m(w3.cpa)} on ${w3.purchases} purchases`;
  const seven = `the last ${w7.days} closed days are ${m(w7.cpa)}`;
  // what the numbers earn, before the settle period and the budget floor
  let nat;
  if (B.days.length >= 2 && over(w2, L.floor)) nat = { action: "cut", pct: -V3.CUT_PCT, why: `Last 2 closed days blend ${m(w2.cpa)}, over the $${L.floor} floor, where a customer is not paid back inside 90 days` };
  else if (over(w3, L.floor)) nat = { action: "cut", pct: -V3.CUT_PCT, why: `${lead}, over the $${L.floor} floor, where a customer is not paid back inside 90 days` };
  else if (over(w3, L.hold)) nat = over(w7, L.hold)
    ? { action: "cut", pct: -V3.TRIM_PCT, why: `${lead}, over the $${L.hold} hold line, and ${seven}, over it too` }
    : { action: "hold", pct: 0, why: `${lead}, over the $${L.hold} hold line but under the $${L.floor} floor, and ${seven}, still under $${L.hold}. Hold and fix the ads; trim 10% only if the 7 days go over $${L.hold} too` };
  else if (over(w3, L.raise)) nat = { action: "hold", pct: 0, why: `${lead}, between the $${L.raise} raise line and the $${L.hold} hold line` };
  else if (w3.purchases < V3.MIN_PURCHASES) nat = { action: "hold", pct: 0, why: `${lead}, under the $${L.raise} raise line but on fewer than ${V3.MIN_PURCHASES} purchases` };
  else nat = { action: "raise", pct: V3.RAISE_PCT, why: `${lead}, at or under the $${L.raise} raise line, where a customer is paid back inside 30 days` };
  // budget floor
  if (nat.action === "cut") {
    let to = Math.round(scale * (1 + nat.pct / 100) / 10) * 10;
    if (!over(w7, L.floor)) to = Math.max(to, V3.MIN_SCALE);
    if (to >= scale) nat = { action: "hold", pct: 0, floor_hold: true, why: `${nat.why}. That calls for pulling the budget back, but scaling is at its ${usd0(V3.MIN_SCALE)} floor and ${seven}, under the $${L.floor} floor. Fix the ads instead of shrinking the budget` };
    else nat = { ...nat, pct: Math.round((to - scale) / scale * 100), plan: { new_scale: to, new_weekly: (to + test) * 7 } };
  }
  if (nat.action === "raise") {
    const add = Math.round(scale * V3.RAISE_PCT / 100 / 10) * 10, ns = scale + add, tot = ns + test;
    nat.plan = { add, scale_add: add, new_scale: ns, new_test: test, test_lanes: 0, lane_size: 0, scale_pct: Math.round(ns / tot * 100), test_pct: Math.round(test / tot * 100), new_weekly: tot * 7 };
  }
  // settle: 3 closed days at a budget before the next move
  let out = nat; const lc = B.last_change;
  const since = lc ? B.days.filter((x) => x.day > lc.day) : null;
  if (lc && since.length < V3.SETTLE) {
    const ws = blend(since), left = V3.SETTLE - since.length;
    const moved = `Scaling went ${usd0(lc.prev_scale)} → ${usd0(lc.new_scale)} a day on ${fmtDay(lc.day)}`;
    if (since.length >= 2 && over(ws, L.floor) && nat.action === "cut") out = { ...nat, why: `${moved}, and the ${since.length} closed days since blend ${m(ws.cpa)}, over the $${L.floor} floor. ${nat.why}` };
    else if (lc.dir === "up" && since.length >= 2 && over(ws, L.hold)) out = { action: "revert", pct: Math.round((lc.prev_scale - scale) / scale * 100), plan: { new_scale: lc.prev_scale, new_weekly: (lc.prev_scale + test) * 7 },
      why: `${moved}, and the ${since.length} closed days since blend ${m(ws.cpa)}, over the $${L.hold} hold line. Undo the raise` };
    else out = { action: "wait", pct: 0, plan: null, would: nat.action === "cut" ? `pull back ${Math.abs(nat.pct)}%` : nat.action === "raise" ? `raise ${nat.pct}%` : "hold",
      why: `${moved}. ${left} more closed day${left > 1 ? "s" : ""} at this budget before the next move. On today's numbers the call would be: ${nat.action === "cut" ? `pull back ${Math.abs(nat.pct)}%` : nat.action === "raise" ? `raise ${nat.pct}%` : "hold"} (${nat.why.charAt(0).toLowerCase() + nat.why.slice(1)})` };
  }
  const c3 = w3.cpa, tier = c3 === null ? 3 : c3 <= L.raise ? 0 : c3 <= L.hold ? 1 : c3 <= L.floor ? 2 : 3;
  d.budget_call = { ...B, rule: "v3", action: out.action, pct: out.pct, plan: out.plan || null, why: out.why, would: out.would || null,
    spine: { rule: B.rule, action: B.action, pct: B.pct, why: B.why }, lines: L, undo_line: L.hold, w7,
    window: { ...(B.window || {}), ...w3, from: d3[0].day, to: d3[d3.length - 1].day, margin_pct: c3 === null ? null : r2((L.raise - c3) / L.raise * 100) },
    tiers: [{ label: `≤ $${L.raise.toFixed(2)}`, pct: V3.RAISE_PCT }, { label: `to $${L.hold.toFixed(2)}`, pct: 0 },
      { label: `to $${L.floor.toFixed(2)}, only if 7 days are over $${L.hold.toFixed(2)} too`, pct: -V3.TRIM_PCT }, { label: `over $${L.floor.toFixed(2)}`, pct: -V3.CUT_PCT }].map((t, i) => ({ ...t, here: i === tier })) };
  return true;
}

// Fetch the spine's operator view and apply every site rule. Returns the same object the page renders.
export async function operatorView(spine, maxAge = 600) {
  const r = await spine(`/api/v1/operator?max_age=${maxAge}`); const text = await r.text();
  if (!r.ok) return { raw: text, status: r.status };
  let d; try { d = JSON.parse(text); } catch { return { raw: text, status: r.status }; }
  if (d.error || !Array.isArray(d.ads)) return { raw: text, status: r.status };
  try {
    const from = addDays(d.closed_through, -(SLIDE_DAYS - 1));
    const ad = await (await spine(`/api/v1/meta/ad-days?from=${from}&to=${d.closed_through}`)).json();
    d.extra_rules = { slide_cuts: applySlide(d, ad.rows || []) };
    // budget: rule v3 replaces the spine's ladder. If it cannot run, the spine's call and the two older patches stand.
    let lines; try { const dy = await (await spine(`/api/v1/daily?from=${addDays(d.closed_through, -13)}&to=${d.closed_through}`)).json(); lines = v3Lines(dy.rows, d.closed_through); }
    catch (e) { lines = { raise: V3.RAISE, hold: V3.HOLD, floor: V3.FLOOR, source: "fixed", note: "daily rows unavailable: " + String(e.message || e).slice(0, 80), set: V3.SET }; }
    d.extra_rules.budget_v3 = applyBudgetV3(d, lines);
    d.extra_rules.early_undo = applyEarlyUndo(d);
    d.extra_rules.carrier = applyCarrier(d);
    d.extra_rules.cut_cooldown = d.extra_rules.budget_v3 ? false : applyCutCooldown(d);
  } catch (e) { d.extra_rules = { error: String(e.message || e).slice(0, 200) }; }
  return { d };
}
