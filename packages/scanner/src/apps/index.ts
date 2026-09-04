import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { OutboundFetch } from '@gc/config';
import {
  EvidenceSchema,
  LocalisedTextSchema,
  sha256,
  type Evidence,
  type EvidenceRef,
  type FindingTypeId,
} from '@gc/contracts';
import { refTo, type EvidenceIdentity } from '../evidence.js';

// App listings (D-05): if the site links to its app in a store, read what the listing
// declares the app collects and hold it against the privacy policy on the site. A
// declared category the policy never mentions is a contradiction, reported with both
// sides quoted. No link means no app, which is a clean pass, not an error. The stores
// are reached through the declared-endpoint fetch only, and never behind a login.

export const APP_DECLARATION_FINDING = 'APP-01' as FindingTypeId;

const StoreLabelsSchema = z.object({
  apple: z.array(z.string()).default([]),
  google: z.array(z.string()).default([]),
});
export const AppCategorySchema = z.object({
  id: z.string().regex(/^[a-z][a-z-]*$/),
  label: LocalisedTextSchema,
  store: StoreLabelsSchema,
  policy: z.record(z.string(), z.array(z.string())),
});
export type AppCategory = z.infer<typeof AppCategorySchema>;

export const APP_CATEGORIES_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/apps/categories.json',
);

export function loadAppCategories(file: string = APP_CATEGORIES_FILE): AppCategory[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { categories: unknown };
  return z.array(AppCategorySchema).min(1).parse(raw.categories);
}

export type StoreId = 'apple' | 'google';
export const APP_STORE_HOSTS: Readonly<Record<StoreId, string>> = {
  apple: 'apps.apple.com',
  google: 'play.google.com',
};

export interface StoreLink {
  readonly store: StoreId;
  readonly url: string;
  readonly appId: string;
}

