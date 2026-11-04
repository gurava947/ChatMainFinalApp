/**
 * Poll, contact and event cards are assembled here so the browser checks what it
 * is about to send, and so a calendar file is generated from real fields instead
 * of pasted text. The bounds mirror the server's zod schemas: a card the server
 * would reject must never leave this device.
 */

const POLL_OPTIONS_MIN = 2
const POLL_OPTIONS_MAX = 12
const POLL_OPTION_MAX_CHARS = 100
const CONTACT_NAME_MAX = 100
const EVENT_TITLE_MAX = 140

function trimmedText(value, label, max) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${label} is required.`)
  if (text.length > max) throw new Error(`${label} must be ${max} characters or fewer.`)
  return text
}

export function buildPollContent({ question, options, multiple = false } = {}) {
  const choices = (Array.isArray(options) ? options : [])
    .map((option) => String(option ?? '').trim())
    .filter(Boolean)
  const text = trimmedText(question, 'A poll question', 200)
  if (choices.length < POLL_OPTIONS_MIN) throw new Error(`Add at least ${POLL_OPTIONS_MIN} poll options.`)
  if (choices.length > POLL_OPTIONS_MAX) throw new Error(`A poll has at most ${POLL_OPTIONS_MAX} options.`)
  if (choices.some((option) => option.length > POLL_OPTION_MAX_CHARS)) {
    throw new Error(`Poll options must be ${POLL_OPTION_MAX_CHARS} characters or fewer.`)
  }
  if (new Set(choices.map((option) => option.toLowerCase())).size !== choices.length) {
    throw new Error('Poll options must be different.')
  }
  return { type: 'poll', question: text, options: choices, multiple: Boolean(multiple) }
}

export function buildContactContent({ name, phone, email, org, note } = {}) {
  const fullName = trimmedText(name, 'A contact name', CONTACT_NAME_MAX)
  const dial = String(phone ?? '').trim()
  const mail = String(email ?? '').trim()
  if (!dial && !mail) throw new Error('A contact needs a phone number or an email.')
  if (dial && !/^[+0-9 ()\-.]+$/.test(dial)) throw new Error('The phone number has unsupported characters.')
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new Error('That email address is not complete.')
  const contact = { type: 'contact', name: fullName }
  if (dial) contact.phone = dial
  if (mail) contact.email = mail
  if (String(org ?? '').trim()) contact.org = String(org).trim().slice(0, 80)
  if (String(note ?? '').trim()) contact.note = String(note).trim().slice(0, 200)
  return contact
}

export function buildEventContent({ title, start, end, allDay = false, location, note } = {}) {
  const summary = trimmedText(title, 'An event title', EVENT_TITLE_MAX)
  const from = Date.parse(start)
  if (!Number.isFinite(from)) throw new Error('Pick a start date for the event.')
  const event = { type: 'event', title: summary, start: from, allDay: Boolean(allDay) }
  if (String(end ?? '').trim()) {
    const to = Date.parse(end)
    if (!Number.isFinite(to)) throw new Error('That end date could not be read.')
    if (to <= from) throw new Error('The event must end after it starts.')
    event.end = to
  }
  if (String(location ?? '').trim()) event.location = String(location).trim().slice(0, 140)
  if (String(note ?? '').trim()) event.note = String(note).trim().slice(0, 500)
  return event
}

function icsStamp(milliseconds) {
  return new Date(Number(milliseconds) || Date.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** All-day events are DATE values; timed ones are UTC stamps, per RFC 5545. */
function icsStart(milliseconds, allDay) {
  return allDay
    ? `DTSTART;VALUE=DATE:${icsStamp(milliseconds).slice(0, 8)}`
    : `DTSTART:${icsStamp(milliseconds)}`
}

function icsEnd(event) {
  if (event.allDay) {
    // RFC 5545 dates are exclusive, so the day after the start is the day it ends.
    const nextDay = Number(event.start) + 86400000
    return `DTEND;VALUE=DATE:${icsStamp(nextDay).slice(0, 8)}`
  }
  if (event.end) return `DTEND:${icsStamp(event.end)}`
  const anHourLater = Number(event.start) + 3600000
  return `DTEND:${icsStamp(anHourLater)}`
}

function icsEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

export function icsForEvent(event, uid) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//InChat//Room events//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${icsEscape(uid || `event-${event.start}`)}@inchat`,
    `DTSTAMP:${icsStamp(Date.now())}`,
    icsStart(event.start, event.allDay),
    icsEnd(event),
    `SUMMARY:${icsEscape(event.title)}`
  ]
  if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`)
  if (event.note) lines.push(`DESCRIPTION:${icsEscape(event.note)}`)
  lines.push('END:VEVENT', 'END:VCALENDAR', '')
  // A calendar file must fold on CRLF; a LF-only file is read as one long line.
  return lines.join('\r\n')
}

/**
 * The server sends `{ totalVoters, options: [{ count, voters }] }`, so the card
 * can show real tallies and whether this device already voted.
 */
export function pollOutcome(content, results, viewerId) {
  const options = Array.isArray(results?.options) ? results.options : []
  const total = Number(results?.totalVoters) || 0
  const rows = (content.options || []).map((label, index) => {
    const entry = options[index] || {}
    const voters = Array.isArray(entry.voters) ? entry.voters : []
    return {
      label,
      count: Number(entry.count) || 0,
      share: total > 0 ? Math.round(((Number(entry.count) || 0) / total) * 100) : 0,
      mine: Boolean(viewerId) && voters.includes(viewerId)
    }
  })
  const mine = rows.some((row) => row.mine)
  const leading = rows.length ? Math.max(...rows.map((row) => row.count)) : 0
  return { total, rows, mine, leading }
}

/** A tel:/mailto: href is only built once, from the same validated fields. */
export function contactLinks(contact) {
  const links = []
  if (contact.phone) links.push({ label: contact.phone, href: `tel:${String(contact.phone).replace(/[^\d+]/g, '')}` })
  if (contact.email) links.push({ label: contact.email, href: `mailto:${contact.email}` })
  return links
}
