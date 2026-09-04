import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserServer,
  type BrowserType,
  type LaunchOptions,
  type Page,
} from 'playwright';
import { guardContext, type Blocked, type EgressGuard } from './egress.js';

// A pool of browser passes. Every pass gets a brand-new browser context — its own
// cookies, storage, IndexedDB, cache and service workers, none of it shared with the
// pass before — because profile bleed would quietly invalidate the three-pass diff.
// The pool holds a concurrency limit, a per-navigation timeout, a hard deadline on the
// whole pass, and a kill switch for a browser that stops answering.
//
// The browser runs as a server the pool connects to, so that a hang can be answered
// with a real kill of the process rather than a polite close that never returns.

export interface ScanTarget {
  readonly url: string;
  // What the visitor looks like to the site: BCP 47 locale, IANA time zone, a viewport.
  readonly locale?: string;
  readonly timezone?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly userAgent?: string;
}

// A Danish visitor on an ordinary laptop, unless the scan target says otherwise.
export const DEFAULT_VISITOR = {
  locale: 'da-DK',
  timezone: 'Europe/Copenhagen',
  viewport: { width: 1440, height: 900 },
} as const;

export interface PoolOptions {
  readonly concurrency: number;
  // The whole pass, from context creation to the last byte: a hard deadline.
  readonly passTimeoutMs: number;
  // Each navigation or action inside the pass.
  readonly navigationTimeoutMs: number;
  // How long closing a context may take before the browser is considered hung and killed.
  readonly closeTimeoutMs?: number;
  readonly launch?: LaunchOptions;
  readonly browserType?: BrowserType;
  // For the fixture estate, whose TLS certificate is self-signed. Never in production.
  readonly ignoreHTTPSErrors?: boolean;
  // Refuse names that resolve to private addresses (T-06). On by default; the fixture
  // estate turns it off because its names resolve nowhere and its proxy answers them.
  readonly resolveEgress?: boolean;
  // For the pool's own tests, whose pages are served on this machine. Never in production.
  readonly allowPrivateTargets?: boolean;
}

export class PassTimeoutError extends Error {
  constructor(
    public readonly url: string,
    public readonly ms: number,
  ) {
    super(`pass on ${url} exceeded ${ms} ms and was cut off`);
    this.name = 'PassTimeoutError';
  }
}

export interface PoolStats {
  readonly inFlight: number;
  readonly peakInFlight: number;
  readonly completed: number;
  readonly failed: number;
  readonly timedOut: number;
  readonly killed: number;
  readonly contextsOpen: number;
}

export type Pass<T> = (page: Page, context: BrowserContext) => Promise<T>;

interface Running {
  readonly server: BrowserServer;
  readonly browser: Browser;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// What the egress guard refused on a context, for a pass to record.
const guardByContext = new WeakMap<BrowserContext, EgressGuard>();
export const blockedRequests = (context: BrowserContext): readonly Blocked[] =>
  guardByContext.get(context)?.blocked ?? [];

export class BrowserPool {
  private running: Running | undefined;
  private launching: Promise<Running> | undefined;
  private inFlight = 0;
  private peakInFlight = 0;
  private completed = 0;
  private failed = 0;
  private timedOut = 0;
  private killed = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly options: PoolOptions) {
    if (options.concurrency < 1) throw new Error('concurrency must be at least 1');
  }

  async start(): Promise<this> {
    await this.ensureBrowser();
    return this;
  }

  async stop(): Promise<void> {
    const running = this.running;
    this.running = undefined;
    if (!running) return;
    const closed = await Promise.race([
      running.browser
        .close()
        .then(() => running.server.close())
        .then(
          () => true,
          () => false,
        ),
      sleep(this.options.closeTimeoutMs ?? 5_000).then(() => false),
    ]);
    if (!closed) await this.kill(running);
  }

  stats(): PoolStats {
    return {
      inFlight: this.inFlight,
      peakInFlight: this.peakInFlight,
      completed: this.completed,
      failed: this.failed,
      timedOut: this.timedOut,
      killed: this.killed,
      contextsOpen: this.running?.browser.contexts().length ?? 0,
    };
  }

  // Run one pass on a fresh context. The context is closed afterwards whatever happens;
  // if closing hangs, the browser is killed and relaunched for the next pass.
  async run<T>(target: ScanTarget, pass: Pass<T>): Promise<T> {
    await this.acquire();
    let context: BrowserContext | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const { browser } = await this.ensureBrowser();
      context = await browser.newContext({
        locale: target.locale ?? DEFAULT_VISITOR.locale,
        timezoneId: target.timezone ?? DEFAULT_VISITOR.timezone,
        viewport: target.viewport ?? DEFAULT_VISITOR.viewport,
        ...(target.userAgent !== undefined ? { userAgent: target.userAgent } : {}),
        ...(this.options.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
        // A page that hands the browser a file gets nothing saved anywhere.
        acceptDownloads: false,
      });
      context.setDefaultTimeout(this.options.navigationTimeoutMs);
      context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);
      const page = await context.newPage();
      if (!this.options.allowPrivateTargets) {
        guardByContext.set(
          context,
          await guardContext(context, page, { resolve: this.options.resolveEgress ?? true }),
        );
      }
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PassTimeoutError(target.url, this.options.passTimeoutMs)),
          this.options.passTimeoutMs,
        );
      });
      const result = await Promise.race([pass(page, context), deadline]);
      this.completed++;
      return result;
    } catch (e) {
      if (e instanceof PassTimeoutError) this.timedOut++;
      else this.failed++;
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      if (context) await this.dispose(context);
      this.release();
    }
  }

  private async ensureBrowser(): Promise<Running> {
    if (this.running?.browser.isConnected()) return this.running;
    if (!this.launching) {
      const type = this.options.browserType ?? chromium;
      this.launching = (async () => {
        const server = await type.launchServer(this.options.launch);
        const browser = await type.connect(server.wsEndpoint());
        const running = { server, browser };
        this.running = running;
        this.launching = undefined;
        return running;
      })();
    }
    return this.launching;
  }

  private async dispose(context: BrowserContext): Promise<void> {
    const closed = await Promise.race([
      context.close().then(
        () => true,
        () => true,
      ),
      sleep(this.options.closeTimeoutMs ?? 5_000).then(() => false),
    ]);
    if (closed) return;
    const running = this.running;
    this.running = undefined;
    if (running) await this.kill(running);
  }

  private async kill(running: Running): Promise<void> {
    this.killed++;
    try {
      await running.server.kill();
    } catch {
      // already gone
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.options.concurrency) {
      this.inFlight++;
      this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.inFlight++;
        this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
        resolve();
      });
    });
  }

  private release(): void {
    this.inFlight--;
    const next = this.waiting.shift();
    if (next) next();
  }
}
