import type { Config, Endpoint, EndpointPurpose } from './schema.js';

// The only door out. Every outbound request the system makes on its own behalf passes
// through here, and is refused before any bytes leave if the host is not declared, or
// is declared for a different purpose. The lint rule and the source scan in
// tests/unit/config make sure nothing else in the repo calls fetch directly.

export class EgressError extends Error {
  constructor(
    public readonly host: string,
    message: string,
  ) {
    super(`outbound request to ${host} refused: ${message}`);
    this.name = 'EgressError';
  }
}

// Loopback and link-local names never leave the machine or the private network, so a
// developer's model server on localhost needs no declaration.
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '[::1]' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  );
}

export function hostOf(url: string | URL): string {
  return (typeof url === 'string' ? new URL(url) : url).hostname.toLowerCase();
}

export function findEndpoint(config: Config, host: string): Endpoint | undefined {
  const h = host.toLowerCase();
  return config.endpoints.find((e) => e.host.toLowerCase() === h);
}

export function assertOutboundAllowed(
  config: Config,
  url: string | URL,
  purpose?: EndpointPurpose,
): Endpoint | undefined {
  const host = hostOf(url);
  if (isLocalHost(host)) return undefined;
  const endpoint = findEndpoint(config, host);
  if (!endpoint) {
    throw new EgressError(host, 'not declared in the endpoint allowlist (F-10)');
  }
  if (purpose !== undefined && endpoint.purpose !== purpose) {
    throw new EgressError(host, `declared for ${endpoint.purpose}, not ${purpose}`);
  }
  return endpoint;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OutboundInit extends RequestInit {
  purpose: EndpointPurpose;
}

export type OutboundFetch = (url: string | URL, init: OutboundInit) => Promise<Response>;

export function createOutboundFetch(
  config: Config,
  impl: FetchLike = globalThis.fetch,
): OutboundFetch {
  return async (url, init) => {
    const { purpose, ...rest } = init;
    assertOutboundAllowed(config, url, purpose);
    return impl(url, rest);
  };
}
