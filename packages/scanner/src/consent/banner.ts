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
} from '@gc/contracts';
import type { Frame, Locator, Page } from 'playwright';
import { refTo, type EvidenceIdentity } from '../evidence.js';
import type { BrowserPool, ScanTarget } from '../pool.js';
import {
  BANNER_WORDS,
  PLATFORM_SIGNATURES,
  REJECT_TEXT,
  SAVE_TEXT,
  SETTINGS_TEXT,
  matches,
} from './signatures.js';

// Refusing consent (S-03). Load the page, find the banner (a platform signature first,
// then the heuristic: a visible overlay that talks about cookies and offers buttons, in
// the page or in a frame), and refuse: the direct "no" if there is one; otherwise open
// the settings, switch every optional toggle off, and save. A screenshot after every
// step is evidence. If no path leads to a refusal, the outcome is undetermined and the
// finding is raised; the scanner never reports a refusal it did not see take effect.

export interface RefusalOptions {
  readonly identity: EvidenceIdentity;
  readonly now?: () => Date;
  // Time for the banner to appear, and for a click to settle.
  readonly settleMs?: number;
  readonly maxToggles?: number;
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

interface Found {
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

async function findBanner(page: Page): Promise<Found | undefined> {
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

export async function refuseConsent(
  pool: BrowserPool,
  target: ScanTarget,
  options: RefusalOptions,
): Promise<RefusalResult> {
  const now = options.now ?? (() => new Date());
  const settle = options.settleMs ?? 400;
  const startedAt = now().toISOString();
  return pool.run(target, async (page) => {
    await page.goto(target.url, { waitUntil: 'load' });
    await sleep(settle);

    const evidence: Evidence[] = [];
    const steps: ConsentStep[] = [];
    const shot = async (
      action: ConsentAction,
      targetText: string,
      frame?: Frame,
    ): Promise<void> => {
      const png = await page.screenshot({ fullPage: false, type: 'png' });
      const body = Buffer.from(png).toString('base64');
      const hash = sha256(body);
      const row = EvidenceSchema.parse({
        id: `screenshot:${hash.slice(0, 16)}`,
        tenantId: options.identity.tenantId,
        caseId: options.identity.caseId,
        ...(options.identity.scanId ? { scanId: options.identity.scanId } : {}),
        kind: 'screenshot',
        capturedAt: options.identity.capturedAt,
        source: { url: page.url(), pass: 'B' },
        body,
        hash,
        caption: `Step ${steps.length + 1}: ${action} ${targetText}`,
      });
      evidence.push(row);
      steps.push({
        n: steps.length + 1,
        action,
        target: targetText,
        ...(frame && frame !== page.mainFrame() ? { frame: frame.url() || frame.name() } : {}),
        at: now().toISOString(),
        screenshot: refTo(row),
      });
    };

    const finish = (
      partial: Omit<ConsentRefusal, 'url' | 'startedAt' | 'steps'>,
    ): RefusalResult => ({
      refusal: ConsentRefusalSchema.parse({ url: target.url, startedAt, steps, ...partial }),
      evidence,
    });
    const undetermined = (
      summary: string,
      platform: ConsentPlatform,
      recognisedBy: Found['recognisedBy'],
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
          evidence: steps.map((s) => s.screenshot) as [EvidenceRef, ...EvidenceRef[]],
        },
      });

    const found = await findBanner(page);
    if (!found) {
      await shot('found', 'no banner');
      return finish({
        bannerFound: false,
        outcome: 'no_banner',
        summary: 'No consent banner was shown on the first load.',
        bannerHiddenAfter: true,
      });
    }
    await shot('found', `${found.platform} banner (${found.recognisedBy})`, found.frame);
    const hidden = async (): Promise<boolean> => {
      await sleep(settle);
      return !(await isVisible(found.root));
    };

    // 1. A direct refusal on the first layer.
    const reject =
      (await firstBySelectors(found.frame, found.signature?.reject)) ??
      (await firstByText(found.root, REJECT_TEXT));
    if (reject) {
      await reject.locator.click({ timeout: 5_000 }).catch(() => undefined);
      await shot('click', reject.text, found.frame);
      if (await hidden()) {
        await shot('hidden', 'banner gone');
        return finish({
          bannerFound: true,
          platform: found.platform,
          recognisedBy: found.recognisedBy,
          outcome: 'refused',
          summary: `Refused with "${reject.text}" on the first layer; the banner closed.`,
          bannerHiddenAfter: true,
        });
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
    await shot('click', settings.text, found.frame);

    // The second layer may be the same root, a new dialog, or a frame; look everywhere.
    const layer = await findBanner(page);
    const scope: Locator | Frame = layer ? layer.root : found.frame;
    const frame = layer ? layer.frame : found.frame;

    const secondReject =
      (await firstBySelectors(frame, found.signature?.reject)) ??
      (await firstByText(scope, REJECT_TEXT));
    if (secondReject) {
      await secondReject.locator.click({ timeout: 5_000 }).catch(() => undefined);
      await shot('click', secondReject.text, frame);
      if (await hidden()) {
        await shot('hidden', 'banner gone');
        return finish({
          bannerFound: true,
          platform: found.platform,
          recognisedBy: found.recognisedBy,
          outcome: 'refused',
          summary: `Opened "${settings.text}", then refused with "${secondReject.text}"; the banner closed.`,
          bannerHiddenAfter: true,
        });
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
      await shot('toggle_off', label, frame);
    }

    const save =
      (await firstBySelectors(frame, found.signature?.save)) ??
      (await firstByText(scope, SAVE_TEXT));
    if (!save) {
      return undetermined(
        `Opened "${settings.text}" and switched ${switchedOff} toggle(s) off, but found nothing to save with.`,
        found.platform,
        found.recognisedBy,
      );
    }
    await save.locator.click({ timeout: 5_000 }).catch(() => undefined);
    await shot('save', save.text, frame);
    if (await hidden()) {
      await shot('hidden', 'banner gone');
      return finish({
        bannerFound: true,
        platform: found.platform,
        recognisedBy: found.recognisedBy,
        outcome: 'refused',
        summary: `Opened "${settings.text}", switched ${switchedOff} toggle(s) off and saved with "${save.text}"; the banner closed.`,
        bannerHiddenAfter: true,
      });
    }
    return undetermined(
      `Opened "${settings.text}", switched ${switchedOff} toggle(s) off and pressed "${save.text}", but the banner stayed.`,
      found.platform,
      found.recognisedBy,
    );
  });
}
