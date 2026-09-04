import {
  ConsentRefusalSchema,
  EvidenceSchema,
  NO_REFUSAL_PATH_FINDING,
  sha256,
  type ConsentAction,
  type ConsentPlatform,
  type ConsentRefusal,
  type ConsentStep,
  type Evidence,
  type EvidenceRef,
  type ScanPass,
} from '@gc/contracts';
import type { Frame, Locator, Page } from 'playwright';
import { refTo, type EvidenceIdentity } from '../evidence.js';
import type { BrowserPool, ScanTarget } from '../pool.js';
import {
  ACCEPT_TEXT,
  BANNER_WORDS,
  PLATFORM_SIGNATURES,
  REJECT_TEXT,
  SAVE_TEXT,
  SETTINGS_TEXT,
  matches,
} from './signatures.js';

// Refusing consent (S-03). Find the banner (a platform signature first, then the
// heuristic: a visible overlay that talks about cookies and offers buttons, in the page
// or in a frame), and refuse: the direct "no" if there is one; otherwise open the
// settings, switch every optional toggle off, and save. A screenshot after every step
// is evidence. If no path leads to a refusal, the outcome is undetermined and the
// finding is raised; the scanner never reports a refusal it did not see take effect.
// Accepting (S-04) is the same machinery pointed at the other button.

export interface RefusalOptions {
  readonly identity: EvidenceIdentity;
  readonly now?: () => Date;
  // Time for the banner to appear, and for a click to settle.
  readonly settleMs?: number;
  readonly maxToggles?: number;
  readonly pass?: ScanPass;
}

export interface RefusalResult {
  readonly refusal: ConsentRefusal;
  readonly evidence: readonly Evidence[];
}

const CONTROL = 'button, a, [role="button"], input[type="button"], input[type="submit"]';
const TOGGLES = 'input[type="checkbox"], [role="switch"]';

const FIND_BANNER = `(() => {
  const words = ${BANNER_WORDS.toString()};
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 40 && r.height > 20 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const candidates = Array.from(document.querySelectorAll('div, section, aside, dialog, form, [role="dialog"], [role="alertdialog"]'));
  let best;
  for (const el of candidates) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    const pinned = s.position === 'fixed' || s.position === 'sticky' || el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog' || el.tagName === 'DIALOG' || Number(s.zIndex) >= 100;
    if (!pinned) continue;
    const text = (el.innerText || '').slice(0, 2000);
    if (!words.test(text)) continue;
    const controls = el.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]').length;
    if (controls === 0) continue;
    const area = el.getBoundingClientRect().width * el.getBoundingClientRect().height;
    if (!best || area < best.area) best = { el, area };
  }
  if (!best) return null;
  const el = best.el;
  if (!el.dataset.gcBanner) el.dataset.gcBanner = 'root';
  return { text: (el.innerText || '').slice(0, 300) };
})()`;

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export interface FoundBanner {
  readonly frame: Frame;
  readonly root: Locator;
  readonly platform: ConsentPlatform;
  readonly recognisedBy: 'signature' | 'heuristic';
  readonly signature?: (typeof PLATFORM_SIGNATURES)[number];
}

async function isVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.first().isVisible();
  } catch {
    return false;
  }
}

export async function findBanner(page: Page): Promise<FoundBanner | undefined> {
  for (const frame of page.frames()) {
    for (const signature of PLATFORM_SIGNATURES) {
      for (const selector of signature.root) {
        const root = frame.locator(selector);
        if (await isVisible(root)) {
          return {
            frame,
            root: root.first(),
            platform: signature.platform,
            recognisedBy: 'signature',
            signature,
          };
        }
      }
    }
  }
  for (const frame of page.frames()) {
    let found: { text: string } | null = null;
    try {
      found = (await frame.evaluate(FIND_BANNER)) as { text: string } | null;
    } catch {
      found = null;
    }
    if (found) {
      return {
        frame,
        root: frame.locator('[data-gc-banner="root"]').first(),
        platform: 'generic',
        recognisedBy: 'heuristic',
      };
    }
  }
  return undefined;
}

