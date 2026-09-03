import { loadConfig } from '@gc/config';
import { connect } from './client.js';
import { migrate } from './migrate.js';

// pnpm db:migrate — apply the committed migrations to the configured database.
// Reads configuration the way the app does, so a missing or malformed DATABASE_URL
// fails here with the same message it would at boot.

const command = process.argv[2];

async function main(): Promise<number> {
  if (command !== 'migrate') {
    console.error('usage: db:migrate');
    return 2;
  }
  const config = loadConfig();
  const connection = connect(config.database.url);
  try {
    const result = await migrate(connection);
    console.log(
      result.applied === 0
        ? `database is current: ${result.total} migration(s) already applied`
        : `applied ${result.applied} migration(s); ${result.total} in total`,
    );
    return 0;
  } finally {
    await connection.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
