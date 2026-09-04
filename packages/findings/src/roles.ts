import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  FINDING_AREAS,
  LocalisedTextSchema,
  SEVERITIES,
  TaskProposalSchema,
  type FindingArea,
  type Locale,
  type RemedyKind,
  type Severity,
  type TaskProposal,
} from '@gc/contracts';
import { localise } from '@gc/i18n';

// Roles and scoped task lists (P-01). Marketing, IT, HR, Finance: each sees only what
// it can actually change. The role a finding belongs to is derived from the finding,
// never assigned by hand; the list is cut to fewer than six items by the assembler; and
// every item carries the "I do not know, check it for me" proposal that hands the
// question back to the agent through the task catalogue (A-04).

export const ROLES = ['marketing', 'it', 'hr', 'finance'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const ITEM_KINDS = ['fix', 'approve', 'confirm', 'answer'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const MAX_ITEMS_PER_ROLE = 5;

const ContentSchema = z.object({
  roles: z.record(RoleSchema, LocalisedTextSchema),
  kinds: z.record(z.enum(ITEM_KINDS), LocalisedTextSchema),
  checkForMe: LocalisedTextSchema,
});
export const ROLE_CONTENT = ContentSchema.parse(
  JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'content', 'roles.json'),
      'utf8',
    ),
  ),
);

// By area first, then by the finding type's prefix where an area spans two desks.
export const ROLE_BY_AREA: Readonly<Record<FindingArea, Role>> = {
  Consent: 'marketing',
  Collection: 'marketing',
  Notice: 'marketing',
  Observation: 'it',
  Security: 'it',
  Recipients: 'it',
  Transfers: 'finance',
  Contracts: 'finance',
};

export const ROLE_BY_PREFIX: Readonly<Record<string, Role>> = {
  HR: 'hr',
  SUB: 'finance',
  DPA: 'finance',
  TRF: 'finance',
  AI: 'it',
  FPR: 'it',
  REC: 'it',
  VND: 'it',
  CLK: 'it',
  SEC: 'it',
  EXP: 'it',
  APP: 'it',
};

export interface RoleSubject {
  readonly typeId: string;
  readonly area: FindingArea;
}

export function roleFor(finding: RoleSubject): Role {
  const prefix = finding.typeId.split('-')[0] ?? '';
  return ROLE_BY_PREFIX[prefix] ?? ROLE_BY_AREA[finding.area];
}

// What a person does about a remedy of this kind.
export const ITEM_KIND_BY_REMEDY: Readonly<Record<RemedyKind, ItemKind>> = {
  self_fix: 'fix',
  generated_artefact: 'approve',
  our_product: 'approve',
  partner_alternative: 'answer',
  no_solution: 'answer',
};

export interface RoleFinding extends RoleSubject {
  readonly id: string;
  readonly severity: Severity;
  readonly status: 'open' | 'working' | 'closed' | 'regressed';
  readonly remedyKind: RemedyKind;
  // The remedy's title, already in the case's language.
  readonly title: string;
}

export interface RoleItem {
  readonly findingId: string;
  readonly typeId: string;
  readonly kind: ItemKind;
  readonly kindLabel: string;
  readonly text: string;
  readonly severity: Severity;
  readonly done: boolean;
  // "I do not know, check it for me": a task proposal for the agent, accepted through
  // the catalogue like anything a planner emits.
  readonly checkForMe: { readonly label: string; readonly proposal: TaskProposal };
}

export interface RoleList {
  readonly role: Role;
  readonly label: string;
  readonly items: readonly RoleItem[];
  // Open items beyond the cut. They are not lost, they are not shown.
  readonly deferred: number;
  readonly open: number;
  readonly done: number;
}

export interface AssembleOptions {
  readonly locale: Locale;
  readonly domain: string;
  readonly max?: number;
}

const rank = (s: Severity) => SEVERITIES.indexOf(s);

// A re-scan of the site is what "check it for me" means for a finding: the agent looks
// again and says what it saw, and the person does not have to know.
export function checkForMeProposal(finding: RoleSubject, domain: string): TaskProposal {
  return TaskProposalSchema.parse({
    type: 'crawl',
    payload: { url: `https://${domain}/`, depth: 0, passes: ['A'] },
    rationale: `${finding.typeId}: the ${roleFor(finding)} desk asked for a check`,
  });
}

export function assembleRoleLists(
  findings: readonly RoleFinding[],
  options: AssembleOptions,
): RoleList[] {
  const max = options.max ?? MAX_ITEMS_PER_ROLE;
  if (max >= 6) throw new Error(`a role list is under six items; ${max} is not`);
  const check = localise(ROLE_CONTENT.checkForMe, options.locale).value;
  return ROLES.map((role) => {
    const mine = findings.filter((f) => roleFor(f) === role);
    const done = mine.filter((f) => f.status === 'closed');
    const open = mine
      .filter((f) => f.status !== 'closed')
      .sort((a, b) => rank(a.severity) - rank(b.severity) || a.typeId.localeCompare(b.typeId));
    const shown = open.slice(0, max);
    const items: RoleItem[] = shown.map((f) => {
      const kind = ITEM_KIND_BY_REMEDY[f.remedyKind];
      return {
        findingId: f.id,
        typeId: f.typeId,
        kind,
        kindLabel: localise(ROLE_CONTENT.kinds[kind], options.locale).value,
        text: f.title,
        severity: f.severity,
        done: false,
        checkForMe: { label: check, proposal: checkForMeProposal(f, options.domain) },
      };
    });
    return {
      role,
      label: localise(ROLE_CONTENT.roles[role], options.locale).value,
      items,
      deferred: open.length - shown.length,
      open: open.length,
      done: done.length,
    };
  });
}

// Every area and every prefix the product raises resolves to a role: the assembler
// never has to guess.
export function roleCoverage(typeIds: readonly string[]): { unmapped: string[] } {
  const unmapped: string[] = [];
  for (const area of FINDING_AREAS) if (!ROLE_BY_AREA[area]) unmapped.push(`area:${area}`);
  for (const id of typeIds) {
    const prefix = id.split('-')[0] ?? '';
    if (!ROLE_BY_PREFIX[prefix] && !/^(CNS|FRM|POL)$/.test(prefix)) unmapped.push(id);
  }
  return { unmapped };
}