async function controlsIn(scope: Locator | Frame): Promise<{ locator: Locator; text: string }[]> {
  const all = scope.locator(CONTROL);
  const count = await all.count();
  const out: { locator: Locator; text: string }[] = [];
  for (let i = 0; i < Math.min(count, 60); i += 1) {
    const locator = all.nth(i);
    if (!(await isVisible(locator))) continue;
    const text = ((await locator.textContent()) ?? (await locator.getAttribute('value')) ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) out.push({ locator, text });
  }
  return out;
}

async function firstBySelectors(
  scope: Frame,
  selectors: readonly string[] | undefined,
): Promise<{ locator: Locator; text: string } | undefined> {
  for (const selector of selectors ?? []) {
    const locator = scope.locator(selector).first();
    if (await isVisible(locator)) {
      const text = ((await locator.textContent()) ?? '').replace(/\s+/g, ' ').trim() || selector;
      return { locator, text };
    }
  }
  return undefined;
}

async function firstByText(
  scope: Locator | Frame,
  patterns: readonly RegExp[],
): Promise<{ locator: Locator; text: string } | undefined> {
  for (const c of await controlsIn(scope)) if (matches(c.text, patterns)) return c;
  return undefined;
}

// The step recorder: a screenshot per step, as an evidence row the step points at.
class Recorder {
  readonly evidence: Evidence[] = [];
  readonly steps: ConsentStep[] = [];
  constructor(
    private readonly page: Page,
    private readonly options: RefusalOptions,
    private readonly now: () => Date,
  ) {}

  async shot(action: ConsentAction, target: string, frame?: Frame): Promise<void> {
    const png = await this.page.screenshot({ fullPage: false, type: 'png' });
    const body = Buffer.from(png).toString('base64');
    const hash = sha256(body);
    const row = EvidenceSchema.parse({
      id: `screenshot:${hash.slice(0, 16)}`,
      tenantId: this.options.identity.tenantId,
      caseId: this.options.identity.caseId,
      ...(this.options.identity.scanId ? { scanId: this.options.identity.scanId } : {}),
      kind: 'screenshot',
      capturedAt: this.options.identity.capturedAt,
      source: { url: this.page.url(), pass: this.options.pass ?? 'B' },
      body,
      hash,
      caption: `Step ${this.steps.length + 1}: ${action} ${target}`,
    });
    this.evidence.push(row);
    this.steps.push({
      n: this.steps.length + 1,
      action,
      target,
      ...(frame && frame !== this.page.mainFrame() ? { frame: frame.url() || frame.name() } : {}),
      at: this.now().toISOString(),
      screenshot: refTo(row),
    });
  }
}

