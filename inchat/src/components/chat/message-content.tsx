'use client';

import { useEffect, useState } from 'react';

import { choiceOf, pollView } from '@/lib/chat/composer';
import { Timestamp } from '@/components/chat/timestamp';
import { bytesLabel, pathInConversation } from '@/lib/chat/uploads';
import type { Message } from '@/lib/chat/timeline';

/**
 * What a message looks like when it is more than a sentence.
 *
 * Every renderer here degrades to the body text when the payload is not what
 * the kind promises. A row written by an older client, or one the composer built
 * before a field was renamed, still has to say something true on screen rather
 * than throw inside the message list and take the thread down with it.
 */

export type ContentProps = {
  message: Message;
  viewerId: string;
  conversationId: string;
  /** A download link for the object, or null when it cannot be signed. */
  resolveUrl(path: string): Promise<string | null>;
  onVote(messageId: string, choice: number): void;
};

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function MessageContent(props: ContentProps) {
  const { message } = props;
  switch (message.kind) {
    case 'poll':
      return <PollBody {...props} />;
    case 'location':
      return <LocationBody {...props} />;
    case 'contact':
      return <ContactBody message={message} />;
    case 'event':
      return <EventBody message={message} />;
    case 'image':
    case 'video':
    case 'voice':
    case 'file':
      return <MediaBody {...props} />;
    default:
      return <p className="whitespace-pre-wrap break-words">{message.body}</p>;
  }
}

/**
 * A poll whose tally comes out of the payload.
 *
 * The counts are never accumulated here: a member's vote arrives as a new map in
 * the row, so two clients that saw the votes in different orders still print the
 * same numbers, and the vote that is already yours is marked rather than counted
 * twice.
 */
