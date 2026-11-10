/**
 * The one place the transfer worker is constructed.
 *
 * `new URL(..., import.meta.url)` is what lets the bundler see the worker as a
 * real entry point and emit it as a separate (module) script. Constructing it
 * any other way - a string path, a blob - would either break the build or lose
 * the imports the worker uses for chunk arithmetic.
 *
 * A browser without module workers, or a policy that blocks them, gets `null`:
 * the caller then hashes on the main thread and reports it as a slower path,
 * rather than failing a transfer the guest already started.
 */
export function createTransferWorker() {
  if (typeof Worker === 'undefined') return null
  try {
    return new Worker(new URL('./workers/transfer-worker.js', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
}
