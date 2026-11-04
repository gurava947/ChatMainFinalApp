import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import {
  AlertCircle, ArrowDownLeft, ArrowLeft, ArrowUpRight, Ban, Bell, CalendarDays, Check, CheckCheck, ChevronLeft,
  ChevronRight, CircleUserRound, Clock3, Download, Ellipsis, Eye, FileText, Image, ListChecks, MapPin, Maximize2,
  Menu, MessageCircle, Mic, MicOff, Minimize2, Moon, Palette, Pause, Phone, PhoneOff, Pin, Play, Plus, Search, Send,
  Settings2, Sparkles, Square, Sun, Trash2, Video, VideoOff, X,
} from 'lucide-react'
import {
  authorizeRoom, blockGuest, CHAT_THEMES, checkRoomAccess, clearCallHistory, clearChatForMe, clearGuest, connectFeed, connectRoom, deleteChatForMe,
  deleteMessagesForMe, deleteStatus, fetchCallHistory, fetchChatSettings, fetchMyProfile, fetchProfiles,
  fetchRoomMessages, fetchStatuses, fetchStatusViewers, forgetRoom, markStatusSeen, normalizeRoomName, postMediaStatus,
  postTextStatus, readGuest, readRooms, removeAvatar, resolveGuest, roomSummary, saveGuest, saveNote, saveRoomTheme,
  saveRooms, unblockGuest, uploadAvatar, uploadStatusMedia,
} from './roomChat'
import {
  buildContactContent, buildEventContent, buildPollContent, contactLinks, icsForEvent, pollOutcome,
} from './richCards'
import { prepareFiles, readHdPreference, saveHdPreference } from './mediaPrepare'
import {
  callDuration, clampToViewport, defaultFrame, dragDelta, frameStyle, movedFrame, pointerPoint,
  readWindowMode, resizedFrame, saveWindowFrame, saveWindowMode, viewportSize,
} from './callWindow'
import {
  canNotify, openNotification, playChime, readNotifyPrefs, requestNotifyPermission,
  saveNotifyPrefs, shouldNotify,
} from './notifications'
import { callDurationLabel, callMoment, canCallBack, describeCall, groupCallsByDay } from './callHistory'
import {
  STATUS_PALETTE, STATUS_TEXT_MAX, cardSummary, canReadViewers, groupFeed, isLive, mediaKind, nextInPlay, pickColor,
  playOrder, timeLeftLabel, viewersLabel,
} from './statusFeed'
import { collectVideoClips } from './shortsFeed'
import useRoomCalls from './useRoomCalls'

const navItems = [
  { to: '/', label: 'Chats', icon: MessageCircle, end: true },
  { to: '/updates', label: 'Updates', icon: Bell },
  { to: '/shorts', label: 'Short Videos', icon: Play },
  { to: '/calls', label: 'Calls', icon: Phone },
]

let overlayHistoryId = 0

function useBackDismiss(active, onDismiss) {
  const dismissRef = useRef(onDismiss)
  const entryRef = useRef(null)
  useEffect(() => { dismissRef.current = onDismiss }, [onDismiss])
  useEffect(() => {
    if (!active) {
      const token = entryRef.current
      entryRef.current = null
      if (token && window.history.state?.inchatOverlay === token) window.history.back()
      return undefined
    }
    if (!entryRef.current) {
      const token = `inchat-overlay-${++overlayHistoryId}`
      const currentState = window.history.state
      window.history.pushState({
        ...(currentState && typeof currentState === 'object' ? currentState : {}),
        inchatOverlay: token
      }, '', window.location.href)
      entryRef.current = token
    }
    const handlePopState = () => dismissRef.current()
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [active])
}

const formatTime = (timestamp) => new Date(Number(timestamp) || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function formatMessageDay(timestamp) {
  const date = new Date(Number(timestamp) || Date.now())
  const startOfDay = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const dayOffset = Math.round((startOfDay(date) - startOfDay(new Date())) / 86400000)
  if (dayOffset === 0) return 'Today'
  if (dayOffset === -1) return 'Yesterday'
  const options = { weekday: 'long', month: 'long', day: 'numeric' }
  if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric'
  return new Intl.DateTimeFormat(undefined, options).format(date)
}

const sameMessageDay = (first, second) => {
  const a = new Date(Number(first) || Date.now())
  const b = new Date(Number(second) || Date.now())
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}

async function extractWaveform(blob, bucketCount = 48) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext
  if (!AudioContextClass) return []
  let context
  try {
    context = new AudioContextClass()
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const channel = decoded.getChannelData(0)
    const bucketSize = Math.max(1, Math.floor(channel.length / bucketCount))
    const raw = Array.from({ length: bucketCount }, (_, bucket) => {
      let peak = 0
      const end = Math.min(channel.length, (bucket + 1) * bucketSize)
      for (let index = bucket * bucketSize; index < end; index += 1) peak = Math.max(peak, Math.abs(channel[index]))
      return peak
    })
    const maximum = Math.max(...raw, 0.01)
    return raw.map((peak) => Math.max(0.08, Math.round((peak / maximum) * 100) / 100))
  } catch {
    return []
  } finally {
    if (context && context.state !== 'closed') await context.close().catch(() => {})
  }
}

function describeMessage(message) {
  if (message.text) return message.text
  if (message.content?.type === 'poll') return `Poll · ${message.content.question}`
  if (message.content?.type === 'event') return `Event · ${message.content.title}`
  if (message.content?.type === 'location') return `Location · ${message.content.label || message.content.address || 'shared'}`
  if (message.content?.type === 'contact') return `Contact · ${message.content.name}`
  if (message.content?.type === 'voice') return 'Voice message'
  if (message.attachments?.length) return `Shared ${message.attachments.length === 1 ? 'an attachment' : `${message.attachments.length} attachments`}`
  return 'Message'
}

function toUiMessage(message, session) {
  return {
    id: message.id || message.clientId,
    clientId: message.clientId,
    text: message.text || '',
    time: formatTime(message.ts),
    ts: Number(message.ts) || Date.now(),
    userId: message.userId,
    sender: message.userId === session.userId ? 'me' : 'them',
    author: message.displayName || 'Guest',
    content: message.content || null,
    // A poll's live tally travels with history, so a rejoin shows real results.
    results: message.results || null,
    seenBy: Array.isArray(message.seenBy) ? message.seenBy : [],
    deliveredTo: Array.isArray(message.deliveredTo) ? message.deliveredTo : [],
    attachments: (message.attachments || []).map((attachment) => ({
      ...attachment,
      url: attachment.url || (attachment.id ? `/media/${encodeURIComponent(attachment.id)}` : ''),
    })),
    pending: false,
    failed: false,
  }
}

function MessageAttachment({ attachment, voiceContent, onOpenMedia }) {
  const url = attachment.url || (attachment.id ? `/media/${encodeURIComponent(attachment.id)}` : '')
  if (!url) return <div className="message-attachment attachment-missing">Attachment unavailable</div>
  if (attachment.kind === 'image') {
    return <button type="button" className="message-attachment image-attachment" aria-label={`View ${attachment.name || 'shared image'} full screen`} onClick={() => onOpenMedia({ kind: 'image', url, name: attachment.name || 'Shared image' })}><img src={url} alt={attachment.name || 'Shared image'} loading="lazy" decoding="async" /></button>
  }
  if (attachment.kind === 'video') {
    const name = attachment.name || 'Shared video'
    return <div className="message-attachment video-attachment"><video className="media-video" controls playsInline preload="metadata" src={url} aria-label={name} onPlay={(event) => { const video = event.currentTarget; const initialTime = video.currentTime; video.pause(); onOpenMedia({ kind: 'video', url, name, initialTime, autoPlay: true }) }} /><button type="button" className="media-expand-button" aria-label={`Expand ${name}`} title="Expand video" onClick={() => onOpenMedia({ kind: 'video', url, name })}><Maximize2 size={16} /></button></div>
  }
  if (attachment.kind === 'audio') {
    return <AudioAttachment attachment={attachment} url={url} voiceContent={voiceContent} />
  }
  return <a className="message-attachment file-attachment" href={url} download={attachment.name || 'file'}><FileText size={18} /><span><strong>{attachment.name || 'Shared file'}</strong><small>{attachment.mime || 'File'}{attachment.size ? ` · ${(attachment.size / 1024 / 1024).toFixed(1)} MB` : ''}</small></span></a>
}

function AudioAttachment({ attachment, url, voiceContent }) {
  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(Math.max(0, Number(voiceContent?.durationMs || 0) / 1000))
  const [speed, setSpeed] = useState(1)
  const [error, setError] = useState(false)
  const peaks = voiceContent?.peaks?.length ? voiceContent.peaks.slice(0, 48) : Array.from({ length: 34 }, (_, index) => .25 + ((index * 17) % 60) / 100)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return undefined
    const onTime = () => setCurrentTime(audio.currentTime || 0)
    const onMetadata = () => { if (Number.isFinite(audio.duration)) setDuration(audio.duration) }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnded = () => { setPlaying(false); setCurrentTime(0) }
    const onError = () => { setError(true); setPlaying(false) }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMetadata)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMetadata)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
    }
  }, [url])

  const togglePlayback = () => {
    const audio = audioRef.current
    if (!audio || error) return
    if (audio.paused) audio.play().catch(() => setError(true))
    else audio.pause()
  }
  const updateSpeed = () => {
    const nextSpeed = speed >= 2 ? 1 : speed === 1 ? 1.25 : speed === 1.25 ? 1.5 : 2
    setSpeed(nextSpeed)
    if (audioRef.current) audioRef.current.playbackRate = nextSpeed
  }

  return (
    <div className={`message-attachment audio-message${error ? ' audio-message-error' : ''}`}>
      <audio ref={audioRef} preload="metadata" src={url} aria-label={attachment.name || 'Shared audio'} />
      <button type="button" className="audio-play-button" aria-label={playing ? 'Pause audio' : 'Play audio'} onClick={togglePlayback} disabled={error}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
      <div className="audio-message-main">
        {voiceContent && <strong className="audio-message-title">Voice message</strong>}
        <div className="audio-waveform" aria-hidden="true">{peaks.map((peak, index) => <i key={index} className={duration > 0 && index / peaks.length <= currentTime / duration ? 'played' : ''} style={{ height: `${Math.max(10, Math.min(100, Number(peak) * 100))}%` }} />)}</div>
        <input className="audio-seek" type="range" min="0" max={duration || 1} step="0.1" value={Math.min(currentTime, duration || 0)} aria-label="Seek audio" onChange={(event) => { if (audioRef.current) audioRef.current.currentTime = Number(event.target.value) }} disabled={error || !duration} />
        <span className="audio-time">{error ? 'Audio unavailable' : `${formatDuration(currentTime)} / ${formatDuration(duration)}`}</span>
      </div>
      <button type="button" className="audio-speed-button" onClick={updateSpeed} aria-label={`Playback speed ${speed} times`} disabled={error}>{speed}×</button>
      <a className="audio-download-button" href={url} download={attachment.name || 'audio'} aria-label="Download audio"><Download size={15} /></a>
    </div>
  )
}

function MediaViewer({ media, onClose }) {
  const videoRef = useRef(null)
  useEffect(() => {
    if (!media) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [media])
  if (!media) return null
  return (
    <div className="media-viewer" role="dialog" aria-modal="true" aria-label={`${media.kind} viewer`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <header className="media-viewer-toolbar"><strong>{media.name}</strong><button type="button" aria-label="Minimize media viewer" title="Minimize" onClick={onClose}><Minimize2 size={19} /><span>Minimize</span></button></header>
      <div className={`media-viewer-stage media-viewer-${media.kind}`}>
        {media.kind === 'image' ? <img src={media.url} alt={media.name} /> : <video ref={videoRef} src={media.url} controls playsInline preload="metadata" autoPlay={Boolean(media.autoPlay)} aria-label={media.name} onLoadedMetadata={(event) => { const video = event.currentTarget; if (Number(media.initialTime) > 0) video.currentTime = Number(media.initialTime); if (media.autoPlay) video.play().catch(() => {}) }} />}
      </div>
      {media.kind === 'video' && <a className="media-viewer-download" href={media.url} download={media.name}><Download size={16} /> Download</a>}
    </div>
  )
}

function MessageStatus({ message, userId }) {
  if (message.failed) return <span className="message-status failed" role="img" aria-label="Message failed to send" title="Message failed"><AlertCircle size={13} /></span>
  if (message.pending) return <span className="message-status pending" role="img" aria-label="Sending message" title="Sending"><Clock3 size={12} /></span>
  const readerIds = (message.seenBy || []).filter((id) => id !== userId)
  if (readerIds.length) return <span className="message-status seen" role="img" aria-label={`Seen by ${readerIds.length}`} title={`Seen by ${readerIds.length}`}><CheckCheck size={14} /></span>
  const receiverIds = (message.deliveredTo || []).filter((id) => id !== userId)
  if (receiverIds.length) return <span className="message-status delivered" role="img" aria-label="Delivered" title="Delivered"><CheckCheck size={14} /></span>
  return <span className="message-status sent" role="img" aria-label="Sent" title="Sent"><Check size={13} /></span>
}

function messageMatchesSearch(message, query, kind, period) {
  const attachments = message.attachments || []
  const contentType = message.content?.type || ''
  const now = new Date()
  const date = new Date(Number(message.ts) || Date.now())
  if (period === 'today' && !sameMessageDay(date, now)) return false
  if (period === 'week' && Date.now() - date.getTime() > 7 * 86400000) return false
  if (period === 'month' && (date.getMonth() !== now.getMonth() || date.getFullYear() !== now.getFullYear())) return false
  if (kind === 'text' && !message.text) return false
  if (kind === 'media' && !attachments.some((item) => ['image', 'video', 'audio'].includes(item.kind))) return false
  if (kind === 'image' && !attachments.some((item) => item.kind === 'image')) return false
  if (kind === 'video' && !attachments.some((item) => item.kind === 'video')) return false
  if (kind === 'audio' && !attachments.some((item) => item.kind === 'audio')) return false
  if (kind === 'files' && !attachments.some((item) => !['image', 'video', 'audio'].includes(item.kind))) return false
  if (kind === 'location' && contentType !== 'location') return false
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  const fields = [message.text, message.author, contentType, ...attachments.flatMap((item) => [item.name, item.mime])]
  if (message.content) fields.push(...Object.values(message.content).filter((value) => typeof value === 'string' || typeof value === 'number'))
  return fields.filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)
}

function highlightText(text, query) {
  if (!query) return text
  const source = String(text || '')
  const lowered = source.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  const parts = []
  let from = 0
  let found = lowered.indexOf(needle, from)
  while (found !== -1) {
    if (found > from) parts.push(source.slice(from, found))
    parts.push(<mark key={`${found}-${parts.length}`}>{source.slice(found, found + needle.length)}</mark>)
    from = found + needle.length
    found = lowered.indexOf(needle, from)
  }
  if (!parts.length) return source
  if (from < source.length) parts.push(source.slice(from))
  return parts
}

function LocationMessage({ content }) {
  const lat = Number(content?.lat)
  const lng = Number(content?.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return <div className="location-message">Location unavailable</div>
  const mapUrl = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lng)}#map=16/${encodeURIComponent(lat)}/${encodeURIComponent(lng)}`
  return (
    <div className="location-message">
      <div className="location-message-icon"><MapPin size={18} /></div>
      <div className="location-message-copy"><strong>{content.label || 'Shared location'}</strong><span>{lat.toFixed(5)}, {lng.toFixed(5)}{content.accuracyM ? ` · ±${Math.round(content.accuracyM)} m` : ''}</span><a href={mapUrl} target="_blank" rel="noreferrer">Open map</a></div>
    </div>
  )
}

