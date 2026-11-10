import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import {
  AlertCircle, ArrowDownLeft, ArrowLeft, ArrowUpRight, Ban, Bell, CalendarDays, Camera, Check, CheckCheck, ChevronLeft,
  ChevronRight, CircleUserRound, Clock3, Download, Ellipsis, Eye, FileText, Image, ListChecks, MapPin, Maximize2,
  MessageCircle, Mic, MicOff, Minimize2, Moon, Palette, Pause, Phone, PhoneOff, Pin, Play, Plus, RefreshCw, Search, Send, Settings2, Smile, Sparkles, Square, Sun, Trash2, Users, Video, VideoOff, X,
} from 'lucide-react'
import {
  authorizeRoom, blockGuest, CHAT_THEMES, checkRoomAccess, clearCallHistory, clearChatForMe, clearGuest, connectFeed, connectRoom, deleteChatForMe,
  deleteMessagesForMe, deleteStatus, fetchCallHistory, fetchChatSettings, fetchMyProfile, fetchProfiles,
  fetchRoomMessages, fetchRoomPresence, fetchRoomRoster, fetchStatuses, fetchStatusViewers, forgetRoom, markStatusSeen, normalizeRoomName, postMediaStatus,
  postTextStatus, readGuest, readRooms, resolveGuest, roomSummary, rotateRoomInvite, saveGuest, saveRoomTheme,
  saveRooms, sessionHeaders, unblockGuest, uploadStatusMedia,
} from './roomChat'
import {
  buildContactContent, buildEventContent, buildPollContent, contactLinks, icsForEvent, pollOutcome,
} from './richCards'
import { prepareFiles, readHdPreference, saveHdPreference } from './mediaPrepare'
import { EMOJI_GROUPS, insertAtCaret } from './emoji'
import { FOCUSABLE_SELECTOR, isUsable, menuTarget, preferredFocus, trapTarget } from './a11y'
import {
  callDuration, clampToViewport, defaultFrame, dragDelta, frameStyle, movedFrame, pointerPoint,
  readWindowMode, resizedFrame, saveWindowFrame, saveWindowMode, viewportSize,
} from './callWindow'
import {
  canNotify, openNotification, playChime, readNotifyPrefs, requestNotifyPermission,
  saveNotifyPrefs, shouldNotify,
} from './notifications'
import { callDurationLabel, callMoment, canCallBack, describeCall, groupCallsByDay } from './callHistory'
import { applyPreferences } from './preferences'
import {
  STATUS_PALETTE, STATUS_TEXT_MAX, cardSummary, canReadViewers, groupFeed, isLive, mediaKind, nextInPlay, pickColor,
  playOrder, timeLeftLabel, viewersLabel,
} from './statusFeed'
import { collectVideoClips } from './shortsFeed'
import {
  attachmentRows, localReadFailure, mergeMessage, mergePage, mergeServerPage, olderCursor, rowsToPersist, SKELETON_ROWS, transcriptPhase,
} from './transcript'
import {
  clearCalls, deleteMedia, deleteMessages, deleteRoomMedia, deleteRoomMessages, forgetRoomState, isQuotaError,
  readCalls, readMessagePage, readProfiles, readRoomState, saveRoomState, seqSpan,
  storeCalls, storeMedia, storeMessages, storeProfiles,
} from './localStore'
import useRoomCalls from './useRoomCalls'
import { primeIceConfig } from './iceCache'

const navItems = [
  { to: '/', label: 'Chats', icon: MessageCircle, end: true },
  { to: '/updates', label: 'Updates', icon: Bell },
  { to: '/calls', label: 'Calls', icon: Phone },
  { to: '/settings', label: 'Settings', icon: Settings2 },
]

/** Settings is a separate chunk: nobody needs it before they open the tab. */
const SettingsPage = lazy(() => import('./settings'))

/**
 * Presence is polled per room, so the list caps how many rooms it asks about and
 * how often. A device with forty rooms should not spend forty requests every
 * few seconds; the rows you can see are the rows that get a dot.
 */
const PRESENCE_QUERY_LIMIT = 12
const PRESENCE_REFRESH_MS = 45000

/**
 * The reference shows four chips; two of them have nothing to filter on here.
 * A room holds two people, so "Groups" would always be empty, and nothing in
 * the app marks a favourite. Both would need data the server does not keep,
 * so the list offers the filters that describe real rooms instead of four
 * buttons where two of them lie.
 */
const LIST_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
]

/**
 * The stored choice wins; a device that has never been asked gets the theme its
 * owner already picked in the OS. Defaulting to light instead meant a first run
 * showed a palette nobody chose, and the reference design is a dark one.
 */
function readThemePreference() {
  let stored = null
  try {
    stored = localStorage.getItem('inchat-theme')
  } catch (err) {
    return true
  }
  if (stored === 'dark') return true
  if (stored === 'light') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
}

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

const focusIfPresent = (element) => {
  if (element && element.isConnected && typeof element.focus === 'function') element.focus()
}

/**
 * A modal that lets Tab walk out of it is not really modal: everything behind
 * it stays reachable and the screen reader user never finds their way back.
 * This keeps Tab and Shift+Tab inside the container, takes focus to the field
 * the dialog was opened for, closes on Escape, and hands focus back to whatever
 * opened it. `onClose` is read through a ref so a fresh inline callback on
 * every render cannot re-run the effect and steal focus mid-sentence.
 */
function useDialogTrap(containerRef, { active = true, onClose } = {}) {
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    const node = containerRef.current
    if (!active || !node) return undefined
    const opener = document.activeElement
    const items = () => [...node.querySelectorAll(FOCUSABLE_SELECTOR)].filter(isUsable)
    focusIfPresent(items()[preferredFocus(items())])
    const handleKeyDown = (event) => {
      if (event.key === 'Tab') {
        const list = items()
        const target = trapTarget({ count: list.length, from: list.indexOf(document.activeElement), shift: event.shiftKey })
        if (target === null) return
        event.preventDefault()
        focusIfPresent(list[target])
      } else if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current?.()
      }
    }
    node.addEventListener('keydown', handleKeyDown)
    return () => {
      node.removeEventListener('keydown', handleKeyDown)
      focusIfPresent(opener)
    }
  }, [containerRef, active])
}

/**
 * The menu pattern the app claimed with `role="menu"` but never implemented:
 * arrows walk the items, Home and End jump to the ends, Escape closes and
 * returns focus to the button that opened the menu.
 */
