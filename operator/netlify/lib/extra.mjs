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
  const BE = B.breakeven ?? d.rules?.breakeven_cpa; if (!BE) return false;
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
    why: `Early undo: the raise on ${fmtDay(B.last_change.day)} closed its first day at ${day1.cpa != null ? "$" + day1.cpa.toFixed(2) : "no purchases"}, over the $${BE} break-even, and today is at ${tc != null ? "$" + tc.toFixed(2) : "no purchases"} on $${Math.round(t.s)} of scaling spend. Go back to $${prev.toLocaleString("en-US")} now instead of waiting for a 2nd bad day` };
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


// Fetch the spine's operator view and apply every site rule. Returns the same object the page renders.
export async function operatorView(spine, maxAge = 600) {
  const r = await spine(`/api/v1/operator?max_age=${maxAge}`); const text = await r.text();
  if (!r.ok) return { raw: text, status: r.status };
  let d; try { d = JSON.parse(text); } catch { return { raw: text, status: r.status }; }
  if (d.error || !Array.isArray(d.ads)) return { raw: text, status: r.status };
  try {
    const from = addDays(d.closed_through, -(SLIDE_DAYS - 1));
    const ad = await (await spine(`/api/v1/meta/ad-days?from=${from}&to=${d.closed_through}`)).json();
    d.extra_rules = { slide_cuts: applySlide(d, ad.rows || []), early_undo: applyEarlyUndo(d) };
    d.extra_rules.carrier = applyCarrier(d);
    d.extra_rules.cut_cooldown = applyCutCooldown(d);
  } catch (e) { d.extra_rules = { error: String(e.message || e).slice(0, 200) }; }
  return { d };
}
