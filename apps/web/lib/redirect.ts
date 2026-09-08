// Every redirect the app issues is relative. Next builds `request.url` from the server's
// own hostname, not from the Host header the visitor sent, so an absolute location
// would send everyone who is not on the server itself, behind a reverse proxy or on
// another machine on the network, to localhost. Seen on 2026-09-08 from a phone on the
// same network, and it would have been every visitor in production.

export function redirectTo(target: URL | string, headers: Record<string, string> = {}): Response {
  const location =
    typeof target === 'string' ? target : `${target.pathname}${target.search}${target.hash}`;
  return new Response(null, { status: 303, headers: { location, ...headers } });
}
