import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LocalisedTextSchema } from '@gc/contracts';

// Sector inference (D-09). A sector is content: a NACE prefix list from the business
// register's industry code, and the signals a site gives when there is no code. The
// register's code wins when it matches; signals decide only when one sector clearly
// fits better than every other; otherwise the sector is unknown, and the inference says
// in words what it read. A sector narrows which questions are asked first; it never
// decides a duty on its own.

export const SectorSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  title: LocalisedTextSchema,
  // NACE Rev. 2 prefixes, "47" or "47.91"; the longest matching prefix wins.
  nace: z.array(z.string().regex(/^\d{2}(\.\d{1,2})?$/)).default([]),
  // A sector with its own supervisor and duties beyond the GDPR (L-01 reads it).
  regulated: z.boolean().default(false),
  signals: z
    .object({
      activities: z.array(z.string()).default([]),
      categories: z.array(z.string()).default([]),
    })
    .default({ activities: [], categories: [] }),
});
export type Sector = z.infer<typeof SectorSchema>;

export const SectorCatalogueSchema = z
  .object({
    version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sectors: z.array(SectorSchema).min(1),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    c.sectors.forEach((s, i) => {
      if (ids.has(s.id))
        ctx.addIssue({ code: 'custom', path: ['sectors', i, 'id'], message: `duplicate ${s.id}` });
      ids.add(s.id);
    });
  });

export const SECTORS_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../content/sectors.json',
);

export function loadSectors(file: string = SECTORS_FILE): Sector[] {
  return SectorCatalogueSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).sectors;
}

// "47.91.10", "479110" and "47.91" all read as the same digits.
export const naceDigits = (code: string): string => code.replace(/[^0-9]/g, '');

export interface SectorInput {
  readonly sectorCode?: string | undefined;
  readonly activities?: readonly string[] | undefined;
  readonly categories?: readonly string[] | undefined;
}

export interface SectorInference {
  readonly sector: string | 'unknown';
  readonly confidence: 'registry' | 'signals' | 'none';
  // What was read, in words, for the case log.
  readonly because: readonly string[];
}

export function inferSector(input: SectorInput, sectors: readonly Sector[]): SectorInference {
  const because: string[] = [];
  if (input.sectorCode) {
    const digits = naceDigits(input.sectorCode);
    let best: { sector: Sector; prefix: string } | undefined;
    for (const sector of sectors)
      for (const prefix of sector.nace)
        if (
          digits.startsWith(naceDigits(prefix)) &&
          (!best || naceDigits(prefix).length > naceDigits(best.prefix).length)
        )
          best = { sector, prefix };
    if (best)
      return {
        sector: best.sector.id,
        confidence: 'registry',
        because: [
          `the register's industry code ${input.sectorCode} falls under NACE ${best.prefix} (${best.sector.title['en']})`,
        ],
      };
    because.push(`the register's industry code ${input.sectorCode} matches no sector on the list`);
  }
  const activities = input.activities ?? [];
  const categories = input.categories ?? [];
  const scored = sectors
    .map((sector) => ({
      sector,
      hits: [
        ...sector.signals.activities
          .filter((a) => activities.includes(a))
          .map((a) => `the activity ${a}`),
        ...sector.signals.categories.filter((c) => categories.includes(c)).map((c) => `${c} data`),
      ],
    }))
    .filter((s) => s.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length);
  const [first, second] = scored;
  if (first && (!second || first.hits.length > second.hits.length))
    return {
      sector: first.sector.id,
      confidence: 'signals',
      because: [
        ...because,
        `${first.hits.join(' and ')} on the site fit${first.hits.length === 1 ? 's' : ''} ${first.sector.title['en']}`,
      ],
    };
  if (first && second)
    because.push(
      `what the site shows fits ${first.sector.title['en']} and ${second.sector.title['en']} equally`,
    );
  else because.push('nothing read so far points at a sector');
  return { sector: 'unknown', confidence: 'none', because };
}
