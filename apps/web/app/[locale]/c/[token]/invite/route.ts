import { inviteForToken } from '@/lib/case';
import { asLocale } from '@/lib/i18n';

// An invitation from the person holding the case (P-02): their name, the colleague's
// address and desk. Back to the case page with the outcome, whatever it was.

export const dynamic = 'force-dynamic';

const ROLES = new Set(['marketing', 'it', 'hr', 'finance']);

export async function POST(
  request: Request,
  context: { params: Promise<{ locale: string; token: string }> },
) {
  const { locale: localeParam, token } = await context.params;
  const locale = asLocale(localeParam);
  if (!locale) return new Response('Not found', { status: 404 });
  const form = await request.formData();
  const role = String(form.get('role') ?? '');
  const email = String(form.get('email') ?? '');
  const from = String(form.get('from') ?? '');
  const outcome = ROLES.has(role)
    ? await inviteForToken(token, {
        role: role as 'marketing' | 'it' | 'hr' | 'finance',
        email,
        from,
        locale,
      })
    : 'invalid';
  if (outcome === 'not_found') return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  url.pathname = `/${locale}/c/${token}`;
  url.search = outcome === 'ok' ? '' : `?outcome=${outcome}`;
  return Response.redirect(url.toString(), 303);
}
