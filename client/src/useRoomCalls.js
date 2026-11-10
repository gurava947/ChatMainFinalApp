import { useEffect, useRef, useState } from 'react'
import { ICE_FALLBACK, primeIceConfig, readIceServers } from './iceCache'
import { RECOVERY_WINDOW_MS, recoveryAction, recoveryGrace, restoredCallStatus } from './callRecovery'
import { FILE_CHANNEL_LABEL, FILE_CHANNEL_TIMEOUT_MS, createFileTransferController } from './fileTransfer'
import * as transferProtocol from './transferProtocol'
import { saveTransfer } from './localStore'

function sendAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(6000).emit(event, payload, (timeoutError, response) => {
      if (timeoutError) return reject(new Error('The room did not respond. Try again.'))
      if (!response?.ok) return reject(new Error(response?.error || 'Call could not be started.'))
      return resolve(response)
    })
  })
}

export default function useRoomCalls(socket, roomId, session, options = {}) {
  const [peers, setPeers] = useState([])
  const [call, setCall] = useState(null)
  const [remoteStream, setRemoteStream] = useState(null)
  const [remoteVideoReady, setRemoteVideoReady] = useState(false)
  const [pickerMode, setPickerMode] = useState(null)
  const [feedback, setFeedback] = useState('')
  const [muted, setMuted] = useState(false)
  const [cameraOff, setCameraOff] = useState(false)
  const [cameraFacing, setCameraFacing] = useState('user')
  const [fileChannelOpen, setFileChannelOpen] = useState(false)
  const cameraOffRef = useRef(false)
  const callRef = useRef(null)
  const remoteStreamRef = useRef(null)
  const peerConnectionRef = useRef(null)
  const pendingIceRef = useRef([])
  const cameraFacingRef = useRef('user')
  const cameraSwitchRequestRef = useRef(0)
  const cameraSwitchPendingRef = useRef(false)
  const signalDroppedRef = useRef(false)
  const reportedCallStatsRef = useRef(new Set())
  const prepareConnectionRef = useRef(null)
  const recoveryRef = useRef({ attempt: 0, grace: 0, window: 0, active: false })
  const remoteVideoRef = useRef(null)
  const remoteAudioRef = useRef(null)
  const localVideoRef = useRef(null)
  /**
   * The file controller outlives the peer connection: a Phase 2 rebuild swaps
   * the data channel underneath an in-flight transfer and the bitmap resumes it
   * instead of restarting. Callbacks are read through a ref because the caller
   * hands in fresh closures on every render while the controller is made once.
   */
  const fileOptionsRef = useRef(options)
  fileOptionsRef.current = options
  const fileTransferRef = useRef(null)
  if (!fileTransferRef.current) {
    fileTransferRef.current = createFileTransferController({
      protocol: transferProtocol,
      store: { saveRecord: saveTransfer },
      onReceived: (file) => fileOptionsRef.current.onFileReceived?.(file),
      onBound: (binding) => fileOptionsRef.current.onFileBound?.(binding),
      onStateChange: setFileChannelOpen,
    })
  }

  const updateCall = (next) => {
    callRef.current = next
    setCall(next)
  }

  const clearRecovery = () => {
    window.clearTimeout(recoveryRef.current.grace)
    window.clearTimeout(recoveryRef.current.window)
    recoveryRef.current = { attempt: 0, grace: 0, window: 0, active: false }
  }

  const cleanupLocal = () => {
    const current = callRef.current
    const connection = peerConnectionRef.current
    cameraSwitchRequestRef.current += 1
    cameraSwitchPendingRef.current = false
    cameraOffRef.current = false
    signalDroppedRef.current = false
    reportedCallStatsRef.current.clear()
    clearRecovery()
    // A transfer has no receiver once the call is gone; leaving its `done`
    // pending would keep a progress bar alive forever.
    fileTransferRef.current?.abortAll()
    peerConnectionRef.current = null
    if (connection) {
      connection.onicecandidate = null
      connection.ontrack = null
      connection.onconnectionstatechange = null
      connection.ondatachannel = null
      connection.close()
    }
    current?.localStream?.getTracks().forEach((track) => track.stop())
    pendingIceRef.current = []
    remoteStreamRef.current = null
    setRemoteStream(null)
    setRemoteVideoReady(false)
    setMuted(false)
    setCameraOff(false)
    updateCall(null)
  }

  useEffect(() => {
    if (!socket) return undefined
    primeIceConfig(session)

    const refreshPeers = (snapshot) => {
      const next = (snapshot?.users || [])
        .filter((person) => person.userId && person.userId !== session.userId && person.socketId)
        .map((person) => ({ socketId: person.socketId, userId: person.userId, displayName: person.displayName || 'Guest' }))
      setPeers(next)
    }

    const sendReject = (signal, reason = 'busy') => {
      socket.emit('call:reject', {
        targetSocketId: signal.fromSocketId,
        callId: signal.callId,
        reason,
      })
    }

    const onIncoming = (signal) => {
      if (signal.room !== roomId || !signal.fromSocketId || !signal.callId) return
      primeIceConfig(session)
      if (callRef.current) {
        sendReject(signal)
        return
      }
      setPickerMode(null)
      setFeedback('')
      updateCall({
        callId: signal.callId,
        peerSocketId: signal.fromSocketId,
        peerName: signal.fromDisplayName || 'Guest',
        mode: signal.mode === 'video' ? 'video' : 'audio',
        direction: 'incoming',
        status: 'incoming',
        localStream: null,
      })
    }

    const createPeerConnection = (active) => {
      // Boot primed this cache, so negotiating never waits on /api/rtc-config.
      const iceServers = readIceServers(session) || ICE_FALLBACK
      primeIceConfig(session)
      const connection = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 2 })
      active.localStream?.getTracks().forEach((track) => connection.addTrack(track, active.localStream))
      connection.onicecandidate = (event) => {
        if (!event.candidate) return
        socket.emit('call:ice', {
          targetSocketId: active.peerSocketId,
          callId: active.callId,
          candidate: event.candidate.toJSON(),
        })
      }
      connection.ontrack = (event) => {
        let stream = event.streams?.[0] || remoteStreamRef.current
        if (!stream) stream = new MediaStream()
        if (!event.streams?.[0] && !stream.getTracks().some((track) => track.id === event.track.id)) {
          stream.addTrack(event.track)
        }
        remoteStreamRef.current = stream
        const video = remoteVideoRef.current
        if (video && video.srcObject !== stream) {
          video.srcObject = stream
          const playback = video.play?.()
          if (playback && typeof playback.catch === 'function') {
            // Resetting srcObject can abort a play() that is already in flight;
            // only a real autoplay refusal deserves a message the guest must act on.
            playback.catch((error) => {
              if (error?.name === 'NotAllowedError') setFeedback('Remote video arrived, but playback was blocked by the browser. Tap the video or check autoplay permissions.')
            })
          }
        }
        setRemoteStream(stream)
      }
      connection.onconnectionstatechange = () => {
        const state = connection.connectionState
        if (state === 'connected') markConnected(active)
        else if (state === 'disconnected' || state === 'failed') scheduleRecovery(active, state)
        else if (state === 'closed' && peerConnectionRef.current === connection) {
          failCall(active, 'The media path could not connect. This network may require a TURN relay; check the deployment ICE/TURN configuration.')
        }
      }
      // The caller owns the one ordered channel; the callee attaches the channel
      // it is handed. It has to be set before setRemoteDescription so an offer
      // that arrives with a channel is never dropped on the floor.
      connection.ondatachannel = (event) => {
        if (event.channel?.label !== FILE_CHANNEL_LABEL) return
        fileTransferRef.current?.attach(event.channel)
      }
      if (active.direction === 'outgoing') {
        const files = connection.createDataChannel(FILE_CHANNEL_LABEL, { ordered: true })
        fileTransferRef.current?.attach(files)
      }
      peerConnectionRef.current = connection
      return connection
    }
    prepareConnectionRef.current = createPeerConnection

    const reportCallStats = (active, outcome) => {
      if (reportedCallStatsRef.current.has(active.callId)) return
      reportedCallStatsRef.current.add(active.callId)
      const connection = peerConnectionRef.current
      const send = (relayed) => socket.emit('call:stats', { callId: active.callId, outcome, relayed })
      if (outcome !== 'connected' || !connection?.getStats) {
        send(null)
        return
      }
      connection.getStats().then((report) => {
        let pair = null
        const candidates = new Map()
        report.forEach((item) => {
          if (item.type === 'candidate-pair' && item.state === 'succeeded' && (item.nominated || !pair)) pair = item
          if (item.type === 'local-candidate' || item.type === 'remote-candidate') candidates.set(item.id, item)
        })
        if (!pair) return send(null)
        const local = candidates.get(pair.localCandidateId)
        const remote = candidates.get(pair.remoteCandidateId)
        send([local, remote].some((candidate) => candidate?.candidateType === 'relay'))
      }).catch(() => send(null))
    }

    const markConnected = (active) => {
      clearRecovery()
      reportCallStats(active, 'connected')
      const current = callRef.current
      if (current?.callId === active.callId) updateCall({ ...current, status: 'active' })
    }

    const failCall = (active, message) => {
      clearRecovery()
      const current = callRef.current
      if (current?.callId !== active.callId) return
      reportCallStats(active, 'failed')
      updateCall({ ...current, status: 'failed' })
      setFeedback(message)
    }

    const rebuildConnection = (active) => {
      const previous = peerConnectionRef.current
      // The old channel dies with its connection; the controller keeps its
      // bitmaps and waits for the replacement instead of failing the transfer.
      fileTransferRef.current?.detach()
      if (previous) {
        previous.onicecandidate = null
        previous.ontrack = null
        previous.onconnectionstatechange = null
        previous.ondatachannel = null
        peerConnectionRef.current = null
        previous.close()
      }
      pendingIceRef.current = []
      return createPeerConnection(active)
    }

    /**
     * One step of the recovery ladder. The caller restarts ICE first and
     * rebuilds the peer connection only if that window closes without media;
     * the callee asks the caller to do the same instead of negotiating too.
     */
    const attemptRecovery = async (active, attempt) => {
      const current = callRef.current
      if (!recoveryRef.current.active || !current || current.callId !== active.callId || current.status === 'failed') return
      const action = recoveryAction(attempt, active.direction)
      if (action === 'fail') {
        failCall(active, 'The call could not recover the media path. Check your network; a TURN relay may be required.')
        return
      }
      updateCall({ ...current, status: 'reconnecting' })
      recoveryRef.current.attempt = attempt
      try {
        if (action === 'rebuild') {
          const connection = rebuildConnection(active)
          const offer = await connection.createOffer()
          await connection.setLocalDescription(offer)
          socket.emit('call:offer', {
            targetSocketId: active.peerSocketId,
            callId: active.callId,
            description: connection.localDescription,
          })
        } else if (action === 'restart') {
          const connection = peerConnectionRef.current
          if (!connection) {
            failCall(active, 'The call could not recover the media path. Check your network; a TURN relay may be required.')
            return
          }
          connection.restartIce?.()
          const offer = await connection.createOffer({ iceRestart: true })
          await connection.setLocalDescription(offer)
          socket.emit('call:offer', {
            targetSocketId: active.peerSocketId,
            callId: active.callId,
            description: connection.localDescription,
          })
        } else {
          socket.emit('call:restart', { targetSocketId: active.peerSocketId, callId: active.callId })
        }
      } catch { /* the window below decides whether the next step runs */ }
      if (!recoveryRef.current.active || callRef.current?.callId !== active.callId) return
      recoveryRef.current.window = window.setTimeout(() => attemptRecovery(active, attempt + 1), RECOVERY_WINDOW_MS)
    }

    const beginRecovery = (active) => {
      const current = callRef.current
      if (!current || current.callId !== active.callId || current.status === 'failed') return
      if (recoveryRef.current.active) return
      clearRecovery()
      recoveryRef.current.active = true
      attemptRecovery(active, 0)
    }

    const scheduleRecovery = (active, peerState) => {
      const current = callRef.current
      if (!current || current.callId !== active.callId || current.status === 'failed') return
      if (recoveryRef.current.active || recoveryRef.current.grace) return
      const grace = recoveryGrace(peerState)
      if (!grace) {
        beginRecovery(active)
        return
      }
      // A brief blip is left alone; only a connection that stays down is shown
      // as reconnecting and handed to the recovery ladder.
      recoveryRef.current.grace = window.setTimeout(() => {
        recoveryRef.current.grace = 0
        beginRecovery(active)
      }, grace)
    }

    const flushIce = async (connection) => {
      const queued = pendingIceRef.current.splice(0)
      for (const candidate of queued) {
        try { await connection.addIceCandidate(new RTCIceCandidate(candidate)) } catch { /* a stale candidate is harmless */ }
      }
    }

    const onAccepted = async (signal) => {
      const active = callRef.current
      if (!active || active.direction !== 'outgoing' || active.callId !== signal.callId || active.peerSocketId !== signal.fromSocketId) return
      try {
        updateCall({ ...active, status: 'connecting' })
        const connection = createPeerConnection(active)
        const offer = await connection.createOffer()
        await connection.setLocalDescription(offer)
        socket.emit('call:offer', {
          targetSocketId: active.peerSocketId,
          callId: active.callId,
          description: connection.localDescription,
        })
      } catch (error) {
        setFeedback(error.message || 'Could not create the call connection.')
        cleanupLocal()
      }
    }

    const onOffer = async (signal) => {
      const active = callRef.current
      if (!active || active.direction !== 'incoming' || active.callId !== signal.callId || active.peerSocketId !== signal.fromSocketId) return
      try {
        const connection = peerConnectionRef.current || createPeerConnection(active)
        await connection.setRemoteDescription(new RTCSessionDescription(signal.description))
        await flushIce(connection)
        const answer = await connection.createAnswer()
        await connection.setLocalDescription(answer)
        socket.emit('call:answer', {
          targetSocketId: active.peerSocketId,
          callId: active.callId,
          description: connection.localDescription,
        })
        updateCall({ ...callRef.current, status: 'connecting' })
      } catch (error) {
        setFeedback(error.message || 'Could not answer the call.')
        cleanupLocal()
      }
    }

    const onAnswer = async (signal) => {
      const active = callRef.current
      const connection = peerConnectionRef.current
      if (!active || !connection || active.callId !== signal.callId || active.peerSocketId !== signal.fromSocketId) return
      try {
        await connection.setRemoteDescription(new RTCSessionDescription(signal.description))
        await flushIce(connection)
      } catch (error) {
        setFeedback(error.message || 'Could not connect the call.')
        cleanupLocal()
      }
    }

    const onIce = async (signal) => {
      const active = callRef.current
      if (!active || active.callId !== signal.callId || active.peerSocketId !== signal.fromSocketId) return
      const connection = peerConnectionRef.current
      if (!connection?.remoteDescription) {
        pendingIceRef.current.push(signal.candidate)
        return
      }
      try { await connection.addIceCandidate(new RTCIceCandidate(signal.candidate)) } catch {
        // A candidate for an offer that has not been applied yet is replayed
        // once the new description lands.
        pendingIceRef.current.push(signal.candidate)
      }
    }

    const onDeclined = (signal) => {
      const active = callRef.current
      if (!active || active.callId !== signal.callId) return
      setFeedback(`${active.peerName} declined the call.`)
      cleanupLocal()
    }

    const onEnded = (signal) => {
      const active = callRef.current
      if (!active || active.callId !== signal.callId) return
      setFeedback('Call ended.')
      cleanupLocal()
    }

    const onSignalDisconnect = () => {
      const current = callRef.current
      if (!current || current.status === 'incoming' || current.status === 'failed') return
      signalDroppedRef.current = true
      updateCall({ ...current, status: 'reconnecting' })
    }
    const onSignalReconnect = () => {
      const current = callRef.current
      if (!signalDroppedRef.current) return
      signalDroppedRef.current = false
      if (!current || current.status === 'incoming') return
      if (['calling', 'connecting', 'reconnecting'].includes(current.status)) {
        socket.emit('call:resume', { callId: current.callId })
      }
      const peerState = peerConnectionRef.current?.connectionState
      if (peerState === 'disconnected' || peerState === 'failed') {
        scheduleRecovery(current, peerState)
        return
      }
      // Signaling and media recover independently; derive the call status from
      // the peer connection instead of assuming the old one survived.
      updateCall({ ...current, status: restoredCallStatus(peerState) })
    }
    const onRestart = (signal) => {
      const active = callRef.current
      if (!active || active.direction !== 'outgoing' || active.callId !== signal.callId || active.peerSocketId !== signal.fromSocketId) return
      beginRecovery(active)
    }
    const onMailbox = async (signal) => {
      const active = callRef.current
      if (!active || active.callId !== signal.callId || active.status === 'incoming' || active.status === 'failed') return
      // The peer may hold a new socket after its own reconnect; the replay
      // carries the id presence knows now, so later signals aim at the live one.
      const peerSocketId = signal.fromSocketId || active.peerSocketId
      updateCall({ ...active, peerSocketId, peerName: signal.fromDisplayName || active.peerName })
      if (signal.description) {
        const replay = { ...signal, fromSocketId: peerSocketId }
        if (active.direction === 'incoming') await onOffer(replay)
        else await onAnswer(replay)
      }
      for (const candidate of signal.candidates || []) {
        await onIce({ callId: signal.callId, fromSocketId: peerSocketId, candidate })
      }
    }
    socket.on('disconnect', onSignalDisconnect)
    socket.on('connect', onSignalReconnect)
    socket.on('presence', refreshPeers)
    socket.on('call:incoming', onIncoming)
    socket.on('call:accepted', onAccepted)
    socket.on('call:offer', onOffer)
    socket.on('call:answer', onAnswer)
    socket.on('call:ice', onIce)
    socket.on('call:restart', onRestart)
    socket.on('call:mailbox', onMailbox)
    socket.on('call:declined', onDeclined)
    socket.on('call:end', onEnded)

    return () => {
      socket.off('disconnect', onSignalDisconnect)
      socket.off('connect', onSignalReconnect)
      socket.off('presence', refreshPeers)
      socket.off('call:incoming', onIncoming)
      socket.off('call:accepted', onAccepted)
      socket.off('call:offer', onOffer)
      socket.off('call:answer', onAnswer)
      socket.off('call:ice', onIce)
      socket.off('call:restart', onRestart)
      socket.off('call:mailbox', onMailbox)
      socket.off('call:declined', onDeclined)
      socket.off('call:end', onEnded)
      prepareConnectionRef.current = null
      cleanupLocal()
    }
    // A room socket is created for one guest and one room; the refs keep event handlers current.
  }, [socket, roomId, session.userId])

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream && remoteVideoRef.current.srcObject !== remoteStream) remoteVideoRef.current.srcObject = remoteStream
    if (remoteAudioRef.current && remoteStream && remoteAudioRef.current.srcObject !== remoteStream) remoteAudioRef.current.srcObject = remoteStream
    if (localVideoRef.current && call?.localStream && localVideoRef.current.srcObject !== call.localStream) localVideoRef.current.srcObject = call.localStream
  }, [remoteStream, call])

  /**
   * Collapsing or floating the call window unmounts the <video>, and a fresh
   * element starts with an empty srcObject. The stream never left the peer
   * connection, so the elements are simply re-bound.
   */
  const reattachMedia = () => {
    const currentRemoteStream = remoteStreamRef.current || remoteStream
    const video = remoteVideoRef.current
    if (video && currentRemoteStream) {
      video.srcObject = currentRemoteStream
      // A remounted <video> can stay paused even with autoPlay; asking
      // explicitly makes expand-from-minimised instant. A refused play puts
      // the placeholder back so the tap-to-play affordance is visible.
      video.play?.()?.catch?.(() => setRemoteVideoReady(false))
    }
    if (remoteAudioRef.current && remoteStream) remoteAudioRef.current.srcObject = remoteStream
    if (localVideoRef.current && callRef.current?.localStream) localVideoRef.current.srcObject = callRef.current.localStream
  }

  /** The blocked-playback notice stays until a frame actually starts. */
  const markRemoteVideoReady = () => {
    setRemoteVideoReady(true)
    setFeedback((current) => (current.startsWith('Remote video arrived') ? '' : current))
  }

  const retryRemotePlayback = () => {
    const video = remoteVideoRef.current
    if (!video) return
    const playback = video.play?.()
    if (playback?.then) playback.then(() => setFeedback('')).catch(() => {})
  }

  useEffect(() => {
    if (!call || !['calling', 'incoming'].includes(call.status)) return undefined
    const timeoutMs = call.status === 'calling' ? 30000 : 45000
    const callId = call.callId
    const timer = window.setTimeout(() => {
      const active = callRef.current
      if (!active || active.callId !== callId) return
      const outgoing = active.direction === 'outgoing'
      if (socket?.connected) {
        socket.emit(outgoing ? 'call:end' : 'call:reject', {
          targetSocketId: active.peerSocketId,
          callId: active.callId,
          reason: outgoing ? 'no-answer' : 'expired',
        })
      }
      setFeedback(outgoing ? 'No answer. The call was cancelled.' : 'The incoming call expired.')
      cleanupLocal()
    }, timeoutMs)
    return () => window.clearTimeout(timer)
    // The call id/status and socket identify this short invitation timer.
  }, [call?.callId, call?.status, socket])

  const openPicker = (mode) => {
    primeIceConfig(session)
    setFeedback('')
    setPickerMode(mode)
  }

  const startCall = async (peer, requestedMode) => {
    if (!socket?.connected) {
      setFeedback('Connect to the room before starting a call.')
      setPickerMode(null)
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setFeedback('This browser cannot access a microphone or camera for calls.')
      setPickerMode(null)
      return
    }
    const mode = requestedMode === 'video' || requestedMode === 'audio' ? requestedMode : (pickerMode || 'audio')
    setPickerMode(null)
    try {
      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: mode === 'video' ? { facingMode: { ideal: cameraFacingRef.current } } : false,
      })
      const active = {
        callId: crypto.randomUUID(),
        peerSocketId: peer.socketId,
        peerName: peer.displayName,
        mode,
        direction: 'outgoing',
        status: 'calling',
        localStream,
      }
      setFeedback('')
      updateCall(active)
      await sendAck(socket, 'call:invite', {
        targetSocketId: peer.socketId,
        callId: active.callId,
        mode,
      })
      // Gathering starts while the other guest is still ringing, so the offer
      // is ready the moment they accept. A fast auto-answer may already have
      // built the connection; a call cancelled during the invite must not
      // leave one behind.
      const latest = callRef.current
      if (latest?.callId === active.callId && !peerConnectionRef.current) prepareConnectionRef.current?.(active)
    } catch (error) {
      const current = callRef.current
      if (current?.direction === 'outgoing') cleanupLocal()
      setFeedback(error.message || 'Could not start the call. Check microphone/camera permissions.')
    }
  }

  const acceptCall = async () => {
    const active = callRef.current
    if (!socket?.connected) {
      setFeedback('The room connection was interrupted. Wait for it to reconnect before accepting.')
      return
    }
    if (!active || active.direction !== 'incoming' || !navigator.mediaDevices?.getUserMedia) {
      setFeedback('This browser cannot access a microphone or camera for calls.')
      return
    }
    try {
      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: active.mode === 'video' ? { facingMode: { ideal: cameraFacingRef.current } } : false,
      })
      const next = { ...active, localStream, status: 'connecting' }
      updateCall(next)
      await sendAck(socket, 'call:accept', { targetSocketId: active.peerSocketId, callId: active.callId })
    } catch (error) {
      setFeedback(error.message || 'Could not accept the call. Check permissions and try again.')
      try { await sendAck(socket, 'call:reject', { targetSocketId: active.peerSocketId, callId: active.callId, reason: 'permission-denied' }) } catch { /* the caller may already have left */ }
      cleanupLocal()
    }
  }

  const declineCall = async () => {
    const active = callRef.current
    if (active?.direction === 'incoming') {
      try { await sendAck(socket, 'call:reject', { targetSocketId: active.peerSocketId, callId: active.callId }) } catch { /* the other guest may have left */ }
    }
    cleanupLocal()
  }

  const hangup = () => {
    const active = callRef.current
    if (active && socket?.connected) {
      socket.emit('call:end', { targetSocketId: active.peerSocketId, callId: active.callId })
    }
    cleanupLocal()
  }

  const toggleMic = () => {
    const nextMuted = !muted
    callRef.current?.localStream?.getAudioTracks().forEach((track) => { track.enabled = !nextMuted })
    setMuted(nextMuted)
  }

  const toggleCamera = () => {
    const nextOff = !cameraOffRef.current
    cameraOffRef.current = nextOff
    callRef.current?.localStream?.getVideoTracks().forEach((track) => { track.enabled = !nextOff })
    setCameraOff(nextOff)
  }
  const switchCamera = async () => {
    const active = callRef.current
    if (!active?.localStream || active.mode !== 'video' || !navigator.mediaDevices?.getUserMedia || cameraSwitchPendingRef.current) return
    cameraSwitchPendingRef.current = true
    const requestId = ++cameraSwitchRequestRef.current
    const nextFacing = cameraFacingRef.current === 'user' ? 'environment' : 'user'
    let stream = null
    let nextTrack = null
    let oldTrack = null
    let sender = null
    let senderReplaced = false
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: nextFacing } }, audio: false })
      } catch {
        // Some browsers expose only one camera or ignore exact facing constraints.
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: nextFacing } }, audio: false })
      }
      nextTrack = stream.getVideoTracks()[0]
      if (!nextTrack) throw new Error('No camera track was available.')
      const isCurrentCall = () => {
        const latest = callRef.current
        return cameraSwitchRequestRef.current === requestId
          && latest?.callId === active.callId
          && latest.localStream === active.localStream
      }
      if (!isCurrentCall()) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      // Read after the permission prompt resolves so a concurrent camera toggle wins.
      nextTrack.enabled = !cameraOffRef.current
      oldTrack = active.localStream.getVideoTracks()[0]
      sender = peerConnectionRef.current?.getSenders().find((item) => item.track?.kind === 'video')
      if (sender) {
        await sender.replaceTrack(nextTrack)
        senderReplaced = true
      }
      if (!isCurrentCall()) {
        if (senderReplaced) {
          try { await sender.replaceTrack(oldTrack?.readyState === 'live' ? oldTrack : null) } catch { /* peer connection may already be closed */ }
        }
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      nextTrack.enabled = !cameraOffRef.current
      active.localStream.addTrack(nextTrack)
      if (oldTrack) active.localStream.removeTrack(oldTrack)
      cameraFacingRef.current = nextFacing
      setCameraFacing(nextFacing)
      updateCall({ ...active })
      nextTrack = null
      if (oldTrack) oldTrack.stop()
    } catch (error) {
      if (senderReplaced) {
        try { await sender.replaceTrack(oldTrack?.readyState === 'live' ? oldTrack : null) } catch { /* peer connection may already be closed */ }
      }
      if (nextTrack && active.localStream.getTracks().includes(nextTrack)) active.localStream.removeTrack(nextTrack)
      stream?.getTracks().forEach((track) => track.stop())
      if (cameraSwitchRequestRef.current === requestId) {
        setFeedback(error.message || 'Could not switch cameras. Check camera permissions.')
      }
    } finally {
      if (cameraSwitchRequestRef.current === requestId) cameraSwitchPendingRef.current = false
    }
  }

  /**
   * Offers a file to the peer over the call's data channel.
   *
   * Returns null - immediately when there is no call, or after the channel
   * window - so the caller can keep the upload as the guarantee and treat this
   * purely as an acceleration. The transfer id comes back before the bytes are
   * done so the media id from that upload can be bound as soon as it lands.
   */
  const sendFileToPeer = async (file, sendOptions = {}) => {
    const controller = fileTransferRef.current
    if (!controller || !file || !callRef.current) return null
    if (Number(file.size) > transferProtocol.TRANSFER_MAX_BYTES) return null
    const open = await controller.whenOpen(FILE_CHANNEL_TIMEOUT_MS)
    if (!open) return null
    return controller.send(file, sendOptions)
  }

  const bindFileToPeer = (transferId, mediaId) => {
    const controller = fileTransferRef.current
    if (!controller || !transferId || !mediaId) return false
    return controller.bind(transferId, mediaId)
  }

  return {
    peers,
    call,
    remoteStream,
    remoteVideoReady,
    markRemoteVideoReady,
    retryRemotePlayback,
    pickerMode,
    feedback,
    muted,
    cameraOff,
    remoteVideoRef,
    remoteAudioRef,
    localVideoRef,
    reattachMedia,
    openPicker,
    closePicker: () => setPickerMode(null),
    startCall,
    acceptCall,
    declineCall,
    hangup,
    toggleMic,
    toggleCamera,
    switchCamera,
    cameraFacing,
    fileChannelOpen,
    sendFileToPeer,
    bindFileToPeer,
  }
}
