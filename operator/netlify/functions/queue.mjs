// Shoot list (Nov 17, 2026): ads the team wants refreshed or remade, sent from the Creative tab to the creator dashboard.
// Stored in the creative engine at state key "remakes". Creators, Shub and Ni only ever see words: this function refuses
// anything that looks like a money or performance number. It never touches Meta.
import { createHash, timingSafeEqual } from "node:crypto";
const env = (k) => Netlify.env.get(k) || "";
const h = (s) => createHash("sha256").update(String(s)).digest();
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const E = (p, init = {}) => fetch(`${env("ENGINE_URL")}/api/v1/${p}`, { ...init, headers: { "x-engine-key": env("ENGINE_KEY"), "content-type": "application/json" }, signal: AbortSignal.timeout(9000) });
const LEAK = /\$|\b(cpa|roas|cpm|ctr)\b|per purchase|%/i;
const str = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const load = async () => { const r = await E("state?key=remakes"); const v = r.ok ? await r.json() : null; return v && Array.isArray(v.items) ? v : { items: [] }; };
export default async (req) => {
  const pw = env("OPERATOR_PASSWORD");
  if (!pw || !timingSafeEqual(h((req.headers.get("x-op-pass") || "").trim().toLowerCase()), h(pw.trim().toLowerCase()))) return json({ error: "unauthorized" }, 401);
  try {
    const cur = await load();
    if (req.method === "GET") return json(cur);
    const b = await req.json();
    if (b.op === "remove") cur.items = cur.items.filter((x) => x.id !== b.id);
    else if (b.op === "add") {
      const i = b.item || {};
      if (!/^[A-Za-z0-9_-]{2,60}$/.test(i.id || "")) return json({ error: "bad id" }, 400);
      const item = { id: i.id, rid: "R-" + i.id, ad_id: /^\d{6,30}$/.test(String(i.ad_id || "")) ? String(i.ad_id) : null, key: /^[A-Za-z0-9_-]{2,60}$/.test(i.key || "") ? i.key : null, kind: i.kind === "remake" ? "remake" : "refresh", for: ["creators", "shub", "ni"].includes(i.for) ? i.for : "creators",
        who: str(i.who, 60), product: ["oil", "powder", "both"].includes(i.product) ? i.product : "both", line: str(i.line, 160), what: str(i.what, 120),
        keep: str(i.keep, 240), change: str(i.change, 240), deliver: str(i.deliver, 160), added_at: new Date().toISOString() };
      if (LEAK.test(JSON.stringify({ ...item, added_at: "", ad_id: "" }))) return json({ error: "numbers are not allowed in what creators see" }, 400);
      cur.items = [...cur.items.filter((x) => x.id !== item.id), item].slice(-20);
    } else return json({ error: "op" }, 400);
    cur.updated_at = new Date().toISOString();
    const r = await E("state", { method: "PUT", body: JSON.stringify({ key: "remakes", value: cur }) });
    if (!r.ok) return json({ error: "could not save" }, 502);
    return json(cur);
  } catch (e) { return json({ error: "shoot list unavailable: " + String(e.message || e).slice(0, 160) }, 500); }
};
export const config = { path: "/api/queue" };
