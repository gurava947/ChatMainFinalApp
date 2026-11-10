/**
 * Recovery rules for a live call. Media can fail independently of signaling,
 * so the call status is driven by the peer connection and only escalates from
 * the first decisive attempt to a full rebuild when a plain ICE restart is not
 * enough.
 */
export const RECONNECT_GRACE_MS = 3000
export const RECOVERY_WINDOW_MS = 8000
export const MAX_RECOVERY_ATTEMPTS = 2

/**
 * The caller owns renegotiation. A callee that loses its media path asks the
 * caller instead of offering too, which keeps both sides from colliding.
 */
export function recoveryAction(attempt, role) {
  if (attempt >= MAX_RECOVERY_ATTEMPTS) return 'fail'
  if (role === 'outgoing') return attempt === 0 ? 'restart' : 'rebuild'
  return 'request-restart'
}

/** A failed transport is terminal; a disconnected one gets a short grace. */
export function recoveryGrace(peerState) {
  return peerState === 'failed' ? 0 : RECONNECT_GRACE_MS
}

/** The status a call resumes with once the socket is back. */
export function restoredCallStatus(peerState) {
  if (peerState === 'connected' || peerState === 'completed') return 'active'
  if (peerState === 'failed' || peerState === 'closed') return 'failed'
  return 'reconnecting'
}