// Refuse on a page that is already loaded. The page stays open afterwards, so a pass can
// go on recording what the site does once it has been told no.
export async function refuseOnPage(
  page: Page,
  url: string,
  options: RefusalOptions,
): Promise<RefusalResult> {
  const now = options.now ?? (() => new Date());
  const settle = options.settleMs ?? 400;
  const startedAt = now().toISOString();
  const rec = new Recorder(page, options, now);

  const finish = (partial: Omit<ConsentRefusal, 'url' | 'startedAt' | 'steps'>): RefusalResult => ({
    refusal: ConsentRefusalSchema.parse({ url, startedAt, steps: rec.steps, ...partial }),
    evidence: rec.evidence,
  });
  const undetermined = (
    summary: string,
    platform: ConsentPlatform,
    recognisedBy: FoundBanner['recognisedBy'],
  ) =>
    finish({
      bannerFound: true,
      platform,
      recognisedBy,
      outcome: 'undetermined',
      summary,
      bannerHiddenAfter: false,
      finding: {
        findingTypeId: NO_REFUSAL_PATH_FINDING,
        evidence: rec.steps.map((s) => s.screenshot) as [EvidenceRef, ...EvidenceRef[]],
      },
    });

  await sleep(settle);
  const found = await findBanner(page);
  if (!found) {
    await rec.shot('found', 'no banner');
    return finish({
      bannerFound: false,
      outcome: 'no_banner',
      summary: 'No consent banner was shown on the first load.',
      bannerHiddenAfter: true,
    });
  }
  await rec.shot('found', `${found.platform} banner (${found.recognisedBy})`, found.frame);
  const hidden = async (): Promise<boolean> => {
    await sleep(settle);
    return !(await isVisible(found.root));
  };
  const refused = async (summary: string): Promise<RefusalResult> => {
    await rec.shot('hidden', 'banner gone');
    return finish({
      bannerFound: true,
      platform: found.platform,
      recognisedBy: found.recognisedBy,
      outcome: 'refused',
      summary,
      bannerHiddenAfter: true,
    });
  };

  // 1. A direct refusal on the first layer.
  const reject =
    (await firstBySelectors(found.frame, found.signature?.reject)) ??
    (await firstByText(found.root, REJECT_TEXT));
  if (reject) {
    await reject.locator.click({ timeout: 5_000 }).catch(() => undefined);
    await rec.shot('click', reject.text, found.frame);
    if (await hidden()) {
      return refused(`Refused with "${reject.text}" on the first layer; the banner closed.`);
    }
  }

  // 2. Settings, toggles off, save.
  const settings =
    (await firstBySelectors(found.frame, found.signature?.settings)) ??
    (await firstByText(found.root, SETTINGS_TEXT));
  if (!settings) {
    return undetermined(
      `The banner offers no refusal and no settings; the only controls are: ${(await controlsIn(found.root)).map((c) => `"${c.text}"`).join(', ') || 'none'}.`,
      found.platform,
      found.recognisedBy,
    );
  }
  await settings.locator.click({ timeout: 5_000 }).catch(() => undefined);
  await sleep(settle);
  await rec.shot('click', settings.text, found.frame);

  // The second layer may be the same root, a new dialog, or a frame; look everywhere.
  const layer = await findBanner(page);
  const scope: Locator | Frame = layer ? layer.root : found.frame;
  const frame = layer ? layer.frame : found.frame;

  const secondReject =
    (await firstBySelectors(frame, found.signature?.reject)) ??
    (await firstByText(scope, REJECT_TEXT));
  if (secondReject) {
    await secondReject.locator.click({ timeout: 5_000 }).catch(() => undefined);
    await rec.shot('click', secondReject.text, frame);
    if (await hidden()) {
      return refused(
        `Opened "${settings.text}", then refused with "${secondReject.text}"; the banner closed.`,
      );
    }
  }

  // Every optional toggle that is on: checkboxes and aria switches, read for their
  // state rather than matched by pseudo-class, and skipped when disabled (necessary).
  const toggles = scope.locator(TOGGLES);
  const max = options.maxToggles ?? 25;
  let switchedOff = 0;
  const total = Math.min(await toggles.count(), max);
  for (let i = 0; i < total; i += 1) {
    const toggle = toggles.nth(i);
    if (!(await isVisible(toggle))) continue;
    const state = await toggle
      .evaluate((el) => {
        const e = el as {
          checked?: unknown;
          disabled?: unknown;
          getAttribute: (n: string) => string | null;
          hasAttribute: (n: string) => boolean;
        };
        const on =
          typeof e.checked === 'boolean' ? e.checked : e.getAttribute('aria-checked') === 'true';
        const disabled =
          e.disabled === true ||
          e.hasAttribute('disabled') ||
          e.getAttribute('aria-disabled') === 'true';
        return { on, disabled };
      })
      .catch(() => ({ on: false, disabled: true }));
    if (!state.on || state.disabled) continue;
    const label =
      (await toggle.getAttribute('aria-label')) ??
      (await toggle.getAttribute('name')) ??
      (await toggle.getAttribute('id')) ??
      'toggle';
    await toggle.click({ timeout: 5_000 }).catch(() => undefined);
    await sleep(100);
    const still = await toggle
      .evaluate((el) => {
        const e = el as { checked?: unknown; getAttribute: (n: string) => string | null };
        return typeof e.checked === 'boolean'
          ? e.checked
          : e.getAttribute('aria-checked') === 'true';
      })
      .catch(() => true);
    if (still) continue;
    switchedOff += 1;
    await rec.shot('toggle_off', label, frame);
  }

  const save =
    (await firstBySelectors(frame, found.signature?.save)) ?? (await firstByText(scope, SAVE_TEXT));
  if (!save) {
    return undetermined(
      `Opened "${settings.text}" and switched ${switchedOff} toggle(s) off, but found nothing to save with.`,
      found.platform,
      found.recognisedBy,
    );
  }
  await save.locator.click({ timeout: 5_000 }).catch(() => undefined);
  await rec.shot('save', save.text, frame);
  if (await hidden()) {
    return refused(
      `Opened "${settings.text}", switched ${switchedOff} toggle(s) off and saved with "${save.text}"; the banner closed.`,
    );
  }
  return undetermined(
    `Opened "${settings.text}", switched ${switchedOff} toggle(s) off and pressed "${save.text}", but the banner stayed.`,
    found.platform,
    found.recognisedBy,
  );
}

