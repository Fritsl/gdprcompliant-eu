import {
  EvidenceSchema,
  REPLAY_CHECKS,
  ReplayObservationSchema,
  ReplayPageSchema,
  ReplayReportSchema,
  canonicalJson,
  sha256,
  type Evidence,
  type FieldCategory,
  type FingerprintProbe,
  type MaskingState,
  type ReplayCheckId,
  type ReplayObservation,
  type ReplayPage,
  type ReplayReport,
  type ReplayTool,
  type Severity,
} from '@gc/contracts';
import { refTo, type EvidenceIdentity } from '../evidence.js';
import { watchNetwork, type QuietOptions } from '../passes/network-quiet.js';
import type { BrowserPool, ScanTarget } from '../pool.js';
import { classifyField, formSensitivity } from './forms.js';

// Session replay and fingerprinting (S-13). A tool is recognised two ways: the hosts
// the page talks to, and the globals the tool leaves on window. Whether it masks input
// is reported only from what the page shows: the vendor's own per-element markers on
// the sensitive fields. Fingerprinting is not inferred from a host list at all; the
// probes are counted as they run, by hooking the APIs before any page script loads.

// ---- who records ------------------------------------------------------------------

export interface ReplayVendor {
  readonly id: string;
  readonly name: string;
  readonly hosts: readonly RegExp[];
  readonly globals: readonly string[];
  // The attribute names and class names the vendor documents for masking an element.
  readonly maskAttributes: readonly string[];
  readonly maskClasses: readonly string[];
}

export const REPLAY_VENDORS: readonly ReplayVendor[] = [
  {
    id: 'hotjar',
    name: 'Hotjar',
    hosts: [/(^|\.)hotjar\.(com|io)$/],
    globals: ['hj', '_hjSettings'],
    maskAttributes: ['data-hj-suppress'],
    maskClasses: [],
  },
  {
    id: 'fullstory',
    name: 'FullStory',
    hosts: [/(^|\.)fullstory\.com$/],
    globals: ['FS', '_fs_org'],
    maskAttributes: [],
    maskClasses: ['fs-exclude', 'fs-mask'],
  },
  {
    id: 'mouseflow',
    name: 'Mouseflow',
    hosts: [/(^|\.)mouseflow\.com$/],
    globals: ['_mfq', 'mouseflow'],
    maskAttributes: [],
    maskClasses: ['mouseflow-hide', 'mf-exclude'],
  },
  {
    id: 'smartlook',
    name: 'Smartlook',
    hosts: [/(^|\.)smartlook\.(com|cloud)$/],
    globals: ['smartlook'],
    maskAttributes: ['data-recording-disable'],
    maskClasses: ['smartlook-hide'],
  },
  {
    id: 'clarity',
    name: 'Microsoft Clarity',
    hosts: [/(^|\.)clarity\.ms$/],
    globals: ['clarity'],
    maskAttributes: ['data-clarity-mask'],
    maskClasses: [],
  },
  {
    id: 'logrocket',
    name: 'LogRocket',
    hosts: [/(^|\.)logrocket\.(io|com)$/, /(^|\.)lr-ingest\.(io|com)$/, /(^|\.)lr-in\.com$/],
    globals: ['LogRocket'],
    maskAttributes: ['data-private'],
    maskClasses: [],
  },
  {
    id: 'contentsquare',
    name: 'Contentsquare',
    hosts: [/(^|\.)contentsquare\.(net|com)$/],
    globals: ['_uxa', 'CS_CONF'],
    maskAttributes: ['data-cs-mask'],
    maskClasses: [],
  },
  {
    id: 'luckyorange',
    name: 'Lucky Orange',
    hosts: [/(^|\.)luckyorange\.(com|net)$/],
    globals: ['__lo_site_id', 'LOQ'],
    maskAttributes: [],
    maskClasses: ['lo-sensitive'],
  },
  {
    id: 'inspectlet',
    name: 'Inspectlet',
    hosts: [/(^|\.)inspectlet\.com$/],
    globals: ['__insp'],
    maskAttributes: [],
    maskClasses: ['inspectlet-sensitive'],
  },
  {
    id: 'posthog',
    name: 'PostHog',
    hosts: [/(^|\.)posthog\.com$/],
    globals: ['posthog'],
    maskAttributes: [],
    maskClasses: ['ph-no-capture', 'ph-mask'],
  },
  {
    id: 'datadog',
    name: 'Datadog RUM',
    hosts: [/(^|\.)browser-intake-datadoghq\.(com|eu)$/, /(^|\.)datadoghq\.(com|eu)$/],
    globals: ['DD_RUM'],
    maskAttributes: ['data-dd-privacy'],
    maskClasses: ['dd-privacy-mask', 'dd-privacy-hidden'],
  },
  {
    id: 'yandex',
    name: 'Yandex Metrica (Webvisor)',
    hosts: [/(^|\.)mc\.yandex\.(ru|com)$/],
    globals: ['ym'],
    maskAttributes: [],
    maskClasses: ['ym-hide-content', 'ym-disable-keys'],
  },
];

