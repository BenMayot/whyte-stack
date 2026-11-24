// The site's own source, as deployed (Nov 19, 2026). Any session that needs to change this site starts from here:
//   curl -H "x-op-pass: <operator password>" https://whyte-ads-operator.netlify.app/api/src -o src.tgz && tar xzf src.tgz
// so nobody rebuilds it from an older project doc and rolls the live site back. Run tools/bundle.sh before every deploy.
import { createHash, timingSafeEqual } from "node:crypto";
import { BUNDLE, BUILT_AT } from "../lib/src_bundle.mjs";
const h = (s) => createHash("sha256").update(String(s)).digest();
export default async (req) => {
  const pw = Netlify.env.get("OPERATOR_PASSWORD") || "";
  if (!pw || !timingSafeEqual(h((req.headers.get("x-op-pass") || "").trim().toLowerCase()), h(pw.trim().toLowerCase()))) return new Response("unauthorized", { status: 401 });
  if (new URL(req.url).searchParams.get("info")) return Response.json({ built_at: BUILT_AT, bytes: BUNDLE.length });
  return new Response(Buffer.from(BUNDLE, "base64"), { headers: { "content-type": "application/gzip", "cache-control": "no-store", "x-built-at": BUILT_AT } });
};
export const config = { path: "/api/src" };