export async function refuseConsent(
  pool: BrowserPool,
  target: ScanTarget,
  options: RefusalOptions,
): Promise<RefusalResult> {
  return pool.run(target, async (page) => {
    await page.goto(target.url, { waitUntil: 'load' });
    return refuseOnPage(page, target.url, options);
  });
}

export interface AcceptanceResult {
  readonly bannerFound: boolean;
  readonly platform?: ConsentPlatform;
  readonly accepted: boolean;
  readonly summary: string;
  readonly steps: readonly ConsentStep[];
  readonly evidence: readonly Evidence[];
}

// Accept everything on a page that is already loaded (Pass C). The same finder; the
// platform's accept control, or the button that says yes to all.
export async function acceptOnPage(page: Page, options: RefusalOptions): Promise<AcceptanceResult> {
  const now = options.now ?? (() => new Date());
  const settle = options.settleMs ?? 400;
  const rec = new Recorder(page, { ...options, pass: options.pass ?? 'C' }, now);
  await sleep(settle);
  const found = await findBanner(page);
  if (!found) {
    await rec.shot('found', 'no banner');
    return {
      bannerFound: false,
      accepted: false,
      summary: 'No consent banner was shown on the first load.',
      steps: rec.steps,
      evidence: rec.evidence,
    };
  }
  await rec.shot('found', `${found.platform} banner (${found.recognisedBy})`, found.frame);
  const accept =
    (await firstBySelectors(found.frame, found.signature?.accept)) ??
    (await firstByText(found.root, ACCEPT_TEXT));
  if (!accept) {
    return {
      bannerFound: true,
      platform: found.platform,
      accepted: false,
      summary: `The banner offers nothing recognisable as accepting; the controls are: ${(await controlsIn(found.root)).map((c) => `"${c.text}"`).join(', ') || 'none'}.`,
      steps: rec.steps,
      evidence: rec.evidence,
    };
  }
  await accept.locator.click({ timeout: 5_000 }).catch(() => undefined);
  await rec.shot('click', accept.text, found.frame);
  await sleep(settle);
  const gone = !(await isVisible(found.root));
  if (gone) await rec.shot('hidden', 'banner gone');
  return {
    bannerFound: true,
    platform: found.platform,
    accepted: gone,
    summary: gone
      ? `Accepted with "${accept.text}"; the banner closed.`
      : `Pressed "${accept.text}" but the banner stayed.`,
    steps: rec.steps,
    evidence: rec.evidence,
  };
}
