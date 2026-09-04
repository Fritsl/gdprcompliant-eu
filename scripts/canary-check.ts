// The canary check (T-10): compare the two most recent nightly snapshots and raise the
// alarm when the scanner, not the internet, is what changed. With no snapshots yet it
// validates the corpus and exits clean, so CI runs it on every push.
//
//   pnpm canary:check             artifacts/canary, or CANARY_DIR
//   pnpm canary:check -- --json   the report as JSON on stdout
import { join } from 'node:path';
import {
  activeSites,
  canaryReport,
  formatCanaryReport,
  loadCanaryCorpus,
  readSnapshots,
  snapshotDates,
} from '@gc/scanner';

const root = process.env['CANARY_DIR'] ?? join(process.cwd(), 'artifacts', 'canary');
const corpus = loadCanaryCorpus();
const active = activeSites(corpus);
const dates = snapshotDates(root);

if (dates.length < 2) {
  console.log(
    `canary: corpus ${corpus.version}, ${active.length} sites active, ${corpus.exclusions.length} excluded, owner ${corpus.owner.name} <${corpus.owner.contact}>; ${
      dates.length === 0 ? 'no snapshots yet' : `one snapshot (${dates[0]}), nothing to compare yet`
    }`,
  );
  process.exit(0);
}

const [before, after] = dates.slice(-2) as [string, string];
const report = canaryReport(
  corpus,
  { date: before, snapshots: readSnapshots(root, before) },
  { date: after, snapshots: readSnapshots(root, after) },
);
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else console.log(formatCanaryReport(report));
process.exit(report.alarm ? 1 : 0);