export interface PageSignals {
  readonly hosts: readonly string[];
  readonly globals: readonly string[];
}

// Which vendors the hosts and globals point at, and how each was seen.
export function recogniseTools(
  signals: PageSignals,
  vendors: readonly ReplayVendor[] = REPLAY_VENDORS,
): Omit<ReplayTool, 'masking' | 'maskingDetail'>[] {
  const out: Omit<ReplayTool, 'masking' | 'maskingDetail'>[] = [];
  for (const v of vendors) {
    const hosts = signals.hosts.filter((h) => v.hosts.some((re) => re.test(h)));
    const globals = v.globals.filter((g) => signals.globals.includes(g));
    if (hosts.length === 0 && globals.length === 0) continue;
    out.push({
      id: v.id,
      name: v.name,
      signals: [
        ...(hosts.length ? ['network' as const] : []),
        ...(globals.length ? ['api' as const] : []),
      ],
      hosts: [...new Set(hosts)].sort(),
      globals,
    });
  }
  return out;
}

export interface MaskedField {
  readonly name: string;
  readonly category: FieldCategory;
  // Attribute names and class names on the field or any ancestor.
  readonly markers: readonly string[];
}

const SENSITIVE: readonly FieldCategory[] = [
  'financial',
  'identity',
  'health',
  'belief',
  'credentials',
];
export const isSensitiveField = (f: { category: FieldCategory }): boolean =>
  SENSITIVE.includes(f.category);

// What the page shows about masking for one vendor. 'on' when every sensitive field
// carries one of the vendor's markers; never 'off', because a global setting is not
// visible from the page; 'unknown' otherwise, saying what was looked for.
export function maskingFor(
  vendor: ReplayVendor,
  fields: readonly MaskedField[],
): { masking: MaskingState; maskingDetail: string } {
  const sensitive = fields.filter(isSensitiveField);
  const markers = [...new Set([...vendor.maskAttributes, ...vendor.maskClasses])];
  if (sensitive.length === 0) {
    return { masking: 'unknown', maskingDetail: 'no sensitive field on the page to look at' };
  }
  if (markers.length === 0) {
    return {
      masking: 'unknown',
      maskingDetail: `${vendor.name} has no per-element masking marker to look for`,
    };
  }
  const unmarked = sensitive.filter((f) => !f.markers.some((m) => markers.includes(m)));
  if (unmarked.length === 0) {
    return {
      masking: 'on',
      maskingDetail: `every sensitive field carries ${markers.join(' or ')}`,
    };
  }
  return {
    masking: 'unknown',
    maskingDetail: `${unmarked.map((f) => f.name).join(', ')} carry none of ${markers.join(', ')}; a site-wide masking setting is not visible from the page`,
  };
}

// ---- the probes -------------------------------------------------------------------