function PollCard({ message, session, socket, onNotice }) {
  const content = message.content
  const outcome = pollOutcome(content, message.results, session.userId)
  const [picked, setPicked] = useState([])
  const [busy, setBusy] = useState(false)

  const toggle = (index) => setPicked((current) => (
    content.multiple
      ? (current.includes(index) ? current.filter((value) => value !== index) : [...current, index].sort((a, b) => a - b))
      : (current.includes(index) ? [] : [index])
  ))

  /** The room is told by the server's own broadcast, so the ack only clears the pick. */
  const vote = () => {
    if (!picked.length || busy) return
    if (!socket?.connected || !message.id) {
      onNotice('Reconnect to the room before voting.')
      return
    }
    setBusy(true)
    socket.timeout(10000).emit('poll:vote', { messageId: message.id, choices: picked }, (error, ack) => {
      setBusy(false)
      if (error || !ack?.results) {
        onNotice('Your vote did not reach the room. Try again.')
        return
      }
      setPicked([])
    })
  }

  return (
    <div className="message-attachment poll-card" role="group" aria-label={`Poll: ${content.question}`}>
      <strong className="poll-question">{content.question}</strong>
      <span className="poll-kind">{content.multiple ? 'Choose any that apply' : 'Choose one'}</span>
      <ul className="poll-options">
        {outcome.rows.map((row, index) => {
          const checked = picked.includes(index) || row.mine
          return (
            <li key={`${index}-${row.label}`}>
              <button type="button" className={`poll-option${checked ? ' is-checked' : ''}`} aria-pressed={checked} disabled={busy} onClick={() => toggle(index)}>
                {outcome.total > 0 && <i className="poll-bar" style={{ width: `${row.share}%` }} aria-hidden="true" />}
                <span className="poll-option-label"><i className={`poll-mark${content.multiple ? ' poll-mark-square' : ''}${checked ? ' is-on' : ''}`} />{row.label}</span>
                <span className="poll-option-tally">{row.count}<small>{row.share}%</small></span>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="poll-foot">
        <span className="poll-total">{outcome.total} {outcome.total === 1 ? 'vote' : 'votes'}{outcome.mine ? ' · you have voted' : ''}</span>
        <button type="button" className="poll-vote-button" onClick={vote} disabled={!picked.length || busy}>{busy ? 'Sending…' : 'Vote'}</button>
      </div>
    </div>
  )
}

function ContactCard({ content }) {
  const links = contactLinks(content)
  return (
    <div className="message-attachment contact-card">
      <div className="contact-card-head">
        <CircleUserRound size={26} aria-hidden="true" />
        <div><strong>{content.name}</strong>{content.org && <span>{content.org}</span>}</div>
      </div>
      {content.note && <p className="contact-card-note">{content.note}</p>}
      <div className="contact-card-links">
        {links.map((link) => <a key={link.href} href={link.href}>{link.href.startsWith('tel:') ? <Phone size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}{link.label}</a>)}
      </div>
    </div>
  )
}

function EventCard({ message, onNotice }) {
  const content = message.content
  const stamp = (milliseconds) => content.allDay
    ? new Date(Number(milliseconds)).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
    : new Date(Number(milliseconds)).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

  /** The file is assembled here from the validated fields, so it really opens in a calendar app. */
  const saveToCalendar = () => {
    const blob = new Blob([icsForEvent(content, message.id || message.clientId)], { type: 'text/calendar;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${String(content.title || 'event').replace(/[^\w-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48) || 'event'}.ics`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 4000)
    onNotice('Calendar file downloaded.')
  }

  return (
    <div className="message-attachment event-card">
      <div className="event-card-head"><CalendarDays size={20} aria-hidden="true" /><strong>{content.title}</strong></div>
      <p className="event-card-when">{stamp(content.start)}{content.end ? ` → ${stamp(content.end)}` : ''}{content.allDay ? ' · all day' : ''}</p>
      {content.location && <p className="event-card-place"><MapPin size={14} aria-hidden="true" />{content.location}</p>}
      {content.note && <p className="event-card-note">{content.note}</p>}
      <button type="button" className="event-card-save" onClick={saveToCalendar}><Download size={14} aria-hidden="true" />Add to calendar</button>
    </div>
  )
}

const richSheetFields = {
  poll: { title: 'Start a poll', eyebrow: 'POLL' },
  contact: { title: 'Share a contact', eyebrow: 'CONTACT' },
  event: { title: 'Plan an event', eyebrow: 'EVENT' }
}

function RichComposer({ kind, onClose, onSend, onCancel }) {
  const [fields, setFields] = useState(() => (
    kind === 'poll'
      ? { question: '', options: ['', ''], multiple: false }
      : kind === 'contact'
        ? { name: '', phone: '', email: '', org: '', note: '' }
        : { title: '', start: '', end: '', allDay: false, location: '', note: '' }
  ))
  const [error, setError] = useState('')

  const update = (key, value) => setFields((current) => ({ ...current, [key]: value }))
  const updateOption = (index, value) => setFields((current) => ({
    ...current,
    options: current.options.map((option, position) => (position === index ? value : option))
  }))

  const submit = (event) => {
    event.preventDefault()
    try {
      const content = kind === 'poll'
        ? buildPollContent(fields)
        : kind === 'contact'
          ? buildContactContent(fields)
          : buildEventContent(fields)
      onSend(content)
    } catch (cause) {
      setError(cause.message)
    }
  }

  return createPortal(
    <div className="room-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="room-modal rich-composer" role="dialog" aria-modal="true" aria-label={richSheetFields[kind].title}>
        <button type="button" className="room-modal-close" aria-label="Close" onClick={onClose}><X size={18} /></button>
        <p className="eyebrow">{richSheetFields[kind].eyebrow}</p>
        <h2 id="rich-composer-title">{richSheetFields[kind].title}</h2>
        <form className="room-modal-form rich-composer-form" onSubmit={submit}>
          {kind === 'poll' && <>
            <label className="field"><span>Question</span><input className="input" required maxLength={200} value={fields.question} placeholder="Which evening works?" onChange={(event) => update('question', event.target.value)} /></label>
            <div className="rich-option-list">
              {fields.options.map((option, index) => (
                <label className="field" key={index}><span>Option {index + 1}</span>
                  <div className="rich-option-row">
                    <input className="input" maxLength={100} value={option} placeholder={index === 0 ? 'Tuesday' : undefined} onChange={(event) => updateOption(index, event.target.value)} />
                    {fields.options.length > 2 && <button type="button" className="rich-option-remove" aria-label={`Remove option ${index + 1}`} onClick={() => update('options', fields.options.filter((_, position) => position !== index))}><Trash2 size={15} /></button>}
                  </div>
                </label>
              ))}
            </div>
            {fields.options.length < 12 && <button type="button" className="rich-add-option" onClick={() => update('options', [...fields.options, ''])}><Plus size={14} />Add option</button>}
            <label className="rich-check"><input type="checkbox" checked={fields.multiple} onChange={(event) => update('multiple', event.target.checked)} />Allow more than one choice</label>
          </>}
          {kind === 'contact' && <>
            <label className="field"><span>Name</span><input className="input" required maxLength={100} value={fields.name} placeholder="Asha Menon" onChange={(event) => update('name', event.target.value)} /></label>
            <label className="field"><span>Phone</span><input className="input" maxLength={40} value={fields.phone} placeholder="+91 98765 43210" onChange={(event) => update('phone', event.target.value)} /></label>
            <label className="field"><span>Email</span><input className="input" type="email" maxLength={120} value={fields.email} placeholder="asha@example.com" onChange={(event) => update('email', event.target.value)} /></label>
            <label className="field"><span>Organisation</span><input className="input" maxLength={80} value={fields.org} onChange={(event) => update('org', event.target.value)} /></label>
            <label className="field"><span>Note</span><input className="input" maxLength={200} value={fields.note} placeholder="Best reached before 6 pm" onChange={(event) => update('note', event.target.value)} /></label>
          </>}
          {kind === 'event' && <>
            <label className="field"><span>Title</span><input className="input" required maxLength={140} value={fields.title} placeholder="Design review" onChange={(event) => update('title', event.target.value)} /></label>
            <label className="field"><span>Starts</span><input className="input" required type={fields.allDay ? 'date' : 'datetime-local'} value={fields.start} onChange={(event) => update('start', event.target.value)} /></label>
            <label className="field"><span>Ends (optional)</span><input className="input" type={fields.allDay ? 'date' : 'datetime-local'} value={fields.end} onChange={(event) => update('end', event.target.value)} /></label>
            <label className="rich-check"><input type="checkbox" checked={fields.allDay} onChange={(event) => update('allDay', event.target.checked)} />All-day event</label>
            <label className="field"><span>Place</span><input className="input" maxLength={140} value={fields.location} placeholder="Room 4" onChange={(event) => update('location', event.target.value)} /></label>
            <label className="field"><span>Note</span><textarea className="input" rows={2} maxLength={500} value={fields.note} onChange={(event) => update('note', event.target.value)} /></label>
          </>}
          {error && <p className="rich-composer-error" role="alert">{error}</p>}
          <div className="rich-composer-actions">
            <button type="button" className="btn" onClick={onCancel}>Cancel</button>
            <button type="submit" className="btn btn-primary rich-composer-send"><ListChecks size={15} />Share with the room</button>
          </div>
        </form>
      </section>
    </div>,
    document.body
  )
}

function mergeMessage(list, incoming) {
  const index = list.findIndex((item) => item.id === incoming.id || (incoming.clientId && item.clientId === incoming.clientId))
  if (index < 0) return [...list, incoming].sort((a, b) => a.ts - b.ts)
  const next = [...list]
  next[index] = { ...next[index], ...incoming, pending: false, failed: false }
  return next.sort((a, b) => a.ts - b.ts)
}

function BrandMark() {
  return (
    <div className="brand-mark" role="img" aria-label="InChat India logo">
      <img className="brand-map" src="/inchat-logo.png" alt="" aria-hidden="true" />
    </div>
  )
}

function ThemeToggle({ dark, onToggle }) {
  return (
    <button className="icon-button theme-toggle" aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} onClick={onToggle}>
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  )
}

/** The About note is stored on the server under the guest session, so it survives a reload. */
function ProfileSheet({ guest, profile, onProfileChange, onClose }) {
  const [note, setNote] = useState(profile ? profile.note : null)
  const [avatar, setAvatar] = useState(profile ? profile.avatar : null)
  const [draft, setDraft] = useState(profile?.note?.text || '')
  const [status, setStatus] = useState(profile ? '' : 'Loading your profile…')
  const [saving, setSaving] = useState(false)
  const [pictureBusy, setPictureBusy] = useState(false)
  const fileInputRef = useRef(null)

  useEffect(() => {
    if (profile) {
      setNote(profile.note)
      setAvatar(profile.avatar)
      setDraft(profile.note.text)
      setStatus('')
      return
    }
    let active = true
    fetchMyProfile(guest)
      .then((loaded) => {
        if (!active) return
        setNote(loaded.note)
        setAvatar(loaded.avatar)
        setDraft(loaded.note.text)
        setStatus('')
        onProfileChange?.(loaded)
      })
      .catch((error) => { if (active) setStatus(error.message) })
    return () => { active = false }
  }, [profile, guest, onProfileChange])

  const submit = async (event) => {
    event.preventDefault()
    setSaving(true)
    setStatus('')
    try {
      const saved = await saveNote(guest, draft.trim())
      setNote(saved)
      setDraft(saved.text)
      setStatus('Saved.')
    } catch (error) {
      setStatus(error.message)
    } finally {
      setSaving(false)
    }
  }

  const pickPicture = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setPictureBusy(true)
    setStatus('')
    try {
      const uploaded = await uploadAvatar(guest, file)
      setAvatar(uploaded)
      onProfileChange?.({ userId: guest.userId, displayName: guest.displayName, note, avatar: uploaded })
      setStatus('Profile picture updated.')
    } catch (error) {
      setStatus(error.message)
    } finally {
      setPictureBusy(false)
    }
  }

  const dropPicture = async () => {
    setPictureBusy(true)
    setStatus('')
    try {
      await removeAvatar(guest)
      setAvatar(null)
      onProfileChange?.({ userId: guest.userId, displayName: guest.displayName, note, avatar: null })
      setStatus('Profile picture removed.')
    } catch (error) {
      setStatus(error.message)
    } finally {
      setPictureBusy(false)
    }
  }

  return createPortal(
    <div className="room-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="room-modal profile-sheet" role="dialog" aria-modal="true" aria-label="My profile">
        <button className="room-modal-close" type="button" aria-label="Close profile" onClick={onClose}><X size={18} /></button>
        <p className="eyebrow">MY PROFILE</p>
        <h2>{guest.displayName}</h2>
        <div className="profile-avatar-row">
          <AvatarFace className="profile-avatar" src={avatar?.url} initials={initialsOf(guest.displayName)} />
          <div className="profile-avatar-actions">
            <input ref={fileInputRef} className="file-input-hidden" type="file" accept="image/*" aria-label="Choose a profile picture" onChange={pickPicture} disabled={pictureBusy} />
            <button className="btn" type="button" disabled={pictureBusy} onClick={() => fileInputRef.current?.click()}><Image size={15} /> {avatar ? 'Change picture' : 'Add picture'}</button>
            {avatar ? <button className="btn btn-danger" type="button" disabled={pictureBusy} onClick={dropPicture}><Trash2 size={15} /> Remove</button> : null}
            <small role="status">{pictureBusy ? 'Uploading…' : ''}</small>
          </div>
        </div>
        <div className="profile-facts">
          <p><span>Guest id</span><code>{guest.userId}</code></p>
          {guest.expiresAt ? <p><span>Session ends</span><strong>{new Date(guest.expiresAt).toLocaleString()}</strong></p> : null}
          {avatar?.updatedAt ? <p><span>Picture</span><strong>{new Date(avatar.updatedAt).toLocaleString()}</strong></p> : null}
        </div>
        <form className="profile-note-form" onSubmit={submit}>
          <label className="field"><span>About</span>
            <textarea className="input" rows={3} maxLength={500} value={draft} placeholder="Say something about yourself" disabled={note === null} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <div className="profile-note-actions">
            <button className="btn btn-primary" type="submit" disabled={saving || note === null}>{saving ? 'Saving…' : 'Save about'}</button>
            <small role="status">{status}</small>
          </div>
          {note?.updatedAt ? <small className="text-muted">Updated {new Date(note.updatedAt).toLocaleString()}</small> : null}
        </form>
      </section>
    </div>,
    document.body,
  )
}

function RoomsSheet({ rooms, onForgetRoom, onClose }) {
  const [copied, setCopied] = useState('')
  const [clipboardBlocked, setClipboardBlocked] = useState(false)

  const copyRoom = async (room) => {
    try {
      await navigator.clipboard.writeText(room.id)
      setCopied(room.id)
      window.setTimeout(() => setCopied((current) => (current === room.id ? '' : current)), 2000)
    } catch {
      setClipboardBlocked(true)
    }
  }

  return createPortal(
    <div className="room-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="room-modal rooms-sheet" role="dialog" aria-modal="true" aria-label="Rooms on this device">
        <button className="room-modal-close" type="button" aria-label="Close rooms list" onClick={onClose}><X size={18} /></button>
        <p className="eyebrow">THIS DEVICE</p>
        <h2>Your rooms</h2>
        {clipboardBlocked && <p className="room-form-error" role="alert">This browser blocked the clipboard. Share the name shown below instead.</p>}
        {rooms.length ? (
          <ul className="rooms-sheet-list">
            {rooms.map((room) => (
              <li key={room.id}>
                <div><strong>{room.name}</strong><small>#{room.id}</small></div>
                <div className="rooms-sheet-actions">
                  <button type="button" className="btn" onClick={() => copyRoom(room)}>{copied === room.id ? 'Copied' : 'Copy name'}</button>
                  <button type="button" className="btn" onClick={() => onForgetRoom(room.id)}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="room-modal-copy">You have not joined a room on this device yet.</p>}
        <p className="rooms-sheet-note">Removing a room only clears it from this device list.</p>
      </section>
    </div>,
    document.body,
  )
}

/**
 * A profile picture is only ever shown when the server has one; without it the
 * app falls back to initials rather than inventing an image.
 */
function AvatarFace({ src, initials, className }) {
  return <div className={className}>{src ? <img src={src} alt="" /> : initials}</div>
}

function initialsOf(name, fallback = 'G') {
  return name?.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || fallback
}

function ProfileMenu({ guest, profile, onClose, onOpenProfile, onOpenRooms, onSignOut }) {
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const initials = initialsOf(guest?.displayName)
  return (
    <div className="profile-menu" role="menu" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <div className="profile-menu-head"><AvatarFace className="avatar avatar-sm avatar-teal" src={profile?.avatar?.url} initials={initials} /><div><strong>{guest?.displayName || 'No profile yet'}</strong><span>{guest ? 'Guest session · no account' : 'Join a room to start one'}</span></div></div>
      <div className="menu-divider" />
      <button role="menuitem" onClick={onOpenProfile} disabled={!guest}><CircleUserRound size={17} /> My profile &amp; about</button>
      <button role="menuitem" onClick={onOpenRooms}><MessageCircle size={17} /> Rooms on this device <ChevronRight size={15} /></button>
      {guest && (confirmingSignOut ? (
        <div className="menu-confirm">
          <button role="menuitem" className="menu-danger" onClick={onSignOut}>Confirm sign out</button>
          <button role="menuitem" onClick={() => setConfirmingSignOut(false)}>Keep session</button>
        </div>
      ) : (
        <button role="menuitem" onClick={() => setConfirmingSignOut(true)}><X size={17} /> Sign out of this device</button>
      ))}
    </div>
  )
}

function AppHeader({ dark, onToggle, guest, profile, rooms, onForgetRoom, onProfileChange, onSignOut }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [sheet, setSheet] = useState(null)
  const closeMenu = () => setMenuOpen(false)
  useBackDismiss(menuOpen || Boolean(sheet), () => {
    if (sheet) setSheet(null)
    else setMenuOpen(false)
  })
  return (
    <header className="app-header">
      <div className="brand-lockup"><BrandMark /><div><strong>INchat</strong></div></div>
      <div className="header-actions">
        <ThemeToggle dark={dark} onToggle={onToggle} />
        <div className="menu-wrap">
          <button className="icon-button" aria-label="Open guest menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><Ellipsis size={21} /></button>
          {menuOpen && (
            <ProfileMenu
              guest={guest}
              profile={profile}
              onClose={closeMenu}
              onOpenProfile={() => { closeMenu(); setSheet('profile') }}
              onOpenRooms={() => { closeMenu(); setSheet('rooms') }}
              onSignOut={() => { closeMenu(); onSignOut() }}
            />
          )}
        </div>
      </div>
      {sheet === 'profile' && guest && <ProfileSheet guest={guest} profile={profile} onProfileChange={onProfileChange} onClose={() => setSheet(null)} />}
      {sheet === 'rooms' && <RoomsSheet rooms={rooms} onForgetRoom={onForgetRoom} onClose={() => setSheet(null)} />}
    </header>
  )
}

function SearchBar({ value, onChange, count }) {
  const [focused, setFocused] = useState(false)
  return (
    <div className={`search-wrap ${focused ? 'focused' : ''}`}>
      <Search size={18} aria-hidden="true" />
      <input value={value} onChange={(event) => onChange(event.target.value)} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)} placeholder="Search your rooms" aria-label="Search your rooms" />
      {value && <button className="clear-search" aria-label="Clear search" onMouseDown={(event) => event.preventDefault()} onClick={() => onChange('')}><X size={16} /></button>}
      {focused && !value && <div className="search-hint"><Sparkles size={14} /> Find a room you have joined on this device</div>}
      {value && <span className="result-count">{count}</span>}
    </div>
  )
}

function Avatar({ chat, small = false }) {
  return <div className={`avatar ${small ? 'avatar-sm' : ''} avatar-${chat.color || 'teal'}`}>{chat.initials}{chat.online && <i className="online-dot" />}</div>
}

function ChatItem({ chat, active, onSelect }) {
  return (
    <button className={`chat-item ${active ? 'active' : ''}`} onClick={() => onSelect(chat)} aria-current={active ? 'true' : undefined}>
      <Avatar chat={chat} />
      <span className="chat-copy"><span className="chat-topline"><strong>{chat.name}</strong>{chat.pinned && <Pin size={13} className="pin-icon" />}</span><span className="chat-preview">{chat.message || 'Room is ready — say hello.'}</span></span>
      <span className="chat-meta"><small>{chat.time || ''}</small>{chat.unread > 0 && <b>{chat.unread}</b>}</span>
    </button>
  )
}

function ChatList({ chats, activeId, onSelect, onCreate, hasQuery }) {
  if (!chats.length) {
    return <div className="empty-state"><div className="empty-icon"><Search size={21} /></div><h3>{hasQuery ? 'No rooms found' : 'No rooms yet'}</h3><p>{hasQuery ? 'Try a different room name.' : 'Create a room or join one by name to start chatting.'}</p>{!hasQuery && <button className="empty-create-button" type="button" onClick={onCreate}><Plus size={15} /> Create or join a room</button>}</div>
  }
  return <div className="chat-list">{chats.map((chat) => <ChatItem key={chat.id} chat={chat} active={activeId === chat.id} onSelect={onSelect} />)}</div>
}

/** A `self-<uuid>` room belongs to one guest, so deleting it really empties it. */
const isSelfRoom = (roomId) => String(roomId || '').startsWith('self-')

function formatRelative(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - Number(timestamp)) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  return new Date(Number(timestamp)).toLocaleDateString()
}

/**
 * Room settings for this guest only. Each action writes to the server under the
 * session id, so a reload — or another device signed in as the same guest —
 * comes back with the same block list, palette and cleared watermark.
 */
function ChatSettingsSheet({ chat, session, settings, onClose, onSettingsChange, onHistoryRefresh, onChatDeleted }) {  const [pending, setPending] = useState('')
  const [status, setStatus] = useState('')
  const [confirming, setConfirming] = useState('')
  const [hd, setHd] = useState(readHdPreference)
  const [notify, setNotify] = useState(readNotifyPrefs)
  const [permission, setPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)

  const changeNotify = async (patch) => {
    if (patch.enabled) {
      const outcome = await requestNotifyPermission()
      setPermission(outcome)
      if (outcome !== 'granted') {
        setStatus(outcome === 'unsupported'
          ? 'This browser has no notification support.'
          : 'The browser refused notifications. Allow them for this site in its settings, then switch alerts back on.')
        return
      }
      setStatus('Alerts are on for this device. Nothing changes for anybody else in the room.')
    }
    setNotify(saveNotifyPrefs({ ...notify, ...patch }))
    if (patch.sound) playChime()
  }

  const run = async (key, action, successText) => {
    setPending(key)
    setStatus('')
    try {
      const outcome = await action()
      setStatus(typeof successText === 'function' ? successText(outcome) : successText)
    } catch (error) {
      setStatus(error.message)
    } finally {
      setPending('')
      setConfirming('')
    }
  }

  const chooseTheme = (theme) => run(`theme-${theme}`, async () => {
    const saved = await saveRoomTheme(session, chat.id, theme)
    onSettingsChange({ ...settings, theme: saved })
  }, `Palette set to ${CHAT_THEMES.find((item) => item.id === theme)?.label || theme}.`)

  const unblock = (target) => run(`unblock-${target.userId}`, async () => {
    const blocked = await unblockGuest(session, target.userId)
    onSettingsChange({ ...settings, blocked })
    await onHistoryRefresh()
  }, `${target.displayName || 'That guest'} is unblocked.`)

  const clearChat = () => run('clear', async () => {
    const cleared = await clearChatForMe(session, chat.id)
    onSettingsChange({ ...settings, ...cleared })
  }, 'History cleared for you. New messages still arrive.')

  const deleteChat = () => run('delete', async () => {
    const result = await deleteChatForMe(session, chat.id)
    onChatDeleted(result)
    return result
  }, (result) => (result.selfRoomDeleted
    ? `Your room was emptied — ${result.removed} message${result.removed === 1 ? '' : 's'} gone.`
    : 'This chat is hidden for you and gone from this device.'))

  return createPortal(
    <div className="room-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="room-modal chat-settings-sheet" role="dialog" aria-modal="true" aria-label={`Chat settings for ${chat.name}`}>
        <button className="room-modal-close" type="button" aria-label="Close chat settings" onClick={onClose}><X size={18} /></button>
        <p className="eyebrow">CHAT SETTINGS</p>
        <h2>{chat.name}</h2>
        <p className="room-modal-copy">Everything here applies to <strong>your</strong> view of #{chat.id}. Other guests keep their history.</p>

        <h3 className="settings-group-title"><Palette size={15} /> Chat theme</h3>
        <div className="theme-swatches">
          {CHAT_THEMES.map((theme) => (
            <button key={theme.id} type="button" className={`theme-swatch theme-swatch-${theme.id}${settings.theme === theme.id ? ' selected' : ''}`} aria-pressed={settings.theme === theme.id} onClick={() => chooseTheme(theme.id)} disabled={Boolean(pending)}>
              <span className="theme-swatch-bubble" />{theme.label}
            </button>
          ))}
        </div>

        <h3 className="settings-group-title"><Image size={15} /> Outgoing media</h3>
        <label className="settings-switch-row">
          <span>
            <strong>Send in HD</strong>
            <small>{hd ? 'Pictures keep their original size and pixels.' : 'Pictures are shrunk to 1600px before sending. This only changes what you send from this device.'}</small>
          </span>
          <input type="checkbox" role="switch" className="settings-switch" checked={hd} onChange={(event) => setHd(saveHdPreference(event.target.checked))} />
        </label>

        <h3 className="settings-group-title"><Bell size={15} /> Alerts</h3>
        <div className="settings-switch-row">
          <span>
            <strong>Notify me</strong>
            <small>{permission === 'granted' ? 'The browser lets this site raise alerts.' : permission === 'denied' ? 'Blocked by the browser — allow notifications for this site first.' : permission === 'unsupported' ? 'This browser cannot raise notifications.' : 'Off until you allow the browser prompt.'}</small>
          </span>
          <input type="checkbox" role="switch" className="settings-switch" aria-label="Turn alerts on for this device" checked={notify.enabled} disabled={permission === 'unsupported' || permission === 'denied'} onChange={(event) => changeNotify({ enabled: event.target.checked })} />
        </div>
        <div className="settings-switch-row">
          <span><strong>Play a chime</strong><small>A short tone on this device when a message lands.</small></span>
          <input type="checkbox" role="switch" className="settings-switch" aria-label="Play a chime" checked={notify.sound} disabled={!notify.enabled} onChange={(event) => changeNotify({ sound: event.target.checked })} />
        </div>
        <div className="settings-switch-row">
          <span><strong>Show the message</strong><small>Off means the alert only says a new message arrived.</small></span>
          <input type="checkbox" role="switch" className="settings-switch" aria-label="Show the message text in alerts" checked={notify.preview} disabled={!notify.enabled} onChange={(event) => setNotify(saveNotifyPrefs({ ...notify, preview: event.target.checked }))} />
        </div>
        <label className="rich-check">
          <input type="checkbox" checked={notify.mentionsOnly} disabled={!notify.enabled} onChange={(event) => setNotify(saveNotifyPrefs({ ...notify, mentionsOnly: event.target.checked }))} />
          Only when someone says my name
        </label>

        <h3 className="settings-group-title"><Ban size={15} /> Blocked guests</h3>
        {settings.blocked.length ? (
          <ul className="blocked-list">
            {settings.blocked.map((target) => (
              <li key={target.userId}>
                <div><strong>{target.displayName || 'A guest'}</strong><small>Blocked {formatRelative(target.blockedAt)}</small></div>
                <button type="button" className="btn" onClick={() => unblock(target)} disabled={pending === `unblock-${target.userId}`}>{pending === `unblock-${target.userId}` ? 'Unblocking…' : 'Unblock'}</button>
              </li>
            ))}
          </ul>
        ) : <p className="settings-empty">Nobody is blocked. Blocking hides a guest's messages for you and is reversible.</p>}

        <h3 className="settings-group-title"><Trash2 size={15} /> History</h3>
        <div className="settings-danger-actions">
          {confirming === 'clear' ? (
            <div className="settings-confirm">
              <button type="button" className="btn btn-danger" onClick={clearChat} disabled={Boolean(pending)}>Yes, clear my history</button>
              <button type="button" className="btn" onClick={() => setConfirming('')}>Keep it</button>
            </div>
          ) : <button type="button" className="btn" onClick={() => setConfirming('clear')}><ListChecks size={15} /> Clear chat for me</button>}
          {confirming === 'delete' ? (
            <div className="settings-confirm">
              <button type="button" className="btn btn-danger" onClick={deleteChat} disabled={Boolean(pending)}>Yes, delete this chat</button>
              <button type="button" className="btn" onClick={() => setConfirming('')}>Cancel</button>
            </div>
          ) : <button type="button" className="btn btn-danger" onClick={() => setConfirming('delete')}><Trash2 size={15} /> Delete chat</button>}
        </div>
        <p className="settings-note">{isSelfRoom(chat.id)
          ? 'This is your own room, so deleting empties it completely.'
          : 'Deleting hides the room for you and forgets it on this device. Other guests keep their copy.'}</p>
        {status && <p className="settings-status" role="status">{status}</p>}
      </section>
    </div>,
    document.body
  )
}

function ChatPreview({ chat, session, onClose, onLatestMessage, onChatRemoved, autoCall, onAutoCallHandled }) {
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState([])
  const [connection, setConnection] = useState('Connecting…')
  const [presenceCount, setPresenceCount] = useState(0)
  const [notice, setNotice] = useState('')
  const [socket, setSocket] = useState(null)
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [messageSearchOpen, setMessageSearchOpen] = useState(false)
  const [messageSearchText, setMessageSearchText] = useState('')
  const [messageSearchKind, setMessageSearchKind] = useState('all')
  const [messageSearchPeriod, setMessageSearchPeriod] = useState('all')
  const [messageSearchIndex, setMessageSearchIndex] = useState(0)
  const [mediaViewer, setMediaViewer] = useState(null)
  const [richSheet, setRichSheet] = useState(null)
  const [chatSettings, setChatSettings] = useState({ blocked: [], clearedAt: 0, theme: 'default', hidden: [] })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [authorMenu, setAuthorMenu] = useState(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [profiles, setProfiles] = useState({})
  const socketRef = useRef(null)
  /** The lookup effect reads this instead of `profiles`, so adding rows cannot re-trigger it. */
  const profilesRef = useRef(profiles)
  useEffect(() => { profilesRef.current = profiles }, [profiles])
  const noticeTimerRef = useRef(null)
  const messagesEndRef = useRef(null)
  const previewBodyRef = useRef(null)
  const messageNodesRef = useRef(new Map())
  const seenQueueRef = useRef(new Set())
  const seenSentRef = useRef(new Set())
  const seenFlushTimerRef = useRef(null)
  const galleryInputRef = useRef(null)
  const fileInputRef = useRef(null)
  const recorderRef = useRef(null)
  const recordingStreamRef = useRef(null)
  const recordingChunksRef = useRef([])
  const recordingStartRef = useRef(0)
  const calls = useRoomCalls(socket, chat.id, session)
  const chatOverlayOpen = attachmentMenuOpen || calls.pickerMode || messageSearchOpen || settingsOpen || Boolean(richSheet) || Boolean(mediaViewer)
  useBackDismiss(chatOverlayOpen, () => {
    if (mediaViewer) setMediaViewer(null)
    else if (richSheet) setRichSheet(null)
    else if (settingsOpen) setSettingsOpen(false)
    else if (messageSearchOpen) setMessageSearchOpen(false)
    else if (calls.pickerMode) calls.closePicker()
    else setAttachmentMenuOpen(false)
  })
  /**
   * A guest's settings decide what this device shows. The server already filters
   * history reads, and it never stores another guest's copy, so this list is the
   * same view applied live to messages that arrive over the socket.
   */
  const hiddenIds = useMemo(() => new Set(chatSettings.hidden), [chatSettings.hidden])
  const blockedIds = useMemo(() => new Set(chatSettings.blocked.map((target) => target.userId)), [chatSettings.blocked])
  const isHiddenForViewer = useCallback((message) => {
    if (!message?.id) return false
    if (hiddenIds.has(message.id) || blockedIds.has(message.userId)) return true
    return Boolean(chatSettings.clearedAt) && Number(message.ts) <= chatSettings.clearedAt
  }, [hiddenIds, blockedIds, chatSettings.clearedAt])
  const visibleMessages = useMemo(() => messages.filter((message) => !isHiddenForViewer(message)), [messages, isHiddenForViewer])
  /** The socket handlers are bound once per room, so they read the filter through a ref. */
  const hiddenCheckRef = useRef(() => false)
  useEffect(() => { hiddenCheckRef.current = isHiddenForViewer }, [isHiddenForViewer])
  const searchMatches = useMemo(() => visibleMessages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => messageMatchesSearch(message, messageSearchText, messageSearchKind, messageSearchPeriod)),
  [visibleMessages, messageSearchText, messageSearchKind, messageSearchPeriod])
  const searchHasFilter = Boolean(messageSearchText.trim() || messageSearchKind !== 'all' || messageSearchPeriod !== 'all')
  const searchIsActive = messageSearchOpen && searchHasFilter
  const displayedMessages = useMemo(() => searchIsActive ? searchMatches.map((item) => item.message) : visibleMessages, [searchIsActive, searchMatches, visibleMessages])

  const showNotice = (text) => {
    setNotice(text)
    window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(''), 3500)
  }

  /**
   * A call-back from the log asks this room to ring one guest. It can only be
   * honoured once the room has said who is online, so it waits for a presence
   * snapshot that contains them and then says so plainly when it never arrives -
   * an invitation to somebody who has left would go nowhere without a trace.
   */
  useEffect(() => {
    if (!autoCall) return undefined
    if (calls.call) {
      onAutoCallHandled?.()
      showNotice('You are already in a call, so this one was not started.')
      return undefined
    }
    const peer = calls.peers.find((person) => person.userId === autoCall.userId)
    if (peer) {
      onAutoCallHandled?.()
      calls.startCall(peer, autoCall.mode)
      return undefined
    }
    const timer = window.setTimeout(() => {
      onAutoCallHandled?.()
      showNotice(`${autoCall.displayName || 'That guest'} is not in ${chat.name || chat.id} right now, so there is nobody to call back.`)
    }, 5000)
    return () => window.clearTimeout(timer)
    // The request is consumed once; the peer list only moves with room presence.
  }, [autoCall, calls.peers, calls.call])

  const flushSeen = () => {
    const roomSocket = socketRef.current
    if (!roomSocket?.connected) return
    const ids = Array.from(seenQueueRef.current).slice(0, 50)
    if (!ids.length) return
    ids.forEach((id) => { seenQueueRef.current.delete(id); seenSentRef.current.add(id) })
    roomSocket.emit('message:seen', { ids })
    if (seenQueueRef.current.size) seenFlushTimerRef.current = window.setTimeout(flushSeen, 250)
  }

  const queueSeenMessage = (id) => {
    if (!id || seenSentRef.current.has(id)) return
    seenQueueRef.current.add(id)
    window.clearTimeout(seenFlushTimerRef.current)
    seenFlushTimerRef.current = window.setTimeout(flushSeen, 180)
  }

  const blockThisGuest = async (target) => {
    setAuthorMenu(null)
    try {
      const blocked = await blockGuest(session, target)
      setChatSettings((current) => ({ ...current, blocked }))
      showNotice(`${target.displayName || 'That guest'} is blocked. You will not see their messages here.`)
    } catch (error) {
      showNotice(error.message)
    }
  }

  /**
   * While an author was blocked the server skipped this device, so their messages
   * are missing locally rather than hidden. Reading history again after an
   * unblock puts those rows back in this room's memory.
   */
  const reloadHistory = async () => {
    try {
      const rows = await fetchRoomMessages(session, chat.id)
      const history = rows.map((message) => toUiMessage(message, session))
      setMessages((current) => history.reduce(mergeMessage, current.filter((message) => message.pending || message.failed)))
    } catch (error) {
      showNotice(error.message)
    }
  }

  const toggleSelectMode = () => {
    setSelectMode((current) => {
      if (current) setSelectedIds(new Set())
      return !current
    })
  }

  const toggleSelected = (id) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const deleteSelectedForMe = async () => {
    const ids = Array.from(selectedIds)
    if (!ids.length) return
    try {
      const hidden = await deleteMessagesForMe(session, chat.id, ids)
      setChatSettings((current) => ({ ...current, hidden }))
      setSelectedIds(new Set())
      setSelectMode(false)
      showNotice(`${ids.length} message${ids.length === 1 ? '' : 's'} deleted for you.`)
    } catch (error) {
      showNotice(error.message)
    }
  }

  const settingsSheetProps = {
    chat,
    session,
    settings: chatSettings,
    onClose: () => setSettingsOpen(false),
    onSettingsChange: setChatSettings,
    onHistoryRefresh: reloadHistory,
    onChatDeleted: (result) => {
      showNotice(result.selfRoomDeleted
        ? `Your room was emptied — ${result.removed} message${result.removed === 1 ? '' : 's'} gone.`
        : 'Chat deleted for you.')
      if (onChatRemoved) onChatRemoved(chat.id)
    }
  }

  const navigateSearch = (step) => {
    if (!searchMatches.length) return
    setMessageSearchIndex((current) => (current + step + searchMatches.length) % searchMatches.length)
  }

  const closeMessageSearch = () => {
    setMessageSearchOpen(false)
    setMessageSearchText('')
    setMessageSearchKind('all')
    setMessageSearchPeriod('all')
    setMessageSearchIndex(0)
  }

  /**
   * This device decides for itself. Nothing is sent to the server and no other
   * guest is affected: a message only earns attention if this guest turned
   * alerts on, and only when they are not already looking at this room.
   */
  const alertForMessage = (item) => {
    const prefs = readNotifyPrefs()
    const away = document.hidden || !document.hasFocus()
    if (!shouldNotify(item, { prefs, ownUserId: session.userId, activeRoomId: away ? null : chat.id })) return
    if (prefs.sound) playChime()
    if (canNotify()) {
      try {
        openNotification({ ...item, room: chat.name || chat.id }, { onOpenRoom: () => window.focus() })
      } catch {
        // A blocked or crashed notification service must never break the room.
      }
    }
  }

  // A call arriving in a tab nobody is looking at has to be louder than a message.
  useEffect(() => {
    if (calls.call?.status !== 'incoming') return undefined
    const prefs = readNotifyPrefs()
    if (prefs.sound) playChime()
    if (prefs.enabled && canNotify() && (document.hidden || !document.hasFocus())) {
      try {
        openNotification({ id: calls.call.callId, room: chat.name || chat.id, displayName: calls.call.peerName, text: `${calls.call.mode} call` }, {})
      } catch {
        // Notification delivery is best effort; the in-app ringing UI still shows.
      }
    }
    return undefined
  }, [calls.call?.status, calls.call?.callId])

  useEffect(() => {
    const roomSocket = connectRoom(session, chat.id)
    socketRef.current = roomSocket
    setSocket(roomSocket)
    roomSocket.on('connect', () => {
      setConnection('Connected')
      window.setTimeout(flushSeen, 180)
    })
    roomSocket.on('disconnect', () => setConnection('Reconnecting…'))
    roomSocket.on('connect_error', () => setConnection('Retrying connection…'))
    roomSocket.on('history', (payload) => {
      if (payload.room !== chat.id) return
      const history = (payload.messages || []).map((message) => toUiMessage(message, session))
      setMessages((current) => {
        const pending = current.filter((message) => message.pending || message.failed)
        return history.reduce(mergeMessage, pending)
      })
      if (history.length) onLatestMessage(chat.id, history[history.length - 1])
    })
    roomSocket.on('new_message', (message) => {
      if (message.room !== chat.id) return
      // A guest this device blocked, or a message it deleted or cleared away, is
      // not this viewer's to keep — so it is dropped before it is ever stored,
      // which also means no delivery receipt is reported for it.
      if (hiddenCheckRef.current(message)) return
      const item = toUiMessage(message, session)
      setMessages((current) => mergeMessage(current, item))
      onLatestMessage(chat.id, item)
      // The message is in this device's memory now, so this is the honest moment
      // to report delivery. Presence would only say a socket was open.
      if (item.sender !== 'me' && message.id) roomSocket.emit('message:delivered', { ids: [message.id] })
      alertForMessage(item)
    })
    roomSocket.on('message_delivered', (receipt) => {
      setMessages((current) => current.map((message) => {
        if (message.id !== receipt.messageId) return message
        const deliveredTo = new Set(message.deliveredTo || [])
        if (receipt.userId) deliveredTo.add(receipt.userId)
        return { ...message, deliveredTo: Array.from(deliveredTo) }
      }))
    })
    roomSocket.on('message_seen', (receipt) => {
      setMessages((current) => current.map((message) => {
        if (message.id !== receipt.messageId) return message
        const seenBy = new Set(message.seenBy || [])
        if (receipt.userId) seenBy.add(receipt.userId)
        return { ...message, seenBy: Array.from(seenBy) }
      }))
    })
    roomSocket.on('poll_voted', (payload) => {
      if (payload.room !== chat.id || !payload.results) return
      setMessages((current) => current.map((message) => (
        message.id === payload.messageId ? { ...message, results: payload.results } : message
      )))
    })
    roomSocket.on('presence', (snapshot) => setPresenceCount(Number(snapshot.connections) || 0))
    roomSocket.on('system', (payload) => {
      if (payload.type === 'error') showNotice(payload.message || 'Room connection error.')
    })
    return () => {
      roomSocket.disconnect()
      socketRef.current = null
      window.clearTimeout(noticeTimerRef.current)
      window.clearTimeout(seenFlushTimerRef.current)
    }
    // Room and guest identity define one socket lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id, session.userId])

  useEffect(() => {
    let active = true
    fetchChatSettings(session, chat.id)
      .then((loaded) => { if (active) setChatSettings(loaded) })
      .catch(() => { /* defaults keep the room usable if settings cannot load */ })
    return () => { active = false }
  }, [chat.id, session.userId])

  /**
   * Sender pictures come from the profile store, keyed by session id. Only the
   * ids this room has not been looked up yet are requested, so a long transcript
   * costs one batch per new guest rather than one request per message.
   */
  useEffect(() => {
    const missing = [...new Set(
      messages
        .filter((message) => message.sender === 'them' && message.userId)
        .map((message) => message.userId)
    )].filter((userId) => !(userId in profilesRef.current))
    if (!missing.length) return
    let active = true
    fetchProfiles(session, missing)
      .then((rows) => { if (active) setProfiles((current) => ({ ...current, ...rows })) })
      .catch(() => { /* a room without pictures still works; initials take over */ })
    return () => { active = false }
  }, [messages, session])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })
  }, [messages])

  useEffect(() => {
    const root = previewBodyRef.current
    if (!root || !('IntersectionObserver' in window)) return undefined
    const observer = new IntersectionObserver((entries) => {
      if (document.hidden || !document.hasFocus()) return
      entries.forEach((entry) => {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.4) return
        const node = entry.target
        if (node.dataset.userId === session.userId) return
        queueSeenMessage(node.dataset.messageId)
      })
    }, { root, threshold: 0.4 })
    displayedMessages.forEach((message) => {
      if (message.sender !== 'them' || !message.id || message.pending) return
      const node = messageNodesRef.current.get(message.id)
      if (node) observer.observe(node)
    })
    return () => observer.disconnect()
    // The observer is rebuilt when the rendered room-message set changes.
  }, [displayedMessages, socket, session.userId])

  useEffect(() => {
    if (!messageSearchOpen || !searchIsActive || !searchMatches.length) return
    const index = Math.min(messageSearchIndex, searchMatches.length - 1)
    const id = searchMatches[index]?.message.id
    messageNodesRef.current.get(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }, [messageSearchOpen, searchIsActive, searchMatches, messageSearchIndex])

  useEffect(() => {
    if (!recording) return undefined
    const timer = window.setInterval(() => {
      setRecordingSeconds(Math.floor((Date.now() - recordingStartRef.current) / 1000))
      if (Date.now() - recordingStartRef.current >= 15 * 60 * 1000 && recorderRef.current?.state === 'recording') recorderRef.current.stop()
    }, 500)
    return () => window.clearInterval(timer)
  }, [recording])

  const uploadFiles = async (files) => {
    const form = new FormData()
    files.forEach((file) => form.append('files', file))
    const response = await fetch('/api/media', { method: 'POST', headers: { 'X-Session-Id': session.userId }, body: form })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || !Array.isArray(result.media)) {
      const reason = result.error === 'file_too_large' ? 'A selected file is larger than the upload limit.' : (result.error || 'File upload failed.')
      throw new Error(reason)
    }
    return result.media
  }

  const sendRoomPayload = (payload) => {
    const roomSocket = socketRef.current
    const text = String(payload.text || '').trim()
    const attachments = payload.attachments || []
    const content = payload.content || null
    if (!text && !attachments.length && !content) return false
    if (!roomSocket?.connected) {
      showNotice('Reconnecting to this room. Try again when connected.')
      return false
    }
    const clientId = crypto.randomUUID()
    const raw = { id: clientId, clientId, userId: session.userId, displayName: session.displayName, text, attachments, content, ts: Date.now() }
    const optimistic = { ...toUiMessage(raw, session), pending: true, failed: false }
    setMessages((current) => mergeMessage(current, optimistic))
    onLatestMessage(chat.id, optimistic)
    const wirePayload = { room: chat.id, text, clientId }
    if (attachments.length) wirePayload.attachments = attachments.map(({ id, kind, name, mime, size }) => ({ id, kind, name, mime, size }))
    if (content) wirePayload.content = content
    roomSocket.timeout(10000).emit('message', wirePayload, (timeoutError, acknowledgement) => {
      if (timeoutError || !acknowledgement?.ok) {
        setMessages((current) => current.map((message) => message.clientId === clientId ? { ...message, pending: false, failed: true } : message))
        showNotice(acknowledgement?.error === 'rate_limited' ? 'You are sending messages too quickly.' : 'Message not sent. Check the connection and try again.')
        return
      }
      setMessages((current) => current.map((message) => message.clientId === clientId ? { ...message, id: acknowledgement.id, ts: acknowledgement.ts || message.ts, time: formatTime(acknowledgement.ts || message.ts), pending: false } : message))
    })
    return true
  }

  const sendMessage = (event) => {
    event.preventDefault()
    if (sendRoomPayload({ text: draft })) setDraft('')
  }

  const handlePickedFiles = async (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    setAttachmentMenuOpen(false)
    if (!files.length) return
    if (files.length > 5) {
      showNotice('Choose up to 5 files in one message.')
      return
    }
    if (!socketRef.current?.connected) {
      showNotice('Reconnect to the room before uploading files.')
      return
    }
    setUploading(true)
    try {
      const prepared = await prepareFiles(files, { hd: readHdPreference() })
      const uploaded = await uploadFiles(prepared)
      const saved = prepared.reduce((bytes, file, index) => bytes + files[index].size - file.size, 0)
      if (saved > 20 * 1024) showNotice(`Sent ${Math.round(saved / 1024)} KB lighter — turn on HD media in chat settings for the original size.`)
      if (sendRoomPayload({ text: draft, attachments: uploaded })) setDraft('')
    } catch (error) {
      showNotice(error.message || 'File upload failed.')
    } finally {
      setUploading(false)
    }
  }

  const shareLocation = () => {
    setAttachmentMenuOpen(false)
    if (!navigator.geolocation) {
      showNotice('Location sharing is not available in this browser.')
      return
    }
    showNotice('Getting your current location…')
    navigator.geolocation.getCurrentPosition((position) => {
      const { latitude: lat, longitude: lng, accuracy } = position.coords
      const content = { type: 'location', lat, lng }
      if (accuracy) content.accuracyM = accuracy
      if (sendRoomPayload({ content })) showNotice('Location shared with this room.')
    }, (error) => {
      showNotice(error.code === error.PERMISSION_DENIED ? 'Location permission was denied.' : 'Could not get your location. Try again.')
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 })
  }

  /** A card the server would reject is refused here first, so no ghost bubble appears. */
  const shareRich = (content) => {
    if (sendRoomPayload({ content })) {
      setRichSheet(null)
      showNotice(content.type === 'poll' ? 'Poll shared with this room.'
        : content.type === 'event' ? 'Event shared with this room.'
          : 'Contact shared with this room.')
    }
  }

  const toggleVoiceRecording = async () => {
    const activeRecorder = recorderRef.current
    if (activeRecorder?.state === 'recording') {
      activeRecorder.stop()
      setRecording(false)
      return
    }
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
      showNotice('Voice recording is not supported in this browser.')
      return
    }
    if (!socketRef.current?.connected) {
      showNotice('Reconnect to the room before recording a voice message.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      recordingStreamRef.current = stream
      recordingChunksRef.current = []
      recordingStartRef.current = Date.now()
      const preferred = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((mime) => MediaRecorder.isTypeSupported?.(mime))
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined)
      recorderRef.current = recorder
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data?.size) recordingChunksRef.current.push(event.data)
      })
      recorder.addEventListener('stop', async () => {
        const durationMs = Math.max(100, Date.now() - recordingStartRef.current)
        const chunks = recordingChunksRef.current
        const mime = recorder.mimeType || 'audio/webm'
        recorderRef.current = null
        recordingChunksRef.current = []
        recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
        recordingStreamRef.current = null
        if (!chunks.length) {
          showNotice('The recording was empty. Please try again.')
          return
        }
        const extension = /ogg/i.test(mime) ? 'ogg' : /mp4/i.test(mime) ? 'm4a' : 'webm'
        const audioBlob = new Blob(chunks, { type: mime })
        const peaks = await extractWaveform(audioBlob)
        const file = new File([audioBlob], `voice-${Date.now()}.${extension}`, { type: mime })
        setUploading(true)
        try {
          const [uploaded] = await uploadFiles([file])
          sendRoomPayload({ attachments: [uploaded], content: { type: 'voice', durationMs: Math.min(durationMs, 15 * 60 * 1000), peaks } })
        } catch (error) {
          showNotice(error.message || 'Voice message could not be sent.')
        } finally {
          setUploading(false)
        }
      }, { once: true })
      recorder.start(500)
      setRecordingSeconds(0)
      setRecording(true)
    } catch (error) {
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
      recordingStreamRef.current = null
      showNotice(error.name === 'NotAllowedError' ? 'Microphone permission was denied.' : 'Could not start the microphone.')
    }
  }

  const subtitle = connection === 'Connected' && presenceCount > 1 ? `${presenceCount} people in this room` : connection

  return (
    <section className={`chat-preview-panel${chatSettings.theme !== 'default' ? ` chat-theme-${chatSettings.theme}` : ''}`}>
      <div className="preview-top">
        <button className="preview-back" aria-label="Back to rooms" onClick={onClose}><ArrowLeft size={20} /></button>
        <div className="preview-person"><Avatar chat={chat} small /><div><strong>{chat.name}</strong><span className={connection === 'Connected' ? 'connection-online' : 'connection-offline'}>{subtitle}</span></div></div>
        <div className="preview-actions">
          <button className={`preview-call-action${messageSearchOpen ? ' is-active' : ''}`} aria-label="Search messages in this room" title="Search this room" aria-pressed={messageSearchOpen} onClick={() => { setMessageSearchOpen((open) => !open); setMessageSearchIndex(0) }}><Search size={17} /></button>
          <button className={`preview-call-action${selectMode ? ' is-active' : ''}`} aria-label="Select messages to delete for me" title="Select messages" aria-pressed={selectMode} onClick={toggleSelectMode}><ListChecks size={17} /></button>
          <button className={`preview-call-action${settingsOpen ? ' is-active' : ''}`} aria-label="Chat settings" title="Chat settings" onClick={() => setSettingsOpen((open) => !open)}><Settings2 size={17} /></button>
          <button className="preview-call-action" aria-label="Start video call" title="Start video call" onClick={() => calls.openPicker('video')} disabled={Boolean(calls.call)}><Video size={18} /></button>
          <button className="preview-call-action" aria-label="Start audio call" title="Start audio call" onClick={() => calls.openPicker('audio')} disabled={Boolean(calls.call)}><Phone size={18} /></button>
          <button className="icon-button preview-close" aria-label="Close room" onClick={onClose}><X size={18} /></button>
        </div>
        {calls.pickerMode && <div className="call-picker" role="dialog" aria-label={`Choose someone for an ${calls.pickerMode} call`}>
          <div className="call-picker-head"><strong>Start {calls.pickerMode} call</strong><button type="button" aria-label="Close" onClick={calls.closePicker}><X size={16} /></button></div>
          {calls.peers.length ? calls.peers.map((peer) => <button className="call-peer-option" key={peer.socketId} onClick={() => calls.startCall(peer)}><span className="call-peer-avatar">{peer.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{peer.displayName}</strong><small>Online in this room</small></span><ChevronRight size={16} /></button>) : <p className="call-picker-empty">Another guest must be online in this room before you can call.</p>}
        </div>}
      </div>
      {messageSearchOpen && <div className="message-search-toolbar" role="search" aria-label="Search room messages">
        <div className="message-search-fields">
          <label className="message-search-input"><Search size={16} /><input autoFocus type="search" value={messageSearchText} placeholder="Search messages, people, files…" aria-label="Search messages and media in this room" onChange={(event) => { setMessageSearchText(event.target.value); setMessageSearchIndex(0) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); navigateSearch(event.shiftKey ? -1 : 1) } if (event.key === 'Escape') closeMessageSearch() }} /></label>
          <select value={messageSearchKind} aria-label="Filter search by message type" onChange={(event) => { setMessageSearchKind(event.target.value); setMessageSearchIndex(0) }}><option value="all">All types</option><option value="text">Text</option><option value="media">Media</option><option value="image">Images</option><option value="video">Videos</option><option value="audio">Audio</option><option value="files">Files</option><option value="location">Locations</option></select>
          <select value={messageSearchPeriod} aria-label="Filter search by date" onChange={(event) => { setMessageSearchPeriod(event.target.value); setMessageSearchIndex(0) }}><option value="all">Any date</option><option value="today">Today</option><option value="week">Last 7 days</option><option value="month">This month</option></select>
        </div>
        <div className="message-search-controls"><span>{searchHasFilter ? `${searchMatches.length} result${searchMatches.length === 1 ? '' : 's'}` : 'Search this room’s loaded history'}</span>{searchHasFilter && searchMatches.length > 0 && <small>{Math.min(messageSearchIndex + 1, searchMatches.length)} / {searchMatches.length}</small>}<button type="button" aria-label="Previous result" title="Previous result" disabled={!searchIsActive || !searchMatches.length} onClick={() => navigateSearch(-1)}><ChevronLeft size={16} /></button><button type="button" aria-label="Next result" title="Next result" disabled={!searchIsActive || !searchMatches.length} onClick={() => navigateSearch(1)}><ChevronRight size={16} /></button><button type="button" className="message-search-close" aria-label="Close search" title="Close search" onClick={closeMessageSearch}><X size={16} /></button></div>
      </div>}
      {selectMode && <div className="message-select-bar" role="toolbar" aria-label="Delete messages for yourself">
        <span>{selectedIds.size ? `${selectedIds.size} selected` : 'Tap the messages you want gone from your view.'}</span>
        <button type="button" className="btn" onClick={() => setSelectedIds(new Set(displayedMessages.map((message) => message.id)))}>Select all here</button>
        <button type="button" className="btn btn-danger" onClick={deleteSelectedForMe} disabled={!selectedIds.size}><Trash2 size={14} /> Delete for me</button>
        <button type="button" className="btn" onClick={toggleSelectMode}>Done</button>
      </div>}
      <div className="preview-body" ref={previewBodyRef} aria-live="polite">
        {!visibleMessages.length && connection === 'Connected' && <div className="room-first-message"><MessageCircle size={25} /><strong>{chatSettings.clearedAt ? 'Your history here is cleared' : 'This room is ready'}</strong><span>Say hello to everyone who joins <b>#{chat.id}</b>.</span></div>}
        {searchIsActive && displayedMessages.length === 0 && <div className="message-search-empty"><Search size={20} /><strong>No matching messages</strong><span>Try another word, type or date range.</span></div>}
        {displayedMessages.map((message, index) => {
          const previous = displayedMessages[index - 1]
          const startsNewDay = !previous || !sameMessageDay(previous.ts, message.ts)
          const hasVideo = message.attachments?.some((attachment) => attachment.kind === 'video')
          const hasImage = message.attachments?.some((attachment) => attachment.kind === 'image')
          const isSearchMatch = searchIsActive && searchMatches.some((item) => item.message.id === message.id)
          const isCurrentSearchMatch = searchIsActive && searchMatches[Math.min(messageSearchIndex, Math.max(0, searchMatches.length - 1))]?.message.id === message.id
          return <Fragment key={message.id}>
            {startsNewDay && <div className="message-date-divider"><span>{formatMessageDay(message.ts)}</span></div>}
            <div ref={(node) => { if (node) messageNodesRef.current.set(String(message.id), node); else messageNodesRef.current.delete(String(message.id)) }} data-message-id={message.id} data-user-id={message.userId || ''} className={`bubble bubble-${message.sender}${message.failed ? ' bubble-failed' : ''}${hasVideo ? ' bubble-has-video' : ''}${hasImage ? ' bubble-has-image' : ''}${isSearchMatch ? ' message-search-match' : ''}${isCurrentSearchMatch ? ' message-search-current' : ''}${selectMode && selectedIds.has(message.id) ? ' message-selected' : ''}`}>
              {selectMode && <button type="button" className="bubble-select-box" role="checkbox" aria-checked={selectedIds.has(message.id)} aria-label={`Select ${message.author || 'this message'} for deletion`} onClick={() => toggleSelected(message.id)}>{selectedIds.has(message.id) ? <Check size={13} /> : <span />}</button>}
              {message.sender === 'them' && <small className="bubble-author"><AvatarFace className="bubble-avatar" src={profiles[message.userId]?.avatar?.url} initials={initialsOf(message.author, '#')} />{highlightText(message.author, searchIsActive ? messageSearchText : '')}<button type="button" className="bubble-author-menu" aria-label={`Options for ${message.author}`} onClick={() => setAuthorMenu({ userId: message.userId, displayName: message.author })}><Ellipsis size={13} /></button></small>}
              {authorMenu && authorMenu.userId === message.userId && <div className="bubble-author-pop" role="menu">
                <button type="button" role="menuitem" onClick={() => blockThisGuest(authorMenu)}><Ban size={14} /> Block {authorMenu.displayName || 'this guest'}</button>
                <button type="button" role="menuitem" onClick={() => setAuthorMenu(null)}>Cancel</button>
              </div>}
              {message.content?.type === 'location' && <LocationMessage content={message.content} />}
              {message.content?.type === 'poll' && <PollCard message={message} session={session} socket={socket} onNotice={showNotice} />}
              {message.content?.type === 'contact' && <ContactCard content={message.content} />}
              {message.content?.type === 'event' && <EventCard message={message} onNotice={showNotice} />}
              {message.attachments?.length > 0 && <div className={`message-attachments${message.attachments.length > 1 ? ' multiple' : ''}`}>{message.attachments.map((attachment) => <MessageAttachment key={attachment.id} attachment={attachment} voiceContent={message.content?.type === 'voice' ? message.content : null} onOpenMedia={setMediaViewer} />)}</div>}
              {message.text && <span className="bubble-text">{highlightText(message.text, searchIsActive ? messageSearchText : '')}</span>}
              <span className="bubble-meta"><time dateTime={new Date(message.ts).toISOString()}>{message.time}</time>{message.sender === 'me' && <MessageStatus message={message} userId={session.userId} />}</span>
            </div>
          </Fragment>
        })}
        <div ref={messagesEndRef} />
        {notice && <div className="chat-notice" role="status">{notice}</div>}
      </div>
      <div className="preview-compose">
        <p className="preview-demo-note">Room: <strong>#{chat.id}</strong> · guest chat, no account required</p>
        {uploading && <p className="uploading-indicator" role="status">Uploading media…</p>}
        {recording && <p className="recording-indicator" role="status"><i /> Recording voice · {Math.floor(recordingSeconds / 60)}:{String(recordingSeconds % 60).padStart(2, '0')} — tap the mic to send</p>}
        <form className="compose-controls" onSubmit={sendMessage}>
          <div className="attach-wrap">
            <button type="button" className="attach-button" aria-label="Add an attachment" aria-expanded={attachmentMenuOpen} onClick={() => setAttachmentMenuOpen((open) => !open)} disabled={uploading}><Plus size={21} /></button>
            {attachmentMenuOpen && <div className="attachment-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { galleryInputRef.current?.click(); setAttachmentMenuOpen(false) }}><Image size={17} /><span>Photos & videos</span></button>
              <button type="button" role="menuitem" onClick={() => { fileInputRef.current?.click(); setAttachmentMenuOpen(false) }}><FileText size={17} /><span>Choose files</span></button>
              <button type="button" role="menuitem" onClick={() => { setAttachmentMenuOpen(false); setRichSheet('poll') }}><ListChecks size={17} /><span>Poll</span></button>
              <button type="button" role="menuitem" onClick={() => { setAttachmentMenuOpen(false); setRichSheet('event') }}><CalendarDays size={17} /><span>Event</span></button>
              <button type="button" role="menuitem" onClick={() => { setAttachmentMenuOpen(false); setRichSheet('contact') }}><CircleUserRound size={17} /><span>Contact</span></button>
              <button type="button" role="menuitem" onClick={() => { setAttachmentMenuOpen(false); shareLocation() }}><MapPin size={17} /><span>Share location</span></button>
            </div>}
          </div>
          <input ref={galleryInputRef} className="hidden-file-input" type="file" accept="image/*,video/*" multiple onChange={handlePickedFiles} />
          <input ref={fileInputRef} className="hidden-file-input" type="file" multiple onChange={handlePickedFiles} />
          <input className="compose-input" type="text" placeholder={`Message #${chat.id}...`} aria-label="Type a message" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={20000} />
          <button type="submit" className="send-button" aria-label="Send message" disabled={!draft.trim() || uploading}><Send size={17} /></button>
          <button type="button" className={`voice-record-button${recording ? ' is-recording' : ''}`} aria-label={recording ? 'Stop and send voice message' : 'Record a voice message'} title={recording ? 'Stop and send voice message' : 'Record a voice message'} onClick={toggleVoiceRecording} disabled={uploading}>{recording ? <Square size={16} /> : <Mic size={18} />}</button>
        </form>
      </div>
      {calls.feedback && !calls.call && <div className="chat-notice call-feedback-toast" role="status">{calls.feedback}</div>}
      {calls.call && <CallWindow calls={calls} chat={chat} />}
      {settingsOpen && <ChatSettingsSheet {...settingsSheetProps} />}
      <MediaViewer media={mediaViewer} onClose={() => setMediaViewer(null)} />
      {richSheet && <RichComposer kind={richSheet} onClose={() => setRichSheet(null)} onCancel={() => setRichSheet(null)} onSend={shareRich} />}
    </section>
  )
}

