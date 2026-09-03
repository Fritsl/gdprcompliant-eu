import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { defaultLocale, localeCodes } from '@/lib/i18n';

// "/" has no content of its own: it sends the visitor to the locale their browser asks
// for, or English. Every real page lives under a locale segment.

export default async function Root() {
  const accept = (await headers()).get('accept-language') ?? '';
  const wanted = accept
    .split(',')
    .map((part) => part.trim().split(';')[0]?.toLowerCase().split('-')[0] ?? '')
    .find((code) => localeCodes.includes(code));
  redirect(`/${wanted ?? defaultLocale}`);
}
