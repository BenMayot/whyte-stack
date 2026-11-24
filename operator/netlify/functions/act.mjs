// /api/act (Nov 17, 2026): switch one ad off or back on in Meta, from the Ads tab. The only write the operator makes.
// Guards: operator password, a separate action PIN (OPERATOR_ACTION_PIN), the ad must be one the operator is showing,
// only PAUSED / ACTIVE. The change itself is made by the data spine, which holds the Meta token. Every use is logged.
import { createHash, timingSafeEqual } from "node:crypto";
import { operatorView } from "../lib/extra.mjs";
import { record, addNote } from "../lib/log.mjs";
import { checkPin } from "../lib/pin.mjs";
const env = (k) => Netlify.env.get(k) || "";
const h = (s) => createHash("sha256").update(String(s)).digest();
const same = (a, b) => timingSafeEqual(h(a), h(b));
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const spine = (path, init = {}) => fetch(`${env("SPINE_URL")}${path}`, { ...init, headers: { "x-spine-key": env("SPINE_API_KEY"), "content-type": "application/json" }, signal: AbortSignal.timeout(20000) });
export default async (req) => {
  const pw = env("OPERATOR_PASSWORD"), pin = env("OPERATOR_ACTION_PIN");
  if (!pw || !same((req.headers.get("x-op-pass") || "").trim().toLowerCase(), pw.trim().toLowerCase())) return json({ error: "unauthorized" }, 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!pin) return json({ error: "Pausing from the dashboard is not set up (no action PIN)." }, 503);
  const b = await req.json().catch(() => ({}));
  const pc = await checkPin(b.pin, pin); if (!pc.ok) return json({ error: pc.error, pin: false }, 403);
  const status = b.status === "ACTIVE" ? "ACTIVE" : b.status === "PAUSED" ? "PAUSED" : null;
  if (!status || !/^\d+$/.test(String(b.ad_id || ""))) return json({ error: "bad request" }, 400);
  try {
    const v = await operatorView(spine, 900); const ad = v.d?.ads?.find((a) => a.id === String(b.ad_id));
    if (!ad) return json({ error: "That ad is not one the operator is showing." }, 404);
    const r = await spine("/api/v1/meta/ad-status", { method: "POST", body: JSON.stringify({ ad_id: ad.id, status }) }); const out = await r.json().catch(() => ({}));
    if (!r.ok || out.error) return json({ error: /permission|\(#200\)|\(#10\)|ads_management/i.test(out.error || "") ? "Meta refused: the access token can read ads but is not allowed to change them (it needs the ads_management permission)." : "Meta refused: " + String(out.error || r.status).slice(0, 240) }, 502);
    const name = ad.we_id || ad.creator || ad.id;
    try { await addNote(`${status === "PAUSED" ? "Paused" : "Switched on"} from the dashboard: ${name} (${ad.lane === "test" ? "testing" : "scaling"}). The call was ${ad.call?.action || "–"}${ad.call?.why ? ": " + ad.call.why : ""}`, "Dashboard"); } catch {}
    try { const f = await operatorView(spine, 20); if (f.d) await record(f.d); } catch {}   // log the change now, not at the next hourly run
    return json({ ok: true, ad_id: ad.id, name, status, changed: out.changed !== false });
  } catch (e) { return json({ error: "Could not reach Meta: " + String(e.message || e).slice(0, 200) }, 502); }
};
export const config = { path: "/api/act" };
