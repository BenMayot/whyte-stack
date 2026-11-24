// Creative tab for the ads operator (Nov 16, 2026). Read-only.
// Money numbers (spend, purchases, cost per purchase, who "won") come from Meta via the creative engine's stats.
// Viewing numbers: hold rate is computed from the spine's Meta rows; hook rate, watch time, length and Motion's
// scores come from Motion, synced into the engine at state key "motion" by a scheduled run (Motion has no API key
// the server can call). Until that sync has run, those columns are empty.
import { createHash, timingSafeEqual } from "node:crypto";
const env = (k) => Netlify.env.get(k) || "";
const h = (s) => createHash("sha256").update(String(s)).digest();
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const engine = (p) => fetch(`${env("ENGINE_URL")}/api/v1/${p}`, { headers: { "x-engine-key": env("ENGINE_KEY") }, signal: AbortSignal.timeout(9000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const spine = (p) => fetch(`${env("SPINE_URL")}${p}`, { headers: { "x-spine-key": env("SPINE_API_KEY") }, signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const r2 = (x) => Math.round(x * 100) / 100, r1 = (x) => Math.round(x * 10) / 10;
const addDays = (day, n) => { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const MIN_JUDGED = 3, TEST_SPEND = 132, WIN_PURCHASES = 25, PASS_PURCHASES = 5, BIG_SPEND = 5000, FAIR_DAYS = 14, LIVE_SPEND7 = 100, STOP_SPEND = 500;
const REV_PER_ORDER = 37.23, TRYBE_COMMISSION = 0.05;
const dayDiff = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);

// Winner definition v2 (Nov 16, 2026), Meta numbers only, last 90 days:
//   winner  = 25+ purchases (Nov 20, Ben: 25 while daily volume is low, back to 50 when the budget allows) AND paid back (cost per purchase at or under its own break-even, or ROAS at or over break-even ROAS).
//             50 purchases is where Meta leaves the learning phase and where a result stops being luck (about $1,000 of spend).
//   passed  = passed the test (5+ purchases, paid back, $132+ spent) but has not reached 50 purchases. Not a winner yet.
//   miss    = spent the $132 test budget and did neither.
//   testing = under $132.
// A creative is "finished" (counts in the hit rate) once it is a winner or a miss, or it passed 14+ days ago and never scaled.
// Each winner also gets a state from the last 7 days: working (paying back on $100+), slipping (over break-even on $100+), resting (under $100).
const POSTERS = new Set("FOUNDER PARTNER_DO WE0095 WE0102 WE0114 WE0115 WE0335 WE0349 WE0353 WE0354 WE0361 WE0366 WE0426 WE0443 WE0446 WE0492 WE0496 WE0501 WE0530 WE0561 WE0645 WE0646".split(" "));
const POSTER_BASE = "https://whyte-creator-brief.netlify.app/posters/";
export function build(stats, cat, tax, motion, adRows, opAds, sends, matches, adtags, testBudgetDay) {
  // Motion's own description of each live ad (engine state "adtags", written by the daily tagging task): theme, hook,
  // format, audience, opening line, and the brief it was made from or sits next to. Description only; money stays Meta's.
  const AT = adtags?.by_creative || {}, atByAd = {};
  for (const [k, e] of Object.entries(AT)) for (const id of e.ad_ids || []) atByAd[String(id)] ||= { key: k, ...e };
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter((x) => x && !/^(none|other)$/i.test(x));
  const tagOf = (c, ads) => { let e = AT[c.id] ? { key: c.id, ...AT[c.id] } : c.legacy_key && AT[c.legacy_key] ? { key: c.legacy_key, ...AT[c.legacy_key] } : null;
    if (!e) for (const id of ads || []) if (atByAd[String(id)]) { e = atByAd[String(id)]; break; }
    return e ? { theme: arr(e.theme), hook: arr(e.hook), format: arr(e.format), persona: arr(e.persona), opening: e.opening || null, kind: e.kind || null,
      verdict: e.brief?.verdict || null, brief_id: e.brief?.verdict === "matched" ? e.brief.brief_id || null : null, near: arr(e.near), why: e.brief?.evidence || "" } : null; };
  const OP = {}; for (const a of opAds || []) OP[a.id] = a;
  const T = stats.thresholds || {}, BE = T.breakeven_cpa || 22.62, BR = T.breakeven_roas || 1.65, TO = stats.window?.to;
  const BE_T = r2(BE - TRYBE_COMMISSION * REV_PER_ORDER), BR_T = r2(REV_PER_ORDER / BE_T);
  const prodName = { oil: "Oil rinse", powder: "Purple powder", both: "Both" };
  const angleLabel = (p, a) => tax?.angles?.[p]?.[a] || tax?.angles?.any?.[a] || a || "Untagged";
  const fmtLabel = (f) => tax?.formats?.video?.[f] || tax?.formats?.static?.[f] || f || "Untagged";
  const hookLabel = (k) => tax?.hooks?.[k] || (k === "other" ? "Other" : k) || "Untagged";
  const srcLabel = (s) => ({ trybe: "Trybe creators", founder: "Founder (Shub)", static: "Statics", legacy: "Older ads", other: "Other" }[s] || s);
  const view = {};
  const from30 = TO ? addDays(TO, -29) : "", byAd = {};
  for (const r of adRows || []) { (byAd[r.ad_id] ||= []).push(r); if (r.day < from30) continue; const v = (view[r.ad_id] ||= { imp: 0, thru: 0, clicks: 0 }); v.imp += r.impressions || 0; v.thru += r.thruplays || 0; v.clicks += r.link_clicks || 0; }
  // viewing and buying rates for a set of ads over a date range (Meta rows)
  const rates = (ids, from, to) => { const x = { spend: 0, imp: 0, clk: 0, pur: 0 };
    for (const id of ids || []) for (const r of byAd[id] || []) if (r.day >= from && r.day <= to) { x.spend += r.spend || 0; x.imp += r.impressions || 0; x.clk += r.link_clicks || 0; x.pur += r.purchases || 0; }
    return { spend: Math.round(x.spend), cpa: x.pur ? r2(x.spend / x.pur) : null, ctr: x.imp ? r2(x.clk / x.imp * 100) : null, cpm: x.imp ? r2(x.spend / x.imp * 1000) : null, cvr: x.clk ? r1(x.pur / x.clk * 100) : null }; };
  const chg = (a, b) => (a != null && b ? Math.round((a - b) / b * 100) : null);
  // Why did a proven ad slip? Compare its last 7 days with the 30 days before.
  //   stale = clicks per view fell 12%+ (people stopped stopping for it) -> refilm the opening
  //   buy   = clicks held but purchases per click fell 12%+ -> not the video; look at the page / offer
  //   reach = neither, but it costs 15%+ more to reach people -> not the video; an auction cost
  const diagnose = (ids) => { if (!TO) return null;
    const now = rates(ids, addDays(TO, -6), TO), was = rates(ids, addDays(TO, -36), addDays(TO, -7));
    const d = { now, was, ctr: chg(now.ctr, was.ctr), cvr: chg(now.cvr, was.cvr), cpm: chg(now.cpm, was.cpm) };
    d.cause = now.spend < 300 || was.spend < 500 ? "thin" : d.ctr != null && d.ctr <= -12 ? "stale" : d.cvr != null && d.cvr <= -12 ? "buy" : d.cpm != null && d.cpm >= 15 ? "reach" : "unclear";
    return d; };
  // How was an ad doing when it stopped? Its last 14 days of spend.
  const ending = (ids, last) => { if (!last) return null; const e = rates(ids, addDays(last, -13), last), b = rates(ids, addDays(last, -43), addDays(last, -14)); return { last14: e, before: b }; };
  const M = motion?.ads || {};
  const creatives = [];
  for (const c of Array.isArray(cat.creatives) ? cat.creatives : Object.values(cat.creatives || {})) {
    const s = stats.by_creative?.[c.id]; if (!s) continue;
    const w = s.d90 || {}, d7 = s.d7 || {}, trybe = c.source === "trybe", be = trybe ? BE_T : BE, br = trybe ? BR_T : BR;
    const paid = (x) => (x.purchases || 0) > 0 && ((x.cpa != null && x.cpa <= be) || (x.roas != null && x.roas >= br));
    const spend = w.spend || 0, pur = w.purchases || 0, age = TO && s.first_day ? dayDiff(s.first_day, TO) : null;
    const tier = spend < TEST_SPEND ? "testing" : pur >= WIN_PURCHASES && paid(w) ? "winner" : pur >= PASS_PURCHASES && paid(w) ? "passed" : "miss";
    const finished = tier === "winner" || tier === "miss" || (tier === "passed" && age != null && age >= FAIR_DAYS);
    const spend7 = d7.spend || 0, now = tier !== "winner" ? null : spend7 < LIVE_SPEND7 ? "resting" : paid(d7) ? "working" : "slipping";
    let imp = 0, thru = 0, clicks = 0, mo = null, moSpend = -1;
    for (const id of s.ads || []) { const v = view[id]; if (v) { imp += v.imp; thru += v.thru; clicks += v.clicks; } const m = M[id]; if (m && (m.spend || 0) > moSpend) { mo = m; moSpend = m.spend || 0; } }
    // the ad to show for this creative: a live one if there is one, else any we know, else its first ad id
    const known = (s.ads || []).map((id) => OP[id]).filter(Boolean).sort((a, b) => (a.paused ? 1 : 0) - (b.paused ? 1 : 0) || (b.windows?.d7?.spend || 0) - (a.windows?.d7?.spend || 0));
    const pk = c.legacy_key && POSTERS.has(c.legacy_key) ? c.legacy_key : POSTERS.has(c.id) ? c.id : null;
    const thumb = pk ? POSTER_BASE + pk + ".jpg" : known[0]?.thumb || null, ad_id = known[0]?.id || (s.ads || [])[0] || null;
    const diag = now === "slipping" ? diagnose(s.ads) : null, end = now === "resting" && spend >= BIG_SPEND ? ending(s.ads, s.last_day) : null;
    if (end) end.verdict = end.last14.spend >= 200 && end.last14.cpa != null && end.last14.cpa <= be ? "relaunch" : "remake";
    const maker = c.source === "founder" ? "shub" : tax?.formats?.static?.[c.format] ? "ni" : "creators";
    const mt = tagOf(c, s.ads);
    creatives.push({ mt, brief_id: c.brief_id || mt?.brief_id || null, maker, key: pk || c.id, diag, end, format_name: fmtLabel(c.format), angle_name: angleLabel(c.product, c.angle), thumb, ad_id, pay7: spend7 >= 20 ? paid(d7) : null, id: c.id, talent: c.talent || null, product: c.product, angle: c.angle, format: c.format, hook: c.hook_pattern, hook_text: c.hook_text || null, source: c.source,
      tier, finished, judged: finished, won: tier === "winner", big: tier === "winner" && spend >= BIG_SPEND, now, age, breakeven: be,
      spend, purchases: pur, cpa: w.cpa ?? null, roas: w.roas ?? null, cpa7: d7.cpa ?? null, spend7, last_day: s.last_day || null, first_day: s.first_day || null,
      hold: imp >= 1000 && thru > 0 ? r1(thru / imp * 100) : null, ctr: imp >= 1000 ? r2(clicks / imp * 100) : null,
      hook_rate: mo?.hook ?? null, watch: mo?.watch ?? null, len: mo?.len ?? null, scores: mo?.scores || null });
  }
  const judged = creatives.filter((c) => c.finished), winners = creatives.filter((c) => c.won);
  const HIT = judged.length ? Math.round(winners.length / judged.length * 100) : null;
  const group = (keyOf, labelOf, filter) => {
    const g = {};
    for (const c of creatives) { if (filter && !filter(c)) continue; const k = keyOf(c); if (!k) continue;
      const x = (g[k] ||= { key: k, label: labelOf(c), judged: 0, won: 0, testing: 0, spend: 0, purchases: 0, hold: [], hook: [], ex: [] });
      if (c.won && c.thumb) x.ex.push(c);
      if (c.finished) x.judged++; else x.testing++; if (c.won) x.won++;
      x.spend += c.spend; x.purchases += c.purchases; if (c.hold != null) x.hold.push(c.hold); if (c.hook_rate != null) x.hook.push(c.hook_rate); }
    const avg = (a) => (a.length ? r1(a.reduce((s, v) => s + v, 0) / a.length) : null);
    return Object.values(g).map((x) => {
      const hit = x.judged ? Math.round(x.won / x.judged * 100) : null, cpa = x.purchases ? r2(x.spend / x.purchases) : null;
      // Calls are relative to the account's own hit rate: clearly above it = make more; nothing won on real money = stop.
      const call = x.judged < MIN_JUDGED ? "test" : x.won >= 2 && hit >= (HIT || 0) * 1.25 ? "more" : x.won === 0 && x.spend >= STOP_SPEND ? "stop" : hit < (HIT || 0) / 2 ? "weak" : "mixed";
      return { key: x.key, label: x.label, judged: x.judged, won: x.won, testing: x.testing, hit, spend: Math.round(x.spend), cpa, hold: avg(x.hold), hook: avg(x.hook), call,
        examples: x.ex.sort((a, b) => b.spend - a.spend).slice(0, 3).map((c) => ({ id: c.id, ad_id: c.ad_id, thumb: c.thumb, who: c.talent || c.id })) };
    }).sort((a, b) => (b.won - a.won) || (b.spend - a.spend));
  };
  // the same table, by Motion's tags. An ad with two formats counts under both.
  const groupTag = (field, dim, filter) => { const out = {}; 
    for (const c of creatives) { if (!c.mt || (filter && !filter(c))) continue; for (const v of c.mt[field]) {
      const x = (out[v] ||= { key: v, label: v, dim, judged: 0, won: 0, testing: 0, spend: 0, purchases: 0, hold: [], ex: [] });
      if (c.won && c.thumb) x.ex.push(c); if (c.finished) x.judged++; else x.testing++; if (c.won) x.won++; x.spend += c.spend; x.purchases += c.purchases; if (c.hold != null) x.hold.push(c.hold); } }
    return Object.values(out).map((x) => { const hit = x.judged ? Math.round(x.won / x.judged * 100) : null;
      const call = x.judged < MIN_JUDGED ? "test" : x.won >= 2 && hit >= (HIT || 0) * 1.25 ? "more" : x.won === 0 && x.spend >= STOP_SPEND ? "stop" : hit < (HIT || 0) / 2 ? "weak" : "mixed";
      return { key: x.key, label: x.label, dim, judged: x.judged, won: x.won, testing: x.testing, hit, spend: Math.round(x.spend), cpa: x.purchases ? r2(x.spend / x.purchases) : null,
        hold: x.hold.length ? r1(x.hold.reduce((a, b) => a + b, 0) / x.hold.length) : null, hook: null, call,
        examples: x.ex.sort((a, b) => b.spend - a.spend).slice(0, 3).map((c) => ({ id: c.id, ad_id: c.ad_id, thumb: c.thumb, who: c.talent || c.id })) }; })
      .sort((a, b) => (b.won - a.won) || (b.spend - a.spend)); };
  const tagged = creatives.filter((c) => c.mt), taggedJudged = tagged.filter((c) => c.finished).length;
  const MOT = { theme: { oil: groupTag("theme", "Angle", (c) => c.product === "oil"), powder: groupTag("theme", "Angle", (c) => c.product === "powder") },
    hook: groupTag("hook", "Opening"), format: groupTag("format", "Format"), persona: groupTag("persona", "Who it speaks to").map((x) => (x.key === "Broad" ? { ...x, label: "Everyone (no specific audience)" } : x)) };
  // use Motion's words for the pattern calls once most finished tests carry its tags
  const useMotion = creatives.filter((c) => c.finished).length > 0 && taggedJudged / creatives.filter((c) => c.finished).length >= 0.6;
  const byAngle = {}; for (const p of ["oil", "powder"]) byAngle[p] = group((c) => c.angle, (c) => angleLabel(c.product, c.angle), (c) => c.product === p);
  const byFormat = group((c) => c.format, (c) => fmtLabel(c.format));
  const byHook = group((c) => c.hook, (c) => hookLabel(c.hook));
  const bySource = group((c) => c.source, (c) => srcLabel(c.source));
  for (const x of bySource) if (x.call === "stop") x.call = "weak"; // a source is not something you stop on one read
  const mode = (arr, f) => { const n = {}; for (const c of arr) { const k = f(c); if (k) n[k] = (n[k] || 0) + 1; } const e = Object.entries(n).sort((a, b) => b[1] - a[1])[0]; return e ? { key: e[0], n: e[1] } : null; };
  const avgOf = (arr, f) => { const v = arr.map(f).filter((x) => x != null); return v.length ? r1(v.reduce((s, x) => s + x, 0) / v.length) : null; };
  const sum = (arr, f) => arr.reduce((s, c) => s + (f(c) || 0), 0);
  const losers = judged.filter((c) => !c.won);
  const mf = mode(winners, (c) => c.format), mh = mode(winners, (c) => c.hook);
  // the account view: how much rests on how few
  const spend90 = sum(creatives, (c) => c.spend), spend7 = sum(creatives, (c) => c.spend7);
  const by7 = [...creatives].filter((c) => c.spend7 > 0).sort((a, b) => b.spend7 - a.spend7), top2 = by7.slice(0, 2);
  const nowCount = (k) => winners.filter((c) => c.now === k).length;
  const notWinnerSpend = sum(creatives.filter((c) => !c.won), (c) => c.spend);
  const name = (c) => c.talent ? `${c.talent} (${c.id})` : c.id;
  const profile = { winners: winners.length, big: winners.filter((c) => c.big).length, judged: judged.length, hit: HIT,
    passed_waiting: creatives.filter((c) => c.tier === "passed" && !c.finished).length, testing: creatives.filter((c) => c.tier === "testing").length,
    passed_never_scaled: creatives.filter((c) => c.tier === "passed" && c.finished).length, misses: creatives.filter((c) => c.tier === "miss").length,
    new30: winners.filter((c) => c.age != null && c.age <= 30).length, working: nowCount("working"), slipping: nowCount("slipping"), resting: nowCount("resting"),
    spend90: Math.round(spend90), winner_spend_share: spend90 ? Math.round(sum(winners, (c) => c.spend) / spend90 * 100) : null,
    cost_per_winner: winners.length ? Math.round(notWinnerSpend / winners.length) : null, not_winner_spend: Math.round(notWinnerSpend),
    spend7: Math.round(spend7), winners7_share: spend7 ? Math.round(sum(winners, (c) => c.spend7) / spend7 * 100) : null,
    top2: top2.map((c) => ({ name: name(c), share: spend7 ? Math.round(c.spend7 / spend7 * 100) : null, cpa7: c.cpa7, over: c.cpa7 != null && c.cpa7 > c.breakeven })),
    top2_share: spend7 ? Math.round(sum(top2, (c) => c.spend7) / spend7 * 100) : null,
    top_format: mf && { label: fmtLabel(mf.key), n: mf.n }, top_hook: mh && { label: hookLabel(mh.key), n: mh.n },
    hold_win: avgOf(winners, (c) => c.hold), hold_lose: avgOf(losers, (c) => c.hold), hook_win: avgOf(winners, (c) => c.hook_rate), hook_lose: avgOf(losers, (c) => c.hook_rate),
    len_win: avgOf(winners, (c) => c.len), len_lose: avgOf(losers, (c) => c.len), watch_win: avgOf(winners, (c) => c.watch) };
  const have = new Set(creatives.map((c) => `${c.product}|${c.angle}|${c.format}`)), gaps = [];
  const goodFormats = byFormat.filter((f) => f.call === "more" && tax?.formats?.video?.[f.key]).map((f) => f.key);
  for (const p of ["oil", "powder"]) for (const a of byAngle[p].filter((x) => x.call === "more")) for (const f of goodFormats)
    if (!have.has(`${p}|${a.key}|${f}`)) gaps.push({ product: prodName[p], angle: a.label, format: fmtLabel(f) });
  const usd = (n, d = 0) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const act = [];
  // protect: winners that are slipping, and big winners that are no longer running
  for (const c of winners.filter((x) => x.now === "slipping").sort((a, b) => b.spend7 - a.spend7).slice(0, 4))
    act.push({ kind: "fix", what: `${name(c)} is slipping`, why: `${usd(c.cpa7, 2)} per purchase on ${usd(c.spend7)} in the last 7 days, against ${usd(c.cpa, 2)} over 90 days. Brief new openings on the same idea before it has to be cut.` });
  for (const c of winners.filter((x) => x.now === "resting" && x.big).sort((a, b) => b.spend - a.spend).slice(0, 3))
    act.push({ kind: "fix", what: `Remake ${name(c)}`, why: `${usd(c.spend)} at ${usd(c.cpa, 2)} per purchase over 90 days, and it is barely spending now${c.last_day ? " (last ran " + c.last_day.slice(5) + ")" : ""}. Same idea, new take.` });
  const pick = (list, call, n) => list.filter((x) => x.call === call).slice(0, n);
  for (const p of ["oil", "powder"]) for (const a of pick(byAngle[p], "more", 2)) act.push({ kind: "more", what: `${prodName[p]}: ${a.label}`, why: `${a.won} of ${a.judged} became winners, ${a.cpa != null ? usd(a.cpa, 2) + " per purchase" : ""}`.trim() });
  for (const f of pick(byFormat, "more", 2)) act.push({ kind: "more", what: `Format: ${f.label}`, why: `${f.won} of ${f.judged} became winners` });
  for (const p of ["oil", "powder"]) for (const a of pick(byAngle[p], "stop", 2)) act.push({ kind: "stop", what: `${prodName[p]}: ${a.label}`, why: `0 of ${a.judged} became winners on ${usd(a.spend)}` });
  for (const a of [...pick(byFormat, "stop", 2), ...pick(byHook, "stop", 2)]) act.push({ kind: "stop", what: a.label, why: `0 of ${a.judged} became winners on ${usd(a.spend)}` });
  for (const g of gaps.slice(0, 3)) act.push({ kind: "test", what: `${g.product}: ${g.angle} as ${g.format}`, why: "A winning angle in a winning format that nobody has filmed" });
  const card = (c) => ({ mt: c.mt ? { theme: c.mt.theme, hook: c.mt.hook, persona: c.mt.persona.filter((x) => x !== "Broad") } : null, maker: c.maker, key: c.key, diag: c.diag, end: c.end, format: c.format_name, angle: c.angle_name, days: c.age, id: c.id, who: c.talent || null, product: c.product, line: c.hook_text || null, thumb: c.thumb, ad_id: c.ad_id, now: c.now, big: c.big, winner: c.won,
    share7: spend7 ? Math.round(c.spend7 / spend7 * 100) : 0, spend7: Math.round(c.spend7), cpa7: c.cpa7, pay7: c.pay7, spend: Math.round(c.spend), cpa: c.cpa, breakeven: c.breakeven, last_day: c.last_day });
  // where the last 7 days' money went: the biggest creatives, the rest lumped together
  const bar = by7.slice(0, 6).filter((c) => spend7 && c.spend7 / spend7 >= 0.04).map(card);
  const restShare = Math.max(0, 100 - bar.reduce((s, c) => s + c.share7, 0));
  const paying7 = spend7 ? Math.round(sum(creatives.filter((c) => c.pay7 === true), (c) => c.spend7) / spend7 * 100) : null;
  const pat = (list, p) => list.map((x) => ({ ...x, product: p || null }));
  const allPat = [...pat(byFormat).map((x) => ({ ...x, dim: "Format" })), ...pat(byAngle.oil, "Oil rinse").map((x) => ({ ...x, dim: "Angle" })), ...pat(byAngle.powder, "Purple powder").map((x) => ({ ...x, dim: "Angle" }))];
  let patterns = { source: "catalogue", more: allPat.filter((x) => x.call === "more").sort((a, b) => b.hit - a.hit || b.won - a.won).slice(0, 4),
    less: allPat.filter((x) => x.call === "stop" || x.call === "weak").sort((a, b) => a.hit - b.hit || b.judged - a.judged).slice(0, 4), next: gaps.slice(0, 3) };
  if (useMotion) {
    const mAll = [...pat(MOT.theme.oil, "Oil rinse"), ...pat(MOT.theme.powder, "Purple powder"), ...pat(MOT.format), ...pat(MOT.hook), ...pat(MOT.persona.filter((x) => x.key !== "Broad"))];
    const haveM = new Set(); for (const c of tagged) for (const t of c.mt.theme) for (const f of c.mt.format) haveM.add(`${c.product}|${t}|${f}`);
    const gF = MOT.format.filter((f) => f.call === "more").map((f) => f.key), nextM = [];
    for (const p of ["oil", "powder"]) for (const a of MOT.theme[p].filter((x) => x.call === "more")) for (const f of gF) if (!haveM.has(`${p}|${a.key}|${f}`)) nextM.push({ product: prodName[p], angle: a.label, format: f });
    patterns = { source: "motion", more: mAll.filter((x) => x.call === "more").sort((a, b) => b.hit - a.hit || b.won - a.won).slice(0, 6),
      less: mAll.filter((x) => x.call === "stop" || x.call === "weak").sort((a, b) => a.hit - b.hit || b.judged - a.judged).slice(0, 4), next: nextM.slice(0, 3) };
  }
  // The ledger: everything that was asked for in a weekly send, and what came of it. A creative counts toward a brief
  // when the catalogue tags it with that brief's id (the Monday run's intake does this; remakes use "R-<original id>").
  const madeBy = {}; for (const c of creatives) if (c.brief_id) (madeBy[c.brief_id] ||= []).push(c);
  // Videos matched to a brief when they were submitted (engine state "matches", written by the daily matcher), whether or
  // not they have run as ads yet. This is what makes "filmed" visible before any money is spent.
  const MS = Object.entries(matches?.by_submission || {}).map(([tid, m]) => ({ trybe_id: tid, ...m })), filmedBy = {};
  for (const m of MS) if (m.verdict === "matched" && m.brief_id) (filmedBy[m.brief_id] ||= []).push(m);
  const matching = matches ? { last_run: matches.last_run || null, checked: MS.length, matched: MS.filter((m) => m.verdict === "matched").length, own: MS.filter((m) => m.verdict === "own_idea").length,
    unsure: MS.filter((m) => m.verdict === "unsure").map((m) => ({ trybe_id: m.trybe_id, creator: m.creator || null, product: m.product || null, thumb: m.thumb || null, opening: m.opening || null, candidates: m.candidates || [], why: m.evidence || "" })).slice(0, 20),
    recheck: matches.recheck || null } : null;
  const nearBy = {}; for (const c of creatives) for (const b of c.mt?.near || []) if (b !== c.brief_id) (nearBy[b] ||= []).push(c);
  const BT = adtags?.briefs || {}, briefTitle = {}; for (const w of sends?.sends || []) for (const it of w.items || []) briefTitle[it.id] = it.title;
  const ex = (list) => list.slice().sort((a, b) => b.spend - a.spend).slice(0, 3).map((c) => ({ id: c.id, ad_id: c.ad_id, thumb: c.thumb, who: c.talent || c.id }));
  const ledger = (sends?.sends || []).slice().reverse().map((w) => ({ week: w.week, week_label: w.week_label, sent_at: w.sent_at, items: (w.items || []).map((it) => {
    const made = madeBy[it.id] || [], n = (t) => made.filter((c) => c.tier === t).length, win = n("winner"), pass = n("passed"), miss = n("miss"), test = n("testing");
    const filmed = (filmedBy[it.id] || []).length, near = (nearBy[it.id] || []).filter((c) => !made.includes(c));
    const status = !made.length ? (near.length ? "near" : filmed ? "filmed" : "none") : win ? "worked" : pass ? "promising" : test ? "testing" : "missed";
    const bt = BT[it.id] ? { theme: arr(BT[it.id].theme), hook: arr(BT[it.id].hook), format: arr(BT[it.id].format), persona: arr(BT[it.id].persona).filter((x) => x !== "Broad") } : null;
    return { ...it, tags: bt, near: near.length, near_won: near.filter((c) => c.won).length, near_passed: near.filter((c) => c.tier === "passed").length, near_examples: ex(near), angle_name: it.angle ? angleLabel(it.product, it.angle) : null, format_name: it.format ? fmtLabel(it.format) : null, filmed, made: made.length, winners: win, passed: pass, testing: test, misses: miss, status,
      spend: Math.round(sum(made, (c) => c.spend)), examples: made.slice().sort((a, b) => b.spend - a.spend).slice(0, 3).map((c) => ({ id: c.id, ad_id: c.ad_id, thumb: c.thumb, who: c.talent || c.id })) }; }) }));
  const firstSend = (sends?.sends || []).map((w) => String(w.sent_at || "").slice(0, 10)).filter(Boolean).sort()[0] || null;
  // Count from the tag store itself, not the catalogue: a new ad is described within a day, but only joins the catalogue on Monday.
  const cById = {}; for (const c of creatives) { cById[c.id] = c; if (c.key) cById[c.key] = c; }
  const cByAd = {}; for (const c of creatives) for (const id of stats.by_creative?.[c.id]?.ads || []) cByAd[String(id)] = c;
  const sinceT = firstSend ? Object.entries(AT).filter(([, e]) => String(e.launched || "").slice(0, 10) >= firstSend).map(([k, e]) => {
    const c = cById[k] || (e.ad_ids || []).map((id) => cByAd[String(id)]).find(Boolean) || null, op = (e.ad_ids || []).map((id) => OP[String(id)]).find(Boolean) || null;
    const matched = e.brief?.verdict === "matched" && e.brief.brief_id, near = arr(e.near);
    const who = c?.talent || (String(e.ad_name || "").match(/^([A-Za-z]+?)\s*_/) || [])[1]?.replace(/([a-z])([A-Z])/g, "$1 $2") || null;
    return { id: c?.id || k, ad_id: c?.ad_id || op?.id || (e.ad_ids || [])[0] || null, thumb: c?.thumb || op?.thumb || null, who, maker: c?.maker || (e.kind === "static" ? "ni" : /founder|shubtyagi|shubwhyte/i.test(e.ad_name || "") ? "shub" : "creators"),
      product: c?.product || (/powder/i.test(e.ad_name || "") && !/rinse/i.test(e.ad_name || "") ? "powder" : /rinse|oil/i.test(e.ad_name || "") && !/powder/i.test(e.ad_name || "") ? "oil" : "both"), tier: c?.tier || "testing",
      place: matched ? "matched" : near.length ? "near" : "own", opening: e.opening || null, tags: [...arr(e.theme), ...arr(e.hook), ...arr(e.format), ...arr(e.persona).filter((x) => x !== "Broad")],
      near: near.map((b) => briefTitle[b] || b).slice(0, 3), why: e.brief?.evidence || "", spend: c?.spend || 0 }; }) : [];
  const tagging = adtags ? { last_run: adtags.last_run || null, tagged: tagged.length, total: creatives.length, all_tagged: Object.keys(AT).length, first_send: firstSend, since: sinceT.length,
    matched: sinceT.filter((x) => x.place === "matched").length, near: sinceT.filter((x) => x.place === "near").length, own: sinceT.filter((x) => x.place === "own").length, untagged: 0,
    unplaced: sinceT.filter((x) => x.place !== "matched").sort((a, b) => (a.place === "near" ? 0 : 1) - (b.place === "near" ? 0 : 1) || b.spend - a.spend).slice(0, 40) } : null;
  // Capacity (Nov 20, 2026): how many new ads the test budget can take in a week, and how many each group actually delivers.
  // Nobody can enforce "3 to 5 versions", so creators are counted from what they launched, not from what was asked.
  const monOf = (d) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
  const todayD = new Date().toISOString().slice(0, 10), thisMon = monOf(todayD), lastMon = monOf(new Date(Date.parse(thisMon + "T12:00:00Z") - 7 * 864e5).toISOString().slice(0, 10));
  const isFounder = (n) => /founder|shubtyagi|shubwhyte/i.test(n || ""), wkCount = (mon) => { const o = { creators: 0, shub: 0, ni: 0, people: new Set() };
    for (const e of Object.values(AT)) { const l = String(e.launched || "").slice(0, 10); if (!l || monOf(l) !== mon) continue;
      if (e.kind === "static") o.ni++; else if (isFounder(e.ad_name)) o.shub++; else { o.creators++; const m = String(e.ad_name || "").match(/^([A-Za-z]+)\s*_.*trybe/i); if (m) o.people.add(m[1].toLowerCase()); } }
    return { creators: o.creators, shub: o.shub, ni: o.ni, people: o.people.size }; };
  const TEST_COST = [110, 132], wkBudget = testBudgetDay ? testBudgetDay * 7 : null;
  const capacity = { test_budget_day: testBudgetDay || null, test_budget_week: wkBudget, cost_per_test: TEST_COST,
    slots: wkBudget ? { low: Math.floor(wkBudget / TEST_COST[1]), high: Math.floor(wkBudget / TEST_COST[0]) } : null,
    last_week: adtags ? { from: lastMon, ...wkCount(lastMon) } : null, this_week: adtags ? { from: thisMon, ...wkCount(thisMon) } : null,
    per_brief: { shub: [2, 3], ni: [2, 3], creators: [3, 5] }, limits: { creators: 3, shub: 3, ni: 2 } };
  const order = { working: 0, slipping: 1, resting: 2 };
  winners.sort((a, b) => (order[a.now] - order[b.now]) || (b.spend7 - a.spend7) || (b.spend - a.spend));
  return { as_of: stats.computed_at, window: stats.window, breakeven: BE, breakeven_trybe: BE_T, rule: { win_purchases: WIN_PURCHASES, test_spend: TEST_SPEND, fair_days: FAIR_DAYS, live_spend7: LIVE_SPEND7 },
    motion: motion ? { pulled_at: motion.pulled_at || null, window: motion.window || null, ads: Object.keys(M).length } : null,
    profile, actions: act, by_angle: byAngle, by_format: byFormat, by_hook: byHook, by_source: bySource, gaps: gaps.slice(0, 12),
    ledger, matching, tagging, capacity, by_motion: tagged.length ? MOT : null, spend7: Math.round(spend7), paying7_share: paying7, bar, bar_rest: restShare, patterns,
    cards: { working: winners.filter((c) => c.now === "working").map(card), slipping: winners.filter((c) => c.now === "slipping").map(card),
      idle: winners.filter((c) => c.now === "resting" && c.big).sort((a, b) => b.spend - a.spend).slice(0, 6).map(card) },
    account: TO ? { now: rates(Object.keys(byAd), addDays(TO, -6), TO), was: rates(Object.keys(byAd), addDays(TO, -36), addDays(TO, -7)) } : null,
    winners: winners.slice(0, 40), almost: creatives.filter((c) => c.tier === "passed" && !c.finished).sort((a, b) => b.spend - a.spend).slice(0, 10), untagged: (stats.untagged || []).length };
}

export default async (req) => {
  const pw = env("OPERATOR_PASSWORD");
  if (!pw || !timingSafeEqual(h((req.headers.get("x-op-pass") || "").trim().toLowerCase()), h(pw.trim().toLowerCase()))) return json({ error: "unauthorized" }, 401);
  const [stats, cat, tax, motion, sends, matches, adtags_] = await Promise.all([engine("stats"), engine("catalogue"), engine("taxonomy"), engine("state?key=motion"), engine("state?key=sends"), engine("state?key=matches"), engine("state?key=adtags")]);
  if (!stats || !cat) return json({ error: "creative engine unreachable" }, 502);
  const to = stats.window?.to;
  // 90 days of Meta ad rows, in three pulls (the spine allows 31 days per pull)
  const pull = (f, t) => spine(`/api/v1/meta/ad-days?from=${f}&to=${t}`).then((x) => x?.rows || []);
  const [r1_, r2_, r3_, op] = await Promise.all([to ? pull(addDays(to, -29), to) : [], to ? pull(addDays(to, -59), addDays(to, -30)) : [], to ? pull(addDays(to, -89), addDays(to, -60)) : [],
    fetch(`${env("SPINE_URL")}/api/v1/operator?max_age=900`, { headers: { "x-spine-key": env("SPINE_API_KEY") }, signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
  const ad = { rows: [...r1_, ...r2_, ...r3_] };
  const mo = motion && (motion.value || motion.data || motion); const at = adtags_ && (adtags_.value || adtags_);
  try { return json(build(stats, cat, tax || {}, mo && mo.ads ? mo : null, ad?.rows || [], op?.ads || [], sends, matches && matches.by_submission ? matches : null, at && at.by_creative ? at : null, op?.account?.daily_budget?.test || null)); }
  catch (e) { return json({ error: "creative view failed: " + String(e.message).slice(0, 200) }, 500); }
};
export const config = { path: "/api/creative" };
