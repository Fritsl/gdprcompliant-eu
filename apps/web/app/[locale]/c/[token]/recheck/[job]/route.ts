import { readRecheck } from '@/lib/case';

// One re-check as it happens (U-04): an event stream of the job's state, for the page
// that asked. Only the case the job belongs to can read it; the stream ends with the
// outcome, when the job fails, or when it is gone.

export const dynamic = 'force-dynamic';

const POLL_MS = 700;
const MAX_MS = 5 * 60 * 1000;

export async function GET(
  _request: Request,
  context: { params: Promise<{ locale: string; token: string; job: string }> },
) {
  const { token, job } = await context.params;
  const first = await readRecheck(token, job);
  if (!first) return new Response('Not found', { status: 404 });
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const started = Date.now();
      let last = '';
      let view = first;
      while (!closed && Date.now() - started < MAX_MS) {
        const now = JSON.stringify([view.state, view.progress]);
        if (now !== last) {
          send('progress', view);
          last = now;
        }
        const settled =
          view.progress?.outcome !== undefined ||
          view.state === 'failed' ||
          view.state === 'cancelled';
        if (settled) {
          send('done', view);
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
        const next = await readRecheck(token, job);
        if (!next) {
          send('gone', {});
          break;
        }
        view = next;
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