// The store links a page carries: an App Store page by numeric id, a Play page by package.
export function storeLinks(links: readonly { readonly href: string }[]): StoreLink[] {
  const out = new Map<string, StoreLink>();
  for (const { href } of links) {
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase();
    if (host === APP_STORE_HOSTS.apple) {
      const m = /\/id(\d{5,})(?:[/?#]|$)/.exec(u.pathname);
      if (m && !out.has(`apple:${m[1]}`))
        out.set(`apple:${m[1]}`, { store: 'apple', url: u.toString(), appId: m[1]! });
    } else if (host === APP_STORE_HOSTS.google && u.pathname.startsWith('/store/apps/details')) {
      const pkg = u.searchParams.get('id');
      if (pkg && /^[a-zA-Z][\w.]+$/.test(pkg) && !out.has(`google:${pkg}`))
        out.set(`google:${pkg}`, {
          store: 'google',
          url: `https://${APP_STORE_HOSTS.google}/store/apps/details?id=${pkg}`,
          appId: pkg,
        });
    }
  }
  return [...out.values()];
}

export interface DeclaredCategory {
  readonly categoryId: string;
  // The label as the store printed it.
  readonly as: string;
}

export interface AppListing {
  readonly store: StoreId;
  readonly appId: string;
  readonly url: string;
  readonly name?: string | undefined;
  readonly declared: readonly DeclaredCategory[];
  // False when the page answered but the declaration could not be read from it.
  readonly parsed: boolean;
  readonly fetchedAt: string;
}

const unescape = (s: string) => s.replace(/\\"/g, '"').replace(/\\\//g, '/');

// Apple prints the privacy label as JSON inside the page: every dataCategory it names.
function appleDeclared(
  body: string,
  categories: readonly AppCategory[],
): DeclaredCategory[] | undefined {
  const text = unescape(body);
  if (!/"privacyTypes"/.test(text) && !/"privacyDetails"/.test(text)) return undefined;
  const seen = new Set<string>();
  for (const m of text.matchAll(/"dataCategory"\s*:\s*"([^"]+)"/g)) seen.add(m[1]!);
  return labelsToCategories([...seen], 'apple', categories);
}

// Google prints the data safety section as text: the categories named after its heading.
function googleDeclared(
  body: string,
  categories: readonly AppCategory[],
): DeclaredCategory[] | undefined {
  const at = body.search(/data safety|datasikkerhed|datensicherheit/i);
  if (at < 0) return undefined;
  const region = body.slice(at, at + 40_000).replace(/<[^>]+>/g, '\n');
  const seen: string[] = [];
  for (const c of categories)
    for (const label of c.store.google)
      if (
        new RegExp(
          `(^|\\n)\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\n|$)`,
          'i',
        ).test(region)
      )
        seen.push(label);
  return labelsToCategories(seen, 'google', categories);
}

function labelsToCategories(
  labels: readonly string[],
  store: StoreId,
  categories: readonly AppCategory[],
): DeclaredCategory[] {
  const out: DeclaredCategory[] = [];
  for (const label of labels) {
    const c = categories.find((x) =>
      x.store[store].some((l) => l.toLowerCase() === label.toLowerCase()),
    );
    if (c && !out.some((d) => d.categoryId === c.id)) out.push({ categoryId: c.id, as: label });
  }
  return out.sort((a, b) => a.categoryId.localeCompare(b.categoryId));
}

const titleOf = (body: string): string | undefined => {
  const m = /<title>([^<]{1,200})<\/title>/i.exec(body);
  return m ? m[1]!.replace(/\s+/g, ' ').trim() : undefined;
};

export class ListingUnavailable extends Error {
  constructor(
    public readonly link: StoreLink,
    message: string,
  ) {
    super(`${link.store} ${link.appId}: ${message}`);
    this.name = 'ListingUnavailable';
  }
}

export async function readListing(
  link: StoreLink,
  outbound: OutboundFetch,
  options: { readonly categories: readonly AppCategory[]; readonly now?: () => Date },
): Promise<{ listing: AppListing; body: string }> {
  const response = await outbound(link.url, {
    purpose: 'store',
    method: 'GET',
    headers: { accept: 'text/html', 'accept-language': 'en' },
    redirect: 'follow',
  });
  if (!response.ok) throw new ListingUnavailable(link, `HTTP ${response.status}`);
  const body = await response.text();
  const declared =
    link.store === 'apple'
      ? appleDeclared(body, options.categories)
      : googleDeclared(body, options.categories);
  const name = titleOf(body);
  return {
    listing: {
      store: link.store,
      appId: link.appId,
      url: link.url,
      ...(name ? { name } : {}),
      declared: declared ?? [],
      parsed: declared !== undefined,
      fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
    },
    body,
  };
}

export interface AppComparison {
  readonly listing: AppListing;
  // Declared by the store, never mentioned by the policy in any language.
  readonly missing: readonly DeclaredCategory[];
  readonly mentioned: readonly DeclaredCategory[];
}

const mentions = (c: AppCategory, policyText: string): boolean =>
  Object.values(c.policy).some((patterns) =>
    patterns.some((p) => new RegExp(p, 'i').test(policyText)),
  );

export function compareDeclared(
  listing: AppListing,
  policyText: string,
  categories: readonly AppCategory[],
): AppComparison {
  const missing: DeclaredCategory[] = [];
  const mentioned: DeclaredCategory[] = [];
  for (const d of listing.declared) {
    const c = categories.find((x) => x.id === d.categoryId);
    if (!c) continue;
    (mentions(c, policyText) ? mentioned : missing).push(d);
  }
  return { listing, missing, mentioned };
}

export interface AppDraft {
  readonly typeId: FindingTypeId;
  readonly subject: { readonly host: string };
  readonly evidence: readonly EvidenceRef[];
  readonly summary: string;
}

export interface AppCheckInput {
  readonly links: readonly { readonly href: string }[];
  readonly host: string;
  readonly identity: EvidenceIdentity;
  // The privacy policy's visible text, and the evidence rows it was read from.
  readonly policyText?: string | undefined;
  readonly policyUrl?: string | undefined;
  readonly policyEvidence?: readonly EvidenceRef[] | undefined;
  readonly categories?: readonly AppCategory[] | undefined;
  readonly now?: (() => Date) | undefined;
  readonly maxListings?: number | undefined;
}

export interface AppCheck {
  readonly outcome: 'pass' | 'fail' | 'undetermined';
  readonly summary: string;
  readonly listings: readonly AppListing[];
  readonly comparisons: readonly AppComparison[];
  readonly drafts: readonly AppDraft[];
  readonly evidence: readonly Evidence[];
}

function evidenceRow(
  identity: EvidenceIdentity,
  kind: Evidence['kind'],
  body: string,
  source: { url: string; host: string },
  caption: string,
): Evidence {
  const hash = sha256(body);
  return EvidenceSchema.parse({
    id: `${kind}:${hash.slice(0, 16)}`,
    tenantId: identity.tenantId,
    caseId: identity.caseId,
    ...(identity.scanId !== undefined ? { scanId: identity.scanId } : {}),
    kind,
    capturedAt: identity.capturedAt,
    source,
    body,
    hash,
    caption,
  });
}

const storeName = (s: StoreId) => (s === 'apple' ? 'App Store' : 'Google Play');

export async function checkAppListings(
  input: AppCheckInput,
  outbound: OutboundFetch,
): Promise<AppCheck> {
  const categories = input.categories ?? loadAppCategories();
  const links = storeLinks(input.links).slice(0, input.maxListings ?? 4);
  if (links.length === 0)
    return {
      outcome: 'pass',
      summary: `No app store listing is linked from ${input.host}.`,
      listings: [],
      comparisons: [],
      drafts: [],
      evidence: [],
    };
  const listings: AppListing[] = [];
  const comparisons: AppComparison[] = [];
  const drafts: AppDraft[] = [];
  const evidence: Evidence[] = [];
  const problems: string[] = [];
  for (const link of links) {
    let read: { listing: AppListing; body: string };
    try {
      read = await readListing(link, outbound, {
        categories,
        ...(input.now ? { now: input.now } : {}),
      });
    } catch (e) {
      problems.push(
        `${storeName(link.store)} listing ${link.appId} could not be read (${(e as Error).message})`,
      );
      continue;
    }
    const { listing } = read;
    listings.push(listing);
    const declaredLabels = listing.declared.map((d) => d.as);
    const listingRow = evidenceRow(
      input.identity,
      'document',
      JSON.stringify(
        {
          store: listing.store,
          appId: listing.appId,
          url: listing.url,
          ...(listing.name ? { name: listing.name } : {}),
          declared: declaredLabels,
          parsed: listing.parsed,
        },
        null,
        2,
      ),
      { url: listing.url, host: APP_STORE_HOSTS[listing.store] },
      `${storeName(listing.store)} listing for ${listing.name ?? listing.appId}: declares ${declaredLabels.length > 0 ? declaredLabels.join(', ') : 'nothing readable'}`,
    );
    evidence.push(listingRow);
    if (!listing.parsed) {
      problems.push(
        `${storeName(listing.store)} listing ${listing.appId} answered but its data declaration could not be read`,
      );
      continue;
    }
    if (input.policyText === undefined) {
      problems.push(
        `${storeName(listing.store)} listing ${listing.appId} read, but there is no privacy policy text to compare it with`,
      );
      continue;
    }
    const comparison = compareDeclared(listing, input.policyText, categories);
    comparisons.push(comparison);
    if (comparison.missing.length === 0) continue;
    const missingLabels = comparison.missing.map((d) => d.as);
    const missingWords = comparison.missing
      .map((d) => categories.find((c) => c.id === d.categoryId)?.label['en'] ?? d.categoryId)
      .join(', ');
    const policyWhere = input.policyUrl ?? `the privacy policy on ${input.host}`;
    const both = [
      `${storeName(listing.store)} listing (${listing.url}) declares: ${declaredLabels.join('; ')}`,
      `Privacy policy (${policyWhere}) mentions: ${comparison.mentioned.map((d) => d.as).join('; ') || 'none of them'}`,
      `Privacy policy does not mention: ${missingLabels.join('; ')}`,
    ].join('\n');
    const bothRow = evidenceRow(
      input.identity,
      'text',
      both,
      { url: listing.url, host: APP_STORE_HOSTS[listing.store] },
      `What the ${storeName(listing.store)} listing declares against what the privacy policy says`,
    );
    evidence.push(bothRow);
    drafts.push({
      typeId: APP_DECLARATION_FINDING,
      subject: { host: input.host },
      evidence: [
        refTo(listingRow, missingLabels.join(', ')),
        refTo(bothRow),
        ...(input.policyEvidence ?? []),
      ],
      summary: `The ${storeName(listing.store)} listing for ${listing.name ?? listing.appId} declares that the app collects ${missingLabels.map((l) => `"${l}"`).join(' and ')}; the privacy policy at ${policyWhere} says nothing about ${missingWords}.`,
    });
  }
  const outcome: AppCheck['outcome'] =
    drafts.length > 0 ? 'fail' : problems.length > 0 ? 'undetermined' : 'pass';
  const summary =
    outcome === 'fail'
      ? drafts.map((d) => d.summary).join(' ')
      : outcome === 'undetermined'
        ? problems.join('; ')
        : `${listings.length} app listing(s) read; the privacy policy mentions everything the store declares.`;
  return { outcome, summary, listings, comparisons, drafts, evidence };
}
