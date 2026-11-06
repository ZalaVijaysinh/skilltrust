import { createGitHub } from "./github.js";
import { runScan } from "./pipeline.js";

const token = process.env.SKILLTRUST_TOKEN || process.env.GITHUB_TOKEN;
if (!token) console.warn("skilltrust: no SKILLTRUST_TOKEN or GITHUB_TOKEN set; code search will fail");
const minStars = Number(process.env.SKILLTRUST_MIN_STARS ?? 10);
if (!Number.isFinite(minStars)) throw new Error("SKILLTRUST_MIN_STARS must be a number");

const r = await runScan({ gh: createGitHub({ token }), dataDir: "data", now: new Date(), minStars });
console.log(`skilltrust: scanned ${r.scanned}, skipped ${r.skipped}, unavailable ${r.unavailable}, stoppedEarly ${r.stoppedEarly}`);
if (r.writeSkipped.length) console.log(`skilltrust: write skipped: ${r.writeSkipped.join(", ")}`);
