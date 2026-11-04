/**
 * A client-generated idempotency token for one send.
 *
 * Both halves of the composer need it - the thread for a text send, the file
 * queue for the message a finished upload becomes - and the column it lands in
 * is a uuid, so it comes from the platform random source rather than a counter.
 */
export function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // A non-secure context has no randomUUID, so the token is built from the
  // bytes the platform does give out, with the version and variant bits set.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join('')
  ].join('-');
}