function CallWindow({ calls, chat }) {
  const [mode, setMode] = useState(readWindowMode)
  const [frame, setFrame] = useState(() => defaultFrame(readWindowMode(), viewportSize()))
  const [fullscreen, setFullscreen] = useState(false)
  const [, setPulse] = useState(0)
  const shellRef = useRef(null)
  const dragRef = useRef(null)
  const activeAtRef = useRef(null)

  useEffect(() => {
    if (calls.call?.status !== 'active') {
      activeAtRef.current = null
      return undefined
    }
    activeAtRef.current ||= Date.now()
    const timer = window.setInterval(() => setPulse((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [calls.call?.status])

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    const onResize = () => setFrame((current) => clampToViewport(current, viewportSize()))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // A mode change remounts the media elements, so the live streams are re-bound.
  useEffect(() => { calls.reattachMedia() }, [mode, fullscreen])

  const changeMode = (next) => {
    const saved = saveWindowMode(next)
    setMode(saved)
    setFrame(defaultFrame(saved, viewportSize()))
  }

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen?.()
      return
    }
    await shellRef.current?.requestFullscreen?.().catch(() => {})
  }

  const startGesture = (kind, event) => {
    if (fullscreen || mode === 'docked') {
      const rect = shellRef.current?.getBoundingClientRect()
      if (!rect) return
      const next = { width: rect.width, height: rect.height, left: rect.left, top: rect.top }
      setMode(saveWindowMode('floating'))
      setFrame(next)
      dragRef.current = { kind, point: pointerPoint(event) }
    } else {
      dragRef.current = { kind, point: pointerPoint(event) }
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const moveGesture = (event) => {
    const gesture = dragRef.current
    if (!gesture) return
    const point = pointerPoint(event)
    const delta = dragDelta(gesture.point, point)
    gesture.point = point
    setFrame((current) => (gesture.kind === 'drag'
      ? movedFrame(current, delta, viewportSize())
      : resizedFrame(current, delta, viewportSize())))
  }

  const endGesture = () => {
    if (!dragRef.current) return
    dragRef.current = null
    saveWindowFrame(frame)
  }

  const statusLine = calls.call.status === 'incoming' ? `Incoming ${calls.call.mode} call`
    : calls.call.status === 'calling' ? 'Calling…'
      : calls.call.status === 'active' ? `Connected · ${callDuration(activeAtRef.current)}`
        : calls.call.status === 'failed' ? 'Connection failed' : 'Connecting…'

  const gestureProps = (kind) => ({
    onPointerDown: (event) => startGesture(kind, event),
    onPointerMove: moveGesture,
    onPointerUp: endGesture,
    onPointerCancel: endGesture,
  })

  const shellClass = `call-window${calls.call.mode === 'video' ? ' video-call-window' : ''}${mode === 'floating' ? ' is-floating' : ''}${mode === 'minimized' ? ' is-minimized' : ''}${fullscreen ? ' is-fullscreen' : ''}`
  const shellStyle = mode === 'docked' && !fullscreen ? undefined : frameStyle(frame, 'floating')

  const stage = calls.call.mode === 'video' ? (
    <div className="call-video-stage">
      <video ref={calls.remoteVideoRef} className="remote-call-video" autoPlay playsInline />
      <video ref={calls.localVideoRef} className="local-call-video" autoPlay muted playsInline />
      {!calls.remoteStream && <div className="call-video-placeholder"><span>{calls.call.peerName.slice(0, 1).toUpperCase()}</span><strong>{calls.call.status === 'incoming' ? 'Video call' : 'Waiting for video…'}</strong></div>}
    </div>
  ) : (
    <div className="audio-call-stage">
      <span className="audio-call-avatar">{calls.call.peerName.slice(0, 1).toUpperCase()}</span>
      <strong>{calls.call.peerName}</strong>
      <small>{calls.call.status === 'active' ? 'Audio connected' : 'Audio call'}</small>
      <audio ref={calls.remoteAudioRef} autoPlay />
    </div>
  )

  if (mode === 'minimized') {
    return (
      <div ref={shellRef} className={shellClass} style={shellStyle} role="group" aria-label={`${calls.call.mode} call with ${calls.call.peerName}, minimised`} {...gestureProps('drag')}>
        <audio ref={calls.remoteAudioRef} autoPlay />
        <span className="call-pill-dot" aria-hidden="true" />
        <span className="call-pill-peer">{calls.call.peerName}</span>
        <span className="call-pill-time">{calls.call.status === 'active' ? callDuration(activeAtRef.current) : statusLine}</span>
        <button type="button" className="call-pill-expand" onClick={() => changeMode(calls.call.mode === 'video' ? 'floating' : 'docked')}><Maximize2 size={15} /> Expand</button>
        <button type="button" className="call-pill-end" aria-label="End call" onClick={calls.hangup}><PhoneOff size={15} /></button>
      </div>
    )
  }

  const windowNode = (
    <div ref={shellRef} className={shellClass} style={shellStyle} role="dialog" aria-modal={mode === 'docked' ? 'true' : undefined} aria-label={`${calls.call.mode} call with ${calls.call.peerName}`}>
      <div className="call-window-head" {...gestureProps('drag')}>
        <div className="call-window-title"><strong>{calls.call.peerName}</strong><span>{statusLine}</span><small>#{chat.id}</small></div>
        <div className="call-window-actions">
          <button type="button" aria-label={mode === 'floating' ? 'Dock the call window' : 'Float the call window'} title={mode === 'floating' ? 'Dock' : 'Float'} onClick={() => changeMode(mode === 'floating' ? 'docked' : 'floating')}><Minimize2 size={15} /></button>
          <button type="button" aria-label="Minimise the call" title="Minimise" onClick={() => changeMode('minimized')}><ChevronLeft size={15} /></button>
          <button type="button" aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen}><Maximize2 size={15} /></button>
          <button type="button" aria-label="End call" className="call-hangup" onClick={calls.hangup}><PhoneOff size={18} /></button>
        </div>
      </div>
      {stage}
      {calls.feedback && <p className="call-feedback" role="status">{calls.feedback}</p>}
      <div className="call-controls">
        {calls.call.status === 'incoming' ? <><button type="button" className="call-accept" onClick={calls.acceptCall}><Phone size={18} /> Accept</button><button type="button" className="call-decline" onClick={calls.declineCall}><PhoneOff size={18} /> Decline</button></> : <>
          <button type="button" className={calls.muted ? 'control-muted' : ''} aria-label={calls.muted ? 'Unmute microphone' : 'Mute microphone'} onClick={calls.toggleMic} disabled={!calls.call.localStream}>{calls.muted ? <MicOff size={18} /> : <Mic size={18} />}</button>
          {calls.call.mode === 'video' && <button type="button" className={calls.cameraOff ? 'control-muted' : ''} aria-label={calls.cameraOff ? 'Turn camera on' : 'Turn camera off'} onClick={calls.toggleCamera} disabled={!calls.call.localStream}>{calls.cameraOff ? <VideoOff size={18} /> : <Video size={18} />}</button>}
          <button type="button" className="call-hangup control-end" aria-label="End call" onClick={calls.hangup}><PhoneOff size={18} /></button>
        </>}
      </div>
      {mode === 'floating' && !fullscreen && <button type="button" className="call-resize-handle" aria-label="Resize the call window" {...gestureProps('resize')} />}
    </div>
  )

  return mode === 'docked' && !fullscreen
    ? <div className="call-overlay" role="presentation">{windowNode}</div>
    : windowNode
}

function JoinRoomDialog({ initialRoom, initialName, onClose, onJoin }) {
  const [displayName, setDisplayName] = useState(initialName || '')
  const [roomName, setRoomName] = useState(initialRoom || '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  useBackDismiss(true, onClose)

  const submit = async (event) => {
    event.preventDefault()
    setPending(true)
    setError('')
    try {
      await onJoin(displayName, roomName, password)
    } catch (reason) {
      setError(reason.message || 'Could not join this room.')
      setPending(false)
    }
  }

  return (
    <div className="room-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="room-modal" role="dialog" aria-modal="true" aria-labelledby="room-modal-title">
        <button className="room-modal-close" type="button" aria-label="Close" onClick={onClose}><X size={18} /></button>
        <div className="room-modal-icon"><MessageCircle size={22} /></div>
        <p className="eyebrow">ROOM CHAT</p>
        <h2 id="room-modal-title">Create or join a room</h2>
        <p className="room-modal-copy">New rooms need a shared password. Existing rooms without a password remain open.</p>
        <form className="room-modal-form" onSubmit={submit}>
          <label className="field"><span>Display name</span><input className="input" required minLength={2} maxLength={32} autoComplete="nickname" placeholder="e.g. Asha" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label className="field"><span>Room name</span><input className="input" required minLength={1} maxLength={64} autoComplete="off" placeholder="e.g. design-team" value={roomName} onChange={(event) => setRoomName(event.target.value)} /></label>
          <small className="room-name-hint">Letters, numbers, dots, dashes and underscores. Spaces turn into dashes.</small>
          <label className="field"><span>Room password</span><input className="input" type="password" minLength={8} maxLength={128} autoComplete="current-password" placeholder="Set one for a new room, or enter the existing password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <small className="room-name-hint">At least 8 characters. Use the same password as other room members.</small>
          {error && <p className="room-form-error" role="alert">{error}</p>}
          <button className="btn btn-primary room-submit" type="submit" disabled={pending}>{pending ? 'Connecting…' : 'Enter room'}<ChevronRight size={17} /></button>
        </form>
      </section>
    </div>
  )
}

function MainDashboard({ guest, rooms, onJoinRoom, onLatestMessage, onRoomRemoved, roomRequest, onRoomRequestHandled }) {
  const [query, setQuery] = useState('')
  const [activeChat, setActiveChat] = useState(null)
  const [joinDialog, setJoinDialog] = useState(null)
  const [inboxPaneWidth, setInboxPaneWidth] = useState(null)
  const [isResizing, setIsResizing] = useState(false)
  const gridRef = useRef(null)
  const filtered = useMemo(() => rooms.filter((chat) => `${chat.name} ${chat.username} ${chat.message}`.toLowerCase().includes(query.toLowerCase())), [rooms, query])

  const resizeInboxPane = (width) => {
    const bounds = gridRef.current?.getBoundingClientRect()
    if (!bounds) return
    const minInboxWidth = 340
    const maxInboxWidth = Math.max(minInboxWidth, bounds.width - 366)
    setInboxPaneWidth(Math.min(maxInboxWidth, Math.max(minInboxWidth, width)))
  }
  const handleResizePointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsResizing(true)
  }
  const handleResizePointerMove = (event) => {
    if (!isResizing) return
    const bounds = gridRef.current?.getBoundingClientRect()
    if (bounds) resizeInboxPane(event.clientX - bounds.left - 18)
  }
  const handleResizeEnd = (event) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setIsResizing(false)
  }
  const handleResizeKeyDown = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const bounds = gridRef.current?.getBoundingClientRect()
    if (!bounds) return
    const currentWidth = inboxPaneWidth ?? (bounds.width - 36) / 2
    resizeInboxPane(currentWidth + (event.key === 'ArrowRight' ? 24 : -24))
  }
  const gridWidth = gridRef.current?.getBoundingClientRect().width ?? 706
  const maxInboxWidth = Math.max(340, gridWidth - 366)
  const currentInboxWidth = Math.min(maxInboxWidth, Math.max(340, inboxPaneWidth ?? (gridWidth - 36) / 2))

  const openRoom = async (chat) => {
    if (!guest) {
      setJoinDialog(chat.id)
      return
    }
    try {
      if (!await checkRoomAccess(guest, chat.id)) {
        setJoinDialog(chat.id)
        return
      }
    } catch {
      setJoinDialog(chat.id)
      return
    }
    setActiveChat(chat)
  }
  const joinFromDialog = async (displayName, roomInput, password) => {
    const chat = await onJoinRoom(displayName, roomInput, password)
    setActiveChat(chat)
    setJoinDialog(null)
  }

  /**
   * A room opened from the call log or the short feed arrives as a request,
   * because those pages are not the chat panel. The row is rendered even if this
   * device had forgotten it - the app has already rejoined it by the time we get
   * here - and a request that also carries a call is left for ChatPreview to
   * consume, since only the room socket can ring somebody.
   */
  useEffect(() => {
    if (!roomRequest) return undefined
    const summary = rooms.find((room) => room.id === roomRequest.roomId) || roomSummary(roomRequest.roomId)
    setActiveChat(summary)
    if (!roomRequest.call) onRoomRequestHandled?.()
    return undefined
    // Only a new request opens a room; the room list changes far too often.
  }, [roomRequest?.roomId])

  return (
    <main className="dashboard-shell">
      <div ref={gridRef} className={`dashboard-grid ${activeChat ? 'chat-open' : ''}${isResizing ? ' is-resizing' : ''}`} style={activeChat ? { '--inbox-pane-width': `${currentInboxWidth}px` } : undefined}>
        <section className="inbox-card">
          <div className="section-title room-list-title"><div><h2>Your rooms</h2><span>{rooms.length} {rooms.length === 1 ? 'room' : 'rooms'} on this device</span></div><button type="button" className="room-add-button" aria-label="Create or join a room" onClick={() => setJoinDialog('')}><Plus size={18} /></button></div>
          <SearchBar value={query} onChange={setQuery} count={filtered.length} />
          <ChatList chats={filtered} activeId={activeChat?.id} onSelect={openRoom} onCreate={() => setJoinDialog('')} hasQuery={Boolean(query)} />
        </section>
        {activeChat && <div className="split-resize-handle" role="separator" aria-orientation="vertical" aria-label="Resize rooms and chat panels" aria-valuemin={340} aria-valuemax={Math.round(maxInboxWidth)} aria-valuenow={Math.round(currentInboxWidth)} aria-valuetext={`${Math.round(currentInboxWidth)} pixels for rooms`} tabIndex={0} onPointerDown={handleResizePointerDown} onPointerMove={handleResizePointerMove} onPointerUp={handleResizeEnd} onPointerCancel={handleResizeEnd} onKeyDown={handleResizeKeyDown} onDoubleClick={() => setInboxPaneWidth(null)} />}
        {activeChat && guest ? <ChatPreview key={`${activeChat.id}:${guest.userId}`} chat={activeChat} session={guest} onClose={() => setActiveChat(null)} onLatestMessage={onLatestMessage} onChatRemoved={(roomId) => { setActiveChat(null); onRoomRemoved(roomId) }} autoCall={roomRequest?.call || null} onAutoCallHandled={() => onRoomRequestHandled?.()} /> : <section className="welcome-card"><div className="welcome-orb"><MessageCircle size={30} /></div><p className="eyebrow">A LITTLE NOTE</p><h2>Make space for<br /><em>good conversations.</em></h2><p>Create a room or join one by name. Share its name with your group and your messages appear here in real time.</p><button type="button" className="welcome-create-button" onClick={() => setJoinDialog('')}><Plus size={16} /> Create or join a room</button><div className="welcome-stats"><span><strong>{rooms.length.toString().padStart(2, '0')}</strong><small>rooms on this device</small></span><span><strong>Live</strong><small>room messages</small></span></div></section>}
      </div>
      {joinDialog !== null && <JoinRoomDialog key={joinDialog || 'new-room'} initialRoom={joinDialog} initialName={guest?.displayName} onClose={() => setJoinDialog(null)} onJoin={joinFromDialog} />}
    </main>
  )
}

/** A photo or text card is read for a few seconds; a video runs to its end. */
const STATUS_CARD_MS = 5000

function UpdatesPage({ guest }) {
  const [statuses, setStatuses] = useState([])
  const [failure, setFailure] = useState('')
  const [notice, setNotice] = useState('')
  const [composerOpen, setComposerOpen] = useState(false)
  const [text, setText] = useState('')
  const [color, setColor] = useState(STATUS_PALETTE[0].hex)
  const [posting, setPosting] = useState(false)
  const [showSeen, setShowSeen] = useState(false)
  const [openId, setOpenId] = useState(null)
  const [viewers, setViewers] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const noticeTimerRef = useRef(null)
  const fileInputRef = useRef(null)

  useEffect(() => () => window.clearTimeout(noticeTimerRef.current), [])

  const showNotice = (message) => {
    window.clearTimeout(noticeTimerRef.current)
    setNotice(message)
    noticeTimerRef.current = window.setTimeout(() => setNotice(''), 3200)
  }

  // Cards die on their own clock, so the page re-reads it often enough that the
  // last minute of a status does not sit on the screen as if it were fresh.
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 15000)
    return () => window.clearInterval(tick)
  }, [])

  const refresh = useCallback(async () => {
    if (!guest?.userId) return
    try {
      setStatuses(await fetchStatuses(guest))
      setFailure('')
    } catch (error) {
      setFailure(error.message || 'Could not load your updates.')
    }
    // The guest is the session; a new guest must not inherit the last one's feed.
  }, [guest?.userId])

  useEffect(() => {
    if (!guest?.userId) {
      setStatuses([])
      return undefined
    }
    refresh()
    return undefined
  }, [guest?.userId, refresh])

  /**
   * A card another guest posted - or deleted - while this page was open arrives
   * as a broadcast, so the feed is re-read instead of pretending to be current.
   */
  useEffect(() => {
    if (!guest?.userId) return undefined
    const socket = connectFeed(guest)
    socket.on('status_created', refresh)
    socket.on('status_removed', refresh)
    return () => {
      socket.removeAllListeners()
      socket.close()
    }
  }, [guest?.userId, refresh])

  const replaceCard = (card) => setStatuses((current) => {
    const at = current.findIndex((item) => item.id === card.id)
    if (at === -1) return [card, ...current]
    const next = [...current]
    next[at] = card
    return next
  })

  const postTextCard = async () => {
    const trimmed = text.trim().slice(0, STATUS_TEXT_MAX)
    if (!trimmed) {
      showNotice('Write something before you post an update.')
      return
    }
    setPosting(true)
    try {
      replaceCard(await postTextStatus(guest, { kind: 'text', text: trimmed, color }))
      setText('')
      setComposerOpen(false)
      showNotice('Update posted. It disappears after 24 hours.')
    } catch (error) {
      showNotice(error.message || 'Could not post that update.')
    } finally {
      setPosting(false)
    }
  }

  const postMediaCard = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const kind = mediaKind(file)
    if (!kind) {
      showNotice('An update holds a photo or a video, not that kind of file.')
      return
    }
    setPosting(true)
    try {
      const [prepared] = await prepareFiles([file], { hd: readHdPreference() })
      const uploaded = await uploadStatusMedia(guest, prepared)
      replaceCard(await postMediaStatus(guest, { kind, id: uploaded.id }))
      showNotice('Update posted. It disappears after 24 hours.')
    } catch (error) {
      showNotice(error.message || 'Could not post that update.')
    } finally {
      setPosting(false)
    }
  }

  const removeCard = async (card) => {
    try {
      await deleteStatus(guest, card.id)
      setStatuses((current) => current.filter((item) => item.id !== card.id))
      if (openId === card.id) setOpenId(null)
      if (viewers?.id === card.id) setViewers(null)
      showNotice('Update removed.')
    } catch (error) {
      showNotice(error.message || 'Could not remove that update.')
    }
  }

  /**
   * Opening a card is what makes it seen. The server counts a guest once, so a
   * re-read of the same card is harmless - but the local row still has to catch
   * up, or the ring would stay lit until the page is reloaded.
   */
  const openCard = (card) => {
    setOpenId(card.id)
    if (card.mine || card.viewedByMe) return
    markStatusSeen(guest, card.id)
      .then((result) => setStatuses((current) => current.map((item) => (item.id === card.id
        ? { ...item, viewedByMe: true, viewerCount: Number(result.viewers) || item.viewerCount }
        : item))))
      .catch(() => { /* a view that did not land is not worth blocking the read */ })
  }

  const readViewers = async (card) => {
    setViewers({ id: card.id, rows: [], loading: true })
    try {
      setViewers({ id: card.id, rows: await fetchStatusViewers(guest, card.id), loading: false })
    } catch (error) {
      setViewers(null)
      showNotice(error.message || 'Could not read who saw this update.')
    }
  }

  const groups = groupFeed(statuses, now)
  const ordered = playOrder(statuses, now)
  const playing = openId ? ordered.find((card) => card.id === openId) : null

  const advanceCard = () => {
    const next = playing ? nextInPlay(ordered, playing.id) : null
    if (next) openCard(next)
    else setOpenId(null)
  }

  /**
   * The reader moves on by itself, the way a story does. A video gets its own
   * length; everything else gets the same few seconds.
   */
  useEffect(() => {
    if (!playing || playing.kind === 'video') return undefined
    const timer = window.setTimeout(() => {
      const next = nextInPlay(ordered, playing.id)
      if (next) openCard(next)
      else setOpenId(null)
    }, STATUS_CARD_MS)
    return () => window.clearTimeout(timer)
  }, [playing?.id, ordered])

  const cardMedia = (card) => (card.kind === 'text' ? (
    <div className="status-card status-text-card" style={{ background: card.color || STATUS_PALETTE[0].hex }}>
      <p>{card.text}</p>
    </div>
  ) : (
    <div className="status-card status-media-card">
      {card.kind === 'video'
        ? <video className="status-thumb" src={card.media?.url} muted playsInline preload="metadata" />
        : <img className="status-thumb" src={card.media?.url} alt={cardSummary(card)} loading="lazy" />}
    </div>
  ))

  const cardRow = (card) => (
    <article className={`update-card${card.viewedByMe && !card.mine ? ' is-seen' : ''}`} key={card.id}>
      <button type="button" className="update-card-open" onClick={() => openCard(card)} aria-label={`Open update from ${card.mine ? 'me' : (card.author?.displayName || 'a guest')}`}>
        <span className={`update-avatar${card.mine || !card.viewedByMe ? ' is-unseen' : ''}`}>
          {card.author?.avatar?.url
            ? <img src={card.author.avatar.url} alt="" />
            : (card.author?.displayName || '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="update-card-copy">
          <strong>{card.author?.displayName || (card.mine ? 'You' : 'Guest')}</strong>
          <span>{timeLeftLabel(card.remainingMs)}</span>
        </span>
        <span className="update-card-strip">{cardMedia(card)}</span>
      </button>
      <div className="update-card-actions">
        {card.mine && <button type="button" onClick={() => readViewers(card)}><Eye size={13} />{viewersLabel(card.viewerCount)}</button>}
        {card.mine && <button type="button" className="update-card-delete" onClick={() => removeCard(card)} aria-label="Remove this update"><Trash2 size={13} /> Remove</button>}
      </div>
    </article>
  )

  return (
    <main className="content-page updates-page">
      <section className="updates-toolbar-card" aria-label="Recent updates">
        <div className="section-title">
          <h2>Recent updates</h2>
          <div className="updates-toolbar-actions">
            {ordered.some((card) => card.viewedByMe && !card.mine) && (
              <button type="button" className="view-all-button" onClick={() => setShowSeen((value) => !value)}>
                {showSeen ? 'Show less' : 'View all'}
              </button>
            )}
            <button type="button" className="updates-add-button" aria-label="Add a photo or video update" title="Add a photo or video update" onClick={() => fileInputRef.current?.click()} disabled={posting}><Image size={18} /></button>
            <button type="button" className="updates-add-button" aria-label="Add a text update" title="Add a text update" onClick={() => setComposerOpen((value) => !value)} disabled={posting}><Plus size={18} /></button>
          </div>
        </div>
        <input ref={fileInputRef} className="hidden-file-input" type="file" accept="image/*,video/*" onChange={postMediaCard} />
        {notice && <p className="updates-action-notice" role="status">{notice}</p>}
        {failure && <p className="feed-failure" role="alert"><AlertCircle size={14} />{failure}</p>}
        {posting && <p className="feed-loading">Posting your update…</p>}
      </section>

      {composerOpen && (
        <section className="status-composer" aria-label="New text update">
          <div className="status-composer-canvas" style={{ background: color }}>
            <textarea
              value={text}
              maxLength={STATUS_TEXT_MAX}
              placeholder="Say something for today"
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          <div className="status-composer-foot">
            <div className="status-palette" role="group" aria-label="Card colour">
              {STATUS_PALETTE.map((entry) => (
                <button
                  key={entry.hex}
                  type="button"
                  className={`status-swatch${color === entry.hex ? ' is-active' : ''}`}
                  style={{ background: entry.hex }}
                  aria-label={entry.name}
                  aria-pressed={color === entry.hex}
                  onClick={() => setColor(pickColor(entry.hex))}
                />
              ))}
            </div>
            <span className="status-count">{text.trim().length}/{STATUS_TEXT_MAX}</span>
            <button type="button" className="status-post" onClick={postTextCard} disabled={posting || !text.trim()}><Send size={14} /> Post update</button>
            <button type="button" className="status-cancel" onClick={() => setComposerOpen(false)}>Cancel</button>
          </div>
        </section>
      )}

      {((guest && groups.mine.length > 0) || groups.unseen.length > 0 || (showSeen && groups.seen.length > 0)) && (
        <div className="updates-live-list" aria-label="Live updates">
          {guest && groups.mine.map(cardRow)}
          {groups.unseen.map(cardRow)}
          {showSeen && groups.seen.map(cardRow)}
        </div>
      )}

      {playing && (
        <div className="status-viewer" role="dialog" aria-modal="true" aria-label={`Update from ${playing.author?.displayName || (playing.mine ? 'you' : 'a guest')}`}>
          <div className="status-viewer-head">
            <span className="status-viewer-progress">{timeLeftLabel(playing.remainingMs)}</span>
            <button type="button" className="status-viewer-close" aria-label="Close update" onClick={() => setOpenId(null)}><X size={18} /></button>
          </div>
          <div className="status-viewer-body">
            {playing.kind === 'text' ? (
              <div className="status-full status-text-card" style={{ background: playing.color || STATUS_PALETTE[0].hex }}><p>{playing.text}</p></div>
            ) : playing.kind === 'video' ? (
              <video className="status-full" src={playing.media?.url} controls autoPlay playsInline onEnded={advanceCard} />
            ) : (
              <img className="status-full" src={playing.media?.url} alt={cardSummary(playing)} onClick={advanceCard} />
            )}
          </div>
          <div className="status-viewer-foot">
            <strong>{playing.author?.displayName || (playing.mine ? 'You' : 'Guest')}</strong>
            <span>{new Date(Number(playing.createdAt) || now).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
            {canReadViewers(playing) && <button type="button" onClick={() => readViewers(playing)}><Eye size={14} /> Who saw this</button>}
          </div>
        </div>
      )}

      {viewers && (
        <div className="status-viewers" role="dialog" aria-modal="true" aria-label="Guests who saw this update">
          <div className="status-viewers-head"><strong>Seen by</strong><button type="button" aria-label="Close" onClick={() => setViewers(null)}><X size={16} /></button></div>
          {viewers.loading ? <p className="feed-loading">Loading…</p> : (viewers.rows.length ? viewers.rows.map((row) => (
            <div className="status-viewer-row" key={row.userId}>
              <span>{row.displayName || 'Guest'}</span>
              <small>{new Date(Number(row.at) || now).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</small>
            </div>
          )) : <p className="updates-empty-line">{viewersLabel(0)}</p>)}
        </div>
      )}
    </main>
  )
}

/**
 * Short videos (the vertical feed). There is no separate store for these: a
 * "short" is a video a guest already sent to a room, read back from that room's
 * history. Nothing is shown until a device has real clips to play.
 */
function ShortsPage({ guest, rooms, onOpenRoom }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState('')
  const trackRef = useRef(null)
  const roomKey = rooms.map((room) => room.id).join('|')

  useEffect(() => {
    if (!guest?.userId || !rooms.length) {
      setItems([])
      setLoading(false)
      return undefined
    }
    let active = true
    setLoading(true)
    const targets = rooms.slice(0, 12)
    Promise.all(targets.map((room) => fetchRoomMessages(guest, room.id).catch(() => [])))
      .then((batches) => {
        if (!active) return
        setItems(collectVideoClips(batches, targets))
        setFailure('')
      })
      .catch((error) => { if (active) setFailure(error.message || 'Could not read your rooms.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
    // Re-read only when the device's room list actually changes, not on every
    // message preview that rebuilds the array.
  }, [guest?.userId, roomKey])

  /** Only the clip filling the frame plays, and the feed stays muted. */
  useEffect(() => {
    const track = trackRef.current
    if (!track || !items.length) return undefined
    const clips = track.querySelectorAll('video')
    const focus = (playing) => {
      for (const clip of clips) {
        if (clip === playing) {
          clip.muted = true
          clip.play().catch(() => { /* a clip the browser will not start stays still */ })
        } else {
          clip.pause()
          clip.currentTime = 0
        }
      }
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio > 0.6) focus(entry.target.querySelector('video'))
      }
    }, { root: track, threshold: [0.65] })
    for (const clip of clips) observer.observe(clip.parentElement)
    focus(clips[0])
    return () => observer.disconnect()
  }, [items])

  const step = (direction) => {
    const track = trackRef.current
    if (!track) return
    track.scrollBy({ top: direction * track.clientHeight, behavior: 'smooth' })
  }

  if (!guest) {
    return <main className="content-page shorts-page" />
  }

  return (
    <main className="content-page shorts-page">
      {failure && <p className="feed-failure" role="alert"><AlertCircle size={14} />{failure}</p>}
      {loading && <p className="feed-loading">Reading the videos in your rooms…</p>}
      {items.length ? (
        <div className="shorts-track" ref={trackRef} tabIndex={0} role="region" aria-label="Short video feed" onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); step(1) }
          if (event.key === 'ArrowUp') { event.preventDefault(); step(-1) }
        }}>
          {items.map((item) => (
            <article className="short-item" key={item.id}>
              <video src={item.url} playsInline loop muted preload="metadata" />
              <div className="short-item-meta">
                <strong>{item.roomName}</strong>
                <span>{item.displayName} · {item.name}</span>
                <button type="button" onClick={() => onOpenRoom(item.room)}><MessageCircle size={14} /> Open room</button>
              </div>
            </article>
          ))}
          <div className="shorts-step" aria-hidden="true"><button type="button" onClick={() => step(-1)}><ChevronLeft size={16} /></button><button type="button" onClick={() => step(1)}><ChevronRight size={16} /></button></div>
        </div>
      ) : null}
    </main>
  )
}

