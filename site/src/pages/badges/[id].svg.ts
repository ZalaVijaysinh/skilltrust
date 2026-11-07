import type { APIRoute } from "astro";
import { loadData } from "../../lib/data.js";
import { bandLabel } from "../../../../scanner/src/score.js";
import type { Band } from "../../../../scanner/src/types.js";

export function getStaticPaths() {
  return loadData().index.map((e) => ({ params: { id: e.id }, props: { score: e.score, band: e.band } }));
}

const COLOR: Record<Band, string> = { low: "#1a7f37", review: "#9a6700", high: "#cf222e" };

/** README badge "SkillTrust | 92 · Low risk". Only a number and a fixed label go in: no scanned text. */
export function badge(score: number, band: Band): string {
  const left = "SkillTrust", right = `${Math.round(Number(score)) || 0} · ${bandLabel(band)}`, fill = COLOR[band] ?? "#555";
  // shortcut: width from character count (Verdana 11px ≈ 7px per char), fine for these fixed labels
  const lw = left.length * 7 + 12, rw = right.length * 7 + 12, w = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${left}: ${right}"><title>${left}: ${right}</title>`
    + `<rect width="${w}" height="20" rx="3" fill="#555"/><path d="M${lw} 0h${rw - 3}a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3h-${rw - 3}z" fill="${fill}"/>`
    + `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle"><text x="${lw / 2}" y="14">${left}</text><text x="${lw + rw / 2}" y="14">${right}</text></g></svg>\n`;
}

export const GET: APIRoute = ({ props }) =>
  new Response(badge(props.score as number, props.band as Band), { headers: { "Content-Type": "image/svg+xml" } });
