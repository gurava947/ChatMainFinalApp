'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  MAX_POLL_OPTIONS,
  contactDraft,
  eventDraft,
  extensionOf,
  locationDraft,
  mediaDraft,
  pollDraft,
  targetEdge,
  type Built,
  type Draft,
  type FieldErrors
} from '@/lib/chat/composer';
import { newClientId } from '@/lib/chat/client-id';
import { prepareImage, readMediaMeta } from '@/lib/chat/media';
import { accessTokenOf, uploadObject, type RequestLike } from '@/lib/chat/uploader';
import {
  ACCEPT,
  MAX_VOICE_SECONDS,
  addTransfer,
  bytesLabel,
  dueTransfers,
  emptyTransfers,
  findTransfer,
  groupForMime,
  hasTransfers,
  markProgress,
  markTransferFailed,
  objectPath,
  percentOf,
  removeTransfer,
  retryTransfer,
  startTransfer,
  validateFile,
  type Transfer,
  type TransferBook
} from '@/lib/chat/uploads';
import { supabaseConfig } from '@/lib/supabase/env';
import { createClient } from '@/lib/supabase/client';

/**
 * The composer: text, the attachment menu, and the files waiting to go out.
 *
 * It owns uploads and nothing else. When a transfer finishes it hands back a
 * validated draft, and the thread puts that through the same offline queue a
 * typed message uses - one path to the server, so a send queued while the radio
 * was off behaves identically whether it started as words or as a photograph.
 *
 * The bytes are the part that cannot wait: a text send survives a closed tab
 * because localStorage holds it, and a two-megabyte picture does not go in
 * localStorage. A pending upload therefore lives in memory for the life of the
 * page, and the tray says so rather than pretending otherwise.
 */

export type ComposerProps = {
  conversationId: string;
  viewerId: string;
  title: string;
  online: boolean;
  /** A send the thread already has in the queue still blocks the input. */
  onSubmit(draft: Draft): void;
  onTyping(): void;
  onNotice(message: string): void;
};

type Panel = 'none' | 'menu' | 'poll' | 'location' | 'contact' | 'event';

const MENU_ITEMS: Array<{ panel: Panel; label: string; hint: string }> = [
  { panel: 'poll', label: 'Poll', hint: 'Ask the group to choose' },
  { panel: 'location', label: 'Location', hint: 'Share where you are' },
  { panel: 'contact', label: 'Contact', hint: 'Send somebody a number' },
  { panel: 'event', label: 'Event', hint: 'Propose a time' }
];

const emptyPoll = { question: '', options: ['', ''], multiple: false };
const emptyLocation = { latitude: '', longitude: '', label: '' };
const emptyContact = { name: '', phone: '', company: '' };
const emptyEvent = { title: '', startsAt: '', endsAt: '', location: '', note: '' };

/** How long a microphone request may stay silent before the button says so. */
const MIC_WAIT_MS = 6_000;

const MIC_DID_NOT_ANSWER =
  'The microphone has not answered. It may still be waiting for you to allow it - ' +
  'otherwise check this site\'s browser permission, or type the message instead.';

