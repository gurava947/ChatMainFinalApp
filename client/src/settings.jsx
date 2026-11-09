import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bell, Check, ChevronRight, CircleUserRound, Copy, HardDrive, Image, LogOut, MessageCircle, Palette, ShieldCheck,
  Sparkles, Trash2, Volume2,
} from 'lucide-react'
import { fetchMyProfile, removeAvatar, saveNote, uploadAvatar } from './roomChat'
import { readHdPreference, saveHdPreference } from './mediaPrepare'
import {
  canNotify, readNotifyPrefs, requestNotifyPermission, saveNotifyPrefs,
} from './notifications'
import { ACCENTS, readAccent, readMotion, saveAccent, saveMotion } from './preferences'
import { clearCalls, supportsLocalStore, wipeLocalStore } from './localStore'

function Switch({ checked, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`pref-switch${checked ? ' is-on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true" />
    </button>
  )
}

function Segmented({ value, options, onChange, label }) {
  return (
    <div className="pref-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={value === option.id ? 'is-active' : ''}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >{option.label}</button>
      ))}
    </div>
  )
}

function PrefRow({ icon: Icon, title, description, children, tone }) {
  return (
    <div className={`pref-row${tone ? ` pref-row-${tone}` : ''}`}>
      <span className="pref-row-icon" aria-hidden="true"><Icon size={17} /></span>
      <div className="pref-row-copy">
        <strong>{title}</strong>
        {description ? <small>{description}</small> : null}
      </div>
      <div className="pref-row-control">{children}</div>
    </div>
  )
}

function SettingsSection({ id, icon: Icon, title, hint, badge, children }) {
  return (
    <section id={id} className="settings-card" aria-label={title}>
      <header className="settings-card-head">
        <span className="settings-card-icon" aria-hidden="true"><Icon size={18} /></span>
        <div>
          <h2>{title}</h2>
          {hint ? <p>{hint}</p> : null}
        </div>
        {badge ? <span className="settings-card-badge">{badge}</span> : null}
      </header>
      <div className="settings-card-body">{children}</div>
    </section>
  )
}

function initialsOf(name) {
  return name?.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'G'
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / 1024 / 1024
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const SECTION_LINKS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'notifications', label: 'Alerts' },
  { id: 'media', label: 'Storage' },
  { id: 'profile', label: 'Profile' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'session', label: 'Session' },
]

function SettingsNav() {
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {SECTION_LINKS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => document.getElementById(entry.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >{entry.label}</button>
      ))}
    </nav>
  )
}

function ProfileCard({ guest, profile, roomCount, onProfileChange }) {
  const [note, setNote] = useState(profile?.note || null)
  const [avatar, setAvatar] = useState(profile?.avatar || null)
  const [draft, setDraft] = useState(profile?.note?.text || '')
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [pictureBusy, setPictureBusy] = useState(false)
  const fileRef = useRef(null)

  useEffect(() => {
    if (profile) {
      setNote(profile.note)
      setAvatar(profile.avatar)
      setDraft(profile.note?.text || '')
    }
  }, [profile])

  useEffect(() => {
    if (profile || !guest) return undefined
    let active = true
    fetchMyProfile(guest)
      .then((loaded) => {
        if (!active) return
        setNote(loaded.note)
        setAvatar(loaded.avatar)
        setDraft(loaded.note?.text || '')
        onProfileChange?.(loaded)
      })
      .catch((error) => { if (active) setStatus(error.message) })
    return () => { active = false }
  }, [guest, profile, onProfileChange])

  const submitAbout = async (event) => {
    event.preventDefault()
    setSaving(true)
    setStatus('')
    try {
      const saved = await saveNote(guest, draft.trim())
      setNote(saved)
      setDraft(saved.text)
      onProfileChange?.({ userId: guest.userId, displayName: guest.displayName, note: saved, avatar })
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
      setStatus('Picture updated.')
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
      setStatus('Picture removed.')
    } catch (error) {
      setStatus(error.message)
    } finally {
      setPictureBusy(false)
    }
  }

  const copyGuestId = async () => {
    if (!guest?.userId) return
    try {
      await navigator.clipboard?.writeText(guest.userId)
      setStatus('Guest id copied.')
    } catch {
      setStatus('Copy is unavailable in this browser.')
    }
  }

  const expires = guest?.expiresAt ? new Date(guest.expiresAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—'

  return (
    <SettingsSection id="profile" icon={CircleUserRound} title="Your profile" hint="What the other seat sees in a room." badge={avatar ? 'Photo' : undefined}>
      <div className="settings-profile">
        <div className={`settings-avatar${pictureBusy ? ' is-busy' : ''}`}>
          {avatar?.url ? <img src={avatar.url} alt="" /> : <span>{initialsOf(guest?.displayName)}</span>}
          {pictureBusy ? <i className="settings-avatar-busy" aria-hidden="true" /> : null}
        </div>
        <div className="settings-profile-copy">
          <strong>{guest?.displayName || 'Guest'}</strong>
          <small>{guest ? 'Guest session · no account needed' : 'Join a room to start a profile'}</small>
          <div className="settings-inline-actions">
            <input ref={fileRef} className="file-input-hidden" tabIndex={-1} type="file" accept="image/*" aria-label="Choose a profile picture" onChange={pickPicture} disabled={pictureBusy || !guest} />
            <button type="button" className="btn" disabled={pictureBusy || !guest} onClick={() => fileRef.current?.click()}>
              <Image size={15} /> {avatar ? 'Change picture' : 'Add picture'}
            </button>
            {avatar ? <button type="button" className="btn btn-danger" disabled={pictureBusy} onClick={dropPicture}><Trash2 size={15} /> Remove</button> : null}
          </div>
        </div>
      </div>
      <div className="settings-profile-stats">
        <span><strong>{roomCount ?? 0}</strong><small>Rooms</small></span>
        <span><strong>{expires}</strong><small>Session ends</small></span>
        <span><strong>{avatar ? 'Visible' : 'Hidden'}</strong><small>Picture</small></span>
      </div>
      <form className="settings-about" onSubmit={submitAbout}>
        <label className="field"><span>About <b className="field-count" aria-hidden="true">{draft.length}/500</b></span>
          <textarea className="input" rows={3} maxLength={500} value={draft} placeholder="Say something about yourself" disabled={!guest || note === null} onChange={(event) => setDraft(event.target.value)} />
        </label>
        <div className="settings-about-actions">
          <button type="submit" className="btn btn-primary" disabled={saving || !guest || note === null}>
            {saving ? <span className="loading-dots" aria-hidden="true"><i /><i /><i /></span> : null}{saving ? 'Saving' : 'Save about'}
          </button>
          {guest ? <button type="button" className="btn" onClick={copyGuestId}><Copy size={14} /> Copy id</button> : null}
          <small role="status">{status}</small>
        </div>
      </form>
    </SettingsSection>
  )
}

function NotificationsCard({ onEnabledChange }) {
  const [prefs, setPrefs] = useState(readNotifyPrefs)
  const [permission, setPermission] = useState(() => (canNotify() ? 'granted' : (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)))
  const [status, setStatus] = useState('')

  const update = (patch) => {
    const next = saveNotifyPrefs({ ...prefs, ...patch })
    setPrefs(next)
    if ('enabled' in patch) onEnabledChange?.(next.enabled)
  }

  const toggleEnabled = async (next) => {
    setStatus('')
    if (!next) {
      update({ enabled: false })
      return
    }
    const result = await requestNotifyPermission()
    setPermission(result)
    if (result === 'granted') {
      update({ enabled: true })
      return
    }
    update({ enabled: false })
    setStatus(result === 'denied'
      ? 'This browser blocked notifications. Allow them in the address-bar site settings, then try again.'
      : result === 'default'
        ? 'Permission was dismissed. Allow notifications for this site, then switch this on again.'
        : 'This browser cannot show notifications.')
  }

  const blocked = permission === 'denied' || permission === 'unsupported'

  return (
    <SettingsSection
      id="notifications"
      icon={Bell}
      title="Notifications"
      hint="Device-only: nothing here changes the other seat."
      badge={permission === 'granted' ? 'Allowed' : permission === 'denied' ? 'Blocked' : undefined}
    >
      <PrefRow icon={Bell} title="Desktop notifications" description={permission === 'granted' ? 'Allowed by this browser' : 'Ask this browser for permission'}>
        <Switch label="Desktop notifications" checked={prefs.enabled} onChange={toggleEnabled} />
      </PrefRow>
      <PrefRow icon={Volume2} title="Sound" description="A short chime for a new message">
        <Switch label="Notification sound" checked={prefs.sound} disabled={!prefs.enabled} onChange={(next) => update({ sound: next })} />
      </PrefRow>
      <PrefRow icon={MessageCircle} title="Message preview" description="Show the text in the notification">
        <Switch label="Message preview" checked={prefs.preview} disabled={!prefs.enabled} onChange={(next) => update({ preview: next })} />
      </PrefRow>
      <PrefRow icon={Sparkles} title="Mentions only" description="Stay quiet unless your name is @mentioned">
        <Switch label="Mentions only" checked={prefs.mentionsOnly} disabled={!prefs.enabled} onChange={(next) => update({ mentionsOnly: next })} />
      </PrefRow>
      {status ? <p className="settings-note" role="status">{status}</p> : null}
      {blocked && !status ? <p className="settings-note">Notifications are unavailable in this browser until site permission is allowed.</p> : null}
    </SettingsSection>
  )
}

function AppearanceCard({ dark, onThemeChange, accent, onAccentChange }) {
  const [reduced, setReduced] = useState(readMotion)
  const accentLabel = ACCENTS.find((entry) => entry.id === accent)?.label || 'Teal'

  return (
    <SettingsSection id="appearance" icon={Palette} title="Appearance" hint="Applied instantly, before the next paint." badge={`${dark ? 'Dark' : 'Light'} · ${accentLabel}`}>
      <PrefRow icon={Palette} title="Theme" description="Light is easier in daylight; dark is easier at night">
        <Segmented
          label="Theme"
          value={dark ? 'dark' : 'light'}
          options={[{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]}
          onChange={(next) => { if ((next === 'dark') !== dark) onThemeChange(next) }}
        />
      </PrefRow>
      <div className="pref-row pref-row-stack">
        <span className="pref-row-icon" aria-hidden="true"><Sparkles size={17} /></span>
        <div className="pref-row-copy">
          <strong>Accent</strong>
          <small>Buttons, badges and active states</small>
        </div>
        <div className="accent-row" role="group" aria-label="Accent colour">
          {ACCENTS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`accent-swatch${accent === entry.id ? ' is-active' : ''}`}
              style={{ '--swatch': entry.light }}
              aria-label={entry.label}
              aria-pressed={accent === entry.id}
              onClick={() => onAccentChange(saveAccent(entry.id))}
            >{accent === entry.id ? <Check size={14} /> : null}</button>
          ))}
        </div>
      </div>
      <PrefRow icon={Sparkles} title="Reduce motion" description="Skip the small transitions and pulses">
        <Switch label="Reduce motion" checked={reduced} onChange={(next) => setReduced(saveMotion(next))} />
      </PrefRow>
    </SettingsSection>
  )
}

function MediaCard({ onNotice }) {
  const [hd, setHd] = useState(readHdPreference)
  const [storage, setStorage] = useState(null)
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    navigator.storage?.estimate?.()
      .then(({ usage, quota }) => {
        if (active && Number.isFinite(usage)) setStorage({ usage, quota: Number.isFinite(quota) ? quota : 0 })
      })
      .catch(() => {})
    return () => { active = false }
  }, [])

  const wipe = async () => {
    setBusy(true)
    try {
      await wipeLocalStore()
      await clearCalls().catch(() => {})
      onNotice('Cached messages and media removed from this device. The server copy is untouched.')
      setStorage((current) => ({ usage: 0, quota: current?.quota || 0 }))
    } catch {
      onNotice('Could not clear the local cache on this browser.')
    } finally {
      setConfirmWipe(false)
      setBusy(false)
    }
  }

  const used = storage?.usage ?? null
  const quota = storage?.quota || 0
  const percent = quota > 0 && used !== null ? Math.min(100, Math.max(1, (used / quota) * 100)) : 0

  return (
    <SettingsSection id="media" icon={HardDrive} title="Media & storage" hint="Keep the phone light without losing history.">
      <PrefRow icon={Image} title="Send photos in HD" description={hd ? 'Original pixels and size' : 'Downscaled to 1600px before upload'}>
        <Switch label="Send photos in HD" checked={hd} onChange={(next) => setHd(saveHdPreference(next))} />
      </PrefRow>
      <div className="settings-storage">
        <div className="settings-storage-head">
          <span><HardDrive size={15} /> Offline cache</span>
          <strong>{used === null ? 'Reading…' : formatBytes(used)}</strong>
        </div>
        <span className="settings-storage-track" aria-hidden="true"><i style={{ width: `${percent}%` }} /></span>
        <small>{quota > 0 ? `${percent.toFixed(1)}% of the ${formatBytes(quota)} this browser allows` : 'Messages and media kept on this device'}</small>
      </div>
      <PrefRow icon={HardDrive} title="Clear cache" description="Your identity and rooms stay; media re-downloads when needed">
        {confirmWipe ? (
          <div className="settings-confirm">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={wipe}>{busy ? <span className="loading-dots" aria-hidden="true"><i /><i /><i /></span> : null}{busy ? 'Clearing' : 'Clear now'}</button>
            <button type="button" className="btn" onClick={() => setConfirmWipe(false)}>Keep</button>
          </div>
        ) : (
          <button type="button" className="btn" disabled={!supportsLocalStore()} onClick={() => setConfirmWipe(true)}><Trash2 size={15} /> Clear cache</button>
        )}
      </PrefRow>
      <p className="settings-note">Clearing the cache keeps your identity and rooms. The next visit re-downloads what it needs.</p>
    </SettingsSection>
  )
}

function RoomsCard({ rooms, onForgetRoom, onOpenRoom }) {
  const [confirming, setConfirming] = useState(null)
  const list = useMemo(() => rooms || [], [rooms])
  return (
    <SettingsSection id="rooms" icon={MessageCircle} title="Rooms on this device" hint="Hiding a room never deletes it for the other seat." badge={`${list.length}`}>
      {list.length ? (
        <ul className="settings-room-list">
          {list.map((room) => (
            <li key={room.id} className="settings-room">
              <button type="button" className="settings-room-open" onClick={() => onOpenRoom?.(room.id)}>
                <span className="settings-room-avatar" aria-hidden="true">{(room.name || room.id).slice(0, 1).toUpperCase()}</span>
                <span className="settings-room-copy"><strong>{room.name || room.id}</strong><small>#{room.id}</small></span>
                <ChevronRight size={16} />
              </button>
              {confirming === room.id ? (
                <span className="settings-confirm">
                  <button type="button" className="btn btn-danger" onClick={() => { onForgetRoom(room.id); setConfirming(null) }}>Remove</button>
                  <button type="button" className="btn" onClick={() => setConfirming(null)}>Keep</button>
                </span>
              ) : (
                <button type="button" className="settings-room-remove" aria-label={`Remove ${room.name || room.id} from this device`} onClick={() => setConfirming(room.id)}><Trash2 size={15} /></button>
              )}
            </li>
          ))}
        </ul>
      ) : <p className="settings-empty">No rooms on this device yet. Join one from Chats with its pairing code.</p>}
    </SettingsSection>
  )
}

function SessionCard({ guest, onSignOut }) {
  const [confirming, setConfirming] = useState(false)
  const [status, setStatus] = useState('')

  const copyGuestId = async () => {
    if (!guest?.userId) return
    try {
      await navigator.clipboard?.writeText(guest.userId)
      setStatus('Guest id copied.')
    } catch {
      setStatus('Copy is unavailable in this browser.')
    }
  }

  return (
    <SettingsSection id="session" icon={ShieldCheck} title="Session" hint="A cookie keeps this guest signed in; the server can revoke it." badge={guest ? 'Active' : undefined}>
      <div className="settings-facts">
        <p><span>Guest id</span><code>{guest?.userId || '—'}</code></p>
        <p><span>Name</span><strong>{guest?.displayName || 'Not joined'}</strong></p>
        <p><span>Room seats</span><strong>{guest ? 'Held by this device' : '—'}</strong></p>
        <p><span>Session ends</span><strong>{guest?.expiresAt ? new Date(guest.expiresAt).toLocaleString() : 'When you sign out'}</strong></p>
      </div>
      <div className="settings-inline-actions">
        {guest ? <button type="button" className="btn" onClick={copyGuestId}><Copy size={14} /> Copy guest id</button> : null}
        {status ? <small role="status">{status}</small> : null}
      </div>
      {guest ? (confirming ? (
        <div className="settings-confirm">
          <button type="button" className="btn btn-danger" onClick={onSignOut}><LogOut size={15} /> Sign out now</button>
          <button type="button" className="btn" onClick={() => setConfirming(false)}>Stay signed in</button>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setConfirming(true)}><LogOut size={15} /> Sign out of this device</button>
      )) : <p className="settings-note">Join a room from Chats to create a guest session.</p>}
    </SettingsSection>
  )
}

export default function SettingsPage({ guest, profile, dark, onThemeChange, onProfileChange, rooms, onForgetRoom, onOpenRoom, onSignOut, onFeedNotice }) {
  const [notice, setNotice] = useState('')
  const [accent, setAccent] = useState(readAccent)
  const [alertsOn, setAlertsOn] = useState(() => readNotifyPrefs().enabled)

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(''), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const report = useCallback((message) => {
    setNotice(message)
    onFeedNotice?.(message)
  }, [onFeedNotice])

  const accentLabel = ACCENTS.find((entry) => entry.id === accent)?.label || 'Teal'

  return (
    <main className="content-page settings-page">
      <header className="settings-hero">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>Tune InChat to your room</h1>
          <p className="settings-hero-copy">Appearance, notifications, media and privacy — every switch is saved on this device as you change it.</p>
          <div className="settings-hero-stats">
            <span><strong>{rooms.length}</strong><small>rooms</small></span>
            <span><strong>{accentLabel}</strong><small>accent</small></span>
            <span><strong>{alertsOn ? 'On' : 'Off'}</strong><small>alerts</small></span>
          </div>
        </div>
        <div className="settings-hero-badge" aria-hidden="true">
          <span className="settings-hero-orb"><Sparkles size={20} /></span>
          <div><strong>{dark ? 'Dark' : 'Light'} mode</strong><small>Saved for this browser</small></div>
        </div>
      </header>

      <SettingsNav />

      {notice ? <p className="feed-notice" role="status">{notice}</p> : null}

      <div className="settings-grid">
        <div className="settings-column">
          <AppearanceCard dark={dark} onThemeChange={onThemeChange} accent={accent} onAccentChange={setAccent} />
          <NotificationsCard onEnabledChange={setAlertsOn} />
          <MediaCard onNotice={report} />
        </div>
        <div className="settings-column">
          <ProfileCard guest={guest} profile={profile} roomCount={rooms.length} onProfileChange={onProfileChange} />
          <RoomsCard rooms={rooms} onForgetRoom={onForgetRoom} onOpenRoom={onOpenRoom} />
          <SessionCard guest={guest} onSignOut={onSignOut} />
        </div>
      </div>

      <footer className="settings-foot">
        <span>INchat · room chat, no account required</span>
        <span>Preferences live in this browser. Nothing here is shared with the other seat.</span>
      </footer>
    </main>
  )
}
