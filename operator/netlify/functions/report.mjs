// Creative report for the ads operator (Nov 20, 2026). Read-only. Built with Ben for Shub and David.
// The Creative tab is a reporting tool first: how creative is doing, why, and what that says to make next.
// The weekly plan and Send moved to the Briefs tab (/api/creative, /api/plan).
//
// Everything here is counted from Meta's own rows (the spine), so an ad shows up the day after it launches,
// not when it joins the catalogue on Monday. Motion's tags (engine state "adtags") describe each ad; they never
// supply money numbers.
//
// DEFINITIONS (agreed Nov 20):
//   passed the test = $110+ spent, 5+ purchases, at or under its line (cost per purchase, or ROAS at/over break-even ROAS):
//                     the same bar the Ads tab uses to graduate an ad
//   winner          = 25+ purchases at or under its line (25 while daily volume is low; back to 50 later)
//   big winner      = $5,000+ of spend at or under its line
//   missed          = spent $132+ and did neither
//   killed early    = switched off between $44 and $132 without passing (a test call was made on it; counts as not passed)
//   no real test    = switched off under $44: Meta barely spent on it, so it says nothing about the ad. Left out of every rate.
//   in test         = under $132, not passed, and still spending in the last 3 days
//   Rates are always by LAUNCH WEEK, so a count and a rate describe the same ads:
//     pass rate   = (passed + winners) / ads no longer in test
//     winner rate = winners / ads launched, shown only for weeks 21+ days old
//   The unit is the IDEA: the brief an ad was made from when that is known, otherwise product + angle + format.
//   An idea "passed" / "won" when at least one of its versions did.
import { createHash, timingSafeEqual } from "node:crypto";
const env = (k) => Netlify.env.get(k) || "";
const h = (s) => createHash("sha256").update(String(s)).digest();
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const engine = (p) => fetch(`${env("ENGINE_URL")}/api/v1/${p}`, { headers: { "x-engine-key": env("ENGINE_KEY") }, signal: AbortSignal.timeout(9000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const spine = (p) => fetch(`${env("SPINE_URL")}${p}`, { headers: { "x-spine-key": env("SPINE_API_KEY") }, signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const r2 = (x) => Math.round(x * 100) / 100, r1 = (x) => Math.round(x * 10) / 10;
const addDays = (day, n) => { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
const monOf = (d) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
const TEST_SPEND = 132, PASS_SPEND = 110, MIN_TEST = 44, PASS_PURCHASES = 5, WIN_PURCHASES = 25, BIG_SPEND = 5000, WINNER_AGE = 21, MIN_PATTERN = 6, QUALITY_MIN_IMP = 3000;
const REV_PER_ORDER = 37.23, TRYBE_COMMISSION = 0.05;
const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter((x) => x && !/^(none|other)$/i.test(x));
const prodName = { oil: "Oil rinse", powder: "Purple powder", both: "Both products" };
const POSTERS = new Set("FOUNDER PARTNER_DO WE0095 WE0102 WE0114 WE0115 WE0335 WE0349 WE0353 WE0354 WE0361 WE0366 WE0426 WE0443 WE0446 WE0492 WE0496 WE0501 WE0530 WE0561 WE0645 WE0646".split(" "));
const POSTER_BASE = "https://whyte-creator-brief.netlify.app/posters/";
const camel = (s) => String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();

export function buildReport({ rows, cat, stats, tax, adtags, sends, op, published }) {
  const R = op?.rules || {}, BE = R.breakeven_cpa || 22.62, BE_T = R.breakeven_cpa_trybe || r2(BE - TRYBE_COMMISSION * REV_PER_ORDER), BR = R.breakeven_roas || 1.65, BR_T = R.breakeven_roas_trybe || 1.79;
  const TO = rows.reduce((m, r) => (r.day > m ? r.day : m), "") || op?.closed_through || new Date().toISOString().slice(0, 10);
  const d7 = addDays(TO, -6), p7 = addDays(TO, -13), d30 = addDays(TO, -29), p30 = addDays(TO, -59), d3 = addDays(TO, -2);
  const OP = {}; for (const a of op?.ads || []) OP[a.id] = a;
  const AT = adtags?.by_creative || {}, atByAd = {}; for (const [k, e] of Object.entries(AT)) for (const id of e.ad_ids || []) atByAd[String(id)] ||= { key: k, ...e };
  // catalogue: which creative an ad belongs to, and what we already know about it
  const catByAd = {}, catById = {}; for (const [cid, c0] of Array.isArray(cat?.creatives) ? cat.creatives.map((c) => [c.id, c]) : Object.entries(cat?.creatives || {})) { const c = { ...c0, id: c0.id || cid }; catById[c.id] = c; for (const id of stats?.by_creative?.[c.id]?.ads || []) catByAd[String(id)] = c; }
  const angleLabel = (p, a) => tax?.angles?.[p]?.[a] || tax?.angles?.any?.[a] || null, fmtLabel = (f) => tax?.formats?.video?.[f] || tax?.formats?.static?.[f] || null;
  const briefTitle = {}, briefFor = {}; for (const w of sends?.sends || []) for (const it of w.items || []) { briefTitle[it.id] = it.title; briefFor[it.id] = it.audience; }

  // ---- 1. one record per creative (the same video or image, across every ad that ran it) ----
  const CR = {};
  for (const r of rows) {
    const id = String(r.ad_id), c = catByAd[id], t = atByAd[id];
    const key = c ? c.id : t ? t.key : r.we_id || (r.trybe_id ? "T-" + r.trybe_id : "AD-" + id);
    const x = (CR[key] ||= { key, ads: new Set(), names: new Set(), cat: c || catById[key] || null, tag: t || AT[key] || null, trybe: false, days: {}, first: r.day, last: r.day });
    x.ads.add(id); x.names.add(r.ad_name || ""); if (r.trybe_id || /trybe=/i.test(r.ad_name || "")) x.trybe = true; if (!x.tag && t) x.tag = t; if (!x.cat && c) x.cat = c;
    if (!(r.spend > 0) && !(r.impressions > 0)) continue;
    if (r.day < x.first) x.first = r.day; if (r.day > x.last) x.last = r.day;
    const d = (x.days[r.day] ||= { s: 0, p: 0, v: 0, c: 0, i: 0, h: 0, t: 0 });
    d.s += r.spend || 0; d.p += r.purchases || 0; d.v += r.purchase_value || 0; d.c += r.link_clicks || 0; d.i += r.impressions || 0; d.h += r.video_3s || 0; d.t += r.thruplays || 0;
  }
  const sum = (x, from, to) => { const o = { s: 0, p: 0, v: 0, c: 0, i: 0, h: 0, t: 0 }; for (const [day, d] of Object.entries(x.days)) if (day >= from && day <= to) for (const k in o) o[k] += d[k]; return o; };
  const fin = (o) => ({ spend: Math.round(o.s), purchases: o.p, cpa: o.p ? r2(o.s / o.p) : null, roas: o.s ? r2(o.v / o.s) : null });
  const creatives = [];
  for (const x of Object.values(CR)) {
    const L = sum(x, "0", "9"); if (L.s < 1) continue;
    const name = [...x.names].sort((a, b) => b.length - a.length)[0] || "", c = x.cat, t = x.tag, anyOp = [...x.ads].map((id) => OP[id]).filter(Boolean);
    const founder = c?.source === "founder" || /founder|shubtyagi|shubwhyte/i.test(name), isStatic = c?.source === "static" || t?.kind === "static" || /\bstatic\b|\bimage\b|\bimg\b/i.test(name);
    const maker = founder ? "shub" : isStatic ? "ni" : x.trybe || c?.source === "trybe" ? "creators" : "older";
    const m = name.match(/^([A-Za-z]+)\s*_.*trybe=/i), who = c?.talent || (m ? camel(m[1]).replace(/\b(\w)(\w*)/g, (_, a, b) => a.toUpperCase() + b) : founder ? "Shub" : anyOp.find((a) => a.creator)?.creator || null);
    const product = c?.product && c.product !== "unknown" ? c.product : /powder|purple/i.test(name) && !/rinse|oil/i.test(name) ? "powder" : /rinse|oil/i.test(name) && !/powder|purple/i.test(name) ? "oil" : anyOp[0]?.product === "Purple powder" ? "powder" : anyOp[0]?.product === "Oil rinse" ? "oil" : "both";
    const line = x.trybe ? BE_T : BE, br = x.trybe ? BR_T : BR, life = fin(L), w7 = fin(sum(x, d7, TO)), wp7 = fin(sum(x, p7, addDays(d7, -1)));
    const paid = (w) => w.purchases > 0 && ((w.cpa !== null && w.cpa <= line) || (w.roas !== null && w.roas >= br));
    const live = anyOp.some((a) => !a.paused), recent = x.last >= d3;
    const status = L.p >= WIN_PURCHASES && paid(life) ? "winner" : L.s >= PASS_SPEND && L.p >= PASS_PURCHASES && paid(life) ? "passed" : L.s >= TEST_SPEND ? "missed" : live || recent ? "testing" : L.s >= MIN_TEST ? "killed" : "untested";
    const big = status === "winner" && L.s >= BIG_SPEND;
    const state = status === "winner" ? (w7.spend >= 100 ? (paid(w7) ? "working" : "slipping") : "resting") : null;
    const theme = arr(t?.theme), hook = arr(t?.hook), format = arr(t?.format), persona = arr(t?.persona).filter((p) => p !== "Broad");
    const angle = theme[0] || (c ? angleLabel(c.product, c.angle) : null), fmt = format[0] || (c ? fmtLabel(c.format) : null);
    const brief = (t?.brief?.verdict === "matched" && t.brief.brief_id) || c?.brief_id || null;
    const ideaKey = brief ? "B:" + brief : `${product}|${angle || "?"}|${fmt || "?"}`;
    const ideaTitle = brief ? briefTitle[brief] || brief : [angle || "Angle not read yet", fmt].filter(Boolean).join(" · ");
    const adId = (anyOp.find((a) => !a.paused) || anyOp[0])?.id || [...x.ads].sort().pop();
    const thumb = POSTERS.has(x.key) ? POSTER_BASE + x.key + ".jpg" : (anyOp.find((a) => a.thumb) || {}).thumb || null;
    const q = L.i >= QUALITY_MIN_IMP ? { hook: isStatic || !L.h ? null : r1(L.h / L.i * 100), hold: isStatic || !L.h ? null : r1(L.t / L.h * 100), ctr: r2(L.c / L.i * 100), cvr: L.c ? r1(L.p / L.c * 100) : null } : null;
    creatives.push({ key: x.key, ad_id: adId, thumb, who, maker, product, trybe: x.trybe, line, first: x.first, last: x.last, week: monOf(x.first), age: dayDiff(x.first, TO) + 1, live, status, big, state,
      spend: life.spend, purchases: life.purchases, cpa: life.cpa, roas: life.roas, spend7: w7.spend, cpa7: w7.cpa, roas7: w7.roas, purchases7: w7.purchases, spend_prev7: wp7.spend, cpa_prev7: wp7.cpa,
      theme, hook, format, persona, angle, fmt, opening: t?.opening || c?.hook_text || null, brief, idea: ideaKey, idea_title: ideaTitle, q, name: name.slice(0, 90) });
  }
  const done = (c) => c.status !== "testing" && c.status !== "untested", passedish = (c) => c.status === "passed" || c.status === "winner", isWin = (c) => c.status === "winner";

  // ---- quality: where each ad sits against the account (ads with $132+ only), so "good but in a slow week" is visible ----
  const base = creatives.filter((c) => c.q && c.spend >= TEST_SPEND), med = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const BQ = Object.fromEntries(["hook", "hold", "ctr", "cvr"].map((f) => [f, base.map((c) => c.q[f]).filter((x) => x != null)]));
  const pctl = (field, v) => { const xs = BQ[field]; return v == null || xs.length < 8 ? null : Math.round(xs.filter((x) => x <= v).length / xs.length * 100); };
  const medians = { hook: med(BQ.hook), hold: med(BQ.hold), ctr: med(BQ.ctr), cvr: med(BQ.cvr) };
  const lvl = (p) => (p == null ? null : p >= 67 ? "high" : p <= 33 ? "low" : "mid");
  const qread = (q, over) => { if (!q) return null; const s = { hook: lvl(pctl("hook", q.hook)), ctr: lvl(pctl("ctr", q.ctr)), cvr: lvl(pctl("cvr", q.cvr)) };
    const txt = over === null ? null
      : over ? (s.cvr === "low" && s.ctr !== "low" ? "Gets the click, doesn’t close the sale" : s.ctr === "low" && s.hook === "high" ? "Stops the scroll, doesn’t earn the click" : s.hook === "low" ? "Doesn’t stop the scroll" : s.ctr === "low" ? "Too few people click" : s.hook === "high" && s.ctr !== "low" && s.cvr !== "low" ? "Good signals, costly reach: worth another look" : "No single weak spot")
      : (s.cvr === "high" ? "Converts well once clicked" : s.ctr === "high" ? "Earns the click" : s.hook === "high" ? "Stops the scroll" : "Solid across the board");
    return { ...q, levels: s, read: txt }; };
  for (const c of creatives) c.quality = qread(c.q, c.cpa === null ? (c.spend >= 66 ? true : null) : c.cpa > c.line), delete c.q;

  // ---- 2. ideas ----
  const IDEAS = {};
  for (const c of creatives) { const g = (IDEAS[c.idea] ||= { key: c.idea, title: c.idea_title, brief: c.brief, product: c.product, angle: c.angle, format: c.fmt, versions: [] }); g.versions.push(c); }
  const rank = { winner: 5, passed: 4, testing: 3, missed: 2, killed: 1, untested: 0 };
  const ideas = Object.values(IDEAS).map((g) => { const v = g.versions.sort((a, b) => b.spend - a.spend), S = (f) => v.reduce((n, c) => n + (c[f] || 0), 0);
    const spend = S("spend"), pur = S("purchases"), spend7 = S("spend7"), pur7 = S("purchases7"), val = v.reduce((n, c) => n + (c.roas || 0) * c.spend, 0), val7 = v.reduce((n, c) => n + (c.roas7 || 0) * c.spend7, 0);
    const best = v.slice().sort((a, b) => rank[b.status] - rank[a.status] || b.spend - a.spend)[0], line = v.every((c) => c.trybe) ? BE_T : BE;
    const makers = [...new Set(v.map((c) => c.maker))], people = [...new Set(v.map((c) => c.who).filter(Boolean))];
    const qv = v.filter((c) => c.quality).sort((a, b) => b.spend - a.spend)[0];
    return { key: g.key, title: g.title, brief: g.brief, product: g.product, angle: g.angle, format: g.format, n: v.length, live: v.filter((c) => c.live).length, makers, people: people.slice(0, 6), status: best.status, state: best.state,
      winners: v.filter(isWin).length, passed: v.filter((c) => c.status === "passed").length, testing: v.filter((c) => c.status === "testing").length, missed: v.filter((c) => c.status === "missed" || c.status === "killed").length, untested: v.filter((c) => c.status === "untested").length, untagged: !g.brief && !g.angle,
      spend, purchases: pur, cpa: pur ? r2(spend / pur) : null, roas: spend ? r2(val / spend) : null, spend7, cpa7: pur7 ? r2(spend7 / pur7) : null, roas7: spend7 ? r2(val7 / spend7) : null, line,
      first: v.reduce((m, c) => (c.first < m ? c.first : m), "9"), last_launch: v.reduce((m, c) => (c.first > m ? c.first : m), ""), thumb: best.thumb || (v.find((c) => c.thumb) || {}).thumb || null, ad_id: best.ad_id,
      quality: qv ? qv.quality : null, opening: best.opening,
      versions: v.slice(0, 12).map((c) => ({ key: c.key, ad_id: c.ad_id, thumb: c.thumb, who: c.who, maker: c.maker, status: c.status, state: c.state, live: c.live, first: c.first, spend: c.spend, purchases: c.purchases, cpa: c.cpa, roas: c.roas, spend7: c.spend7, cpa7: c.cpa7, line: c.line, opening: c.opening, quality: c.quality, hook: c.hook[0] || null, persona: c.persona[0] || null })) }; })
    .sort((a, b) => b.spend7 - a.spend7 || b.spend - a.spend);

  // ---- 3. batches by launch week ----
  const weeks = [...new Set(creatives.map((c) => c.week))].sort().reverse().slice(0, 8);
  const batches = weeks.map((w) => { const v = creatives.filter((c) => c.week === w), fin_ = v.filter(done), ideasW = [...new Set(v.map((c) => c.idea))], old = dayDiff(w, TO) >= WINNER_AGE;
    const ideaHit = (f) => ideasW.filter((k) => v.some((c) => c.idea === k && f(c))).length;
    return { week: w, age_days: dayDiff(w, TO), launched: v.length, spend: v.reduce((n, c) => n + c.spend, 0), testing: v.filter((c) => c.status === "testing").length, untested: v.filter((c) => c.status === "untested").length,
      missed: v.filter((c) => c.status === "missed" || c.status === "killed").length, passed: v.filter(passedish).length, winners: v.filter(isWin).length, finished: fin_.length,
      pass_rate: fin_.length ? Math.round(v.filter(passedish).length / fin_.length * 100) : null, winner_rate: old && v.length ? Math.round(v.filter(isWin).length / v.length * 100) : null, winner_rate_ready: old,
      ideas: ideasW.length, ideas_passed: ideaHit(passedish), ideas_won: ideaHit(isWin),
      by_maker: Object.fromEntries(["creators", "shub", "ni", "older"].map((m) => { const x = v.filter((c) => c.maker === m); return [m, { launched: x.length, passed: x.filter(passedish).length, winners: x.filter(isWin).length }]; })),
      best: v.filter(passedish).sort((a, b) => b.spend - a.spend).slice(0, 4).map((c) => ({ key: c.key, ad_id: c.ad_id, thumb: c.thumb, who: c.who, cpa: c.cpa, spend: c.spend, status: c.status })) }; });

  // ---- 4. patterns (each finished ad counts once per tag) ----
  const pattern = (dim, valsOf, filter) => { const out = {};
    for (const c of creatives) { if (filter && !filter(c)) continue; for (const v of valsOf(c)) { const x = (out[v] ||= { label: v, dim, n: 0, finished: 0, passed: 0, winners: 0, testing: 0, spend: 0, pur: 0, ex: [] });
      x.n++; if (done(c)) x.finished++; else if (c.status === "testing") x.testing++; if (passedish(c)) { x.passed++; if (c.thumb) x.ex.push(c); } if (isWin(c)) x.winners++; x.spend += c.spend; x.pur += c.purchases; } }
    return Object.values(out).map((x) => ({ label: x.label, dim, n: x.n, finished: x.finished, testing: x.testing, passed: x.passed, winners: x.winners, pass_rate: x.finished ? Math.round(x.passed / x.finished * 100) : null,
      spend: Math.round(x.spend), cpa: x.pur ? r2(x.spend / x.pur) : null, examples: x.ex.sort((a, b) => b.spend - a.spend).slice(0, 3).map((c) => ({ key: c.key, ad_id: c.ad_id, thumb: c.thumb, who: c.who })) }))
      .filter((x) => x.finished >= 1).sort((a, b) => b.winners - a.winners || b.passed - a.passed || b.spend - a.spend); };
  const makerName = { creators: "Trybe creators", shub: "Shub", ni: "Statics", older: "Other videos" };
  const patterns = { angle_oil: pattern("Angle", (c) => (c.angle ? [c.angle] : []), (c) => c.product === "oil"), angle_powder: pattern("Angle", (c) => (c.angle ? [c.angle] : []), (c) => c.product === "powder"),
    opening: pattern("Opening", (c) => c.hook), format: pattern("Format", (c) => (c.fmt ? [c.fmt] : [])), audience: pattern("Who it speaks to", (c) => c.persona), maker: pattern("Who made it", (c) => [makerName[c.maker]]) };
  const allFin = creatives.filter(done), basePass = allFin.length ? Math.round(creatives.filter(passedish).length / allFin.length * 100) : null;

  // ---- 5. creators ----
  const PE = {}, PN = {}; for (const c of creatives) { if (c.maker !== "creators" || !c.who) continue; const k = c.who.toLowerCase().replace(/[^a-z]/g, ""); (PE[k] ||= []).push(c); if (!PN[k] || c.who.length > PN[k].length) PN[k] = c.who; }
  for (const c of creatives) if (c.maker === "creators" && c.who) c.who = PN[c.who.toLowerCase().replace(/[^a-z]/g, "")];
  const creators = Object.entries(PE).map(([k, v]) => { const who = PN[k]; const fin_ = v.filter(done), sp = v.reduce((n, c) => n + c.spend, 0), pu = v.reduce((n, c) => n + c.purchases, 0), best = v.slice().sort((a, b) => rank[b.status] - rank[a.status] || (a.cpa ?? 1e9) - (b.cpa ?? 1e9))[0];
    return { who, launched: v.length, last14: v.filter((c) => c.first >= addDays(TO, -13)).length, testing: v.filter((c) => c.status === "testing").length, finished: fin_.length, passed: v.filter(passedish).length, winners: v.filter(isWin).length,
      spend: sp, cpa: pu ? r2(sp / pu) : null, ideas: new Set(v.map((c) => c.idea)).size, best: best && best.spend >= 44 ? { key: best.key, ad_id: best.ad_id, thumb: best.thumb, cpa: best.cpa, spend: best.spend, status: best.status } : null }; })
    .sort((a, b) => b.winners - a.winners || b.passed - a.passed || b.spend - a.spend);

  // ---- 6. scorecard ----
  const tot = (from, to, f) => creatives.reduce((o, c) => { if (f && !f(c)) return o; const x = sum(CR[c.key], from, to); o.s += x.s; o.p += x.p; o.v += x.v; return o; }, { s: 0, p: 0, v: 0 });
  const a7 = tot(d7, TO), ap7 = tot(p7, addDays(d7, -1)), w7 = tot(d7, TO, isWin), wp7 = tot(p7, addDays(d7, -1), isWin);
  const winners = creatives.filter(isWin), newWin30 = winners.filter((c) => c.first >= d30), newWinPrev = winners.filter((c) => c.first >= p30 && c.first < d30);
  const liveWin = winners.filter((c) => c.state === "working" || c.state === "slipping"), slipping = winners.filter((c) => c.state === "slipping");
  const lastFull = batches.find((b) => b.finished >= 5) || batches[0] || null, prevFull = batches.filter((b) => b !== lastFull && b.finished >= 5 && b.week < (lastFull?.week || "9"))[0] || null;
  const spend90 = creatives.reduce((n, c) => n + c.spend, 0), testSpend = creatives.reduce((n, c) => n + Math.min(c.spend, TEST_SPEND), 0);
  const score = { new_winners_30: newWin30.length, new_winners_prev_30: newWinPrev.length, winners_total: winners.length, big_winners: winners.filter((c) => c.big).length,
    pass_rate_latest: lastFull ? { week: lastFull.week, rate: lastFull.pass_rate, passed: lastFull.passed, finished: lastFull.finished, launched: lastFull.launched, testing: lastFull.testing } : null,
    pass_rate_prev: prevFull ? { week: prevFull.week, rate: prevFull.pass_rate, passed: prevFull.passed, finished: prevFull.finished } : null, pass_rate_90: basePass,
    cost_per_winner: winners.length ? Math.round(testSpend / winners.length) : null, test_spend_90: Math.round(testSpend),
    winner_share7: a7.s ? Math.round(w7.s / a7.s * 100) : null, winner_share_prev7: ap7.s ? Math.round(wp7.s / ap7.s * 100) : null,
    slipping: slipping.length, live_winners: liveWin.length,
    account7: { spend: Math.round(a7.s), cpa: a7.p ? r2(a7.s / a7.p) : null, roas: a7.s ? r2(a7.v / a7.s) : null }, account_prev7: { spend: Math.round(ap7.s), cpa: ap7.p ? r2(ap7.s / ap7.p) : null, roas: ap7.s ? r2(ap7.v / ap7.s) : null },
    ads_90: creatives.length, spend_90: Math.round(spend90) };

  // ---- 7. takeaways: written from the numbers above, each with how many ads are behind it ----
  const T = [], ex = (list) => list.filter((c) => c.thumb).slice(0, 3).map((c) => ({ key: c.key, ad_id: c.ad_id, thumb: c.thumb, who: c.who }));
  const mk = patterns.maker.reduce((o, x) => ((o[x.label] = x), o), {}), sh = mk["Shub"], crs = mk["Trybe creators"];
  if (sh && crs && sh.finished >= 3 && crs.finished >= 5) T.push({ kind: sh.pass_rate > (crs.pass_rate || 0) ? "more" : "note", title: `Shub’s ads pass ${sh.passed} of ${sh.finished}; creator ads ${crs.passed} of ${crs.finished}`,
    detail: `${sh.winners} of Shub’s became winners against ${crs.winners} for creators. ${crs.testing} creator ads are still in test.`, so: sh.pass_rate > (crs.pass_rate || 0) ? "Protect Shub’s filming slots first. For creators, fewer ideas with more people filming each one." : "Creators are carrying their weight; keep the volume.",
    n: sh.finished + crs.finished, evidence: ex(creatives.filter((c) => c.maker === "shub" && passedish(c)).sort((a, b) => b.spend - a.spend)) });
  const cand = [...patterns.angle_oil.map((x) => ({ ...x, product: "Oil rinse" })), ...patterns.angle_powder.map((x) => ({ ...x, product: "Purple powder" })), ...patterns.audience, ...patterns.opening, ...patterns.format].filter((x) => x.finished >= MIN_PATTERN);
  const up = cand.filter((x) => x.passed >= 3 && x.pass_rate >= Math.max(30, (basePass || 0) * 1.4)).sort((a, b) => b.pass_rate - a.pass_rate || b.finished - a.finished)[0];
  const down = cand.filter((x) => x.passed === 0 && x.finished >= MIN_PATTERN).sort((a, b) => b.spend - a.spend)[0];
  const lbl = (x) => `${x.dim === "Who it speaks to" ? "Ads speaking to" : x.dim === "Opening" ? "Ads that open with a" : x.dim === "Format" ? "The format" : "The angle"} “${x.label}”${x.product ? " (" + x.product + ")" : ""}`;
  if (up) T.push({ kind: "more", title: `${lbl(up)}: ${up.passed} of ${up.finished} passed`, detail: `The account average is ${basePass}%. ${up.winners} became winners. Cost per purchase across them: ${up.cpa !== null ? "$" + up.cpa.toFixed(2) : "n/a"}.`, so: "Build at least one of next week’s ideas on this.", n: up.finished, evidence: up.examples });
  if (down) T.push({ kind: "less", title: `${lbl(down)}: 0 of ${down.finished} passed`, detail: `$${down.spend.toLocaleString("en-US")} has gone into it.`, so: "Stop briefing it unless there is a new reason to believe in it.", n: down.finished, evidence: [] });
  if (liveWin.length) { const worst = slipping.slice().sort((a, b) => b.spend7 - a.spend7)[0];
    T.push({ kind: slipping.length ? "less" : "more", title: slipping.length ? `${slipping.length} of ${liveWin.length} running winners cost more than they earned this week` : `All ${liveWin.length} running winners paid for themselves this week`,
      detail: worst ? `Biggest: ${worst.who || worst.key} at $${worst.cpa7?.toFixed(2)} on $${worst.spend7.toLocaleString("en-US")} (its line is $${worst.line.toFixed(2)}).` : "Nothing to refresh.", so: slipping.length ? "Give the biggest one a new opening before making anything new: it is already proven." : "No refresh needed; spend the filming time on new ideas.",
      n: liveWin.length, evidence: ex(slipping.slice().sort((a, b) => b.spend7 - a.spend7)) }); }
  if (lastFull) T.push({ kind: "note", title: `Latest batch (week of ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+lastFull.week.slice(5,7)-1]} ${+lastFull.week.slice(8,10)}): ${lastFull.passed} of ${lastFull.finished} finished tests passed`, detail: `${lastFull.launched} ads launched from ${lastFull.ideas} ideas; ${lastFull.testing} still in test. ${lastFull.ideas_passed} of those ideas ${lastFull.ideas_passed===1?"has":"have"} a version that passed.`,
    so: lastFull.testing > lastFull.finished ? "Too early to judge this batch: most of it is still in test." : "This is the read to bring to next week’s briefs.", n: lastFull.finished, evidence: lastFull.best });
  const gq = (f) => { const v = base.filter(f); return v.length >= 5 ? { n: v.length, hook: med(v.map((c) => c.quality?.hook)), ctr: med(v.map((c) => c.quality?.ctr)), cvr: med(v.map((c) => c.quality?.cvr)) } : null; };
  const qc = gq((c) => c.maker === "creators"), qs = gq((c) => c.maker === "shub" || c.maker === "older");
  if (qc && qs && qc.cvr != null && qs.cvr != null) { const weak = qc.cvr < qs.cvr * 0.85 ? "cvr" : qc.ctr < qs.ctr * 0.85 ? "ctr" : qc.hook != null && qs.hook != null && qc.hook < qs.hook * 0.85 ? "hook" : null;
    if (weak) T.push({ kind: "note", title: weak === "cvr" ? "Creator ads get clicked but sell less per click" : weak === "ctr" ? "Creator ads get watched but clicked less" : "Creator ads stop the scroll less often",
      detail: `Creator ads: ${qc.hook ?? "–"}% stop the scroll, ${qc.ctr}% click, ${qc.cvr}% of clicks buy. Everything else: ${qs.hook ?? "–"}%, ${qs.ctr}%, ${qs.cvr}%.`, so: weak === "cvr" ? "Ask creators to show the result and say the offer before the end, not only the routine." : weak === "ctr" ? "Ask creators for a clearer reason to tap: the product and what it does, on screen, early." : "Ask creators for a stronger first three seconds.",
      n: qc.n + qs.n, evidence: [] }); }

  // ---- 8. the weekly loop ----
  const thisMon = monOf(TO), tw = creatives.filter((c) => c.week === thisMon), sent = (sends?.sends || []).slice().sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)))[0] || null;
  const loop = { launched: { n: tw.length, since: thisMon }, tested: { in_test: creatives.filter((c) => c.status === "testing").length, finished_this_week: creatives.filter((c) => done(c) && c.last >= thisMon && c.week >= addDays(thisMon, -14)).length },
    read: { tagged: Object.keys(AT).length, at: adtags?.last_run || null }, briefs: { week_label: sent?.week_label || published?.week_label || null, sent_at: sent?.sent_at || null, items: sent?.items?.length || 0 } };

  const verdict = (() => { const a = score.account7, ok = a.cpa !== null && a.cpa <= BE; const nw = score.new_winners_30;
    return { tone: ok && nw >= 2 ? "good" : !ok && nw < 2 ? "bad" : "mixed",
      line: `${nw} new winner${nw === 1 ? "" : "s"} in the last 30 days. ${score.winner_share7 ?? 0}% of this week’s spend is on proven ads. The account is at $${a.cpa?.toFixed(2) ?? "–"} per purchase against a $${BE.toFixed(2)} break-even.` }; })();

  return { as_of: TO, window: { from: addDays(TO, -89), to: TO }, defs: { test_spend: TEST_SPEND, pass_spend: PASS_SPEND, min_test: MIN_TEST, pass_purchases: PASS_PURCHASES, win_purchases: WIN_PURCHASES, big_spend: BIG_SPEND, winner_age_days: WINNER_AGE, breakeven: BE, breakeven_trybe: BE_T, breakeven_roas: BR, breakeven_roas_trybe: BR_T, min_pattern: MIN_PATTERN },
    verdict, loop, score, takeaways: T.slice(0, 5), ideas: ideas.filter((g) => g.spend >= 44 && !g.untagged).slice(0, 80), ideas_total: ideas.filter((g) => !g.untagged).length, ideas_untagged: ideas.filter((g) => g.untagged).map((g) => ({ product: g.product, n: g.n, spend: g.spend, winners: g.winners })), batches, patterns, base_pass_rate: basePass, creators, medians,
    counts: { creatives: creatives.length, winners: winners.length, passed: creatives.filter((c) => c.status === "passed").length, testing: creatives.filter((c) => c.status === "testing").length, missed: creatives.filter((c) => c.status === "missed").length, killed: creatives.filter((c) => c.status === "killed").length, untested: creatives.filter((c) => c.status === "untested").length, tagged: creatives.filter((c) => c.theme.length).length } };
}

export default async (req) => {
  const pw = env("OPERATOR_PASSWORD");
  if (!pw || !timingSafeEqual(h((req.headers.get("x-op-pass") || "").trim().toLowerCase()), h(pw.trim().toLowerCase()))) return json({ error: "unauthorized" }, 401);
  const [stats, cat, tax, sends, adtags_, published, op] = await Promise.all([engine("stats"), engine("catalogue"), engine("taxonomy"), engine("state?key=sends"), engine("state?key=adtags"), engine("state?key=published"), spine("/api/v1/operator?max_age=900")]);
  const to = op?.closed_through || stats?.window?.to;
  if (!to) return json({ error: "data spine unreachable" }, 502);
  const pull = (f, t) => spine(`/api/v1/meta/ad-days?from=${f}&to=${t}`).then((x) => x?.rows || null);
  const parts = await Promise.all([pull(addDays(to, -29), to), pull(addDays(to, -59), addDays(to, -30)), pull(addDays(to, -89), addDays(to, -60))]);
  if (parts.some((p) => p === null)) return json({ error: "could not read 90 days of ad rows from the spine" }, 502);
  const at = adtags_ && (adtags_.value || adtags_), pb = published && (published.value || published);
  try { return json(buildReport({ rows: parts.flat(), cat: cat || {}, stats: stats || {}, tax: tax || {}, adtags: at && at.by_creative ? at : null, sends, op, published: pb })); }
  catch (e) { return json({ error: "creative report failed: " + String(e.message).slice(0, 200) }, 500); }
};
export const config = { path: "/api/report" };
