/**
 * "typing…" as a set of heartbeats rather than a flag.
 *
 * A peer that closes the tab mid-typing never sends the "stopped" event, so a
 * boolean would leave the indicator burning forever. Storing the instant of the
 * last signal means the indicator dies on its own, and `prune` keeps the map
 * bounded no matter how many people pass through the thread - the memory-leak
 * half of the same bug.
 */

export type TypingState = { beats: Record<string, number> };

/** A peer with no signal in this window is not typing. */
export const DEFAULT_TTL_MS = 6_000;

export function emptyTyping(): TypingState {
  return { beats: {} };
}

export function signal(state: TypingState, userId: string, now: number): TypingState {
  if (state.beats[userId] === now) return state;
  return { beats: { ...state.beats, [userId]: now } };
}

export function signalMany(state: TypingState, userIds: string[], now: number): TypingState {
  return userIds.reduce((acc, id) => signal(acc, id, now), state);
}

export function stopped(state: TypingState, userId: string): TypingState {
  if (!(userId in state.beats)) return state;
  const beats = { ...state.beats };
  delete beats[userId];
  return { beats };
}

export function active(
  state: TypingState,
  now: number,
  ttl: number = DEFAULT_TTL_MS,
  except?: string
): string[] {
  return Object.entries(state.beats)
    .filter(([userId, at]) => userId !== except && now - at < ttl)
    .sort((a, b) => a[1] - b[1])
    .map(([userId]) => userId);
}

/** Drop entries that have already expired; call it on a timer, not per render. */
export function prune(state: TypingState, now: number, ttl: number = DEFAULT_TTL_MS): TypingState {
  const beats: Record<string, number> = {};
  let removed = false;

  for (const [userId, at] of Object.entries(state.beats)) {
    if (now - at < ttl) beats[userId] = at;
    else removed = true;
  }
  return removed ? { beats } : state;
}

export function count(state: TypingState): number {
  return Object.keys(state.beats).length;
}
