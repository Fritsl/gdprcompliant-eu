import { createRecordedFetch, loadConfig } from '@gc/config';
import { connect, registerRetentionWorker, scheduleRetention } from '@gc/db';
import { JobQueue } from '@gc/jobs';
import { loadCatalogue } from '@gc/remedies';
import { JsonLinesSink, event, setSink } from '@gc/telemetry';
import { BrowserPool } from '@gc/scanner';
import { registerRecheckWorker } from './recheck.js';
import { registerScanWorker } from './scan.js';

// The worker process: one browser pool, one queue, the scan worker and the scheduled
// jobs. Stops cleanly on SIGTERM so a job in flight is released for the next worker.

// Telemetry (O-04): JSON lines on stdout, redacted before they are written.
setSink(new JsonLinesSink());
const config = loadConfig();
const connection = connect(config.database.url);
const queue = new JobQueue({ connectionString: config.database.url });
const pool = new BrowserPool({
  concurrency: config.scanner.concurrency,
  passTimeoutMs: 60_000,
  navigationTimeoutMs: 15_000,
});

await pool.start();
await queue.start();
const catalogue = loadCatalogue();
const stores = createRecordedFetch(config, { name: 'app-stores' });
await registerScanWorker(queue, connection, { pool, catalogue, stores });
await registerRecheckWorker(queue, connection, { pool, catalogue });
await registerRetentionWorker(queue, connection);
await scheduleRetention(queue);
event('worker.up', { concurrency: config.scanner.concurrency });

const stop = async () => {
  await queue.stop({ graceful: true });
  await pool.stop();
  await connection.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
