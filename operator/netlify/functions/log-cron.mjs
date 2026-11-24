// Hourly call logger: reads the operator view (spine + site rules) and records what changed. Read-only on Meta.
import { operatorView } from "../lib/extra.mjs";
import { record } from "../lib/log.mjs";
const env = (k) => Netlify.env.get(k) || "";
const spine = (path) => fetch(`${env("SPINE_URL")}${path}`, { headers: { "x-spine-key": env("SPINE_API_KEY") }, signal: AbortSignal.timeout(20000) });
export default async () => {
  try { const v = await operatorView(spine, 600); if (!v.d) { console.log("log: spine said", v.status); return; } console.log(JSON.stringify(await record(v.d))); }
  catch (e) { console.log("log failed", String(e.message || e).slice(0, 300)); }
};
export const config = { schedule: "20 * * * *" };
