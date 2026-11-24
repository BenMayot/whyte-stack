// /api/plan (Nov 18, 2026): the weekly creative plan. Nothing reaches creators or Shub until Ben presses send.
//   GET                      the draft (Monday run's briefs + Ben's picks from the Creative tab) and what was last sent
//   POST {op:"toggle", id}   leave a draft brief out of / put it back into this week's send
//   POST {op:"send", pin}    publish: writes a snapshot to the creative engine (state key "published"). The creator dashboard
//                            and Shub's corner show that snapshot, and only that, until the next send. Needs the action PIN.
// Engine state keys: "remakes" (picks waiting), "plan" ({week, off:[brief ids]}), "published" (the last send), "inspo".
import { checkPin } from "../lib/pin.mjs";
import { createHash, timingSafeEqual } from "node:crypto";
const env = (k) => Netlify.env.get(k) || "";
const h = (s) => createHash("sha256").update(String(s)).digest();
const same = (a, b) => timingSafeEqual(h(a), h(b));
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const E = (p, init = {}) => fetch(`${env("ENGINE_URL")}/api/v1/${p}`, { ...init, headers: { "x-engine-key": env("ENGINE_KEY"), "content-type": "application/json" }, signal: AbortSignal.timeout(12000) });
const get = (p) => E(p).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const state = (k) => get("state?key=" + k);
const put = (key, value) => E("state", { method: "PUT", body: JSON.stringify({ key, value }) });

async function gather() {
  const [weekly, pc, ps, remakes, plan, published, inspo, tax] = await Promise.all([get("weekly/latest"), get("public?audience=creators"), get("public?audience=shub"), state("remakes"), state("plan"), state("published"), state("inspo"), get("taxonomy")]);
  const week = weekly?.week || pc?.week || null, off = plan && plan.week === week && Array.isArray(plan.off) ? plan.off : [];
  const picks = remakes && Array.isArray(remakes.items) ? remakes.items : [];
  return { weekly, pc, ps, picks, off, published, inspo, week, tax };
}
const slim = (b, off) => ({ id: b.id, title: b.title, product: b.product, format: b.format_name || b.format || null, angle: b.angle_name || b.angle || null, wildcard: !!b.wildcard, direction: b.direction || "", on: !off.includes(b.id) });

export default async (req) => {
  const pw = env("OPERATOR_PASSWORD");
  if (!pw || !same((req.headers.get("x-op-pass") || "").trim().toLowerCase(), pw.trim().toLowerCase())) return json({ error: "unauthorized" }, 401);
  try {
    const g = await gather();
    if (req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      if (b.op === "toggle") {
        if (!/^[A-Za-z0-9_-]{2,60}$/.test(b.id || "")) return json({ error: "bad id" }, 400);
        const off = g.off.includes(b.id) ? g.off.filter((x) => x !== b.id) : [...g.off, b.id];
        const r = await put("plan", { week: g.week, off, updated_at: new Date().toISOString() }); if (!r.ok) return json({ error: "could not save" }, 502);
        g.off = off;
      } else if (b.op === "send") {
        const pin = env("OPERATOR_ACTION_PIN");
        if (!pin) return json({ error: "Sending is not set up (no action PIN)." }, 503);
        const pc = await checkPin(b.pin, pin); if (!pc.ok) return json({ error: pc.error, pin: false }, 403);
        if (!g.pc || !g.ps) return json({ error: "The creative engine did not answer. Nothing was sent." }, 502);
        const side = (v, who) => ({ week: v.week, week_label: v.week_label, headline: v.headline || "", stop: v.stop || [], briefs: (v.briefs || []).filter((x) => !g.off.includes(x.id)), remakes: g.picks.filter((p) => p.for === who) });
        const snap = { week: g.week, sent_at: new Date().toISOString(), creators: { ...side(g.pc, "creators"), inspo: g.inspo && (!g.inspo.week || g.inspo.week === g.week) ? g.inspo.items || [] : [] }, shub: side(g.ps, "shub"),
          ni: { briefs: (g.weekly?.briefs || []).filter((x) => x.audience === "designer" && !g.off.includes(x.id)).map((x) => x.id), remakes: g.picks.filter((p) => p.for === "ni").map((p) => p.id) } };
        const r = await put("published", snap); if (!r.ok) return json({ error: "could not publish" }, 502);
        // The record of what was asked for, week by week. The Creative tab and the Monday run score it against what got made.
        const item = (x, aud) => ({ id: x.id, audience: aud, kind: "brief", title: x.title, product: x.product, angle: x.angle || null, format: x.format || null, wildcard: !!x.wildcard });
        const entry = { week: g.week, week_label: g.pc.week_label || g.week, sent_at: snap.sent_at, items: [
          ...(g.weekly?.briefs || []).filter((x) => !g.off.includes(x.id)).map((x) => item(x, x.audience === "designer" ? "ni" : x.audience)),
          ...g.picks.map((p) => ({ id: p.rid || "R-" + p.id, audience: p.for, kind: p.kind, title: p.line || p.id, product: p.product, of: p.id, what: p.what || null })) ] };
        const hist = (await state("sends")) || { sends: [] };
        await put("sends", { sends: [...(hist.sends || []).filter((x) => x.week !== entry.week || x.sent_at === entry.sent_at), entry].slice(-80) });
        await put("remakes", { items: [], updated_at: snap.sent_at, last_sent: g.picks.map((p) => p.id) });   // picks went out with this send
        g.published = snap; g.picks = [];
      } else return json({ error: "op" }, 400);
    }
    const W = g.weekly || {}, P = g.published;
    const by = (aud, src) => (src?.briefs || W.briefs?.filter((x) => x.audience === aud) || []).map((x) => slim(x, g.off));
    const ni = (W.briefs || []).filter((x) => x.audience === "designer").map((x) => ({ ...slim({ ...x, format_name: g.tax?.formats?.static?.[x.format] || g.tax?.formats?.video?.[x.format] || String(x.format || "").replace(/^s_/, "") }, g.off), openings: x.openings || [], show: x.show || "", points: x.points || [], avoid: x.avoid || [], sizes: x.sizes || x.deliver || null }));
    const newWeek = !P || P.week !== g.week;
    return json({ week: g.week, week_label: g.pc?.week_label || W.week_label || g.week, generated_at: W.generated_at || null, headline: g.pc?.headline || "",
      status: newWeek ? "draft" : g.picks.length ? "picks" : "sent",
      published: P ? { week: P.week, week_label: P.creators?.week_label || P.week, sent_at: P.sent_at, creators: (P.creators?.briefs || []).length, shub: (P.shub?.briefs || []).length, remake_ids: [...(P.creators?.remakes || []), ...(P.shub?.remakes || [])].map((x) => x.id).concat(P.ni?.remakes || []) } : null,
      preview: env("PREVIEW_KEY") ? { creators: "https://whyte-creator-brief.netlify.app/?preview=" + encodeURIComponent(env("PREVIEW_KEY")) + "#week", shub: "https://whyte-creator-brief.netlify.app/shub.html?preview=" + encodeURIComponent(env("PREVIEW_KEY")) } : null,
      creators: by("creators", g.pc), shub: by("shub", g.ps), ni, designer_doc: W.designer_doc_url || null, picks: g.picks });
  } catch (e) { return json({ error: "plan unavailable: " + String(e.message || e).slice(0, 200) }, 500); }
};
export const config = { path: "/api/plan" };
