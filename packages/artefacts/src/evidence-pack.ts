import { strToU8, unzipSync, zipSync } from 'fflate';
import { disclaimerText } from './disclaimer.js';
import { canonicalJson, sha256 } from '@gc/contracts';

// The evidence pack (G-04): a dated bundle proving the work happened. Plain files in a
// plain zip: a README anyone can read, the whole case as canonical JSON, one file per
// evidence row, the timeline as PDF, and a manifest with every file's hash. Built from
// the case's state alone with the clock it is given, so the same case at the same point
// packs to the same bytes.

export interface PackSignoff {
  readonly at: string;
  readonly who: string;
  readonly what: string;
}

export interface PackInput {
  readonly caseId: string;
  readonly domain: string;
  readonly stage: string;
  readonly generatedAt: Date;
  // The whole case, as exportCase shapes it.
  readonly bundle: Record<string, unknown>;
  readonly evidence: readonly {
    id: string;
    kind: string;
    hash: string;
    body: string;
    caption?: string | null;
  }[];
  readonly timelinePdf: Uint8Array;
  readonly signoffs: readonly PackSignoff[];
  // The reference material the case was assessed against, by version.
  readonly corpusVersions: Readonly<Record<string, string>>;
  readonly counts: Readonly<Record<string, number>>;
}

export interface PackFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface EvidencePack {
  readonly files: readonly PackFile[];
  readonly manifest: {
    readonly caseId: string;
    readonly generatedAt: string;
    readonly files: readonly { name: string; sha256: string; bytes: number }[];
  };
  readonly zip: Uint8Array;
  readonly sha256: string;
}

const iso = (d: Date) => d.toISOString();

function readme(input: PackInput, files: readonly PackFile[]): string {
  const lines = [
    `# Evidence pack · ${input.caseId}`,
    '',
    `Generated ${iso(input.generatedAt)} for ${input.domain}. Case stage: ${input.stage}.`,
    '',
    'Everything in this folder was produced from the case as it stood at that moment. It is',
    'a record of what was observed, what was done and who did it; it is not legal advice.',
    '',
    disclaimerText('en'),
    '',
    '## What is here',
    '',
    '| File | What it is |',
    '| --- | --- |',
    '| `README.md` | This note. |',
    '| `case.json` | The whole case: findings, evidence, answers, vendors, timeline, documents. Canonical JSON, one line per key, so two packs of the same case compare byte for byte. |',
    '| `timeline.pdf` | The timeline as a dated document. |',
    '| `evidence/` | One file per evidence row, named by its id; the SHA-256 in each is of the body as captured. |',
    '| `MANIFEST.json` | Every file above with its size and SHA-256. |',
    '',
    '## Counts',
    '',
    ...Object.entries(input.counts).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Sign-offs',
    '',
    ...(input.signoffs.length === 0
      ? ['None recorded.']
      : input.signoffs.map((s) => `- ${s.at} · ${s.who} · ${s.what}`)),
    '',
    '## Reference material, by version',
    '',
    ...Object.entries(input.corpusVersions).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Checking the pack',
    '',
    'Compute the SHA-256 of any file and compare it with `MANIFEST.json`. Compute the SHA-256',
    'of the body in any `evidence/*.json` and compare it with the `hash` field beside it.',
    '',
    `Files: ${files.map((f) => f.name).join(', ')}.`,
    '',
  ];
  return lines.join('\n');
}

const file = (name: string, bytes: Uint8Array): PackFile => ({
  name,
  bytes,
  sha256: sha256(Buffer.from(bytes)),
});

export function buildEvidencePack(input: PackInput): EvidencePack {
  const files: PackFile[] = [];
  files.push(file('case.json', strToU8(canonicalJson(input.bundle))));
  files.push(file('timeline.pdf', input.timelinePdf));
  for (const e of [...input.evidence].sort((a, b) => a.id.localeCompare(b.id))) {
    files.push(
      file(
        `evidence/${e.id.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`,
        strToU8(
          canonicalJson({
            id: e.id,
            kind: e.kind,
            hash: e.hash,
            caption: e.caption ?? null,
            body: e.body,
          }),
        ),
      ),
    );
  }
  files.unshift(file('README.md', strToU8(readme(input, files))));
  const manifest = {
    caseId: input.caseId,
    generatedAt: iso(input.generatedAt),
    files: files.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes.byteLength })),
  };
  files.push(file('MANIFEST.json', strToU8(canonicalJson(manifest))));

  // Fixed modification times, sorted names, no extra fields: the archive is a function
  // of its contents.
  const entries: Record<string, [Uint8Array, { mtime: Date; level: 6 }]> = {};
  for (const f of files) entries[f.name] = [f.bytes, { mtime: input.generatedAt, level: 6 }];
  const zip = zipSync(entries, { mtime: input.generatedAt });
  return { files, manifest, zip, sha256: sha256(Buffer.from(zip)) };
}

// Reads a pack back, as anyone with an unzip could.
export function openEvidencePack(zip: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(zip);
}
