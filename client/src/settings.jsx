import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bell, Check, ChevronRight, CircleUserRound, HardDrive, Image, LogOut, MessageCircle, Palette, ShieldCheck,
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

function SettingsSection({ icon: Icon, title, hint, children }) {
  return (
    <section className="settings-card" aria-label={title}>
      <header className="settings-card-head">
        <span className="settings-card-icon" aria-hidden="true"><Icon size={18} /></span>
        <div>
          <h2>{title}</h2>
          {hint ? <p>{hint}</p> : null}
        </div>
      </header>
      <div className="settings-card-body">{children}</div>
    </section>
  )
}

function initialsOf(name) {
  return name?.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'G'
}

function ProfileCard({ guest, profile, onProfileChange }) {
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

  return (
    <SettingsSection icon={CircleUserRound} title="Your profile" hint="What the other seat sees in a room.">
      <div className="settings-profile">
        <div className="settings-avatar">
          {avatar?.url ? <img src={avatar.url} alt="" /> : <span>{initialsOf(guest?.displayName)}</span>}
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
      <form className="settings-about" onSubmit={submitAbout}>
        <label className="field"><span>About</span>
          <textarea className="input" rows={3} maxLength={500} value={draft} placeholder="Say something about yourself" disabled={!guest || note === null} onChange={(event) => setDraft(event.target.value)} />
        </label>
        <div className="settings-about-actions">
          <button type="submit" className="btn btn-primary" disabled={saving || !guest || note === null}>{saving ? 'Saving…' : 'Save about'}</button>
          <small role="status">{status}</small>
        </div>
      </form>
    </SettingsSection>
  )
}

function NotificationsCard() {
  const [prefs, setPrefs] = useState(readNotifyPrefs)
  const [permission, setPermission] = useState(() => (canNotify() ? 'granted' : (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)))
  const [status, setStatus] = useState('')

  const update = (patch) => setPrefs(saveNotifyPrefs({ ...prefs, ...patch }))

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
      : 'This browser cannot show notifications.')
  }

  const blocked = permission === 'denied' || permission === 'unsupported'

  return (
    <SettingsSection icon={Bell} title="Notifications" hint="Device-only: nothing here changes the other seat.">
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

function AppearanceCard({ dark, onToggleTheme }) {
  const [accent, setAccent] = useState(readAccent)
  const [reduced, setReduced] = useState(readMotion)

  return (
    <SettingsSection icon={Palette} title="Appearance" hint="Applied instantly, before the next paint.">
      <PrefRow icon={Palette} title="Theme" description="Light is easier in daylight; dark is easier at night">
        <Segmented
          label="Theme"
          value={dark ? 'dark' : 'light'}
          options={[{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]}
          onChange={(next) => { if ((next === 'dark') !== dark) onToggleTheme() }}
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
              onClick={() => setAccent(saveAccent(entry.id))}
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
  const [usage, setUsage] = useState(null)
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    navigator.storage?.estimate?.()
      .then(({ usage: used }) => { if (active && Number.isFinite(used)) setUsage(used) })
      .catch(() => {})
    return () => { active = false }
  }, [])

  const wipe = async () => {
    setBusy(true)
    try {
      await wipeLocalStore()
      await clearCalls().catch(() => {})
      onNotice('Cached messages and media removed from this device. The server copy is untouched.')
      setUsage(0)
    } catch {
      onNotice('Could not clear the local cache on this browser.')
    } finally {
      setConfirmWipe(false)
      setBusy(false)
    }
  }

  return (
    <SettingsSection icon={HardDrive} title="Media & storage" hint="Keep the phone light without losing history.">
      <PrefRow icon={Image} title="Send photos in HD" description={hd ? 'Original pixels and size' : 'Downscaled to 1600px before upload'}>
        <Switch label="Send photos in HD" checked={hd} onChange={(next) => setHd(saveHdPreference(next))} />
      </PrefRow>
      <PrefRow icon={HardDrive} title="Offline cache" description={usage === null ? 'Messages and media kept on this device' : `${(usage / 1024 / 1024).toFixed(1)} MB used by this site`}>
        {confirmWipe ? (
          <div className="settings-confirm">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={wipe}>{busy ? 'Clearing…' : 'Clear now'}</button>
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
    <SettingsSection icon={MessageCircle} title="Rooms on this device" hint="Hiding a room never deletes it for the other seat.">
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
  return (
    <SettingsSection icon={ShieldCheck} title="Session" hint="A cookie keeps this guest signed in; the server can revoke it.">
      <div className="settings-facts">
        <p><span>Guest id</span><code>{guest?.userId || '—'}</code></p>
        <p><span>Name</span><strong>{guest?.displayName || 'Not joined'}</strong></p>
        <p><span>Session ends</span><strong>{guest?.expiresAt ? new Date(guest.expiresAt).toLocaleString() : 'When you sign out'}</strong></p>
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

export default function SettingsPage({ guest, profile, dark, onToggleTheme, onProfileChange, rooms, onForgetRoom, onOpenRoom, onSignOut, onFeedNotice }) {
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(''), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const report = useCallback((message) => {
    setNotice(message)
    onFeedNotice?.(message)
  }, [onFeedNotice])

  return (
    <main className="content-page settings-page">
      <header className="settings-hero">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>Tune InChat to your room</h1>
          <p className="settings-hero-copy">Appearance, notifications, media and privacy — every switch is saved on this device as you change it.</p>
        </div>
        <div className="settings-hero-badge" aria-hidden="true">
          <span className="settings-hero-orb"><Sparkles size={20} /></span>
          <div><strong>{dark ? 'Dark' : 'Light'} mode</strong><small>Saved for this browser</small></div>
        </div>
      </header>

      {notice ? <p className="feed-notice" role="status">{notice}</p> : null}

      <div className="settings-grid">
        <div className="settings-column">
          <AppearanceCard dark={dark} onToggleTheme={onToggleTheme} />
          <NotificationsCard />
          <MediaCard onNotice={report} />
        </div>
        <div className="settings-column">
          <ProfileCard guest={guest} profile={profile} onProfileChange={onProfileChange} />
          <RoomsCard rooms={rooms} onForgetRoom={onForgetRoom} onOpenRoom={onOpenRoom} />
          <SessionCard guest={guest} onSignOut={onSignOut} />
        </div>
      </div>
    </main>
  )
}
