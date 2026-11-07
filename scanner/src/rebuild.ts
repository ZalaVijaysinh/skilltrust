// Rebuilds index.json and report.json from every record on disk (used after a data merge in CI).
import { rebuildIndex } from "./records.js";

const { skipped } = await rebuildIndex(process.env.SKILLTRUST_DATA || "data");
if (skipped.length) console.warn(`skilltrust: skipped ${skipped.length} unreadable record(s): ${skipped.join(", ")}`);
