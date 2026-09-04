import { readScan } from '@/lib/scan';
import { asLocale } from '@/lib/i18n';

// The scan as it happens (U-02): an event stream of the worker's checkpoints. Nothing
// here is invented; a stage is sent when the worker marked it, and the stream ends with
// the outcome or when the job is gone.

export const dynamic = 'force-dynamic';

const POLL_MS = 700;
const MAX_MS = 10 * 60 * 1000;

export async function GET(
  _request: Request,
  context: { params: Promise<{ locale: string; job: string }> },
) {
  const { locale: localeParam, job } = await context.params;
  if (!asLocale(localeParam)) return new Response('Not found', { status: 404 });
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const started = Date.now();
      let last = '';
      while (!closed && Date.now() - started < MAX_MS) {
        const view = await readScan(job);
        if (!view) {
          send('gone', {});
          break;
        }
        const now = JSON.stringify(view.progress);
        if (now !== last) {
          send('progress', view);
          last = now;
        }
        if (view.done) {
          send('done', view);
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      controller.close();
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
