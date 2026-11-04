'use client';

import { useSyncExternalStore } from 'react';

/**
 * A time the server and the viewer can agree on.
 *
 * Every stamp in this app is an instant stored in UTC, and only the browser
 * knows what that instant looks like on the viewer's wall - their zone and their
 * date format. Printing it during the server render therefore cannot be right:
 * the server answers in its own zone (UTC on Vercel, en-US), the browser then
 * paints its own, and React finds a tree that does not match the HTML it was
 * handed and throws the whole subtree away.
 *
 * So the first paint - server and client alike - uses a fixed locale and UTC, and
 * the local text arrives in the same frame the page becomes interactive.
 */

export type TimestampStyle = 'clock' | 'day' | 'datetime' | 'auto';

const nothingToSubscribeTo = () => () => undefined;
const onTheClient = () => true;
const onTheServer = () => false;

const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
const DAY: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short' };
const DATE_AND_CLOCK: Intl.DateTimeFormatOptions = { ...DAY, year: 'numeric', ...CLOCK };

function utcText(at: Date, style: TimestampStyle): string {
  const options = style === 'datetime' ? DATE_AND_CLOCK : style === 'day' || style === 'auto' ? DAY : CLOCK;
  return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(at);
}

function sameLocalDay(at: Date, now: Date): boolean {
  return (
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  );
}

function localText(at: Date, style: TimestampStyle, now: Date): string {
  if (style === 'auto') {
    return sameLocalDay(at, now)
      ? at.toLocaleTimeString([], CLOCK)
      : at.toLocaleDateString([], DAY);
  }
  if (style === 'datetime') return at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  if (style === 'day') return at.toLocaleDateString([], DAY);
  return at.toLocaleTimeString([], CLOCK);
}

export function Timestamp({
  epoch,
  style = 'clock',
  className
}: {
  epoch: number;
  style?: TimestampStyle;
  className?: string;
}) {
  const local = useSyncExternalStore(nothingToSubscribeTo, onTheClient, onTheServer);
  const at = new Date(epoch);
  if (!Number.isFinite(at.getTime())) return null;

  return (
    <time dateTime={at.toISOString()} className={className}>
      {local ? localText(at, style, new Date()) : utcText(at, style)}
    </time>
  );
}
