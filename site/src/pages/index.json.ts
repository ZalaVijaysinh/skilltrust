import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRoute } from "astro";

// The finder skill reads this file. Minified and without installCommand (half the bytes; the finder builds and
// validates its own command), otherwise the index as scanned: the finder validates every entry itself.
export const GET: APIRoute = () => {
  let body = "[]";
  try {
    const index: unknown = JSON.parse(readFileSync(join(process.env.SKILLTRUST_DATA ?? "data", "index.json"), "utf8"));
    if (Array.isArray(index)) body = JSON.stringify(index.map((e) => {
      if (!e || typeof e !== "object") return e;
      const { installCommand: _, ...rest } = e as Record<string, unknown>;
      return rest;
    }));
  } catch { /* no scan yet, or unreadable: publish an empty index */ }
  return new Response(body + "\n", { headers: { "Content-Type": "application/json" } });
};
