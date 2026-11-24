// Thin, password-checked proxy to the data spine's operator view. The spine key never reaches the browser.
// Nov 14, 2026: two rules are applied here, on top of the spine's calls (the spine is unchanged):
//   1. Slide cut (scaling): last 3 closed days blend 10%+ over the ad's own break-even, on $300+ = cut,
//      whatever the 7-day number says.
//   2. Early undo (budget): the first closed day after a raise is over break-even AND today is over
//      break-even on $1,000+ of scaling spend = undo the raise now, without waiting for the 2nd closed day.
// Nov 17, 2026: 3. Carrier guard, 4. Cut cooldown (below).
import { createHash, timingSafeEqual } from "node:crypto";
const env = (k) => Netlify.env.get(k) || "";
const h = (s) => createHash("sha256").update(String(s)).digest();
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
import { operatorView } from "../lib/extra.mjs";
const spine = (path) => fetch(`${env("SPINE_URL")}${path}`, { headers: { "x-spine-key": env("SPINE_API_KEY") } });

export default async (req) => {
  const pw = env("OPERATOR_PASSWORD");
  if (!pw || !timingSafeEqual(h((req.headers.get("x-op-pass") || "").trim().toLowerCase()), h(pw.trim().toLowerCase()))) return json({ error: "unauthorized" }, 401);
  const q = new URL(req.url).searchParams;
  const pv = q.get("preview");
  if (pv) {
    if (!/^\d+$/.test(pv)) return json({ error: "bad ad id" }, 400);
    try {
      // the ad's own video file first (plays with sound in a normal player); Meta's muted preview only if there is none
      const v = await spine(`/api/v1/meta/ad-video?ad_id=${pv}`).then((x) => x.json()).catch(() => null);
      if (v?.video) return json({ ad_id: pv, video: v.video, poster: v.poster || null });
      const r = await spine(`/api/v1/meta/ad-preview?ad_id=${pv}`);
      return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (e) { return json({ error: "spine unreachable" }, 502); }
  }
  const fresh = q.get("fresh") === "1";
  let v; try { v = await operatorView(spine, fresh ? 20 : 600); }
  catch (e) { return json({ error: "spine unreachable: " + String(e.message).slice(0, 200) }, 502); }
  if (!v.d) return new Response(v.raw, { status: v.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const d = v.d;
  return json(d);
};
export const config = { path: "/api/data" };
