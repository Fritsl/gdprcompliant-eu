import {
  EvidenceSchema,
  FORM_CHECKS,
  FormInventorySchema,
  FormObservationSchema,
  FormRecordSchema,
  canonicalJson,
  sha256,
  type ConsentControl,
  type ConsentPurpose,
  type Evidence,
  type FieldCategory,
  type FormCheckId,
  type FormInventory,
  type FormObservation,
  type FormRecord,
  type Sensitivity,
  type Severity,
} from '@gc/contracts';
import type { Page } from 'playwright';
import { refTo, type EvidenceIdentity } from '../evidence.js';
import type { BrowserPool, ScanTarget } from '../pool.js';

// The form inventory (S-11). Read-only by construction: the page is loaded, its forms
// are read, and every request that is not a GET is refused at the browser before it
// leaves. The classifiers are pure and exported, so the rules are testable without a
// browser; the browser part only gathers what the page says.

// ---- classification -----------------------------------------------------------

const HEALTH =
  /symptom|diagnos|sygdom|helbred|health|medic|krank|gesundheit|allergi|blodtype|handicap|disabilit|graviditet|pregnan|schwanger/i;
const BELIEF =
  /religion|tro(?:sretning|ssamfund)|fagforening|union member|gewerkschaft|seksuel|sexual|etnisk|ethnic|politisk|political/i;
const FINANCIAL =
  /kort ?nummer|card ?number|kreditkort|credit ?card|kartennummer|iban|konto ?nummer|account ?number|cvc|cvv|udløb|expiry|bank/i;
const IDENTITY =
  /\bcpr\b|personnummer|national ?id|\bssn\b|social security|ausweis|passport|pas ?nummer|kørekort|driver'?s? licen|geburtsdatum|fødselsdato|date of birth|\bdob\b/i;
const CONTACT =
  /e-?mail|telefon|phone|mobil|navn|name|adresse|address|postnummer|zip|postal|\bby\b|city|ort|land\b|country|firma|company/i;

function text(field: { name: string; label?: string; placeholder?: string; id?: string }): string {
  return [field.name, field.id ?? '', field.label ?? '', field.placeholder ?? ''].join(' ');
}

export function classifyField(field: {
  name: string;
  type: string;
  id?: string;
  label?: string;
  autocomplete?: string;
  placeholder?: string;
}): FieldCategory {
  const t = text(field);
  const ac = (field.autocomplete ?? '').toLowerCase();
  if (field.type === 'password') return 'credentials';
  if (HEALTH.test(t)) return 'health';
  if (BELIEF.test(t)) return 'belief';
  if (ac.startsWith('cc-') || FINANCIAL.test(t)) return 'financial';
  if (IDENTITY.test(t)) return 'identity';
  if (
    field.type === 'email' ||
    field.type === 'tel' ||
    /^(email|tel|name|given-name|family-name|street-address|postal-code|address-)/.test(ac) ||
    CONTACT.test(t)
  ) {
    return 'contact';
  }
  if (field.type === 'textarea') return 'free_text';
  return 'other';
}

const SENSITIVITY_OF: Record<FieldCategory, Sensitivity> = {
  health: 'special',
  belief: 'special',
  financial: 'financial',
  identity: 'identity',
  credentials: 'contact',
  contact: 'contact',
  free_text: 'none',
  other: 'none',
};
const RANK: Record<Sensitivity, number> = {
  special: 4,
  financial: 3,
  identity: 2,
  contact: 1,
  none: 0,
};

export function formSensitivity(fields: readonly { category: FieldCategory }[]): Sensitivity {
  let top: Sensitivity = 'none';
  for (const f of fields) {
    const s = SENSITIVITY_OF[f.category];
    if (RANK[s] > RANK[top]) top = s;
  }
  return top;
}

// Does a form collect personal data at all? Free text on its own does not count.
export const collectsPersonalData = (fields: readonly { category: FieldCategory }[]): boolean =>
  fields.some((f) => f.category !== 'other' && f.category !== 'free_text');

const MARKETING =
  /nyhedsbrev|newsletter|tilbud|marketing|markedsføring|werbung|angebote|reklame|kampagne|updates|nyheder|news\b|sms|profil|tilpas|personalis|promotion/i;
const TERMS =
  /vilkår|betingelser|terms|\bagb\b|bedingungen|conditions|handelsbetingelser|accepterer|akzeptiere|agree/i;
const PRIVACY =
  /privatliv|persondata|personoplysninger|privacy|datenschutz|behandl\w* (?:af )?(?:dine|mine|personlige)|data protection/i;

