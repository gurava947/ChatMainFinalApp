import { BUCKET } from '@/lib/chat/uploads';

/**
 * The one place that talks to the Storage HTTP API.
 *
 * supabase-js has no upload-progress callback: it wraps `fetch`, and fetch does
 * not report bytes sent. A progress bar and a cancel button therefore need an
 * XMLHttpRequest, and the request is the documented Storage endpoint with the
 * caller's own access token - the same one the SDK would have sent, which is
 * what the bucket policy authorises against.
 *
 * Everything here is structural (a factory for the request, a function for the
 * token) so the success, refusal and mid-flight abort paths can be driven from
 * a test without a network or a browser.
 */

export type ProgressEvent = { loaded: number; total: number; lengthComputable: boolean };

export type RequestLike = {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: unknown): void;
  abort(): void;
  upload: { onprogress: ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
  status: number;
  timeout: number;
};

export type RequestFactory = () => RequestLike;

export type UploadOutcome =
  | { ok: true; path: string }
  | { ok: false; path: string; reason: string };

const TIMEOUT_MS = 120_000;

/**
 * `POST {url}/storage/v1/object/{bucket}/{path}`
 *
 * Each segment is encoded because the path is built from a file name's
 * extension: a path that escapes the bucket prefix would land the object
 * somewhere the policies never look.
 */
export function objectUploadUrl(supabaseUrl: string, bucket: string, path: string): string {
  const base = supabaseUrl.replace(/\/+$/, '');
  const segments = path.split('/').map((segment) => encodeURIComponent(segment));
  return `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${segments.join('/')}`;
}

export type UploadRequest = {
  supabaseUrl: string;
  accessToken: string;
  anonKey: string;
  path: string;
  mimeType: string;
  body: unknown;
  newRequest: RequestFactory;
  onProgress?(loaded: number, total: number): void;
  /** Returns a function that stops the transfer, so the caller can cancel. */
  onAbortReady?(cancel: () => void): void;
};

/**
 * Send one object, reporting progress.
 *
 * A non-2xx answer is a resolved `ok: false`, not a rejection: the caller has a
 * retry button to show, and an exception per refused upload would mean the
 * queue's error handling lived in a catch block instead of in its state.
 */
export function uploadObject(request: UploadRequest): Promise<UploadOutcome> {
  const xhr = request.newRequest();
  const url = objectUploadUrl(request.supabaseUrl, BUCKET, request.path);
  let settled = false;

  return new Promise<UploadOutcome>((resolve) => {
    const finish = (outcome: UploadOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const cancel = () => {
      if (settled) return;
      try {
        xhr.abort();
      } catch {
        // An abort on a request that already ended is not a failure to report.
      }
      finish({ ok: false, path: request.path, reason: 'Upload cancelled' });
    };

    request.onAbortReady?.(cancel);

    xhr.open('POST', url);
    // The apikey is what the Storage gateway expects on every call; the
    // Authorization bearer is the user the bucket policy reads. Both are the
    // caller's own values - nothing here can reach a project it is not in.
    xhr.setRequestHeader('apikey', request.anonKey);
    xhr.setRequestHeader('Authorization', `Bearer ${request.accessToken}`);
    xhr.setRequestHeader('Content-Type', request.mimeType);
    xhr.timeout = TIMEOUT_MS;

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      request.onProgress?.(event.loaded, event.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        finish({ ok: true, path: request.path });
        return;
      }
      finish({ ok: false, path: request.path, reason: `Storage refused the file (${xhr.status})` });
    };
    xhr.onerror = () => finish({ ok: false, path: request.path, reason: 'The upload failed' });
    xhr.ontimeout = () => finish({ ok: false, path: request.path, reason: 'The upload timed out' });

    xhr.send(request.body);
  });
}

export type SessionLike = { access_token?: string | null };

/** The token to put in the Authorization header, or null when signed out. */
export function accessTokenOf(session: SessionLike | null | undefined): string | null {
  const token = session?.access_token;
  return typeof token === 'string' && token !== '' ? token : null;
}
