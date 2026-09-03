import 'server-only';
import { connect, rankedDemand, type RankedDemandRow } from '@gc/db';
import { searchPath } from '@/lib/case';

// The ranked demand view for the page and the CSV route. One read per request, as the
// owner (the function is its own gate: demand_ranked returns nothing about any one
// company). Without a database there is nothing to show, and the page says so.

export async function loadRankedDemand(
  env: Record<string, string | undefined> = process.env,
): Promise<RankedDemandRow[]> {
  const url = env['DATABASE_URL'];
  if (!url) return [];
  const connection = connect(url, { max: 1, ...searchPath(env) });
  try {
    return await rankedDemand(connection);
  } finally {
    await connection.close();
  }
}