export function consentPurposes(label: string, name = ''): ConsentPurpose[] {
  const t = `${label} ${name}`;
  const out: ConsentPurpose[] = [];
  if (MARKETING.test(t)) out.push('marketing');
  if (TERMS.test(t)) out.push('terms');
  if (PRIVACY.test(t)) out.push('privacy');
  if (out.length === 0) out.push('other');
  return out;
}

// A link or a sentence, in or right beside the form, that says how the data is used.
const NOTICE_TEXT =
  /privatliv|persondata|personoplysninger|privacy|datenschutz|behandler (?:vi )?dine oplysninger|how we (?:use|handle) your|verarbeiten wir/i;
const NOTICE_HREF = /privat|privacy|datenschutz|persondata|gdpr/i;

export function noticeIn(links: readonly { href: string; text: string }[], nearbyText: string) {
  const link = links.find((l) => NOTICE_HREF.test(l.href) || NOTICE_TEXT.test(l.text));
  if (link) return { found: true as const, via: 'link' as const, text: link.text.trim() };
  const m = NOTICE_TEXT.exec(nearbyText);
  if (m) {
    const at = Math.max(0, m.index - 60);
    return {
      found: true as const,
      via: 'text' as const,
      text: nearbyText.slice(at, m.index + 100).trim(),
    };
  }
  return { found: false as const };
}

// ---- the checks, over records ---------------------------------------------------