function useMenuNavigation(listRef, { active = true, onClose } = {}) {
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    const node = listRef.current
    if (!active || !node) return undefined
    const opener = document.activeElement
    const items = () => [...node.querySelectorAll('[role="menuitem"]')].filter(isUsable)
    focusIfPresent(items()[0])
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current?.()
        return
      }
      const list = items()
      const target = menuTarget({ count: list.length, from: list.indexOf(document.activeElement), key: event.key })
      if (target === null) return
      event.preventDefault()
      focusIfPresent(list[target])
    }
    node.addEventListener('keydown', handleKeyDown)
    return () => {
      node.removeEventListener('keydown', handleKeyDown)
      focusIfPresent(opener)
    }
  }, [listRef, active])
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
    // The store's own arrival number. Two replicas' clocks disagree; their
    // sequences do not, so this is what the list is ordered by.
    seq: Number.isFinite(Number(message.seq)) ? Number(message.seq) : null,
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
  // The message row outlives the bytes it points at, so the gap is named
  // instead of leaving a thumbnail that 404s when it is opened.
  if (attachment.expired) return <div className="message-attachment attachment-missing">This file is no longer on the server.</div>
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
  const viewerRef = useRef(null)
  const videoRef = useRef(null)
  const [broken, setBroken] = useState(false)
  useDialogTrap(viewerRef, { active: Boolean(media), onClose })
  useEffect(() => {
    if (!media) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [media])
  // A new item is a new file, so the previous one's failure must not carry over.
  useEffect(() => { setBroken(false) }, [media])
  if (!media) return null
  return (
    <div ref={viewerRef} className="media-viewer" role="dialog" aria-modal="true" aria-label={`${media.kind} viewer`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <header className="media-viewer-toolbar"><strong>{media.name}</strong><button type="button" aria-label="Minimize media viewer" title="Minimize" onClick={onClose}><Minimize2 size={19} /><span>Minimize</span></button></header>
      <div className={`media-viewer-stage media-viewer-${media.kind}`}>
        {media.kind === 'image' ? <img src={media.url} alt={media.name} onError={() => setBroken(true)} /> : <video ref={videoRef} src={media.url} controls playsInline preload="metadata" autoPlay={Boolean(media.autoPlay)} aria-label={media.name} onError={() => setBroken(true)} onLoadedMetadata={(event) => { const video = event.currentTarget; if (Number(media.initialTime) > 0) video.currentTime = Number(media.initialTime); if (media.autoPlay) video.play().catch(() => {}) }} />}
        {/* A 404 on /media/:id used to be a blank stage, which reads as a broken app rather than a gone file. */}
        {broken && <p className="feed-failure media-viewer-failure" role="alert"><AlertCircle size={14} />This file could not be opened. It may no longer be on the server.</p>}
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
  const sheetRef = useRef(null)
  const [fields, setFields] = useState(() => (
    kind === 'poll'
      ? { question: '', options: ['', ''], multiple: false }
      : kind === 'contact'
        ? { name: '', phone: '', email: '', org: '', note: '' }
        : { title: '', start: '', end: '', allDay: false, location: '', note: '' }
  ))
  const [error, setError] = useState('')
  useDialogTrap(sheetRef, { onClose })

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
      <section ref={sheetRef} className="room-modal rich-composer" role="dialog" aria-modal="true" aria-label={richSheetFields[kind].title}>
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

function BrandMark() {
  return (
    <div className="brand-mark" role="img" aria-label="InChat India logo">
      <img className="brand-map" src="/inchat-logo.png" alt="" aria-hidden="true" />
    </div>
  )
}

/**
 * Both themes are visible at once, because a toggle that only names the theme
 * you are *not* in asks the guest to translate before they can choose. The
 * compact pill sits where the old three-dot menu was.
 */
function ThemeSwitch({ dark, onChange }) {
  return (
    <div className="theme-switch" role="group" aria-label="Colour theme">
      <button type="button" className={dark ? '' : 'is-active'} aria-pressed={!dark} title="Light theme" onClick={() => onChange('light')}>
        <Sun size={15} aria-hidden="true" /><span>Light</span>
      </button>
      <button type="button" className={dark ? 'is-active' : ''} aria-pressed={dark} title="Dark theme" onClick={() => onChange('dark')}>
        <Moon size={15} aria-hidden="true" /><span>Dark</span>
      </button>
    </div>
  )
}

/**
 * The header carries the brand and the theme switch. Every account surface -
 * profile, rooms, session, sign out - lives in Settings, so the phone header
 * has no entry point that competes with the bottom navigation. The avatar used
 * to open a profile sheet here; that duplicated Settings and sat too close to
 * the theme switch on small screens.
 */
function AppHeader({ dark, onThemeChange }) {
  return (
    <header className="app-header">
      <div className="brand-lockup"><BrandMark /><div><strong>INchat</strong></div><span className="india-flag" aria-label="India">🇮🇳</span></div>
      <div className="header-actions">
        <ThemeSwitch dark={dark} onChange={onThemeChange} />
      </div>
    </header>
  )
}

/**
 * A sender picture is only ever shown when the server has one; without it the
 * bubble falls back to initials rather than inventing an image.
 */
function AvatarFace({ src, initials, className }) {
  return <div className={className}>{src ? <img src={src} alt="" /> : initials}</div>
}

function initialsOf(name, fallback = 'G') {
  return name?.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || fallback
}

/**
 * One pill, one popover. The old hint strip floated under the field with no
 * relationship to what was typed; this lists the rooms that actually match and
 * opens one on click, so the dropdown is a shortcut rather than decoration.
 */
function SearchBar({ value, onChange, count, results = [], onPick }) {
  const [focused, setFocused] = useState(false)
  const showing = focused && Boolean(value.trim())
  return (
    <div className="search-region">
      <div className={`search-wrap ${focused ? 'focused' : ''}`}>
        <Search size={18} aria-hidden="true" />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 160)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { onChange(''); event.currentTarget.blur() }
            if (event.key === 'Enter' && results[0]) { onPick?.(results[0]); onChange('') }
          }}
          placeholder="Search rooms"
          aria-label="Search your rooms"
          aria-expanded={showing}
          aria-controls="room-search-results"
          role="combobox"
        />
        {value
          ? <button className="clear-search" aria-label="Clear search" onMouseDown={(event) => event.preventDefault()} onClick={() => onChange('')}><X size={16} /></button>
          : <span className="search-kbd" aria-hidden="true">/</span>}
      </div>
      {showing && (
        <div className="search-panel" id="room-search-results" role="listbox" aria-label="Matching rooms">
          <p className="search-panel-head"><span>{count} {count === 1 ? 'match' : 'matches'}</span><kbd>Enter</kbd></p>
          {results.length ? results.map((chat) => (
            <button
              key={chat.id}
              type="button"
              role="option"
              aria-selected="false"
              className="search-result"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { onPick?.(chat); onChange('') }}
            >
              <Avatar chat={chat} small />
              <span><strong>{chat.name}</strong><small>#{chat.id}{chat.message ? ` · ${chat.message}` : ''}</small></span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          )) : <p className="search-empty">No room on this device matches “{value.trim()}”.</p>}
        </div>
      )}
    </div>
  )
}

function Avatar({ chat, small = false, online = chat.online }) {
  return <div className={`avatar ${small ? 'avatar-sm' : ''} avatar-${chat.color || 'teal'}`}>{chat.initials}{online && <i className="online-dot" aria-hidden="true" />}</div>
}

function ChatItem({ chat, active, online, onSelect }) {
  const unread = chat.unread || 0
  return (
    <button
      className={`chat-item ${active ? 'active' : ''}`}
      onClick={() => onSelect(chat)}
      aria-current={active ? 'true' : undefined}
      aria-label={unread ? `${chat.name}, ${unread} unread ${unread === 1 ? 'message' : 'messages'}` : chat.name}
    >
      <Avatar chat={chat} online={online} />
      <span className="chat-copy"><span className="chat-topline"><strong>{chat.name}</strong>{chat.pinned && <Pin size={13} className="pin-icon" />}</span><span className="chat-preview">{chat.message || 'Room is ready — say hello.'}</span></span>
      <span className="chat-meta"><small>{chat.time || ''}</small>{unread > 0 && <b aria-hidden="true">{unread > 99 ? '99+' : unread}</b>}</span>
    </button>
  )
}

function ChatList({ chats, activeId, presence, failure, onSelect, onCreate, hasQuery, filter }) {
  if (!chats.length) {
    const filtered = filter === 'unread' && !hasQuery
    return (
      <div className="empty-state">
        <div className="empty-icon">{hasQuery || filtered ? <Search size={21} /> : <MessageCircle size={21} />}</div>
        <h3>{hasQuery ? 'No rooms found' : filtered ? 'Nothing unread' : 'No rooms yet'}</h3>
        <p>{hasQuery ? 'Try a different room name.' : filtered ? 'Every room on this device is caught up.' : 'Create a room or join one by name to start chatting.'}</p>
        {!hasQuery && !filtered && <button className="empty-create-button" type="button" onClick={onCreate}><Plus size={15} /> Create or join a room</button>}
      </div>
    )
  }
  return (
    <>
      {/* Every room answered "nobody is online" because none could be asked. */}
      {failure && <p className="feed-failure chat-list-failure" role="alert"><AlertCircle size={14} />{failure}</p>}
      <div className="chat-list">{chats.map((chat) => <ChatItem key={chat.id} chat={chat} active={activeId === chat.id} online={Boolean(presence?.[chat.id])} onSelect={onSelect} />)}</div>
    </>
  )
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
/**
 * Two seats and one code.
 *
 * The code is minted on request and never kept: what is on the screen can be
 * replaced, so a code read over somebody's shoulder costs one click rather than
 * a new room. The names come from the profile lookup and fall back to the
 * session id, because a partner may never have set a display name.
 */
function PairingSection({ chat, session }) {
  const [roster, setRoster] = useState(null)
  const [partner, setPartner] = useState(null)
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [status, setStatus] = useState('')
  const [pending, setPending] = useState(false)

  const load = useCallback(async () => {
    setPending(true)
    try {
      const loaded = await fetchRoomRoster(session, chat.id)
      setRoster(loaded)
      const other = loaded.members.find((member) => member.userId !== session.userId)
      setPartner(other ? (await fetchProfiles(session, [other.userId]))[other.userId] || other : null)
    } catch (error) {
      setStatus(error.message)
    } finally {
      setPending(false)
    }
  }, [chat.id, session])

  useEffect(() => {
    setCode('')
    setStatus('')
    load()
  }, [load])

  const mint = async () => {
    setPending(true)
    setStatus('')
    try {
      const next = await rotateRoomInvite(session, chat.id)
      setCode(next.inviteCode)
      setCopied(false)
      await load()
    } catch (error) {
      setStatus(error.message)
    } finally {
      setPending(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
    } catch {
      setStatus('This browser will not hand the code to the clipboard. Read it out instead.')
    }
  }

  const seatLabel = (member) => {
    if (member.userId === session.userId) return 'You'
    return partner?.userId === member.userId && partner.displayName ? partner.displayName : `Guest ${member.userId.slice(0, 8)}`
  }

  const seatNote = (member) => (member.role === 'owner' ? 'Created this room' : 'Paired with a code')

  return (
    <>
      <h3 className="settings-group-title"><Users size={15} /> People</h3>
      {roster ? (
        <ul className="blocked-list">
          {roster.members.map((member) => (
            <li key={member.userId}>
              <div><strong>{seatLabel(member)}</strong><small>{seatNote(member)}</small></div>
            </li>
          ))}
          {!roster.seatsFull && (
            <li>
              <div><strong>Second seat</strong><small>Free — one more person can join with a code.</small></div>
              {roster.role === 'owner' && <button type="button" className="btn" onClick={mint} disabled={pending}>{code ? 'New code' : 'Give a code'}</button>}
            </li>
          )}
        </ul>
      ) : <div className="settings-inline-skeleton" role="status" aria-label="Reading who is in this room"><span /><span /></div>}
      {code && (
        <div className="pairing-code">
          <code>{code}</code>
          <button type="button" className="btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      )}
      {roster?.role === 'owner' && roster.seatsFull && (
        <button type="button" className="btn" onClick={mint} disabled={pending}>
          {pending ? 'Making a new code…' : 'New pairing code'}
        </button>
      )}
      <p className="settings-note">A room holds two people, and only its owner can hand out a code. A new code stops the old one working, so share it in person or over a channel you already trust.</p>
      {status && <p className="settings-status" role="status">{status}</p>}
    </>
  )
}

function ChatSettingsSheet({
  chat, session, settings, onClose, onSettingsChange, onHistoryRefresh, onChatDeleted, onLocalClear, onLocalForget,
}) {
  const sheetRef = useRef(null)
  const [pending, setPending] = useState('')
  const [status, setStatus] = useState('')
  const [confirming, setConfirming] = useState('')
  const [hd, setHd] = useState(readHdPreference)
  const [notify, setNotify] = useState(readNotifyPrefs)
  const [permission, setPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
  useDialogTrap(sheetRef, { onClose })

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
    // The view goes blank here; the device's own copy of those rows goes with it.
    await onLocalClear?.()
  }, 'History cleared for you. New messages still arrive.')

  const deleteChat = () => run('delete', async () => {
    const result = await deleteChatForMe(session, chat.id)
    await onLocalForget?.()
    onChatDeleted(result)
    return result
  }, (result) => (result.selfRoomDeleted
    ? `Your room was emptied — ${result.removed} message${result.removed === 1 ? '' : 's'} gone.`
    : 'This chat is hidden for you and gone from this device.'))

  return createPortal(
    <div className="room-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={sheetRef} className="room-modal chat-settings-sheet" role="dialog" aria-modal="true" aria-label={`Chat settings for ${chat.name}`}>
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

        <PairingSection chat={chat} session={session} />

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

/**
 * Rows read off this device before the room's socket has said anything.
 *
 * Bigger than the server's page on purpose: the point of a local transcript is
 * that a reload shows more than a fresh join would.
 */
const LOCAL_HYDRATION_LIMIT = 200

/**
 * One bubble, one menu — so this can only ever mount once, which is what lets
 * it own a focus hook. A menu rendered inside the message loop could not.
 */
function AuthorPopMenu({ author, onBlock, onClose }) {
  const menuRef = useRef(null)
  useMenuNavigation(menuRef, { onClose })
  return (
    <div ref={menuRef} className="bubble-author-pop" role="menu">
      <button type="button" role="menuitem" onClick={onBlock}><Ban size={14} /> Block {author.displayName || 'this guest'}</button>
      <button type="button" role="menuitem" onClick={onClose}>Cancel</button>
    </div>
  )
}

function ChatPreview({ chat, session, onClose, onLatestMessage, onChatRemoved, autoCall, onAutoCallHandled }) {
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState([])
  // A room keeps more rows than one read returns, so the oldest sequence this
  // device holds is the cursor that reaches the page underneath it.
  const [historyCursor, setHistoryCursor] = useState(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hydrating, setHydrating] = useState(true)
  const [hydrateFailure, setHydrateFailure] = useState('')
  const [hydrateAttempt, setHydrateAttempt] = useState(0)
  const [connection, setConnection] = useState('Connecting…')
  const [presenceCount, setPresenceCount] = useState(0)
  const [notice, setNotice] = useState('')
  const [socket, setSocket] = useState(null)
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false)
  const [hdQuality, setHdQuality] = useState(readHdPreference)
  const [emojiOpen, setEmojiOpen] = useState(false)
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
  /** Rows this device has committed to its local store, and rows that have since changed. */
  const persistedRef = useRef(new Set())
  const dirtyRef = useRef(new Set())
  /** The newest row this viewer has seen; `undefined` until this room has shown one. */
  const previewedRef = useRef(undefined)
  /** The list callback is read through a ref because the socket handlers bind once per room. */
  const onLatestMessageRef = useRef(onLatestMessage)
  useEffect(() => { onLatestMessageRef.current = onLatestMessage }, [onLatestMessage])
  const galleryInputRef = useRef(null)
  const fileInputRef = useRef(null)
  /** `capture` asks the phone for its camera instead of its library. */
  const cameraInputRef = useRef(null)
  const frontCameraInputRef = useRef(null)
  const videoInputRef = useRef(null)
  const composeInputRef = useRef(null)
  const recorderRef = useRef(null)
  const recordingStreamRef = useRef(null)
  const recordingChunksRef = useRef([])
  const recordingStartRef = useRef(0)
  const attachMenuRef = useRef(null)
  const calls = useRoomCalls(socket, chat.id, session)
  useDialogTrap(attachMenuRef, { active: attachmentMenuOpen, onClose: () => setAttachmentMenuOpen(false) })
  const chatOverlayOpen = attachmentMenuOpen || emojiOpen || calls.pickerMode || messageSearchOpen || settingsOpen || Boolean(richSheet) || Boolean(mediaViewer)
  useBackDismiss(chatOverlayOpen, () => {
    if (mediaViewer) setMediaViewer(null)
    else if (richSheet) setRichSheet(null)
    else if (settingsOpen) setSettingsOpen(false)
    else if (messageSearchOpen) setMessageSearchOpen(false)
    else if (calls.pickerMode) calls.closePicker()
    else if (emojiOpen) setEmojiOpen(false)
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
  const bodyPhase = transcriptPhase({ hydrating, failure: hydrateFailure, messages: visibleMessages.length, connected: connection === 'Connected' })

  const showNotice = (text) => {
    setNotice(text)
    window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(''), 3500)
  }

  /**
   * Reads this device's own copy of the room before the network has answered.
   *
   * IndexedDB is the primary store, so the transcript is shown from disk and the
   * server's page is folded over it rather than the other way round. A guest who
   * reloads in a room whose server is down now reads their own conversation,
   * which is the behaviour the storage layer exists to buy. The stored cursor is
   * kept because it usually reaches further back than the server's page.
   *
   * A read that failed used to be silent, and silence cost more than a missing
   * message: the cursor stays null, so the only pagination affordance never
   * renders and the guest is left in a room that looks untouched. It now names
   * what it could not open, and reads again on request.
   */
  useEffect(() => {
    let active = true
    setHydrating(true)
    setHydrateFailure('')
    Promise.all([readMessagePage(chat.id, { limit: LOCAL_HYDRATION_LIMIT }), readRoomState(chat.id)])
      .then(([rows, state]) => {
        if (!active) return
        if (rows.length) {
          rows.forEach((row) => persistedRef.current.add(row.id))
          // Only the rows this device does not already have are taken from disk:
          // whatever the socket delivered arrived after the read started and is
          // newer than the copy on it, receipts included.
          setMessages((current) => mergePage(current, rows))
          setHistoryCursor((current) => olderCursor(current, state?.oldestSeq ?? rows[0].seq))
        }
        setHydrating(false)
      })
      .catch((reason) => {
        if (!active) return
        setHydrating(false)
        setHydrateFailure(localReadFailure(reason))
      })
    return () => { active = false }
    // One read per room per guest; the component is keyed on both.
  }, [chat.id, session.userId, hydrateAttempt])

  /**
   * Writes what the transcript has just learned, in the order it matters.
   *
   * Rows first, then the attachment metadata that describes them, then the
   * room's cursor - so a store interrupted halfway never records a cursor
   * pointing at rows it does not hold. Only rows this device has not committed
   * (or has since changed) are written, and a row is counted as held only once
   * the transaction commits. A failure keeps the rows dirty, so the next change
   * in this room retries, and says so out loud: a chat that looks saved but is
   * not there after a reload is the one outcome a guest cannot discover alone.
   */
  useEffect(() => {
    const fresh = rowsToPersist(visibleMessages, persistedRef.current, dirtyRef.current)
    if (!fresh.length) return
    const files = attachmentRows(fresh)
    const span = seqSpan(visibleMessages)
    storeMessages(chat.id, fresh)
      .then(() => (files.length ? storeMedia(chat.id, files) : 0))
      .then(() => saveRoomState(chat.id, { oldestSeq: span.oldest, latestSeq: span.latest }))
      .then(() => {
        fresh.forEach((message) => {
          persistedRef.current.add(message.id)
          dirtyRef.current.delete(message.id)
        })
      })
      .catch((error) => {
        showNotice(isQuotaError(error)
          ? 'This device is out of storage space, so this chat is not being kept locally.'
          : 'This chat could not be saved on this device.')
      })
    // The view this guest is allowed to see, not the raw list: a message they
    // blocked, deleted or cleared away is not theirs to keep a copy of.
  }, [visibleMessages, chat.id])

  /**
   * Keeps the room list's preview in step with what this viewer can see.
   *
   * The list is written when a message arrives, but deleting or clearing a
   * transcript changes the newest row without anything arriving. Without this
   * the room list - and the copy of it in localStorage - would go on showing the
   * text of the message the guest just asked to have gone.
   */
  useEffect(() => {
    const newest = visibleMessages.length ? visibleMessages[visibleMessages.length - 1] : null
    const id = newest ? newest.id : null
    if (previewedRef.current === id) return
    // An empty room that has never shown a message here is not a deletion, and
    // the list keeps whatever the last visit wrote until this one says otherwise.
    if (previewedRef.current === undefined && id === null) return
    previewedRef.current = id
    onLatestMessageRef.current(chat.id, newest)
  }, [visibleMessages, chat.id])

  /**
   * The server has forgotten these rows for this viewer, so this device must too.
   *
   * "Delete for me" and "clear chat" are viewer-scoped on the server; leaving the
   * local copy behind would resurrect messages the guest removed, and spend quota
   * on a transcript nobody is allowed to see any more.
   */
  const dropLocalMessages = async (ids) => {
    try {
      // The attachment rows are named by the messages that carried them, and
      // those are still on screen, so no scan of the media store is needed.
      const files = messages
        .filter((message) => ids.includes(message.id))
        .flatMap((message) => (message.attachments || []).map((file) => file.id))
      await deleteMessages(chat.id, ids)
      await deleteMedia(files)
      ids.forEach((id) => {
        persistedRef.current.delete(id)
        dirtyRef.current.delete(id)
      })
    } catch {
      showNotice('Deleted on the server, but some rows are still on this device.')
    }
  }

  const clearLocalRoom = async () => {
    try {
      const [removed] = await Promise.all([deleteRoomMessages(chat.id), deleteRoomMedia(chat.id)])
      // Every row still on screen belongs to the past this guest just cleared:
      // they are marked as handled so the next message cannot write them back.
      messages.forEach((message) => persistedRef.current.add(message.id))
      return removed
    } catch {
      showNotice('Cleared on the server, but this device kept its local copy.')
      return 0
    }
  }

  /** The whole room is gone for this guest, and the local copy goes with it. */
  const forgetLocalRoom = async () => {
    try {
      await Promise.all([deleteRoomMessages(chat.id), deleteRoomMedia(chat.id), forgetRoomState(chat.id)])
      messages.forEach((message) => persistedRef.current.add(message.id))
    } catch {
      showNotice('Deleted on the server, but this device still holds its own copy.')
    }
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
      setMessages((current) => mergeServerPage(current, history))
      // The page is the room's newest window; this device may already reach
      // further back, and paging from the newer edge would hide what it holds.
      setHistoryCursor((current) => olderCursor(current, history.length ? history[0].seq : null))
    } catch (error) {
      showNotice(error.message)
    }
  }

  /**
   * Reads the page underneath what this device holds. A room keeps far more
   * rows than the first read returns, so without this the older transcript is
   * unreachable no matter how long the room has been running.
   */
  const loadOlder = async () => {
    if (historyCursor === null || loadingOlder) return
    setLoadingOlder(true)
    try {
      const older = (await fetchRoomMessages(session, chat.id, { before: historyCursor }))
        .map((message) => toUiMessage(message, session))
      setMessages((current) => mergePage(current, older))
      // The page came back oldest-first, so its first row is the next cursor.
      setHistoryCursor(older.length ? older[0].seq ?? null : null)
    } catch (error) {
      showNotice(error.message)
    } finally {
      setLoadingOlder(false)
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
      await dropLocalMessages(ids)
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
    onLocalClear: clearLocalRoom,
    onLocalForget: forgetLocalRoom,
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
      setMessages((current) => mergeServerPage(current, history))
      // Rows arrive oldest first, so the first one is where the next page begins -
      // unless this device's own copy already reaches under it.
      setHistoryCursor((current) => olderCursor(current, history.length ? history[0].seq : null))
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
    /**
     * A receipt names the room it belongs to, and one page arriving is a list
     * of ids rather than a message: applying a receipt meant for another room
     * would tick messages this device never sent in this one.
     */
    const applyReceipt = (field) => (receipt) => {
      if (receipt.room && receipt.room !== chat.id) return
      const ids = receipt.messageIds || [receipt.messageId]
      // The ticks are part of the copy this device keeps, so a row whose
      // receipts moved has to be written again rather than left as first stored.
      ids.forEach((id) => dirtyRef.current.add(id))
      setMessages((current) => current.map((message) => {
        if (!ids.includes(message.id)) return message
        const holders = new Set(message[field] || [])
        if (receipt.userId) holders.add(receipt.userId)
        return { ...message, [field]: Array.from(holders) }
      }))
    }
    roomSocket.on('message_delivered', applyReceipt('deliveredTo'))
    roomSocket.on('messages_delivered', applyReceipt('deliveredTo'))
    roomSocket.on('message_seen', applyReceipt('seenBy'))
    roomSocket.on('poll_voted', (payload) => {
      if (payload.room !== chat.id || !payload.results) return
      dirtyRef.current.add(payload.messageId)
      setMessages((current) => current.map((message) => (
        message.id === payload.messageId ? { ...message, results: payload.results } : message
      )))
    })
    // The header says "people", so it has to count people: one guest holding two
    // tabs is two connections, and a room that legally fits two would claim three.
    roomSocket.on('presence', (snapshot) => setPresenceCount(Number(snapshot.onlineUsers ?? snapshot.connections) || 0))
    roomSocket.on('system', (payload) => {
      if (payload.type === 'error') showNotice(payload.message || 'Room connection error.')
      // The server closed this socket because the session behind it is gone, so
      // say so instead of leaving a room that looks connected but receives nothing.
      if (payload.type === 'session_revoked') showNotice('Your session expired. Join this room again to keep chatting.')
      // Without a shared store this instance cannot see what the others hold,
      // and a guest would otherwise believe the room was one chat.
      if (payload.type === 'connected' && payload.sharedStore === false) {
        showNotice('This server has no shared store: other instances will not see this room.')
      }
    })
    return () => {
      roomSocket.disconnect()
      socketRef.current = null
      window.clearTimeout(noticeTimerRef.current)
      window.clearTimeout(seenFlushTimerRef.current)
    }
    // Room and guest identity define one socket lifecycle.
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
    // The faces this device already knows go on first, so a reload does not
    // show initials where there were pictures a second ago. The request below
    // still runs and still wins: an author who changed their avatar since the
    // last visit sees the new one on the next load, not after a cache clear.
    readProfiles(missing)
      .then((cached) => {
        if (!active || !cached.length) return
        setProfiles((current) => {
          const next = { ...current }
          cached.forEach((profile) => { if (profile?.userId && !(profile.userId in next)) next[profile.userId] = profile })
          return next
        })
      })
      .catch(() => { /* a cold cache only means waiting for the server */ })
    fetchProfiles(session, missing)
      .then((rows) => {
        if (!active) return
        setProfiles((current) => ({ ...current, ...rows }))
        storeProfiles(Object.values(rows)).catch(() => {})
      })
      .catch(() => { /* a room without pictures still works; initials take over */ })
    return () => { active = false }
  }, [messages, session])

  // Keyed on the last row rather than the whole list: reading an older page
  // changes the list and must not drag the transcript back to the bottom.
  const newestMessageId = messages.length ? messages[messages.length - 1].id : null
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })
  }, [newestMessageId])

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
    const response = await fetch('/api/media', { method: 'POST', headers: sessionHeaders(session), body: form })
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
      // The ack's sequence is the store's own arrival number: filing the row by
      // it the moment the server accepts it is what lets this device write the
      // message to its local transcript instead of waiting for a live copy of
      // its own send to arrive back over the socket.
      setMessages((current) => current.map((message) => (message.clientId === clientId
        ? {
          ...message,
          id: acknowledgement.id || message.id,
          seq: Number.isFinite(Number(acknowledgement.seq)) ? Number(acknowledgement.seq) : message.seq,
          ts: acknowledgement.ts || message.ts,
          time: formatTime(acknowledgement.ts || message.ts),
          pending: false,
        }
        : message)))
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

  /**
   * The reference writes "Online" under a name, and the only honest source for
   * that here is the room's own socket roster: the server counts the members it
   * can see in this room, you included. Two of them means the other seat is
   * awake; one means nobody else is reading.
   */
  const peerOnline = connection === 'Connected' && presenceCount > 1
  /**
   * The picker takes focus when it opens, so the caret it reads is the one the
   * field last reported and the field has to be handed the caret back.
   */
  const pickEmoji = (glyph) => {
    const field = composeInputRef.current
    const { value, caret } = insertAtCaret(draft, field?.selectionStart, field?.selectionEnd, glyph)
    if (value.length > 20000) return
    setDraft(value)
    setEmojiOpen(false)
    window.requestAnimationFrame(() => {
      if (!field) return
      field.focus()
      field.setSelectionRange(caret, caret)
    })
  }

  const subtitle = connection !== 'Connected' ? connection : peerOnline ? 'Online' : 'Only you in this room'

  return (
    <section className={`chat-preview-panel${chatSettings.theme !== 'default' ? ` chat-theme-${chatSettings.theme}` : ''}`}>
      <div className="preview-top">
        <button className="preview-back" aria-label="Back to rooms" onClick={onClose}><ArrowLeft size={20} /></button>
        <div className="preview-person"><Avatar chat={chat} small online={peerOnline} /><div><strong>{chat.name}</strong><span className={connection === 'Connected' ? 'connection-online' : 'connection-offline'}>{subtitle}</span></div></div>
        <div className="preview-actions">
          <button className={`preview-call-action${messageSearchOpen ? ' is-active' : ''}`} aria-label="Search messages in this room" title="Search this room" aria-pressed={messageSearchOpen} onClick={() => { setMessageSearchOpen((open) => !open); setMessageSearchIndex(0) }}><Search size={17} /></button>
          <button className={`preview-call-action${selectMode ? ' is-active' : ''}`} aria-label="Select messages to delete for me" title="Select messages" aria-pressed={selectMode} onClick={toggleSelectMode}><ListChecks size={17} /></button>
          <button className={`preview-call-action${settingsOpen ? ' is-active' : ''}`} aria-label="Chat settings" title="Chat settings" onClick={() => setSettingsOpen((open) => !open)}><Settings2 size={17} /></button>
          <button className="preview-call-action" aria-label="Start video call" title="Start video call" onClick={() => calls.openPicker('video')} disabled={Boolean(calls.call)}><Video size={18} /></button>
          <button className="preview-call-action" aria-label="Start audio call" title="Start audio call" onClick={() => calls.openPicker('audio')} disabled={Boolean(calls.call)}><Phone size={18} /></button>
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
      <div className="preview-body" ref={previewBodyRef} aria-live="polite" aria-busy={bodyPhase === 'skeleton'}>
        {historyCursor !== null && !!visibleMessages.length && (
          <div className="room-older-messages">
            <button type="button" className={`btn${loadingOlder ? ' is-loading' : ''}`} onClick={loadOlder} disabled={loadingOlder} aria-label={loadingOlder ? 'Loading older messages' : 'Load older messages'}>
              {loadingOlder ? <span className="loading-dots" aria-hidden="true"><i /><i /><i /></span> : 'Load older messages'}
            </button>
          </div>
        )}
        {bodyPhase === 'skeleton' && <>
          <span className="sr-only" role="status">Opening this chat from this device</span>
          <div className="transcript-skeleton" aria-hidden="true">
            {Array.from({ length: SKELETON_ROWS }, (row, index) => <span key={index} className={`skeleton-bubble${index % 2 ? ' skeleton-out' : ' skeleton-in'}`} />)}
          </div>
        </>}
        {bodyPhase === 'connecting' && <div className="transcript-connecting" role="status"><span className="loading-dots" aria-hidden="true"><i /><i /><i /></span><span>Joining <b>#{chat.id}</b></span></div>}
        {hydrateFailure && <p className="feed-failure" role="alert"><AlertCircle size={14} />{hydrateFailure} <button type="button" className="btn" onClick={() => setHydrateAttempt((count) => count + 1)}>Try again</button></p>}
        {bodyPhase === 'empty' && <div className="room-first-message"><MessageCircle size={25} /><strong>{chatSettings.clearedAt ? 'Your history here is cleared' : 'This room is ready'}</strong><span>Say hello to whoever holds the other seat in <b>#{chat.id}</b>.</span></div>}
        {searchIsActive && displayedMessages.length === 0 && <div className="message-search-empty"><Search size={20} /><strong>No matching messages</strong><span>Try another word, type or date range.</span></div>}
        {displayedMessages.map((message, index) => {
          const previous = displayedMessages[index - 1]
          const startsNewDay = !previous || !sameMessageDay(previous.ts, message.ts)
          /**
           * A run of messages from one person is one turn, not three name tags.
           * The reference writes no name inside the bubbles at all; the name here
           * also carries the block control, so it stays on the row that opens the
           * run and the rows under it group tight against it.
           */
          const showAuthor = message.sender === 'them' && (startsNewDay || !previous || previous.userId !== message.userId)
          const grouped = Boolean(previous) && !startsNewDay && previous.sender === message.sender && previous.userId === message.userId
          const hasVideo = message.attachments?.some((attachment) => attachment.kind === 'video')
          const hasImage = message.attachments?.some((attachment) => attachment.kind === 'image')
          const isSearchMatch = searchIsActive && searchMatches.some((item) => item.message.id === message.id)
          const isCurrentSearchMatch = searchIsActive && searchMatches[Math.min(messageSearchIndex, Math.max(0, searchMatches.length - 1))]?.message.id === message.id
          return <Fragment key={message.id}>
            {startsNewDay && <div className="message-date-divider"><span>{formatMessageDay(message.ts)}</span></div>}
            <div ref={(node) => { if (node) messageNodesRef.current.set(String(message.id), node); else messageNodesRef.current.delete(String(message.id)) }} data-message-id={message.id} data-user-id={message.userId || ''} className={`bubble bubble-${message.sender}${grouped ? ' bubble-grouped' : ''}${message.failed ? ' bubble-failed' : ''}${hasVideo ? ' bubble-has-video' : ''}${hasImage ? ' bubble-has-image' : ''}${isSearchMatch ? ' message-search-match' : ''}${isCurrentSearchMatch ? ' message-search-current' : ''}${selectMode && selectedIds.has(message.id) ? ' message-selected' : ''}`}>
              {selectMode && <button type="button" className="bubble-select-box" role="checkbox" aria-checked={selectedIds.has(message.id)} aria-label={`Select ${message.author || 'this message'} for deletion`} onClick={() => toggleSelected(message.id)}>{selectedIds.has(message.id) ? <Check size={13} /> : <span />}</button>}
              {showAuthor && <small className="bubble-author"><AvatarFace className="bubble-avatar" src={profiles[message.userId]?.avatar?.url} initials={initialsOf(message.author, '#')} />{highlightText(message.author, searchIsActive ? messageSearchText : '')}<button type="button" className="bubble-author-menu" aria-label={`Options for ${message.author}`} aria-haspopup="menu" aria-expanded={authorMenu?.messageId === message.id} onClick={() => setAuthorMenu({ messageId: message.id, userId: message.userId, displayName: message.author })}><Ellipsis size={13} /></button></small>}
              {/* One menu per author means two bubbles of the same guest each rendered a copy; the id pins it to the bubble that opened it. */}
              {showAuthor && authorMenu?.messageId === message.id && (
                <AuthorPopMenu author={authorMenu} onBlock={() => blockThisGuest(authorMenu)} onClose={() => setAuthorMenu(null)} />
              )}
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
        {uploading && <p className="uploading-indicator" role="status"><span className="loading-dots" aria-hidden="true"><i /><i /><i /></span>Preparing your media</p>}
        {recording && <p className="recording-indicator" role="status"><i /> Recording voice · {Math.floor(recordingSeconds / 60)}:{String(recordingSeconds % 60).padStart(2, '0')} — tap the mic to send</p>}
        <form className="compose-controls" onSubmit={sendMessage}>
          <div className="compose-field">
            <div className="emoji-wrap">
              <button type="button" className="emoji-toggle" aria-label="Insert an emoji" aria-expanded={emojiOpen} onClick={() => setEmojiOpen((open) => !open)}><Smile size={20} /></button>
              {emojiOpen && <div className="emoji-sheet" role="dialog" aria-label="Choose an emoji">
                {EMOJI_GROUPS.map((group) => <div className="emoji-group" key={group.label}>
                  <strong>{group.label}</strong>
                  <div className="emoji-grid">{group.items.map((glyph) => <button type="button" key={glyph} onClick={() => pickEmoji(glyph)}>{glyph}</button>)}</div>
                </div>)}
              </div>}
            </div>
            <input ref={composeInputRef} className="compose-input" type="text" placeholder="Type a message…" aria-label="Type a message" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={20000} />
            <div className="attach-wrap">
              <button type="button" className="attach-button" aria-label="Add an attachment" aria-haspopup="dialog" aria-expanded={attachmentMenuOpen} onClick={() => setAttachmentMenuOpen((open) => !open)} disabled={uploading}><Plus size={21} /></button>
              {attachmentMenuOpen && <div className="attachment-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAttachmentMenuOpen(false) }}>
                <section ref={attachMenuRef} className="attachment-menu" role="dialog" aria-modal="true" aria-label="Choose an attachment">
                  <div className="attachment-sheet-handle" aria-hidden="true" />
                  <div className="attachment-sheet-header"><div><span>SHARE SOMETHING</span><strong>Choose an attachment</strong></div><button type="button" aria-label="Close attachments" onClick={() => setAttachmentMenuOpen(false)}><X size={18} /></button></div>
                  <div className="attachment-shortcuts">
                    <button type="button" onClick={() => { cameraInputRef.current?.click(); setAttachmentMenuOpen(false) }}><Camera size={20} /><span>Back camera</span></button>
                    <button type="button" onClick={() => { frontCameraInputRef.current?.click(); setAttachmentMenuOpen(false) }}><CircleUserRound size={20} /><span>Front camera</span></button>
                    <button type="button" onClick={() => { videoInputRef.current?.click(); setAttachmentMenuOpen(false) }}><Video size={20} /><span>Record video</span></button>
                    <button type="button" onClick={() => { galleryInputRef.current?.click(); setAttachmentMenuOpen(false) }}><Image size={20} /><span>Photos & videos</span></button>
                    <button type="button" onClick={() => { fileInputRef.current?.click(); setAttachmentMenuOpen(false) }}><Ellipsis size={20} /><span>More apps & files</span></button>
                  </div>
                  <label className="attachment-hd-row"><span><strong>Send in HD</strong><small>{hdQuality ? 'Keep original image quality.' : 'Optimize media to send faster.'}</small></span><input type="checkbox" role="switch" className="settings-switch" checked={hdQuality} onChange={(event) => setHdQuality(saveHdPreference(event.target.checked))} /></label>
                  <div className="attachment-sheet-divider" />
                  <div className="attachment-rich-actions" aria-label="More sharing options">
                    <button type="button" onClick={() => { setAttachmentMenuOpen(false); setRichSheet('poll') }}><ListChecks size={17} /><span>Poll</span></button>
                    <button type="button" onClick={() => { setAttachmentMenuOpen(false); setRichSheet('event') }}><CalendarDays size={17} /><span>Event</span></button>
                    <button type="button" onClick={() => { setAttachmentMenuOpen(false); setRichSheet('contact') }}><CircleUserRound size={17} /><span>Contact</span></button>
                    <button type="button" onClick={() => { setAttachmentMenuOpen(false); shareLocation() }}><MapPin size={17} /><span>Location</span></button>
                  </div>
                </section>
              </div>}
            </div>
          </div>
          <input ref={galleryInputRef} className="hidden-file-input" tabIndex={-1} type="file" accept="image/*,video/*" multiple onChange={handlePickedFiles} />
          <input ref={fileInputRef} className="hidden-file-input" tabIndex={-1} type="file" multiple onChange={handlePickedFiles} />
          {/* `capture` is a request, not a guarantee: a desktop browser opens its file box. */}
          <input ref={cameraInputRef} className="hidden-file-input" tabIndex={-1} type="file" accept="image/*" capture="environment" onChange={handlePickedFiles} />
          <input ref={frontCameraInputRef} className="hidden-file-input" tabIndex={-1} type="file" accept="image/*" capture="user" onChange={handlePickedFiles} />
          <input ref={videoInputRef} className="hidden-file-input" tabIndex={-1} type="file" accept="video/*" capture="environment" onChange={handlePickedFiles} />
          {draft.trim()
            ? <button type="submit" className="send-button" aria-label="Send message" disabled={uploading}><Send size={18} /></button>
            : <button type="button" className={`voice-record-button${recording ? ' is-recording' : ''}`} aria-label={recording ? 'Stop and send voice message' : 'Record a voice message'} title={recording ? 'Stop and send voice message' : 'Record a voice message'} onClick={toggleVoiceRecording} disabled={uploading}>{recording ? <Square size={16} /> : <Mic size={18} />}</button>}
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
    if (calls.call?.status === 'reconnecting') return undefined
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
  // Docked is the one mode that claims aria-modal, so it is the one that must hold focus.
  useDialogTrap(shellRef, { active: mode === 'docked', onClose: () => changeMode('floating') })

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
      : calls.call.status === 'reconnecting' ? 'Reconnecting signaling…'
        : calls.call.status === 'active' ? `Connected · ${callDuration(activeAtRef.current)}`
        : calls.call.status === 'failed' ? 'Connection failed' : 'Connecting…'

  const gestureProps = (kind) => ({
    onPointerDown: (event) => {
      // Controls sit inside the drag surface (the header and the minimised
      // pill). Capturing the pointer there retargeted the click to the drag
      // surface, so Float, Minimise, Expand and End call never fired; a press
      // on a control must not start a drag.
      if (kind === 'drag' && event.target.closest?.('button, a, input, select, textarea')) return
      startGesture(kind, event)
    },
    onPointerMove: moveGesture,
    onPointerUp: endGesture,
    onPointerCancel: endGesture,
  })

  const shellClass = `call-window${calls.call.mode === 'video' ? ' video-call-window' : ''}${mode === 'floating' ? ' is-floating' : ''}${mode === 'minimized' ? ' is-minimized' : ''}${fullscreen ? ' is-fullscreen' : ''}`
  const shellStyle = mode === 'docked' && !fullscreen ? undefined : frameStyle(frame, 'floating')

  /**
   * Readiness is "has this call shown a frame at all", not "is a frame arriving
   * right now". The old `onWaiting` reset flipped the placeholder back over a
   * perfectly good last frame every time the network hiccupped, which is what
   * made the stage blink. Once a frame has played it stays; `waiting` only dims
   * the video for a moment.
   */
  const remoteHasVideo = Boolean(calls.remoteStream?.getVideoTracks?.().length)
  const waitingLabel = calls.call.status === 'incoming' ? 'Video call'
    : calls.call.status === 'failed' ? 'Video connection failed'
      : calls.call.status === 'active' ? (remoteHasVideo ? 'Waiting for the first frame' : 'Camera is off')
        : 'Connecting video'

  const stage = calls.call.mode === 'video' ? (
    <div className={`call-video-stage${calls.call.status === 'active' ? ' is-live' : ''}`}>
      <video ref={calls.remoteVideoRef} className="remote-call-video" autoPlay playsInline onClick={calls.retryRemotePlayback} onPlaying={calls.markRemoteVideoReady} />
      <video ref={calls.localVideoRef} className={`local-call-video${calls.cameraFacing === 'user' ? ' is-mirrored' : ''}${calls.cameraOff ? ' is-camera-off' : ''}`} autoPlay muted playsInline />
      <div className="call-stage-overlay" data-visible={fullscreen ? 'true' : 'false'}>
        <span className={`call-live-dot${calls.call.status === 'active' ? ' is-live' : ''}`} aria-hidden="true" />
        <div><strong>{calls.call.peerName}</strong><small>{statusLine}</small></div>
      </div>
      {/* Kept mounted and faded, not removed: swapping the element in and out
          was the other half of the stage blink. */}
      <div className="call-video-placeholder" data-visible={!calls.remoteVideoReady} aria-hidden={calls.remoteVideoReady ? 'true' : undefined}>
        <span>{calls.call.peerName.slice(0, 1).toUpperCase()}</span>
        <strong>{waitingLabel}</strong>
        <small>{calls.call.status === 'failed'
          ? 'A TURN relay may be required on this network.'
          : calls.call.status === 'active' && !remoteHasVideo ? 'Their audio is still connected.' : 'The first frame is on its way.'}</small>
      </div>
    </div>
  ) : (
    <div className={`audio-call-stage${calls.call.status === 'active' ? ' is-live' : ''}`}>
      <span className="audio-call-avatar" aria-hidden="true">{calls.call.peerName.slice(0, 1).toUpperCase()}</span>
      <strong>{calls.call.peerName}</strong>
      <small>{calls.call.status === 'active' ? 'Audio connected' : statusLine}</small>
      {calls.call.status === 'active' && <span className="call-equalizer" aria-hidden="true"><i /><i /><i /><i /><i /></span>}
      <audio ref={calls.remoteAudioRef} autoPlay />
    </div>
  )

  const minimizedNode = (
    <div ref={shellRef} className={shellClass} style={shellStyle} role="group" aria-label={`${calls.call.mode} call with ${calls.call.peerName}, minimised`} {...gestureProps('drag')}>
      <audio ref={calls.remoteAudioRef} autoPlay />
      <span className="call-pill-dot" aria-hidden="true" />
      <span className="call-pill-peer">{calls.call.peerName}</span>
      <span className="call-pill-time">{calls.call.status === 'active' ? callDuration(activeAtRef.current) : statusLine}</span>
      <button type="button" className="call-pill-expand" onClick={() => changeMode(calls.call.mode === 'video' ? 'floating' : 'docked')}><Maximize2 size={15} /> Expand</button>
      <button type="button" className="call-pill-end" aria-label="End call" onClick={calls.hangup}><PhoneOff size={15} /></button>
    </div>
  )

  const windowNode = (
    <div ref={shellRef} className={shellClass} style={shellStyle} role="dialog" aria-modal={mode === 'docked' ? 'true' : undefined} aria-label={`${calls.call.mode} call with ${calls.call.peerName}`}>
      <div className="call-window-head" {...gestureProps('drag')}>
        <div className="call-window-title"><strong>{calls.call.peerName}</strong><span aria-live="polite">{statusLine}</span><small>#{chat.id}</small></div>
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
          {calls.call.mode === 'video' && <button type="button" className={calls.cameraOff ? 'control-muted' : ''} aria-label={calls.cameraOff ? 'Turn camera on' : 'Turn camera off'} onClick={calls.toggleCamera} disabled={!calls.call.localStream}>{calls.cameraOff ? <VideoOff size={18} /> : <Video size={18} />}</button>}{calls.call.mode === 'video' && <button type="button" aria-label={`Switch to ${calls.cameraFacing === 'user' ? 'back' : 'front'} camera`} title={`Switch to ${calls.cameraFacing === 'user' ? 'back' : 'front'} camera`} onClick={calls.switchCamera} disabled={!calls.call.localStream}><RefreshCw size={18} /></button>}
          <button type="button" className="call-hangup control-end" aria-label="End call" onClick={calls.hangup}><PhoneOff size={18} /></button>
        </>}
      </div>
      {mode === 'floating' && !fullscreen && <button type="button" className="call-resize-handle" aria-label="Resize the call window" {...gestureProps('resize')} />}
    </div>
  )

  /**
   * The host element never changes type. Rendered conditionally inside an
   * overlay and outside it, React tore the whole window down on every
   * dock/float switch - a new <video>, an empty srcObject, and the flash that
   * looked like a broken container. Now only the host's class changes.
   */
  const docked = mode === 'docked' && !fullscreen
  return (
    <div className={`call-window-host${docked ? ' is-docked' : ''}${mode === 'minimized' ? ' is-minimized-host' : ''}`} role={docked ? 'presentation' : undefined}>
      {mode === 'minimized' ? minimizedNode : windowNode}
    </div>
  )
}

function JoinRoomDialog({ initialRoom, initialName, onClose, onJoin }) {
  const sheetRef = useRef(null)
  const [displayName, setDisplayName] = useState(initialName || '')
  const [roomName, setRoomName] = useState(initialRoom || '')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  useBackDismiss(true, onClose)
  useDialogTrap(sheetRef, { onClose })

  const submit = async (event) => {
    event.preventDefault()
    setPending(true)
    setError('')
    try {
      await onJoin(displayName, roomName, code)
    } catch (reason) {
      setError(reason.message || 'Could not join this room.')
      setPending(false)
    }
  }

  return (
    <div className="room-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={sheetRef} className="room-modal" role="dialog" aria-modal="true" aria-labelledby="room-modal-title">
        <button className="room-modal-close" type="button" aria-label="Close" onClick={onClose}><X size={18} /></button>
        <div className="room-modal-icon"><MessageCircle size={22} /></div>
        <p className="eyebrow">ROOM CHAT</p>
        <h2 id="room-modal-title">Create or join a room</h2>
        <p className="room-modal-copy">A room holds two people. Leaving the code empty makes you the owner of a new room; typing somebody&rsquo;s code takes the free seat in a room they created. A new owner hands the code out from <strong>People</strong> in the room&rsquo;s settings.</p>
        <form className="room-modal-form" onSubmit={submit}>
          <label className="field"><span>Display name</span><input className="input" required minLength={2} maxLength={32} autoComplete="nickname" placeholder="e.g. Asha" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label className="field"><span>Room name</span><input className="input" required minLength={1} maxLength={64} autoComplete="off" placeholder="e.g. design-team" value={roomName} onChange={(event) => setRoomName(event.target.value)} /></label>
          <small className="room-name-hint">Letters, numbers, dots, dashes and underscores. Spaces turn into dashes.</small>
          <label className="field"><span>Pairing code</span><input className="input code-input" minLength={8} maxLength={128} autoComplete="off" spellCheck={false} placeholder="Only for a room someone else created" value={code} onChange={(event) => setCode(event.target.value)} /></label>
          <small className="room-name-hint">Eight characters, no spaces needed. Leave it empty to start your own room.</small>
          {error && <p className="room-form-error" role="alert">{error}</p>}
          <button className="btn btn-primary room-submit" type="submit" disabled={pending}>{pending ? 'Connecting…' : 'Enter room'}<ChevronRight size={17} /></button>
        </form>
      </section>
    </div>
  )
}

function MainDashboard({ guest, rooms, onJoinRoom, onLatestMessage, onRoomRead, onActiveRoomChange, onRoomRemoved, roomRequest, onRoomRequestHandled }) {
  const [query, setQuery] = useState('')
  const [activeChat, setActiveChat] = useState(null)
  const [joinDialog, setJoinDialog] = useState(null)
  const [listFilter, setListFilter] = useState('all')
  const [presence, setPresence] = useState({})
  const [presenceFailure, setPresenceFailure] = useState('')
  const [inboxPaneWidth, setInboxPaneWidth] = useState(null)
  const [isResizing, setIsResizing] = useState(false)
  const gridRef = useRef(null)
  const roomIds = rooms.map((room) => room.id).join('|')
  const filtered = useMemo(() => {
    const matched = rooms.filter((chat) => `${chat.name} ${chat.username} ${chat.message}`.toLowerCase().includes(query.toLowerCase()))
    return listFilter === 'unread' ? matched.filter((chat) => (chat.unread || 0) > 0) : matched
  }, [rooms, query, listFilter])
  const unreadTotal = useMemo(() => rooms.reduce((total, room) => total + (room.unread || 0), 0), [rooms])

  /**
   * Presence is a server fact, so the list asks the server rather than reading a
   * socket that only ever covers the one room currently open. Membership is
   * checked on the way in, so a room this device cannot enter simply stays grey
   * instead of leaking anything about it.
   */
  useEffect(() => {
    if (!guest?.userId || !roomIds) {
      setPresence({})
      setPresenceFailure('')
      return undefined
    }
    const ids = roomIds.split('|').slice(0, PRESENCE_QUERY_LIMIT)
    let active = true
    const look = () => {
      Promise.allSettled(ids.map((id) => fetchRoomPresence(guest, id).then((users) => users.some((user) => user.userId !== guest.userId))))
        .then((results) => {
          if (!active) return
          const next = {}
          ids.forEach((id, index) => { next[id] = results[index].status === 'fulfilled' ? results[index].value : false })
          setPresence(next)
          // One room refusing to answer is normal; every room refusing to answer
          // is a server nobody should be reading dots from.
          const refused = results.filter((result) => result.status === 'rejected').length
          setPresenceFailure(refused === ids.length && ids.length > 0
            ? 'Online status could not be checked, so the green dots may be out of date.'
            : '')
        })
    }
    look()
    const timer = window.setInterval(look, PRESENCE_REFRESH_MS)
    return () => { active = false; window.clearInterval(timer) }
  }, [roomIds, guest?.userId])

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
    onRoomRead(chat.id)
  }
  const joinFromDialog = async (displayName, roomInput, code) => {
    const chat = await onJoinRoom(displayName, roomInput, code)
    setActiveChat(chat)
    onRoomRead(chat.id)
    setJoinDialog(null)
  }

  /**
   * The shell needs to know which room is on screen: a message that lands in it
   * is read, and a message that lands anywhere else is a badge.
   */
  useEffect(() => {
    onActiveRoomChange(activeChat?.id || null)
  }, [activeChat?.id, onActiveRoomChange])

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
    onRoomRead(summary.id)
    if (!roomRequest.call) onRoomRequestHandled?.()
    return undefined
    // Only a new request opens a room; the room list changes far too often.
  }, [roomRequest?.roomId])

  return (
    <main className="dashboard-shell">
      <div ref={gridRef} className={`dashboard-grid ${activeChat ? 'chat-open' : ''}${isResizing ? ' is-resizing' : ''}`} style={activeChat ? { '--inbox-pane-width': `${currentInboxWidth}px` } : undefined}>
        <section className="inbox-card">
          <div className="section-title room-list-title"><div><h2>Your rooms</h2><span>{rooms.length} {rooms.length === 1 ? 'room' : 'rooms'} on this device</span></div><button type="button" className="room-add-button" aria-label="Create or join a room" onClick={() => setJoinDialog('')}><Plus size={18} /></button></div>
          <SearchBar value={query} onChange={setQuery} count={filtered.length} results={filtered.slice(0, 6)} onPick={openRoom} />
          <div className="list-filters" role="group" aria-label="Filter conversations">
            {LIST_FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`list-filter ${listFilter === item.id ? 'active' : ''}`}
                aria-pressed={listFilter === item.id}
                onClick={() => setListFilter(item.id)}
              >
                {item.label}
                {item.id === 'unread' && unreadTotal > 0 && <span className="list-filter-count">{unreadTotal > 99 ? '99+' : unreadTotal}</span>}
              </button>
            ))}
          </div>
          <ChatList chats={filtered} activeId={activeChat?.id} presence={presence} failure={presenceFailure} onSelect={openRoom} onCreate={() => setJoinDialog('')} hasQuery={Boolean(query)} filter={listFilter} />
          <button type="button" className="room-fab" aria-label="Create or join a room" onClick={() => setJoinDialog('')}><Plus size={22} /></button>
        </section>
        {activeChat && <div className="split-resize-handle" role="separator" aria-orientation="vertical" aria-label="Resize rooms and chat panels" aria-valuemin={340} aria-valuemax={Math.round(maxInboxWidth)} aria-valuenow={Math.round(currentInboxWidth)} aria-valuetext={`${Math.round(currentInboxWidth)} pixels for rooms`} tabIndex={0} onPointerDown={handleResizePointerDown} onPointerMove={handleResizePointerMove} onPointerUp={handleResizeEnd} onPointerCancel={handleResizeEnd} onKeyDown={handleResizeKeyDown} onDoubleClick={() => setInboxPaneWidth(null)} />}
        {activeChat && guest ? <ChatPreview key={`${activeChat.id}:${guest.userId}`} chat={activeChat} session={guest} onClose={() => setActiveChat(null)} onLatestMessage={onLatestMessage} onChatRemoved={(roomId) => { setActiveChat(null); onRoomRemoved(roomId) }} autoCall={roomRequest?.call || null} onAutoCallHandled={() => onRoomRequestHandled?.()} /> : <section className="welcome-card"><div className="welcome-orb"><MessageCircle size={30} /></div><p className="eyebrow">A LITTLE NOTE</p><h2>Make space for<br /><em>good conversations.</em></h2><p>Create a room, or join one with the pairing code its owner hands you. A room holds two people, and your messages appear here in real time.</p><button type="button" className="welcome-create-button" onClick={() => setJoinDialog('')}><Plus size={16} /> Create or join a room</button><div className="welcome-stats"><span><strong>{rooms.length.toString().padStart(2, '0')}</strong><small>rooms on this device</small></span><span><strong>Live</strong><small>room messages</small></span></div></section>}
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
  const viewerRef = useRef(null)
  const viewersRef = useRef(null)

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
  const liveCount = groups.mine.length + groups.unseen.length
  const hasCards = Boolean((guest && groups.mine.length) || groups.unseen.length || (showSeen && groups.seen.length))
  const playing = openId ? ordered.find((card) => card.id === openId) : null
  useDialogTrap(viewerRef, { active: Boolean(playing), onClose: () => setOpenId(null) })
  useDialogTrap(viewersRef, { active: Boolean(viewers), onClose: () => setViewers(null) })

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
      <header className="updates-hero">
        <div>
          <p className="eyebrow">UPDATES</p>
          <h1>Small moments, one day only</h1>
          <p className="updates-hero-copy">Text, photos and short videos for the rooms on this device. Every update clears itself after 24 hours, so the feed never piles up.</p>
        </div>
        <div className="updates-hero-side">
          <div className="updates-hero-stats">
            <span><strong>{liveCount}</strong><small>live now</small></span>
            <span><strong>{groups.seen.length}</strong><small>already seen</small></span>
            <span><strong>24h</strong><small>then gone</small></span>
          </div>
          <div className="updates-hero-actions">
            <button type="button" className="updates-hero-primary" onClick={() => setComposerOpen((value) => !value)} disabled={posting || !guest} title={guest ? undefined : 'Join a room first'}><Plus size={16} /> Text update</button>
            <button type="button" className="btn" onClick={() => fileInputRef.current?.click()} disabled={posting || !guest} title={guest ? undefined : 'Join a room first'}><Image size={16} /> Photo or video</button>
          </div>
        </div>
      </header>

      <section className="updates-toolbar-card" aria-label="Recent updates">
        <div className="section-title">
          <h2>Recent updates</h2>
          <div className="updates-toolbar-actions">
            {ordered.some((card) => card.viewedByMe && !card.mine) && (
              <button type="button" className="view-all-button" onClick={() => setShowSeen((value) => !value)}>
                {showSeen ? 'Show less' : 'View all'}
              </button>
            )}
            <button type="button" className="updates-add-button" aria-label="Add a photo or video update" title="Add a photo or video update" onClick={() => fileInputRef.current?.click()} disabled={posting || !guest}><Image size={18} /></button>
            <button type="button" className="updates-add-button" aria-label="Add a text update" title="Add a text update" onClick={() => setComposerOpen((value) => !value)} disabled={posting || !guest}><Plus size={18} /></button>
          </div>
        </div>
        <input ref={fileInputRef} className="hidden-file-input" tabIndex={-1} type="file" accept="image/*,video/*" onChange={postMediaCard} />
        {notice && <p className="updates-action-notice" role="status">{notice}</p>}
        {failure && <p className="feed-failure" role="alert"><AlertCircle size={14} />{failure}</p>}
        {posting && <p className="updates-action-notice is-busy" role="status"><span className="loading-dots" aria-hidden="true"><i /><i /><i /></span>Posting your update</p>}
      </section>

      {composerOpen && guest && (
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

      {hasCards ? (
        <div className="updates-live-list" aria-label="Live updates">
          {guest && groups.mine.map(cardRow)}
          {groups.unseen.map(cardRow)}
          {showSeen && groups.seen.map(cardRow)}
        </div>
      ) : guest && !posting ? (
        <div className="updates-empty-state">
          <span className="updates-empty-orb" aria-hidden="true"><Sparkles size={22} /></span>
          <strong>No updates yet</strong>
          <p>Post the first one. A photo, a short video or a line of text stays for a day, then clears itself.</p>
          <button type="button" className="updates-hero-primary" onClick={() => setComposerOpen(true)}><Plus size={16} /> Write an update</button>
        </div>
      ) : !guest ? (
        <div className="updates-empty-state">
          <span className="updates-empty-orb" aria-hidden="true"><MessageCircle size={22} /></span>
          <strong>Join a room to see updates</strong>
          <p>Updates belong to a guest session. Open Chats, join a room with its pairing code, and this feed fills in.</p>
          <NavLink to="/" className="updates-hero-primary"><MessageCircle size={16} /> Open Chats</NavLink>
        </div>
      ) : null}

      {playing && (
        <div ref={viewerRef} className="status-viewer" role="dialog" aria-modal="true" aria-label={`Update from ${playing.author?.displayName || (playing.mine ? 'you' : 'a guest')}`}>
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
        <div ref={viewersRef} className="status-viewers" role="dialog" aria-modal="true" aria-label="Guests who saw this update">
          <div className="status-viewers-head"><strong>Seen by</strong><button type="button" aria-label="Close" onClick={() => setViewers(null)}><X size={16} /></button></div>
          {viewers.loading ? (
            <div className="status-viewer-skeleton" aria-hidden="true"><span /><span /><span /></div>
          ) : (viewers.rows.length ? viewers.rows.map((row) => (
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
      {loading ? (
        <div className="shorts-skeleton" aria-hidden="true"><span /><span /><span /></div>
      ) : null}
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
    // The log on this device is shown straight away, so the Calls tab is never
    // blank while the server is still answering - or empty because it is not
    // answering at all. The fetch below replaces it, and is the authority.
    readCalls()
      .then((cached) => { if (active && cached.length) setCalls((current) => (current.length ? current : cached)) })
      .catch(() => { /* a cold cache just means waiting for the fetch below */ })
    fetchCallHistory(guest)
      .then((rows) => {
        if (!active) return
        setCalls(rows)
        setFailure('')
        storeCalls(rows).catch(() => {})
      })
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
      await clearCalls().catch(() => {})
      showNotice('Call history cleared on every device for this guest.')
    } catch (error) {
      showNotice(error.message || 'Could not clear your call history.')
    }
  }

  if (!guest) {
    return (
      <main className="content-page calls-page">
        <header className="calls-hero">
          <div>
            <p className="eyebrow">CALLS</p>
            <h1>Every ring, kept in order</h1>
            <p className="calls-hero-copy">Calls start inside a room. Accept, decline or call back — this page keeps the trail, and nothing is shared with the other seat.</p>
          </div>
        </header>
        <section className="calls-card" aria-label="Call history">
          <div className="empty-state"><div className="empty-icon"><Phone size={21} /></div><h3>Join a room to start calling</h3><p>Calls are made from inside a room. Once you have joined one, the history of your calls appears here.</p></div>
        </section>
      </main>
    )
  }

  const groups = groupCallsByDay(calls)
  const missedCount = calls.filter((call) => call.status === 'missed').length
  const outgoingCount = calls.filter((call) => call.direction === 'out').length
  return (
    <main className="content-page calls-page">
      <header className="calls-hero">
        <div>
          <p className="eyebrow">CALLS</p>
          <h1>Every ring, kept in order</h1>
          <p className="calls-hero-copy">Calls start inside a room. Accept, decline or call back — this page keeps the trail, and nothing is shared with the other seat.</p>
        </div>
        <span className="calls-hero-count">{loading && !calls.length ? 'Syncing' : `${calls.length} ${calls.length === 1 ? 'call' : 'calls'}`}</span>
      </header>
      <section className="calls-card" aria-label="Call history">
        {calls.length ? (
          <div className="calls-stats">
            <span><Phone size={14} /><strong>{calls.length}</strong><small>total</small></span>
            <span><ArrowUpRight size={14} /><strong>{outgoingCount}</strong><small>outgoing</small></span>
            <span className={missedCount ? 'is-warn' : ''}><PhoneOff size={14} /><strong>{missedCount}</strong><small>missed</small></span>
          </div>
        ) : null}
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
          <div className="calls-skeleton" aria-hidden="true">
            {[0, 1, 2, 3].map((row) => <span key={row}><i /><span><b /><em /></span></span>)}
          </div>
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

/** The Settings chunk is small, so the wait is one paint; a skeleton reads as the page rather than a spinner. */
function SettingsSkeleton() {
  return (
    <main className="content-page settings-page" aria-busy="true">
      <span className="sr-only" role="status">Loading your settings</span>
      <div className="settings-skeleton" aria-hidden="true">
        <div className="settings-skeleton-hero"><span /><span /><span /></div>
        <div className="settings-skeleton-grid">
          {[0, 1, 2, 3].map((card) => <div className="settings-skeleton-card" key={card}><span /><span /><span /></div>)}
        </div>
      </div>
    </main>
  )
}

function App() {
  const [dark, setDark] = useState(() => readThemePreference())
  const [guest, setGuest] = useState(() => readGuest())
  const [rooms, setRooms] = useState(() => readRooms())
  const activeRoomRef = useRef(null)
  const rememberActiveRoom = useCallback((roomId) => { activeRoomRef.current = roomId || null }, [])
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
    // theme-boot.js already painted these from localStorage; re-applying keeps a
    // dev-time HMR reload and a cleared attribute from falling back mid-session.
    applyPreferences()
  }, [])

  useEffect(() => {
    // The pre-paint helper owns both the attribute and the browser-chrome colour,
    // so a toggle cannot leave the status bar showing the other theme.
    if (window.__inchatSetTheme) window.__inchatSetTheme(dark)
    else document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.setItem('inchat-theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => {
    if (!guest?.userId) return undefined
    let active = true
    // The cookie is the credential now: the stored identity is validated on
    // load, and a 401/404 means that cookie no longer backs this guest.
    fetch(`/api/sessions/${encodeURIComponent(guest.userId)}`, { headers: sessionHeaders(guest) })
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
   * Warm the ICE config as soon as the app knows the guest, and again when the
   * tab comes back, so a call never has to fetch it on the click path.
   */
  useEffect(() => {
    if (!guest?.userId) return undefined
    primeIceConfig(guest)
    const onVisible = () => {
      if (document.visibilityState === 'visible') primeIceConfig(guest)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
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

  const joinRoom = async (displayName, roomInput, code) => {
    const room = normalizeRoomName(roomInput)
    const session = await resolveGuest(displayName)
    await authorizeRoom(session, room, code)
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
    if (!message) return forgetRoomPreview(roomId)
    const text = message.text || describeMessage(message)
    const summary = { message: text.length > 70 ? `${text.slice(0, 67)}…` : text, time: message.time || formatTime(message.ts) }
    /**
     * A message is unread when this device was not looking at the room it landed
     * in, and your own message is never unread for you. The count belongs to the
     * device: reading a room on a phone does not silence the same room on a
     * laptop, and reloading the page does not invent a message nobody sent.
     */
    const reading = roomId === activeRoomRef.current
    setRooms((current) => {
      const next = current.map((room) => (room.id === roomId ? {
        ...room,
        ...summary,
        unread: reading || message.sender !== 'them' ? 0 : (room.unread || 0) + 1,
      } : room))
      saveRooms(next)
      return next
    })
  }

  /** Opening a room is the read event: the badge clears with the transcript. */
  const clearRoomUnread = (roomId) => setRooms((current) => {
    if (!current.some((room) => room.id === roomId && room.unread)) return current
    const next = current.map((room) => (room.id === roomId ? { ...room, unread: 0 } : room))
    saveRooms(next)
    return next
  })

  /**
   * One channel for the rooms this device is not sitting in. A room socket only
   * ever hears its own room, so without this the list would show a transcript
   * the server has moved on from and a badge that never moves. The payload is
   * the same message the room channel got; rooms this device does not list are
   * dropped by the preview update, which only maps over rooms it knows.
   */
  useEffect(() => {
    if (!guest?.userId) return undefined
    const socket = connectFeed(guest)
    socket.on('room_activity', (payload) => {
      if (!payload?.room || payload.userId === guest.userId) return
      updateRoomPreview(payload.room, toUiMessage(payload, guest))
    })
    return () => {
      socket.removeAllListeners()
      socket.close()
    }
    // A new identity is the only thing that should rebuild this channel.
  }, [guest?.userId])

  /** Nothing left to preview: the row goes back to the empty-room wording. */
  const forgetRoomPreview = (roomId) => setRooms((current) => {
    const next = current.map((room) => room.id === roomId ? { ...room, message: '', time: '' } : room)
    saveRooms(next)
    return next
  })

  const shellClass = location.pathname === '/calls' ? 'app-shell calls-route'
    : location.pathname === '/' ? 'app-shell home-route'
      : location.pathname === '/updates' ? 'app-shell updates-route'
        : location.pathname === '/settings' ? 'app-shell settings-route'
          : 'app-shell'
  const signOut = () => {
    // The cookie is HttpOnly, so only the server can expire it.
    if (guest?.userId) {
      fetch('/api/sessions/current', { method: 'DELETE', headers: sessionHeaders(guest) }).catch(() => {})
    }
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
        returnToFeed('This device is not in that room yet. Join it with its pairing code from Chats.')
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
      <Route path="/" element={<MainDashboard guest={guest} rooms={rooms} onJoinRoom={joinRoom} onLatestMessage={updateRoomPreview} onRoomRead={clearRoomUnread} onActiveRoomChange={rememberActiveRoom} onRoomRemoved={forgetRoomOnDevice} roomRequest={roomRequest} onRoomRequestHandled={() => setRoomRequest(null)} onFeedReturn={returnToFeed} />} />
      <Route path="/updates" element={<UpdatesPage guest={guest} />} />
      <Route path="/shorts" element={<ShortsPage guest={guest} rooms={rooms} onOpenRoom={openRoomFromFeed} />} />
      <Route path="/calls" element={<CallsPage guest={guest} notice={feedNotice} onOpenRoom={(roomId) => openRoomFromFeed(roomId)} onCallBack={(call) => openRoomFromFeed(call.room, { userId: call.peer.userId, displayName: call.peer.displayName, mode: call.mode })} />} />
      <Route path="/settings" element={
        <Suspense fallback={<SettingsSkeleton />}>
          <SettingsPage
            guest={guest}
            profile={profile}
            dark={dark}
            onThemeChange={(next) => setDark(next === 'dark')}
            onProfileChange={setProfile}
            rooms={rooms}
            onForgetRoom={forgetRoomOnDevice}
            onOpenRoom={(roomId) => openRoomFromFeed(roomId)}
            onSignOut={signOut}
            onFeedNotice={setFeedNotice}
          />
        </Suspense>
      } />
    </Routes>
  )

  return <div className={shellClass}><AppHeader dark={dark} onThemeChange={(next) => setDark(next === 'dark')} />{routes}<BottomNavigation /></div>
}

export default App
