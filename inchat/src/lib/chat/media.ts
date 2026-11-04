/**
 * The browser-side half of a media send: what the composer hands to the queue.
 *
 * Both functions answer "the file as it came, if I cannot do better" rather than
 * throwing. A phone whose browser has no canvas path or no metadata event should
 * still send the picture; the resize and the duration are savings, not gates.
 *
 * There is no unit test here on purpose: these need a real image decoder and a
 * real media pipeline, which a node test does not have. The decisions built on
 * top of them - the HD toggle, the payload shape, the size limits - are tested
 * in composer.test.ts against the values returned here.
 */

export type PreparedFile = {
  blob: Blob;
  width: number | null;
  height: number | null;
  resized: boolean;
};

const JPEG_QUALITY = 0.82;

/**
 * Shrink a picture so its longest edge is `edge` pixels, and say when it did.
 *
 * An edge of zero means HD: the bytes leave as the camera made them. A picture
 * that is already smaller than the edge is sent untouched rather than
 * re-encoded, because a second lossy pass on a small photo is a worse picture
 * and no saving at all.
 */
export async function prepareImage(file: Blob, edge: number): Promise<PreparedFile> {
  const original: PreparedFile = { blob: file, width: null, height: null, resized: false };
  if (typeof createImageBitmap !== 'function') return original;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return original;
  }

  const natural: PreparedFile = { blob: file, width: bitmap.width, height: bitmap.height, resized: false };
  const longest = Math.max(bitmap.width, bitmap.height);
  if (edge <= 0 || longest <= edge) {
    bitmap.close();
    return natural;
  }

  const scale = edge / longest;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return natural;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await canvasToBlob(canvas);
    // A "smaller" encode that is not actually smaller would be a re-encode for
    // nothing, so the original wins.
    if (!blob || blob.size >= file.size) return natural;
    return { blob, width, height, resized: true };
  } catch {
    bitmap.close();
    return natural;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', JPEG_QUALITY);
  });
}

export type MediaMeta = { durationSecs: number | null; width: number | null; height: number | null };

/**
 * Ask the browser how long a clip is and how big its frame is.
 *
 * The element is never attached to the document: `preload = 'metadata'` makes
 * the decoder read the header and fire `loadedmetadata`, which is all this
 * needs. A timeout covers the file that never decodes - an unbounded wait would
 * leave the composer showing a spinner for a clip that will not play.
 */
export function readMediaMeta(blob: Blob, kind: 'audio' | 'video'): Promise<MediaMeta> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const element = document.createElement(kind === 'audio' ? 'audio' : 'video');
    let settled = false;

    const finish = (meta: MediaMeta) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      element.removeAttribute('src');
      resolve(meta);
    };

    const timer = window.setTimeout(() => finish(emptyMeta()), 10_000);

    element.preload = 'metadata';
    element.onloadedmetadata = () => {
      const seconds = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null;
      // An audio element has no frame, so the dimensions are read only when the
      // browser hands back an element that carries them.
      const width = 'videoWidth' in element && element.videoWidth > 0 ? element.videoWidth : null;
      const height = 'videoHeight' in element && element.videoHeight > 0 ? element.videoHeight : null;
      finish({ durationSecs: seconds, width, height });
    };
    element.onerror = () => finish(emptyMeta());
    element.src = url;
  });
}

const emptyMeta = (): MediaMeta => ({ durationSecs: null, width: null, height: null });