// Installed before any page script. Counts reads of the canvas, text measurements
// across font families, and offline audio rendering, with the script URLs on the stack.
export const PROBE_HOOKS = `(() => {
  const P = {
    canvas: { calls: 0, scripts: new Set(), text: new Set() },
    font: { calls: 0, scripts: new Set(), fonts: new Set() },
    audio: { calls: 0, scripts: new Set(), nodes: new Set() },
  };
  const who = () => {
    const out = [];
    for (const line of (new Error().stack || '').split('\\n')) {
      const m = /(https?:\\/\\/[^\\s)]+?)(?::\\d+){1,2}\\)?$/.exec(line.trim());
      if (m && m[1] !== location.href) out.push(m[1]);
    }
    return out;
  };
  const hook = (proto, method, bucket, note) => {
    if (!proto || typeof proto[method] !== 'function') return;
    const original = proto[method];
    Object.defineProperty(proto, method, {
      configurable: true,
      writable: true,
      value: function (...args) {
        try {
          P[bucket].calls += 1;
          for (const u of who()) P[bucket].scripts.add(u);
          if (note) note(this, args);
        } catch {}
        return original.apply(this, args);
      },
    });
  };
  const drawn = (ctx, args) => { if (typeof args[0] === 'string') P.canvas.text.add(String(args[0]).slice(0, 40)); };
  const fillText = CanvasRenderingContext2D.prototype.fillText;
  Object.defineProperty(CanvasRenderingContext2D.prototype, 'fillText', {
    configurable: true, writable: true,
    value: function (...args) { try { drawn(this, args); } catch {} return fillText.apply(this, args); },
  });
  hook(HTMLCanvasElement.prototype, 'toDataURL', 'canvas');
  hook(HTMLCanvasElement.prototype, 'toBlob', 'canvas');
  hook(CanvasRenderingContext2D.prototype, 'getImageData', 'canvas');
  hook(CanvasRenderingContext2D.prototype, 'measureText', 'font', (ctx) => P.font.fonts.add(ctx.font));
  if (window.OfflineAudioContext) hook(OfflineAudioContext.prototype, 'startRendering', 'audio', () => P.audio.nodes.add('OfflineAudioContext'));
  if (window.BaseAudioContext) {
    hook(BaseAudioContext.prototype, 'createOscillator', 'audio', () => P.audio.nodes.add('OscillatorNode'));
    hook(BaseAudioContext.prototype, 'createDynamicsCompressor', 'audio', () => P.audio.nodes.add('DynamicsCompressorNode'));
  }
  if (window.AudioBuffer) hook(AudioBuffer.prototype, 'getChannelData', 'audio', () => P.audio.nodes.add('AudioBuffer.getChannelData'));
  Object.defineProperty(window, '__gcProbes', {
    enumerable: false,
    value: () => ({
      canvas: { calls: P.canvas.calls, scripts: [...P.canvas.scripts], text: [...P.canvas.text] },
      font: { calls: P.font.calls, scripts: [...P.font.scripts], fonts: [...P.font.fonts] },
      audio: { calls: P.audio.calls, scripts: [...P.audio.scripts], nodes: [...P.audio.nodes] },
    }),
  });
})()`;

// Which globals from the vendor list are present, and the page's fields with any
// masking markers on them or their ancestors.
const PAGE_SCRIPT = `((globals, markers) => {
  const present = globals.filter((g) => { try { return typeof window[g] !== 'undefined'; } catch { return false; } });
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
  const labelOf = (el) => {
    const parts = [];
    if (el.id) for (const l of document.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]')) parts.push(l.textContent);
    const wrap = el.closest('label');
    if (wrap) parts.push(wrap.textContent);
    return clean(parts.join(' '));
  };
  const fields = [];
  for (const el of document.querySelectorAll('input, textarea, select')) {
    const type = el.tagName.toLowerCase() === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : el.tagName.toLowerCase();
    if (['submit', 'button', 'reset', 'image', 'hidden', 'checkbox', 'radio'].includes(type)) continue;
    const name = el.getAttribute('name') || el.id || '';
    if (!name) continue;
    const found = new Set();
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      for (const m of markers) {
        if (n.hasAttribute && n.hasAttribute(m)) found.add(m);
        if (n.classList && n.classList.contains(m)) found.add(m);
      }
    }
    fields.push({ name, type, id: el.id || undefined, label: labelOf(el) || undefined,
      autocomplete: el.getAttribute('autocomplete') || undefined, placeholder: el.getAttribute('placeholder') || undefined,
      markers: [...found] });
  }
  return { globals: present, fields };
})`;

interface RawProbes {
  canvas: { calls: number; scripts: string[]; text: string[] };
  font: { calls: number; scripts: string[]; fonts: string[] };
  audio: { calls: number; scripts: string[]; nodes: string[] };
}
interface RawPage {
  globals: string[];
  fields: {
    name: string;
    type: string;
    id?: string;
    label?: string;
    autocomplete?: string;
    placeholder?: string;
    markers: string[];
  }[];
}

// Thresholds: one read of the canvas on load is a probe; so is measuring text in ten
// font families, or rendering audio nobody asked for.
export const FONT_PROBE_MIN_FAMILIES = 10;