function PollBody({ message, viewerId, onVote }: ContentProps) {
  const view = pollView(message.payload);
  const mine = choiceOf(view, viewerId);
  const settled = message.pending || message.failed;

  if (view.options.length === 0) {
    return <p className="whitespace-pre-wrap break-words">{message.body}</p>;
  }

  return (
    <div className="grid gap-2">
      <p className="font-medium">{view.question || message.body}</p>
      <ul className="grid gap-1">
        {view.options.map((option, index) => {
          const chosen = mine === index;
          return (
            <li key={`${index}:${option.text}`}>
              <button
                type="button"
                className="btn btn-ghost w-full items-center justify-between gap-2 text-left text-xs"
                aria-label={`${option.text}: ${option.votes} votes`}
                onClick={() => onVote(message.id, index)}
                disabled={settled || view.closed}
                aria-pressed={chosen}
              >
                <span className="min-w-0 flex-1 truncate">
                  {chosen ? '✓ ' : ''}
                  {option.text}
                </span>
                <span className="shrink-0 text-[var(--text-dim)]">{option.votes}</span>
              </button>
              <span
                className="mt-0.5 block h-1 overflow-hidden rounded-full bg-[var(--line)]"
                aria-hidden="true"
              >
                <span
                  className="block h-full rounded-full bg-[var(--accent)]"
                  style={{ width: `${option.share}%` }}
                />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-[var(--text-dim)]" role="status">
        {view.closed
          ? 'This poll is closed.'
          : `${view.total} vote${view.total === 1 ? '' : 's'}`}
        {view.multiple ? ' · multiple answers allowed' : ''}
        {settled ? ' · waiting for the network' : ''}
      </p>
    </div>
  );
}

function LocationBody({ message }: ContentProps) {
  const latitude = num(message.payload['latitude']);
  const longitude = num(message.payload['longitude']);
  const maps = str(message.payload['maps_url']);
  const accuracy = num(message.payload['accuracy']);

  if (latitude === null || longitude === null) {
    return <p className="whitespace-pre-wrap break-words">{message.body}</p>;
  }

  return (
    <div className="grid gap-1">
      <p className="font-medium">{message.body || `${latitude}, ${longitude}`}</p>
      <p className="text-[11px] text-[var(--text-dim)]">
        {latitude.toFixed(5)}, {longitude.toFixed(5)}
        {accuracy !== null ? ` · within ${Math.round(accuracy)} m` : ''}
      </p>
      {/* Only an https link the payload was written with: a link built from a
          member's own text would be a page this app sends people to. */}
      {maps && maps.startsWith('https://') ? (
        <a className="text-xs underline" href={maps} target="_blank" rel="noopener noreferrer">
          Open in a map
        </a>
      ) : null}
    </div>
  );
}

function ContactBody({ message }: { message: Message }) {
  const name = str(message.payload['name']);
  const phone = str(message.payload['phone']);
  const company = str(message.payload['company']);
  if (!name) return <p className="whitespace-pre-wrap break-words">{message.body}</p>;

  return (
    <div className="grid gap-1">
      <p className="font-medium">{name}</p>
      {company ? <p className="text-xs text-[var(--text-dim)]">{company}</p> : null}
      {phone ? (
        <a className="text-xs underline" href={`tel:${phone.replace(/[^0-9+*#]/g, '')}`}>
          {phone}
        </a>
      ) : null}
    </div>
  );
}

function EventBody({ message }: { message: Message }) {
  const title = str(message.payload['title']);
  const startsAt = str(message.payload['starts_at']);
  const endsAt = str(message.payload['ends_at']);
  const place = str(message.payload['location']);
  if (!title || !startsAt) return <p className="whitespace-pre-wrap break-words">{message.body}</p>;

  const start = Date.parse(startsAt);
  if (!Number.isFinite(start)) return <p className="whitespace-pre-wrap break-words">{message.body}</p>;
  const end = endsAt ? Date.parse(endsAt) : Number.NaN;
  const note = message.body.split('\n').slice(1).join('\n');

  return (
    <div className="grid gap-1">
      <p className="font-medium">{title}</p>
      <p className="text-xs">
        <Timestamp epoch={start} style="datetime" />
        {Number.isFinite(end) ? (
          <>
            {' → '}
            <Timestamp epoch={end} />
          </>
        ) : null}
      </p>
      {place ? <p className="text-xs text-[var(--text-dim)]">{place}</p> : null}
      {note ? <p className="whitespace-pre-wrap break-words text-xs">{note}</p> : null}
    </div>
  );
}

/**
 * A file that lives in the private bucket.
 *
 * Nothing in the payload is a URL: the row holds an object path, and the link is
 * signed when this bubble is actually looked at. The request is made once per
 * view and dropped on unmount, so a long thread does not accumulate media.
 */
function MediaBody({ message, conversationId, resolveUrl }: ContentProps) {
  const path = str(message.payload['path']);
  const name = str(message.payload['name']) ?? 'Attachment';
  const bytes = num(message.payload['bytes']);
  const duration = num(message.payload['duration_secs']);
  const hd = message.payload['hd'] === true;
  const width = num(message.payload['width']);
  const height = num(message.payload['height']);

  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // A path that cannot belong to this conversation is answered during render:
  // an effect that set state to say the same thing would paint a loading line
  // for one frame before admitting the file is not reachable.
  const usable = path !== null && pathInConversation(path, conversationId);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    void resolveUrl(path)
      .then((signed) => {
        if (cancelled) return;
        if (signed) setUrl(signed);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, resolveUrl]);

  const caption = (
    <p className="text-[11px] text-[var(--text-dim)]">
      {name}
      {bytes !== null ? ` · ${bytesLabel(bytes)}` : ''}
      {duration !== null ? ` · ${Math.round(duration)}s` : ''}
      {hd ? ' · HD' : ''}
      {!hd && width && height ? ` · ${width}×${height}` : ''}
    </p>
  );

  if (!path) {
    return <p className="whitespace-pre-wrap break-words">{message.body || name}</p>;
  }
  if (!usable) {
    return (
      <div className="grid gap-1">
        <p className="notice notice-error">This file does not belong to this chat, so it stays hidden.</p>
        {caption}
      </div>
    );
  }
  if (failed) {
    return (
      <div className="grid gap-1">
        <p className="notice notice-error">This file could not be opened. It may have been removed.</p>
        {caption}
      </div>
    );
  }
  if (!url) {
    return (
      <div className="grid gap-1">
        <p className="text-xs text-[var(--text-dim)]">Loading {name}…</p>
        {caption}
      </div>
    );
  }

  return (
    <div className="grid gap-1">
      {message.kind === 'image' ? (
        // Not next/image: the URL is signed for this viewer and expires, so
        // routing it through the image optimizer would cache one member's
        // private bytes under a URL the next member is not allowed to fetch.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={name}
          className="max-h-72 w-full rounded-[var(--radius-sm)] object-contain"
          loading="lazy"
        />
      ) : null}
      {message.kind === 'video' ? (
        <video
          src={url}
          controls
          preload="metadata"
          className="max-h-72 w-full rounded-[var(--radius-sm)]"
          aria-label={name}
        />
      ) : null}
      {message.kind === 'voice' ? (
        <audio src={url} controls className="w-full" aria-label={`Voice message: ${name}`} />
      ) : null}
      {message.kind === 'file' ? (
        <a className="text-xs underline" href={url} download={name}>
          Download {name}
        </a>
      ) : null}
      {caption}
    </div>
  );
}
