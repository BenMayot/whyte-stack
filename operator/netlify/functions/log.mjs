// /api/log: the call log and the checks, for the Rules tab. Password-checked like /api/data.
// ?run=1 records a snapshot now (same as the hourly job), then returns the log.
import { createHash, timingSafeEqual } from "node:crypto";
import { operatorView } from "../lib/extra.mjs";
import { record, read, addNote } from "../lib/log.mjs";
const env = (k) => Netlify.env.get(k) || "";
const h = (s) => createHash("sha256").update(String(s)).digest();
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const spine = (path) => fetch(`${env("SPINE_URL")}${path}`, { headers: { "x-spine-key": env("SPINE_API_KEY") }, signal: AbortSignal.timeout(20000) });
export default async (req) => {
  const pw = env("OPERATOR_PASSWORD");
  if (!pw || !timingSafeEqual(h((req.headers.get("x-op-pass") || "").trim().toLowerCase()), h(pw.trim().toLowerCase()))) return json({ error: "unauthorized" }, 401);
  try {
    if (new URL(req.url).searchParams.get("run") === "1") { const v = await operatorView(spine, 600); if (v.d) await record(v.d); }
    if (req.method === "POST") { const b = await req.json().catch(() => ({})); if (b.note) await addNote(b.note); }
    // Meta ad rows for the learning layer: closed days over the log's 21-day window (the ad account's day is US Eastern).
    const et = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
    const to = et(new Date(Date.now() - 864e5)), from = et(new Date(Date.now() - 24 * 864e5));
    const rows = await spine(`/api/v1/meta/ad-days?from=${from}&to=${to}`).then((r) => (r.ok ? r.json() : null)).then((x) => x?.rows || null).catch(() => null);
    return json(await read(21, rows, to));
  } catch (e) { return json({ error: "log unavailable: " + String(e.message || e).slice(0, 200) }, 500); }
};
export const config = { path: "/api/log" };