const worse = (a: Severity, b: Severity): Severity => {
  const order: Severity[] = ['advisory', 'serious', 'blocking'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
};
const severityFor = (s: Sensitivity, base: Severity): Severity =>
  s === 'special' || s === 'financial' ? worse(base, 'blocking') : base;

const isConsent = (c: ConsentControl) =>
  c.purposes.some((p) => p === 'marketing' || p === 'privacy');
const preticked = (c: ConsentControl) =>
  isConsent(c) && (c.checkedInMarkup || c.checkedAfterScripts);
const bundled = (c: ConsentControl) =>
  c.purposes.includes('marketing') && (c.purposes.includes('terms') || c.required);

function control(form: FormRecord, c: ConsentControl) {
  return {
    page: form.page,
    form: form.index,
    id: c.id,
    name: c.name,
    label: c.label,
    kind: c.kind,
    hidden: c.hidden,
    required: c.required,
    setBy: c.checkedInMarkup ? 'markup' : 'script',
  };
}

export function evaluateForms(forms: readonly FormRecord[]): FormObservation[] {
  const out: FormObservation[] = [];
  const observe = (
    check: FormCheckId,
    outcome: FormObservation['outcome'],
    severity: Severity,
    summary: string,
    detail: Record<string, unknown>,
    refs: FormRecord[],
  ) =>
    out.push(
      FormObservationSchema.parse({
        check,
        findingTypeId: FORM_CHECKS[check],
        outcome,
        severity,
        summary,
        detail,
        evidence: refs.map((f) => f.evidence),
      }),
    );

  const ticked = forms.flatMap((f) => f.controls.filter(preticked).map((c) => [f, c] as const));
  if (ticked.length > 0) {
    const hiddenCount = ticked.filter(([, c]) => c.hidden || c.kind === 'hidden_input').length;
    const scripted = ticked.filter(([, c]) => !c.checkedInMarkup).length;
    const sev = ticked.reduce<Severity>(
      (s, [f]) => worse(s, severityFor(f.sensitivity, 'serious')),
      'serious',
    );
    observe(
      'preticked',
      'fail',
      sev,
      `${ticked.length} consent box(es) are ticked before the visitor touches them` +
        (hiddenCount ? `, ${hiddenCount} of them hidden from view` : '') +
        (scripted ? `, ${scripted} ticked by script after the page loaded` : '') +
        `: ${ticked.map(([f, c]) => `${f.page} "${c.label}"`).join('; ')}.`,
      { controls: ticked.map(([f, c]) => control(f, c)) },
      [...new Set(ticked.map(([f]) => f))],
    );
  } else {
    observe('preticked', 'pass', 'advisory', 'No consent box is ticked in advance.', {}, []);
  }

  const bundles = forms.flatMap((f) => f.controls.filter(bundled).map((c) => [f, c] as const));
  if (bundles.length > 0) {
    observe(
      'bundled',
      'fail',
      'advisory',
      `${bundles.length} checkbox(es) tie marketing to something the visitor cannot refuse: ${bundles
        .map(([f, c]) => `${f.page} "${c.label}"`)
        .join('; ')}.`,
      { controls: bundles.map(([f, c]) => control(f, c)) },
      [...new Set(bundles.map(([f]) => f))],
    );
  } else {
    observe(
      'bundled',
      'pass',
      'advisory',
      'Marketing consent is never bundled with terms.',
      {},
      [],
    );
  }

  const silent = forms.filter((f) => collectsPersonalData(f.fields) && !f.notice.found);
  if (silent.length > 0) {
    const sev = silent.reduce<Severity>(
      (s, f) => worse(s, severityFor(f.sensitivity, 'serious')),
      'serious',
    );
    observe(
      'no_notice',
      'fail',
      sev,
      `${silent.length} form(s) collect personal data with no notice at the point of collection: ${silent
        .map(
          (f) =>
            `${f.page} (${f.sensitivity === 'none' ? 'personal data' : f.sensitivity}: ${f.fields.map((x) => x.name).join(', ')})`,
        )
        .join('; ')}.`,
      {
        forms: silent.map((f) => ({
          page: f.page,
          form: f.index,
          action: f.action,
          fields: f.fields.map((x) => x.name),
          categories: [...new Set(f.fields.map((x) => x.category))],
          sensitivity: f.sensitivity,
        })),
      },
      silent,
    );
  } else {
    const collecting = forms.filter((f) => collectsPersonalData(f.fields)).length;
    observe(
      'no_notice',
      'pass',
      'advisory',
      collecting === 0
        ? 'No form collects personal data.'
        : `Every form that collects personal data has a notice beside it.`,
      {},
      [],
    );
  }
  return out;
}

// ---- the browser part -------------------------------------------------------------

export interface FormInventoryOptions {
  readonly identity: EvidenceIdentity;
  // Pages beyond the landing page: same host, linked from it, and likely to hold a form.
  readonly maxPages?: number;
}

export const FORM_PAGE_HINT =
  /kontakt|contact|tilmeld|signup|sign-up|register|registr|login|log-ind|checkout|kasse|kassen|nyhedsbrev|newsletter|konto|account|book|support|anmod|apply|ansøg|bestil|order|quote|tilbud|intake|patient|indskriv|opret|subscribe|abonner|reserv|booking|appointment/i;

interface RawForm {
  action: string;
  method: string;
  submitLabel?: string;
  fields: {
    name: string;
    type: string;
    id?: string;
    label?: string;
    autocomplete?: string;
    placeholder?: string;
    required: boolean;
  }[];
  controls: Omit<ConsentControl, 'purposes'>[];
  links: { href: string; text: string }[];
  nearbyText: string;
}

// Runs in the page. Reads everything; changes nothing.
const INVENTORY_SCRIPT = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 300);
  const labelOf = (el) => {
    const parts = [];
    if (el.id) for (const l of document.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]')) parts.push(l.textContent);
    const wrap = el.closest('label');
    if (wrap) parts.push(wrap.textContent);
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    const by = el.getAttribute('aria-labelledby');
    if (by) for (const id of by.split(/\\s+/)) { const n = document.getElementById(id); if (n) parts.push(n.textContent); }
    return clean(parts.join(' '));
  };
  const hidden = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return true;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return true;
    if (r.right < 0 || r.bottom < 0) return true;
    return false;
  };
  return Array.from(document.forms).map((f) => {
    const fields = [];
    const controls = [];
    for (const el of Array.from(f.elements)) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'button' || tag === 'fieldset' || tag === 'output') continue;
      const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') continue;
      const name = el.getAttribute('name') || el.id || '';
      if (type === 'checkbox') {
        controls.push({
          id: el.id || undefined, name, kind: 'checkbox', label: labelOf(el),
          checkedInMarkup: el.hasAttribute('checked'), checkedAfterScripts: !!el.checked,
          hidden: hidden(el), required: el.required,
        });
        continue;
      }
      if (type === 'hidden') {
        if (name && /^(1|true|yes|on|ja)$/i.test(el.value || '')) {
          controls.push({ id: el.id || undefined, name, kind: 'hidden_input', label: name,
            checkedInMarkup: true, checkedAfterScripts: true, hidden: true, required: false });
        }
        continue;
      }
      if (!name && !el.id) continue;
      fields.push({
        name, type, id: el.id || undefined, label: labelOf(el) || undefined,
        autocomplete: el.getAttribute('autocomplete') || undefined,
        placeholder: el.getAttribute('placeholder') || undefined, required: !!el.required,
      });
    }
    let scope = f;
    for (let i = 0; i < 2 && scope.parentElement && scope.parentElement !== document.body; i += 1) scope = scope.parentElement;
    const links = Array.from(scope.querySelectorAll('a[href]')).map((a) => ({ href: a.getAttribute('href') || '', text: clean(a.textContent) }));
    const submit = f.querySelector('button[type=submit], input[type=submit], button:not([type])');
    return {
      action: f.getAttribute('action') || location.href,
      method: (f.getAttribute('method') || 'get').toLowerCase(),
      submitLabel: submit ? clean(submit.textContent || submit.value) || undefined : undefined,
      fields, controls, links, nearbyText: clean(scope.innerText).slice(0, 2000),
    };
  });
})()`;

const LINKS_SCRIPT = `Array.from(document.querySelectorAll('a[href]')).map((a) => a.href)`;

function formEvidence(
  identity: EvidenceIdentity,
  pageUrl: string,
  index: number,
  raw: RawForm,
): Evidence {
  const body = canonicalJson({ page: pageUrl, index, ...raw });
  const hash = sha256(body);
  return EvidenceSchema.parse({
    id: `text:${hash.slice(0, 16)}`,
    tenantId: identity.tenantId,
    caseId: identity.caseId,
    ...(identity.scanId !== undefined ? { scanId: identity.scanId } : {}),
    kind: 'text',
    capturedAt: identity.capturedAt,
    source: { url: pageUrl, host: new URL(pageUrl).hostname },
    body,
    hash,
    caption: `${new URL(pageUrl).pathname} · form ${index + 1}: ${raw.fields.map((f) => f.name).join(', ') || 'no fields'}`,
  });
}

function toRecord(
  identity: EvidenceIdentity,
  pageUrl: string,
  index: number,
  raw: RawForm,
  ev: Evidence,
): FormRecord {
  const fields = raw.fields.map((f) => ({ ...f, category: classifyField(f) }));
  return FormRecordSchema.parse({
    page: new URL(pageUrl).pathname,
    index,
    action: new URL(raw.action, pageUrl).toString(),
    method: raw.method === 'post' || raw.method === 'dialog' ? raw.method : 'get',
    ...(raw.submitLabel ? { submitLabel: raw.submitLabel } : {}),
    fields,
    controls: raw.controls.map((c) => ({ ...c, purposes: consentPurposes(c.label, c.name) })),
    sensitivity: formSensitivity(fields),
    notice: noticeIn(raw.links, raw.nearbyText),
    evidence: refTo(ev),
  });
}

// Refuses, at the browser, anything that is not a GET: the inventory cannot submit.
export async function readOnly(page: Page): Promise<void> {
  await page.route('**/*', (route) =>
    route.request().method() === 'GET' ? route.continue() : route.abort('blockedbyclient'),
  );
}

export async function inventoryForms(
  pool: BrowserPool,
  target: ScanTarget,
  options: FormInventoryOptions,
): Promise<{ inventory: FormInventory; evidence: Evidence[] }> {
  const { identity } = options;
  const maxPages = options.maxPages ?? 6;
  const home = new URL(target.url);

  return pool.run(target, async (page) => {
    await readOnly(page);
    const evidence: Evidence[] = [];
    const forms: FormRecord[] = [];
    const pages: string[] = [];

    const visit = async (url: string) => {
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForTimeout(250);
      pages.push(new URL(page.url()).pathname);
      const raws = (await page.evaluate(INVENTORY_SCRIPT)) as RawForm[];
      raws.forEach((raw, index) => {
        const ev = formEvidence(identity, page.url(), index, raw);
        evidence.push(ev);
        forms.push(toRecord(identity, page.url(), index, raw, ev));
      });
    };

    await visit(home.toString());
    const links = (await page.evaluate(LINKS_SCRIPT)) as string[];
    const candidates = [...new Set(links)]
      .map((l) => {
        try {
          const u = new URL(l);
          u.hash = '';
          return u;
        } catch {
          return undefined;
        }
      })
      .filter(
        (u): u is URL =>
          u !== undefined && u.hostname === home.hostname && FORM_PAGE_HINT.test(u.pathname),
      )
      .map((u) => u.toString())
      .filter((u) => u !== home.toString());
    for (const url of candidates.slice(0, Math.max(0, maxPages - 1))) {
      try {
        await visit(url);
      } catch {
        // A page that will not load has no forms to report.
      }
    }

    const inventory = FormInventorySchema.parse({
      site: home.hostname,
      startedAt: identity.capturedAt,
      pages,
      forms,
      observations: evaluateForms(forms),
      submitted: false,
    });
    return { inventory, evidence };
  });
}
