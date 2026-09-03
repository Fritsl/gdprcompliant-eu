import { promises as dns } from 'node:dns';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '@gc/config';

// Where DNS answers come from (D-01). Tests replay recorded answers from
// fixtures/dns/<domain>.json; a missing recording in replay mode is an error, never a
// live lookup. Recording and live modes ask the system resolver, like the cassettes
// for HTTP (F-09).

export interface MxAnswer {
  readonly exchange: string;
  readonly priority: number;
}

export interface Resolver {
  txt(name: string): Promise<string[]>;
  mx(name: string): Promise<MxAnswer[]>;
  cname(name: string): Promise<string[]>;
}

export const DNS_FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/dns/',
);

export interface DnsRecording {
  readonly txt: Record<string, string[]>;
  readonly mx: Record<string, MxAnswer[]>;
  readonly cname: Record<string, string[]>;
}

const emptyRecording = (): DnsRecording => ({ txt: {}, mx: {}, cname: {} });

// Nothing found, nothing there: a name with no record of a type resolves to []; the
// system resolver's ENODATA and ENOTFOUND mean the same.
const quiet = async <T>(work: Promise<T[]>): Promise<T[]> => {
  try {
    return await work;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ESERVFAIL') return [];
    throw e;
  }
};

export function systemResolver(): Resolver {
  return {
    txt: async (name) => (await quiet(dns.resolveTxt(name))).map((chunks) => chunks.join('')),
    mx: async (name) =>
      (await quiet(dns.resolveMx(name))).map((m) => ({
        exchange: m.exchange,
        priority: m.priority,
      })),
    cname: (name) => quiet(dns.resolveCname(name)),
  };
}

export class DnsRecordingMissingError extends Error {
  constructor(
    readonly domain: string,
    readonly file: string,
  ) {
    super(
      `no DNS recording for ${domain} at ${file} — replay mode makes no live lookups. Re-record with GC_NETWORK=record (see TESTING.md).`,
    );
    this.name = 'DnsRecordingMissingError';
  }
}

export const recordingFile = (domain: string, dir = DNS_FIXTURES_DIR): string =>
  join(dir, `${domain.toLowerCase()}.json`);

export function recordedResolver(domain: string, dir = DNS_FIXTURES_DIR): Resolver {
  const file = recordingFile(domain, dir);
  if (!existsSync(file)) throw new DnsRecordingMissingError(domain, file);
  const rec = {
    ...emptyRecording(),
    ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<DnsRecording>),
  };
  return {
    txt: async (name) => rec.txt[name.toLowerCase()] ?? [],
    mx: async (name) => rec.mx[name.toLowerCase()] ?? [],
    cname: async (name) => rec.cname[name.toLowerCase()] ?? [],
  };
}

// Asks the system resolver and writes every answer down, so the next replay has it.
export function recordingResolver(domain: string, dir = DNS_FIXTURES_DIR): Resolver {
  const file = recordingFile(domain, dir);
  const live = systemResolver();
  const rec: DnsRecording = existsSync(file)
    ? { ...emptyRecording(), ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<DnsRecording>) }
    : emptyRecording();
  const save = () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(rec, null, 2) + '\n');
  };
  return {
    txt: async (name) => {
      rec.txt[name.toLowerCase()] = await live.txt(name);
      save();
      return rec.txt[name.toLowerCase()]!;
    },
    mx: async (name) => {
      rec.mx[name.toLowerCase()] = await live.mx(name);
      save();
      return rec.mx[name.toLowerCase()]!;
    },
    cname: async (name) => {
      rec.cname[name.toLowerCase()] = await live.cname(name);
      save();
      return rec.cname[name.toLowerCase()]!;
    },
  };
}

// The resolver the config's network mode calls for: replay by default.
export function createResolver(
  config: Pick<Config, 'network'>,
  domain: string,
  dir?: string,
): Resolver {
  switch (config.network.mode) {
    case 'replay':
      return recordedResolver(domain, dir);
    case 'record':
      return recordingResolver(domain, dir);
    default:
      return systemResolver();
  }
}
