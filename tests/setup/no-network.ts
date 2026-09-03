import dns from 'node:dns';
import net from 'node:net';

// Runs in every unit-test worker before any test file. A unit test has no network and
// no database; this makes that a fact rather than a convention. Anything that tries to
// open a socket, resolve a name or call fetch fails at once with a message that says
// which suite it belongs in.

const REFUSED = 'unit tests have no network and no database (F-08) — this belongs in integration/';

function refuse(): never {
  throw new Error(REFUSED);
}

// The async APIs reject rather than throw, as the real ones would on failure.
async function refuseAsync(): Promise<never> {
  throw new Error(REFUSED);
}

// Every TCP client in Node — pg, undici, http, Playwright's driver — ends up here.
net.Socket.prototype.connect = refuse as unknown as typeof net.Socket.prototype.connect;
net.connect = refuse as unknown as typeof net.connect;
net.createConnection = refuse as unknown as typeof net.createConnection;

dns.lookup = refuse as unknown as typeof dns.lookup;
dns.resolve = refuse as unknown as typeof dns.resolve;
dns.promises.lookup = refuseAsync as unknown as typeof dns.promises.lookup;
dns.promises.resolve = refuseAsync as unknown as typeof dns.promises.resolve;

globalThis.fetch = refuseAsync as unknown as typeof globalThis.fetch;

// A connection string lying around is how a "unit" test quietly becomes an integration
// test. Not in here.
delete process.env['DATABASE_URL'];
