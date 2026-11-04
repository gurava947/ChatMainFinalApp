/**
 * Reading the call log (P7). The server stores one shared record per call and
 * hands each guest the same row with a different `direction`, so all the
 * wording lives here: the same row has to read as "You missed" for one guest
 * and "No answer" for the other.
 */

const DAY_MS = 86400000

const statusText = (call) => {
  if (call.status === 'ringing') return call.direction === 'out' ? 'Calling' : 'Ringing'
  if (call.status === 'connected') return 'Ongoing'
  if (call.status === 'declined') return call.direction === 'out' ? 'Declined' : 'You declined'
  if (call.status === 'missed') return call.direction === 'out' ? 'No answer' : 'Missed'
  return 'Ended'
}

const formatClock = (timestamp) => new Date(Number(timestamp) || Date.now())
  .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function startOfDay(value) {
  const date = new Date(Number(value) || Date.now())
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Today at 09:41, yesterday as the word, older days as a date. */
export function callMoment(startedAt, now = Date.now()) {
  const offset = Math.round((startOfDay(startedAt) - startOfDay(now)) / DAY_MS)
  if (offset === 0) return formatClock(startedAt)
  if (offset === -1) return 'Yesterday'
  const date = new Date(Number(startedAt) || now)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(undefined, sameYear
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
}

/** Connected time only: a ring nobody answered has no duration to show. */
export function callDurationLabel(call) {
  if (!call || call.connectedAt == null) return ''
  const seconds = Math.max(0, Math.floor((Number(call.durationMs) || 0) / 1000))
  const mm = String(seconds % 60).padStart(2, '0')
  const total = Math.floor(seconds / 60)
  if (total < 60) return `${total}:${mm}`
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}:${mm}`
}

export function describeCall(call) {
  const kind = call.mode === 'video' ? 'video' : 'voice'
  return `${statusText(call)} ${kind} call`
}

/** Newest first, then one group per calendar day so the list can be scanned. */
export function groupCallsByDay(calls, now = Date.now()) {
  const ordered = [...calls].sort((a, b) => Number(b.startedAt) - Number(a.startedAt))
  const groups = []
  for (const call of ordered) {
    const day = startOfDay(call.startedAt)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.calls.push(call)
    else groups.push({ day, label: dayLabel(day, now), calls: [call] })
  }
  return groups
}

function dayLabel(day, now) {
  const offset = Math.round((day - startOfDay(now)) / DAY_MS)
  if (offset === 0) return 'Today'
  if (offset === -1) return 'Yesterday'
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(day))
}

/**
 * A missed call is the only one worth a callback button: the guest is the one
 * who was rung, and the record tells us who to ring back.
 */
export function canCallBack(call) {
  return Boolean(call && call.peer && call.direction === 'in')
}

export { statusText }