function CallsPage({ guest, notice: returnedNotice, onOpenRoom, onCallBack }) {
  const [calls, setCalls] = useState([])
  const [loading, setLoading] = useState(Boolean(guest))
  const [failure, setFailure] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const noticeTimerRef = useRef(null)

  useEffect(() => () => window.clearTimeout(noticeTimerRef.current), [])

  const showNotice = (message) => {
    window.clearTimeout(noticeTimerRef.current)
    setNotice(message)
    noticeTimerRef.current = window.setTimeout(() => setNotice(''), 3200)
  }

  useEffect(() => {
    if (!guest?.userId) {
      setLoading(false)
      setCalls([])
      return undefined
    }
    let active = true
    setLoading(true)
    fetchCallHistory(guest)
      .then((rows) => { if (active) { setCalls(rows); setFailure('') } })
      .catch((error) => { if (active) setFailure(error.message || 'Could not load your call history.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
    // The guest is the session; a new guest must not inherit the last one's log.
  }, [guest?.userId])

  const clearAll = async () => {
    setConfirmClear(false)
    try {
      await clearCallHistory(guest)
      setCalls([])
      showNotice('Call history cleared on every device for this guest.')
    } catch (error) {
      showNotice(error.message || 'Could not clear your call history.')
    }
  }

  if (!guest) {
    return (
      <main className="content-page"><section className="calls-card"><div className="section-title"><h2>Calls</h2><span>Room calling</span></div><div className="empty-state"><div className="empty-icon"><Phone size={21} /></div><h3>Join a room to start calling</h3><p>Calls are made from inside a room. Once you have joined one, the history of your calls appears here.</p></div></section></main>
    )
  }

  const groups = groupCallsByDay(calls)
  return (
    <main className="content-page calls-page">
      <section className="calls-card" aria-label="Call history">
        <div className="section-title">
          <h2>Calls</h2>
          <span>{loading ? 'Loading' : `${calls.length} ${calls.length === 1 ? 'call' : 'calls'}`}</span>
        </div>
        {(returnedNotice || notice) && <p className="feed-notice" role="status">{returnedNotice || notice}</p>}
        {failure && <p className="feed-failure" role="alert"><AlertCircle size={14} />{failure}</p>}
        {calls.length ? (
          <>
            <div className="calls-toolbar">
              {confirmClear ? (
                <div className="calls-confirm">
                  <span>Clear every call record for this guest?</span>
                  <button type="button" className="calls-confirm-yes" onClick={clearAll}>Clear</button>
                  <button type="button" className="calls-confirm-no" onClick={() => setConfirmClear(false)}>Keep</button>
                </div>
              ) : (
                <button type="button" className="calls-clear" onClick={() => setConfirmClear(true)}><Trash2 size={14} /> Clear history</button>
              )}
            </div>
            {groups.map((group) => (
              <div className="calls-day" key={group.day}>
                <p className="calls-day-label">{group.label}</p>
                {group.calls.map((call) => {
                  const Icon = call.mode === 'video' ? Video : Phone
                  const missed = call.status === 'missed'
                  return (
                    <article className="call-row" key={call.id}>
                      <span className={`call-row-icon${missed ? ' is-missed' : ''}`}><Icon size={16} /></span>
                      <div className="call-row-copy">
                        <strong>
                          <em className="call-row-direction" title={call.direction === 'out' ? 'Outgoing call' : 'Incoming call'}>
                            {call.direction === 'out' ? <ArrowUpRight size={12} /> : <ArrowDownLeft size={12} />}
                          </em>
                          {call.peer?.displayName || 'Guest'}
                        </strong>
                        <span className={missed ? 'missed' : undefined}>
                          {describeCall(call)}{callDurationLabel(call) ? ` · ${callDurationLabel(call)}` : ''}
                        </span>
                      </div>
                      <small className="call-row-time"><Clock3 size={11} />{callMoment(call.startedAt)}</small>
                      <div className="call-row-actions">
                        <button type="button" className="call-action" title={`Open #${call.room}`} aria-label={`Open room ${call.room}`} onClick={() => onOpenRoom(call.room)}><MessageCircle size={15} /></button>
                        {canCallBack(call) && <button type="button" className="call-action call-action-primary" title={`Call ${call.peer.displayName} back`} aria-label={`Call ${call.peer.displayName} back`} onClick={() => onCallBack(call)}><ArrowUpRight size={15} /></button>}
                      </div>
                    </article>
                  )
                })}
              </div>
            ))}
          </>
        ) : loading ? (
          <p className="feed-loading">Loading your calls…</p>
        ) : (
          <div className="empty-state"><div className="empty-icon"><Phone size={21} /></div><h3>No calls yet</h3><p>Open a room and use the phone or video button to call a guest who is online there. Calls you make and receive are listed here.</p></div>
        )}
      </section>
    </main>
  )
}

function BottomNavigation() {
  return <nav className="bottom-nav" aria-label="Primary navigation">{navItems.map(({ to, label, icon: Icon, end }) => <NavLink key={to} to={to} end={end} className={({ isActive }) => isActive ? 'active' : ''}><Icon size={20} /><span>{label}</span></NavLink>)}</nav>
}

function App() {
  const [dark, setDark] = useState(() => localStorage.getItem('inchat-theme') === 'dark')
  const [guest, setGuest] = useState(() => readGuest())
  const [rooms, setRooms] = useState(() => readRooms())
  const [profile, setProfile] = useState(null)
  const [roomRequest, setRoomRequest] = useState(null)
  const [feedNotice, setFeedNotice] = useState('')
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    if (!feedNotice) return undefined
    const timer = window.setTimeout(() => setFeedNotice(''), 4000)
    return () => window.clearTimeout(timer)
  }, [feedNotice])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.setItem('inchat-theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => {
    if (!guest?.userId) return undefined
    let active = true
    fetch(`/api/sessions/${encodeURIComponent(guest.userId)}`)
      .then(async (response) => {
        if (response.ok) return response.json()
        if (response.status === 401 || response.status === 404) return null
        return undefined
      })
      .then((session) => {
        if (!active) return
        if (session) setGuest(session)
        else if (session === null) {
          setGuest(null)
          clearGuest()
        }
      })
      .catch(() => {})
    return () => { active = false }
  }, [guest?.userId])

  /**
   * The profile - name, about note, picture - belongs to the session, so it is
   * loaded once per guest and shared with the header and the chat sheets.
   */
  useEffect(() => {
    if (!guest?.userId) {
      setProfile(null)
      return undefined
    }
    let active = true
    setProfile(null)
    fetchMyProfile(guest)
      .then((loaded) => { if (active) setProfile(loaded) })
      .catch(() => { /* a profile that cannot load must not block the room */ })
    return () => { active = false }
  }, [guest?.userId])

  const joinRoom = async (displayName, roomInput, password) => {
    const room = normalizeRoomName(roomInput)
    const session = await resolveGuest(displayName)
    await authorizeRoom(session, room, password)
    setGuest(session)
    saveGuest(session)
    localStorage.setItem('chat:room', room)
    const summary = roomSummary(room)
    setRooms((current) => {
      const next = [summary, ...current.filter((item) => item.id !== room)]
      saveRooms(next)
      return next
    })
    return summary
  }

  const updateRoomPreview = (roomId, message) => {
    const text = message.text || describeMessage(message)
    const summary = { message: text.length > 70 ? `${text.slice(0, 67)}…` : text, time: message.time || formatTime(message.ts) }
    setRooms((current) => {
      const next = current.map((room) => room.id === roomId ? { ...room, ...summary } : room)
      saveRooms(next)
      return next
    })
  }

  const shellClass = location.pathname === '/calls' ? 'app-shell calls-route' : location.pathname === '/' ? 'app-shell home-route' : location.pathname === '/updates' ? 'app-shell updates-route' : 'app-shell'
  const signOut = () => {
    clearGuest()
    setGuest(null)
  }
  const forgetRoomOnDevice = (roomId) => setRooms(forgetRoom(roomId))

  /**
   * The call log and the short feed both live outside a room, so opening a room
   * from them is a request the dashboard honours rather than a link it can reach
   * directly. A call-back carries the guest to ring, and the room must already be
   * joined before anyone can be rung - a call travels through the room socket.
   */
  const openRoomFromFeed = async (roomId, call) => {
    if (!guest) return
    try {
      if (!await checkRoomAccess(guest, roomId)) {
        returnToFeed('Open this room from Chats and enter its password first.')
        return
      }
    } catch (error) {
      returnToFeed(error.message)
      return
    }
    if (!rooms.some((room) => room.id === roomId)) {
      try {
        await joinRoom(guest.displayName, roomId)
      } catch (error) {
        returnToFeed(error.message || 'That room is not reachable right now.')
        return
      }
    }
    setRoomRequest({ roomId, call: call || null })
    navigate('/')
  }

  /** A room that cannot be opened leaves the guest where they were, with the reason. */
  const returnToFeed = (message) => {
    setRoomRequest(null)
    setFeedNotice(message || '')
    navigate('/calls')
  }

  const routes = (
    <Routes>
      <Route path="/" element={<MainDashboard guest={guest} rooms={rooms} onJoinRoom={joinRoom} onLatestMessage={updateRoomPreview} onRoomRemoved={forgetRoomOnDevice} roomRequest={roomRequest} onRoomRequestHandled={() => setRoomRequest(null)} onFeedReturn={returnToFeed} />} />
      <Route path="/updates" element={<UpdatesPage guest={guest} />} />
      <Route path="/shorts" element={<ShortsPage guest={guest} rooms={rooms} onOpenRoom={openRoomFromFeed} />} />
      <Route path="/calls" element={<CallsPage guest={guest} notice={feedNotice} onOpenRoom={(roomId) => openRoomFromFeed(roomId)} onCallBack={(call) => openRoomFromFeed(call.room, { userId: call.peer.userId, displayName: call.peer.displayName, mode: call.mode })} />} />
    </Routes>
  )

  return <div className={shellClass}><AppHeader guest={guest} profile={profile} onProfileChange={setProfile} rooms={rooms} dark={dark} onToggle={() => setDark((value) => !value)} onForgetRoom={forgetRoomOnDevice} onSignOut={signOut} /><div className="mobile-location"><Menu size={18} /><span>{location.pathname === '/' ? 'Chats' : location.pathname.slice(1)}</span></div>{routes}<BottomNavigation /></div>
}

export default App
