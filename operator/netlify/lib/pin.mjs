// Action PIN check with a lockout (Nov 18, 2026). The PIN is short, so guessing is stopped by counting misses:
// 5 wrong PINs in a row lock every PIN action for 15 minutes. A correct PIN clears the count.
import { createHash, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
const h = (s) => createHash("sha256").update(String(s)).digest();
const store = () => getStore({ name: "oplog", consistency: "strong" });
const MAX = 5, LOCK_MS = 15 * 60 * 1000, KEY = "pin_guard";
export async function checkPin(input, pin) {
  let g = {}; try { g = (await store().get(KEY, { type: "json" })) || {}; } catch {}
  const now = Date.now();
  if (g.until && g.until > now) return { ok: false, error: `Too many wrong PINs. Locked for ${Math.ceil((g.until - now) / 60000)} more minutes.` };
  if (timingSafeEqual(h(String(input || "").trim()), h(String(pin).trim()))) { if (g.fails || g.until) { try { await store().setJSON(KEY, {}); } catch {} } return { ok: true }; }
  const fails = (g.until ? 0 : g.fails || 0) + 1, locked = fails >= MAX;
  try { await store().setJSON(KEY, locked ? { fails: 0, until: now + LOCK_MS } : { fails }); } catch {}
  return { ok: false, error: locked ? "Wrong PIN. Too many tries: locked for 15 minutes." : `Wrong PIN. ${MAX - fails} ${MAX - fails === 1 ? "try" : "tries"} left.` };
}