export function Composer({
  conversationId,
  viewerId,
  title,
  online,
  onSubmit,
  onTyping,
  onNotice
}: ComposerProps) {
  const client = useMemo(() => createClient(), []);

  const [draft, setDraft] = useState('');
  const [panel, setPanel] = useState<Panel>('none');
  const [hd, setHd] = useState(false);
  const [transfers, setTransfers] = useState<TransferBook>(emptyTransfers);

  const [poll, setPoll] = useState(emptyPoll);
  const [location, setLocation] = useState(emptyLocation);
  const [contact, setContact] = useState(emptyContact);
  const [eventForm, setEventForm] = useState(emptyEvent);
  const [formErrors, setFormErrors] = useState<FieldErrors>({});

  const [cameraOpen, setCameraOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordedSeconds, setRecordedSeconds] = useState(0);

  // The queue is read by the pump while a state update is still in flight, so
  // the ref is the working copy and the state is what the tray renders - the
  // same split the message outbox makes.
  const transfersRef = useRef<TransferBook>(emptyTransfers());
  const pumpingRef = useRef(false);
  const blobsRef = useRef(new Map<string, Blob>());
  const cancelsRef = useRef(new Map<string, () => void>());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const micWaitRef = useRef<number | null>(null);
  const aliveRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const commit = useCallback((book: TransferBook) => {
    transfersRef.current = book;
    setTransfers(book);
  }, []);

  const uploadOne = useCallback(
    async (item: Transfer) => {
      const blob = blobsRef.current.get(item.clientId);
      if (!blob) {
        const { book } = markTransferFailed(
          transfersRef.current,
          item.clientId,
          Date.now(),
          'That file is no longer in this tab. Pick it again.',
          { permanent: true }
        );
        commit(book);
        return;
      }

      const session = await client.auth.getSession();
      const token = accessTokenOf(session.data.session);
      if (!token) {
        const { book } = markTransferFailed(transfersRef.current, item.clientId, Date.now(), 'Sign in again to send files');
        commit(book);
        return;
      }

      const { url, anonKey } = supabaseConfig();
      const claim = startTransfer(transfersRef.current, item.clientId, Date.now());
      commit(claim.book);
      if (!claim.transfer) return;

      const outcome = await uploadObject({
        supabaseUrl: url,
        accessToken: token,
        anonKey,
        path: item.path,
        mimeType: item.mimeType,
        body: blob,
        newRequest: () => new XMLHttpRequest() as unknown as RequestLike,
        onProgress: (loaded) => commit(markProgress(transfersRef.current, item.clientId, loaded)),
        onAbortReady: (cancel) => {
          cancelsRef.current.set(item.clientId, cancel);
        }
      });

      cancelsRef.current.delete(item.clientId);
      const finished = findTransfer(transfersRef.current, item.clientId);
      if (!finished) return;

      if (outcome.ok) {
        commit(removeTransfer(transfersRef.current, item.clientId));
        blobsRef.current.delete(item.clientId);
        const built = mediaDraft({
          fileName: item.name,
          mimeType: item.mimeType,
          sizeBytes: blob.size,
          path: item.path,
          width: finished.width,
          height: finished.height,
          durationSecs: finished.durationSecs,
          hd: item.hd
        });
        if (!built.ok) {
          onNotice(Object.values(built.errors)[0] ?? 'That file could not be attached.');
          return;
        }
        onSubmit(built.draft);
        return;
      }

      const failed = markTransferFailed(transfersRef.current, item.clientId, Date.now(), outcome.reason, {
        // A refusal from Storage is the same answer every time it is asked.
        permanent: outcome.reason.includes('refused')
      });
      commit(failed.book);
      if (failed.exhausted) onNotice(`Upload failed: ${outcome.reason}`);
    },
    [client, commit, onNotice, onSubmit]
  );

  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      // The await before the first claim is also what keeps the setState calls
      // in this loop out of the effect that fires it.
      const now = Date.now();
      const queue = dueTransfers(transfersRef.current, now);
      for (const item of queue) {
        await uploadOne(item);
      }
    } finally {
      pumpingRef.current = false;
    }
  }, [uploadOne]);

  // Coming back to the network is the second half of the promise the tray makes:
  // a file that stopped mid-transfer is picked up again without a second tap.
  useEffect(() => {
    if (online && hasTransfers(transfersRef.current)) void pump();
  }, [online, pump]);

  const stageFile = useCallback(
    async (source: Blob, name: string, mimeType: string, options: { seconds?: number | null } = {}) => {
      const group = groupForMime(mimeType);
      const reason = validateFile({ mimeType, sizeBytes: source.size, group });
      if (reason) {
        onNotice(reason);
        return;
      }

      let blob = source;
      let width: number | null = null;
      let height: number | null = null;
      let durationSecs = options.seconds ?? null;

      if (group === 'image') {
        const prepared = await prepareImage(blob, targetEdge(hd));
        blob = prepared.blob;
        width = prepared.width;
        height = prepared.height;
        if (prepared.resized) onNotice(`Sent at ${width}×${height} to save data. Turn on HD for the original.`);
      } else if (group === 'video' || group === 'audio') {
        const meta = await readMediaMeta(blob, group);
        width = meta.width;
        height = meta.height;
        durationSecs = durationSecs ?? meta.durationSecs;
      }

      const clientId = newClientId();
      let path: string;
      try {
        path = objectPath({
          conversationId,
          uploaderId: viewerId,
          fileId: newClientId(),
          extension: extensionOf(name)
        });
      } catch {
        onNotice('This chat cannot store a file yet. Sign in again and try once more.');
        return;
      }

      blobsRef.current.set(clientId, blob);
      const added = addTransfer(transfersRef.current, {
        clientId,
        conversationId,
        path,
        name,
        mimeType,
        group,
        bytes: blob.size,
        sentBytes: 0,
        status: 'queued',
        attempts: 0,
        nextAttemptAt: Date.now(),
        error: null,
        hd,
        width,
        height,
        durationSecs
      });
      commit(added);
      void pump();
    },
    [commit, conversationId, hd, onNotice, pump, viewerId]
  );

  const onFilesPicked = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      for (const file of Array.from(files)) {
        await stageFile(file, file.name, file.type || 'application/octet-stream');
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [stageFile]
  );

  function sendText() {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    onSubmit({ kind: 'text', body, payload: {} });
  }

  /**
   * A form that produced a draft closes itself; one that did not leaves the
   * reasons beside the fields that caused them.
   */
  function submitForm(built: Built, close: () => void): void {
    if (!built.ok) {
      setFormErrors(built.errors);
      return;
    }
    setFormErrors({});
    close();
    onSubmit(built.draft);
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorder.onstop = () => {
      const mime = recorder.mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type: mime });
      chunksRef.current = [];
      recorder.stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setRecording(false);
      if (blob.size === 0) {
        onNotice('The microphone sent nothing. Record once more, or type the message.');
        return;
      }
      const seconds = Math.max(1, Math.round((Date.now() - startedRef.current) / 1000));
      void stageFile(blob, `voice-${seconds}s.webm`, mime, { seconds });
    };
    recorder.stop();
  }

  async function toggleRecording() {
    if (recording) {
      stopRecording();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onNotice('This browser cannot record audio. A microphone clip needs Chrome, Edge or Safari.');
      return;
    }

    // Armed before the request, not after it: a prompt that has not been answered
    // leaves getUserMedia pending, and a timer scheduled on the far side of that
    // await would never run for exactly the case it exists for.
    micWaitRef.current = window.setTimeout(() => {
      micWaitRef.current = null;
      onNotice(MIC_DID_NOT_ANSWER);
    }, MIC_WAIT_MS);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      clearMicWait();
      onNotice('The microphone was not allowed. Check the browser permission for this site.');
      return;
    }
    clearMicWait();

    // The thread can be left while the prompt is still open; the tracks that
    // arrive afterwards belong to nobody and must not keep the light on.
    if (!aliveRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      onNotice('This browser would not record from the microphone. Type the message instead.');
      return;
    }

    // Without this handler the recorder never hands back a single byte, and the
    // clip that reaches the tray is an empty file.
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    chunksRef.current = [];
    recorderRef.current = recorder;
    startedRef.current = Date.now();
    setRecordedSeconds(0);
    setRecording(true);
    recorder.start();
    timerRef.current = window.setInterval(() => {
      const seconds = Math.round((Date.now() - startedRef.current) / 1000);
      setRecordedSeconds(seconds);
      if (seconds >= MAX_VOICE_SECONDS) stopRecording();
    }, 1_000);
  }

  function clearMicWait() {
    if (micWaitRef.current === null) return;
    window.clearTimeout(micWaitRef.current);
    micWaitRef.current = null;
  }

  // Release the microphone whatever way this screen is left: a stream that
  // outlives the composer keeps the recording light on.
  useEffect(() => {
    // Re-armed on every mount. StrictMode runs the cleanup below once in
    // development before the screen is ever used, and a ref left at false by that
    // throwaway pass would drop the microphone answer when it finally arrives.
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      clearMicWait();
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cancels = cancelsRef.current;
    return () => {
      // A transfer still in flight when the thread closes stops being anybody's.
      cancels.forEach((cancel) => cancel());
      cancels.clear();
    };
  }, []);

  async function useMyLocation() {
    if (!navigator.geolocation) {
      onNotice('This browser will not share a position. Type the coordinates instead.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({
          latitude: position.coords.latitude.toFixed(6),
          longitude: position.coords.longitude.toFixed(6),
          label: location.label
        });
      },
      () => onNotice('The position was not allowed. Type the coordinates instead.'),
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  }

  const openPanel = (next: Panel) => {
    setFormErrors({});
    setPanel(panel === next ? 'none' : next);
  };

  const busy = transfers.items.filter((item) => item.status === 'uploading').length;
  const blocked = !online && hasTransfers(transfers);

  return (
    <div className="panel grid gap-2 p-3">
      {hasTransfers(transfers) ? (
        <ul className="grid gap-1" aria-label="Uploads">
          {transfers.items.map((item) => (
            <li key={item.clientId} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate" title={item.name}>
                {item.name}
                <span className="text-[var(--text-dim)]"> · {bytesLabel(item.bytes)}</span>
              </span>
              <span
                className="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--line)]"
                role="progressbar"
                aria-valuenow={percentOf(item)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${item.name} upload progress`}
              >
                <span
                  className="block h-full rounded-full bg-[var(--accent)]"
                  style={{ width: `${percentOf(item)}%` }}
                />
              </span>
              <span className="w-16 text-right text-[var(--text-dim)]">
                {item.status === 'uploading' ? `${percentOf(item)}%` : item.status}
              </span>
              {item.status === 'failed' ? (
                <button
                  type="button"
                  className="btn btn-ghost !px-2 !py-1 text-xs"
                  onClick={() => {
                    commit(retryTransfer(transfersRef.current, item.clientId, Date.now()));
                    void pump();
                  }}
                >
                  Retry
                </button>
              ) : null}
              {item.status === 'uploading' ? (
                <button
                  type="button"
                  className="btn btn-ghost !px-2 !py-1 text-xs"
                  onClick={() => {
                    cancelsRef.current.get(item.clientId)?.();
                  }}
                >
                  Cancel
                </button>
              ) : null}
              {item.error ? (
                <span className="text-[var(--danger)]" title={item.error}>
                  {item.error.slice(0, 40)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {blocked ? (
        <p className="notice" role="status">
          Waiting for a connection to send {transfers.items.length} file(s).
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-ghost !grid !h-10 !w-10 !place-items-center !rounded-xl !p-0 text-xl"
          aria-label="Add attachment"
          aria-expanded={panel === 'menu'}
          onClick={() => openPanel('menu')}
        >
          <span aria-hidden="true">+</span>
        </button>
        <button
          type="button"
          className="btn btn-ghost !px-3 !py-2 text-sm"
          title="Open the camera"
          onClick={() => setCameraOpen(true)}
        >
          Camera
        </button>
        <button
          type="button"
          className="btn btn-ghost !px-3 !py-2 text-sm"
          aria-pressed={recording}
          onClick={() => {
            void toggleRecording();
          }}
          disabled={recording && recordedSeconds >= MAX_VOICE_SECONDS}
        >
          {recording ? `Stop ${recordedSeconds}s` : 'Voice'}
        </button>
        <button
          type="button"
          className="btn btn-ghost !px-3 !py-2 text-xs"
          aria-pressed={hd}
          title="HD sends the original bytes; standard shrinks a picture to save data"
          onClick={() => setHd((current) => !current)}
        >
          HD {hd ? 'on' : 'off'}
        </button>
      </div>

      {panel === 'menu' ? (
        <div className="attachment-scrim" onClick={() => setPanel('none')}>
          <section className="attachment-sheet" role="dialog" aria-modal="true" aria-label="Share an attachment" onClick={(event) => event.stopPropagation()}>
            <div className="attachment-sheet-grab" aria-hidden="true" />
            <div className="attachment-sheet-heading"><div><strong>Share with {title}</strong><p>Choose what you want to send</p></div><button type="button" className="attachment-close" aria-label="Close attachment picker" onClick={() => setPanel('none')}>×</button></div>
            <div className="attachment-actions">
              <button type="button" className="attachment-action" onClick={() => { setPanel('none'); setCameraOpen(true); }}><i className="material-symbols-outlined">photo_camera</i><span>Camera</span></button>
              <button type="button" className="attachment-action" onClick={() => { fileInputRef.current?.click(); setPanel('none'); }}><i className="material-symbols-outlined">photo_library</i><span>Photos &amp; videos</span></button>
              <button type="button" className="attachment-action" onClick={() => { fileInputRef.current?.click(); setPanel('none'); }}><i className="material-symbols-outlined">attach_file</i><span>Documents</span></button>
              {MENU_ITEMS.map((item) => <button key={item.panel} type="button" className="attachment-action" onClick={() => openPanel(item.panel)}><i className="material-symbols-outlined">{item.panel === 'poll' ? 'poll' : item.panel === 'location' ? 'location_on' : item.panel === 'contact' ? 'person' : 'event'}</i><span>{item.label}</span></button>)}
            </div>
            <button type="button" className={`attachment-hd ${hd ? 'is-on' : ''}`} aria-pressed={hd} onClick={() => setHd((current) => !current)}><span><i className="material-symbols-outlined">hd</i><span><strong>Send in HD</strong><small>Keep original photo quality</small></span></span><span className="attachment-switch" aria-hidden="true" /></button>
            <p className="attachment-apps-note">Recent apps · Camera roll · More options</p>
          </section>
        </div>
      ) : null}

      {panel === 'poll' ? (
        <form
          className="grid gap-2"
          onSubmit={(form) => {
            form.preventDefault();
            submitForm(pollDraft(poll), () => {
              setPoll(emptyPoll);
              setPanel('none');
            });
          }}
        >
          <label className="field">
            <span>Question</span>
            <input
              className="input"
              value={poll.question}
              maxLength={200}
              onChange={(event) => setPoll({ ...poll, question: event.target.value })}
            />
          </label>
          {poll.options.map((option, index) => (
            <div className="grid gap-1" key={index}>
              <label className="field">
                <span>Option {index + 1}</span>
                <input
                  className="input"
                  value={option}
                  maxLength={120}
                  onChange={(event) =>
                    setPoll({
                      ...poll,
                      options: poll.options.map((current, at) =>
                        at === index ? event.target.value : current
                      )
                    })
                  }
                />
              </label>
              {poll.options.length > 2 ? (
                // Outside the label: a button inside it would also move the caret
                // into the option it is meant to delete.
                <button
                  type="button"
                  className="btn btn-ghost self-start !px-2 !py-0 text-xs"
                  aria-label={`Remove option ${index + 1}`}
                  onClick={() =>
                    setPoll({ ...poll, options: poll.options.filter((_, at) => at !== index) })
                  }
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
          {poll.options.length < MAX_POLL_OPTIONS ? (
            <button
              type="button"
              className="btn btn-ghost self-start text-xs"
              onClick={() => setPoll({ ...poll, options: [...poll.options, ''] })}
            >
              Add option
            </button>
          ) : null}
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={poll.multiple}
              onChange={(event) => setPoll({ ...poll, multiple: event.target.checked })}
            />
            Allow more than one answer
          </label>
          <FormErrors errors={formErrors} />
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-sm">
              Send poll
            </button>
            <button type="button" className="btn btn-ghost text-sm" onClick={() => setPanel('none')}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {panel === 'location' ? (
        <form
          className="grid gap-2"
          onSubmit={(form) => {
            form.preventDefault();
            submitForm(
              locationDraft({
                latitude: location.latitude === '' ? '' : Number(location.latitude),
                longitude: location.longitude === '' ? '' : Number(location.longitude),
                label: location.label
              }),
              () => {
                setLocation(emptyLocation);
                setPanel('none');
              }
            );
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <label className="field flex-1">
              <span>Latitude</span>
              <input
                className="input"
                inputMode="decimal"
                value={location.latitude}
                onChange={(event) => setLocation({ ...location, latitude: event.target.value })}
              />
            </label>
            <label className="field flex-1">
              <span>Longitude</span>
              <input
                className="input"
                inputMode="decimal"
                value={location.longitude}
                onChange={(event) => setLocation({ ...location, longitude: event.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span>Place name (optional)</span>
            <input
              className="input"
              maxLength={120}
              value={location.label}
              onChange={(event) => setLocation({ ...location, label: event.target.value })}
            />
          </label>
          <button type="button" className="btn btn-ghost self-start text-xs" onClick={useMyLocation}>
            Use my current position
          </button>
          <FormErrors errors={formErrors} />
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-sm">
              Send location
            </button>
            <button type="button" className="btn btn-ghost text-sm" onClick={() => setPanel('none')}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {panel === 'contact' ? (
        <form
          className="grid gap-2"
          onSubmit={(form) => {
            form.preventDefault();
            submitForm(contactDraft(contact), () => {
              setContact(emptyContact);
              setPanel('none');
            });
          }}
        >
          <label className="field">
            <span>Name</span>
            <input
              className="input"
              maxLength={80}
              value={contact.name}
              onChange={(event) => setContact({ ...contact, name: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Number</span>
            <input
              className="input"
              inputMode="tel"
              maxLength={32}
              value={contact.phone}
              onChange={(event) => setContact({ ...contact, phone: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Company (optional)</span>
            <input
              className="input"
              maxLength={80}
              value={contact.company}
              onChange={(event) => setContact({ ...contact, company: event.target.value })}
            />
          </label>
          <FormErrors errors={formErrors} />
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-sm">
              Send contact
            </button>
            <button type="button" className="btn btn-ghost text-sm" onClick={() => setPanel('none')}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {panel === 'event' ? (
        <form
          className="grid gap-2"
          onSubmit={(form) => {
            form.preventDefault();
            submitForm(eventDraft(eventForm), () => {
              setEventForm(emptyEvent);
              setPanel('none');
            });
          }}
        >
          <label className="field">
            <span>Title</span>
            <input
              className="input"
              maxLength={120}
              value={eventForm.title}
              onChange={(input) => setEventForm({ ...eventForm, title: input.target.value })}
            />
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <label className="field flex-1">
              <span>Starts</span>
              <input
                className="input"
                type="datetime-local"
                value={eventForm.startsAt}
                onChange={(input) => setEventForm({ ...eventForm, startsAt: input.target.value })}
              />
            </label>
            <label className="field flex-1">
              <span>Ends (optional)</span>
              <input
                className="input"
                type="datetime-local"
                value={eventForm.endsAt}
                onChange={(input) => setEventForm({ ...eventForm, endsAt: input.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span>Where</span>
            <input
              className="input"
              maxLength={120}
              value={eventForm.location}
              onChange={(input) => setEventForm({ ...eventForm, location: input.target.value })}
            />
          </label>
          <label className="field">
            <span>Note (optional)</span>
            <textarea
              className="input"
              rows={2}
              maxLength={2000}
              value={eventForm.note}
              onChange={(input) => setEventForm({ ...eventForm, note: input.target.value })}
            />
          </label>
          <FormErrors errors={formErrors} />
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-sm">
              Send event
            </button>
            <button type="button" className="btn btn-ghost text-sm" onClick={() => setPanel('none')}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {cameraOpen ? (
        <CameraCapture
          onCancel={() => setCameraOpen(false)}
          onPhoto={(blob) => {
            setCameraOpen(false);
            void stageFile(blob, `camera-${newClientId().slice(0, 8)}.jpg`, 'image/jpeg');
          }}
          onNotice={onNotice}
        />
      ) : null}

      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        multiple
        accept={ACCEPT}
        onChange={(input) => {
          void onFilesPicked(input.target.files);
        }}
      />

      <form
        className="flex items-end gap-2"
        onSubmit={(form) => {
          form.preventDefault();
          sendText();
        }}
      >
        <label className="field min-w-0 flex-1">
          <span className="sr-only">Message</span>
          <textarea
            className="input"
            rows={1}
            placeholder={`Message ${title}`}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              onTyping();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendText();
              }
            }}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
          Send
        </button>
      </form>
      {busy > 0 ? (
        <p className="text-xs text-[var(--text-dim)]">
          {busy} upload{busy > 1 ? 's' : ''} running. Keep this tab open until they finish.
        </p>
      ) : null}
    </div>
  );
}

function FormErrors({ errors }: { errors: FieldErrors }) {
  const messages = Object.values(errors).filter((value): value is string => Boolean(value));
  if (messages.length === 0) return null;
  return (
    <ul className="notice notice-error grid gap-1" role="alert">
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

/**
 * A live preview with a shutter, rather than a file picker.
 *
 * `getUserMedia` needs the permission prompt, which is why the fallback matters
 * more than the preview: a phone that says no still has to be able to take the
 * picture the user came here for. Saying yes is not the same as working either -
 * an unanswered prompt leaves the promise pending, and a camera another app
 * already holds resolves and then delivers no frames - so the shutter stays dead
 * until a frame actually arrives, and the wait for one is announced out loud.
 */
const CAMERA_FRAME_WAIT_MS = 6_000;

const CAMERA_WENT_SILENT =
  'The camera has not sent a picture. It may still be waiting for you to allow it - ' +
  'otherwise close this, free the camera, or use Documents to pick a photo.';

function CameraCapture({
  onPhoto,
  onCancel,
  onNotice
}: {
  onPhoto(blob: Blob): void;
  onCancel(): void;
  onNotice(message: string): void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const deadlineRef = useRef<number | null>(null);
  const settledRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const stop = () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (deadlineRef.current !== null) {
        window.clearTimeout(deadlineRef.current);
        deadlineRef.current = null;
      }
    };

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        settledRef.current = true;
        setFailure('This browser has no camera access. Use Documents to pick a photo instead.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
      } catch {
        if (cancelled || settledRef.current) return;
        settledRef.current = true;
        setFailure('The camera was not allowed. Use Documents to pick a photo instead.');
      }
    }

    // Armed before the request, not after it: a pending permission prompt never
    // resolves, and a watchdog scheduled on the far side of that await would
    // never run for exactly the case it exists for.
    deadlineRef.current = window.setTimeout(() => {
      if (settledRef.current) return;
      settledRef.current = true;
      setFailure(CAMERA_WENT_SILENT);
    }, CAMERA_FRAME_WAIT_MS);

    void start();
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  function onFirstFrame() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
    settledRef.current = true;
    if (deadlineRef.current !== null) {
      window.clearTimeout(deadlineRef.current);
      deadlineRef.current = null;
    }
    setReady(true);
  }

  function shoot() {
    const video = videoRef.current;
    if (!video || !ready) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context || canvas.width === 0) {
      onNotice('The camera frame was not ready. Try once more.');
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob) {
        onPhoto(blob);
      } else {
        onNotice('This browser would not turn the frame into a picture.');
      }
    }, 'image/jpeg', 0.9);
  }

  return (
    <div className="grid gap-2">
      <video
        ref={videoRef}
        className="w-full rounded-[var(--radius-sm)] border border-[var(--line)]"
        muted
        playsInline
        aria-label="Camera preview"
        onLoadedData={onFirstFrame}
      />
      {failure ? (
        <p className="notice notice-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary text-sm" onClick={shoot} disabled={!ready}>
          Capture
        </button>
        <button type="button" className="btn btn-ghost text-sm" onClick={onCancel}>
          Close
        </button>
      </div>
    </div>
  );
}