export function probesFrom(raw: RawProbes): FingerprintProbe[] {
  const fonts = new Set(
    raw.font.fonts.map((f) => f.replace(/^[^"']*?(?:\d+px|\d+pt|\d+em)\s*/i, '')),
  );
  return [
    {
      kind: 'canvas',
      calls: raw.canvas.calls,
      scripts: raw.canvas.scripts,
      detail: { text: raw.canvas.text },
    },
    {
      kind: 'font',
      calls: fonts.size >= FONT_PROBE_MIN_FAMILIES ? raw.font.calls : 0,
      scripts: raw.font.scripts,
      detail: { families: fonts.size, measurements: raw.font.calls },
    },
    {
      kind: 'audio',
      calls: raw.audio.calls,
      scripts: raw.audio.scripts,
      detail: { nodes: raw.audio.nodes },
    },
  ];
}

// ---- the checks, over pages -------------------------------------------------------

const worse = (a: Severity, b: Severity): Severity => {
  const order: Severity[] = ['advisory', 'serious', 'blocking'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
};

export function evaluateReplay(pages: readonly ReplayPage[]): ReplayObservation[] {
  const out: ReplayObservation[] = [];
  const observe = (
    check: ReplayCheckId,
    outcome: ReplayObservation['outcome'],
    severity: Severity,
    summary: string,
    detail: Record<string, unknown>,
    refs: ReplayPage[],
  ) =>
    out.push(
      ReplayObservationSchema.parse({
        check,
        findingTypeId: REPLAY_CHECKS[check],
        outcome,
        severity,
        summary,
        detail,
        evidence: refs.map((p) => p.evidence),
      }),
    );

  // Replay on a page with payment, account, identity or health fields, unless every
  // such field is observably masked.
  const exposed = pages.flatMap((p) =>
    p.sensitiveFields.length === 0
      ? []
      : p.tools.filter((t) => t.masking !== 'on').map((t) => [p, t] as const),
  );
  if (exposed.length > 0) {
    const sev = exposed.reduce<Severity>(
      (s, [p]) =>
        worse(
          s,
          p.sensitivity === 'special' || p.sensitivity === 'financial' ? 'blocking' : 'serious',
        ),
      'serious',
    );
    observe(
      'replay_on_sensitive',
      'fail',
      sev,
      `Session replay is active on ${[...new Set(exposed.map(([p]) => p.page))].join(', ')}, where visitors type ${[
        ...new Set(exposed.flatMap(([p]) => p.sensitiveFields)),
      ].join(
        ', ',
      )}: ${exposed.map(([p, t]) => `${t.name} on ${p.page} (masking ${t.masking}: ${t.maskingDetail})`).join('; ')}.`,
      {
        pages: exposed.map(([p, t]) => ({
          page: p.page,
          tool: t.name,
          toolId: t.id,
          hosts: t.hosts,
          signals: t.signals,
          fields: p.sensitiveFields,
          sensitivity: p.sensitivity,
          masking: t.masking,
          maskingDetail: t.maskingDetail,
        })),
      },
      [...new Set(exposed.map(([p]) => p))],
    );
  } else {
    const tools = [...new Set(pages.flatMap((p) => p.tools.map((t) => t.name)))];
    observe(
      'replay_on_sensitive',
      'pass',
      'advisory',
      tools.length === 0
        ? 'No session replay or heatmap tool was seen.'
        : `${tools.join(', ')} seen, but not on a page with payment, account or health fields.`,
      { tools },
      [],
    );
  }

  for (const kind of ['canvas', 'font', 'audio'] as const) {
    const hits = pages.flatMap((p) =>
      p.probes.filter((x) => x.kind === kind && x.calls > 0).map((x) => [p, x] as const),
    );
    const what = {
      canvas: 'reads the canvas back',
      font: 'measures text across many font families',
      audio: 'renders audio nobody hears',
    }[kind];
    if (hits.length > 0) {
      const scripts = [...new Set(hits.flatMap(([, x]) => x.scripts))];
      observe(
        kind,
        'fail',
        'serious',
        `A script ${what} on ${[...new Set(hits.map(([p]) => p.page))].join(', ')}: ${scripts.join(', ') || 'inline script'}.`,
        { scripts, pages: hits.map(([p, x]) => ({ page: p.page, calls: x.calls, ...x.detail })) },
        [...new Set(hits.map(([p]) => p))],
      );
    } else {
      observe(kind, 'pass', 'advisory', `No script ${what}.`, {}, []);
    }
  }
  return out;
}

// ---- the browser part -------------------------------------------------------------

export interface ReplayOptions {
  readonly identity: EvidenceIdentity;
  // Paths beyond the landing page to look at; the form inventory's pages, typically.
  readonly paths?: readonly string[];
  readonly quiet?: Partial<QuietOptions>;
  readonly vendors?: readonly ReplayVendor[];
}

const DETECT_QUIET: QuietOptions = { minDwellMs: 1_500, quietMs: 1_000, maxWaitMs: 8_000 };

function pageEvidence(
  identity: EvidenceIdentity,
  url: string,
  record: Omit<ReplayPage, 'evidence'>,
): Evidence {
  const body = canonicalJson(record);
  const hash = sha256(body);
  return EvidenceSchema.parse({
    id: `text:${hash.slice(0, 16)}`,
    tenantId: identity.tenantId,
    caseId: identity.caseId,
    ...(identity.scanId !== undefined ? { scanId: identity.scanId } : {}),
    kind: 'text',
    capturedAt: identity.capturedAt,
    source: { url, host: new URL(url).hostname },
    body,
    hash,
    caption: `${record.page} · ${record.tools.map((t) => t.name).join(', ') || 'no replay tool'}; probes: ${
      record.probes
        .filter((p) => p.calls > 0)
        .map((p) => p.kind)
        .join(', ') || 'none'
    }`,
  });
}

export async function detectReplay(
  pool: BrowserPool,
  target: ScanTarget,
  options: ReplayOptions,
): Promise<{ report: ReplayReport; evidence: Evidence[] }> {
  const { identity } = options;
  const vendors = options.vendors ?? REPLAY_VENDORS;
  const quiet = { ...DETECT_QUIET, ...options.quiet };
  const home = new URL(target.url);
  const globals = [...new Set(vendors.flatMap((v) => v.globals))];
  const markers = [...new Set(vendors.flatMap((v) => [...v.maskAttributes, ...v.maskClasses]))];
  const urls = [home.toString(), ...(options.paths ?? []).map((p) => new URL(p, home).toString())];

  const pages: ReplayPage[] = [];
  const evidence: Evidence[] = [];
  for (const url of [...new Set(urls)]) {
    const page = await pool.run(target, async (pw, context) => {
      await context.addInitScript(PROBE_HOOKS);
      const hosts = new Set<string>();
      context.on('request', (r) => {
        try {
          hosts.add(new URL(r.url()).hostname);
        } catch {
          // not a URL we can name
        }
      });
      const watch = watchNetwork(context, Date.now(), quiet);
      await pw.goto(url, { waitUntil: 'load' });
      await watch.settle();
      const raw = (await pw.evaluate(
        PAGE_SCRIPT + `(${JSON.stringify(globals)}, ${JSON.stringify(markers)})`,
      )) as RawPage;
      const probes = (await pw.evaluate(
        'window.__gcProbes ? window.__gcProbes() : null',
      )) as RawProbes | null;
      const fields: MaskedField[] = raw.fields.map((f) => ({
        name: f.name,
        category: classifyField(f),
        markers: f.markers,
      }));
      const tools: ReplayTool[] = recogniseTools(
        { hosts: [...hosts], globals: raw.globals },
        vendors,
      ).map((t) => ({
        ...t,
        ...maskingFor(
          vendors.find((v) => v.id === t.id)!,
          fields,
        ),
      }));
      const record: Omit<ReplayPage, 'evidence'> = {
        page: new URL(pw.url()).pathname,
        sensitivity: formSensitivity(fields),
        sensitiveFields: fields.filter(isSensitiveField).map((f) => f.name),
        tools,
        probes: probes
          ? probesFrom(probes)
          : [
              { kind: 'canvas', calls: 0, scripts: [], detail: {} },
              { kind: 'font', calls: 0, scripts: [], detail: {} },
              { kind: 'audio', calls: 0, scripts: [], detail: {} },
            ],
      };
      const ev = pageEvidence(identity, pw.url(), record);
      evidence.push(ev);
      return ReplayPageSchema.parse({ ...record, evidence: refTo(ev) });
    });
    pages.push(page);
  }

  const report = ReplayReportSchema.parse({
    site: home.hostname,
    startedAt: identity.capturedAt,
    pages,
    observations: evaluateReplay(pages),
  });
  return { report, evidence };
}
