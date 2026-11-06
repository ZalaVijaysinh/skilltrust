import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRoute } from "astro";

// Published verbatim: the finder skill reads this file.
export const GET: APIRoute = () => {
  let body = "[]\n";
  try { body = readFileSync(join(process.env.SKILLTRUST_DATA ?? "data", "index.json"), "utf8"); } catch { /* no scan yet */ }
  return new Response(body, { headers: { "Content-Type": "application/json" } });
};
