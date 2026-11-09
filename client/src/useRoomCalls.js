import { useEffect, useRef, useState } from 'react'

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

function sendAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(6000).emit(event, payload, (timeoutError, response) => {
      if (timeoutError) return reject(new Error('The room did not respond. Try again.'))
      if (!response?.ok) return reject(new Error(response?.error || 'Call could not be started.'))
      return resolve(response)
    })
  })
}

export default function useRoomCalls(socket, roomId, session) {
  const [peers, setPeers] = useState([])
  const [call, setCall] = useState(null)
  const [remoteStream, setRemoteStream] = useState(null)
  const [remoteVideoReady, setRemoteVideoReady] = useState(false)
  const [pickerMode, setPickerMode] = useState(null)
  const [feedback, setFeedback] = useState('')
  const [muted, setMuted] = useState(false)
  const [cameraOff, setCameraOff] = useState(false)
  const [cameraFacing, setCameraFacing] = useState('user')
  const cameraOffRef = useRef(false)
  const callRef = useRef(null)
  const remoteStreamRef = useRef(null)
  const peerConnectionRef = useRef(null)
  const pendingIceRef = useRef([])
  const cameraFacingRef = useRef('user')
  const cameraSwitchRequestRef = useRef(0)
  const cameraSwitchPendingRef = useRef(false)
  const callBeforeSignalDropRef = useRef(null)
  const signalDroppedRef = useRef(false)
  const remoteVideoRef = useRef(null)
  const remoteAudioRef = useRef(null)
  const localVideoRef = useRef(null)

  const updateCall = (next) => {
    callRef.current = next
    setCall(next)
  }

  const cleanupLocal = () => {
    const current = callRef.current
    const connection = peerConnectionRef.current
    cameraSwitchRequestRef.current += 1
    cameraSwitchPendingRef.current = false
    cameraOffRef.current = false
    signalDroppedRef.current = false
    peerConnectionRef.current = null
    if (connection) {
      connection.onicecandidate = null
      connection.ontrack = null
      connection.onconnectionstatechange = null
      connection.close()
    }
    current?.localStream?.getTracks().forEach((track) => track.stop())
    pendingIceRef.current = []
    remoteStreamRef.current = null
    setRemoteStream(null)
    setRemoteVideoReady(false)
    setMuted(false)
    setCameraOff(false)
    callBeforeSignalDropRef.current = null
    updateCall(null)
  }

  useEffect(() => {
    if (!socket) return undefined

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

    const createPeerConnection = async (active) => {
      let iceServers = ICE_SERVERS
      if (session?.userId) {
        const controller = new AbortController()
        const timeout = window.setTimeout(() => controller.abort(), 2500)
        try {
          const response = await fetch('/api/rtc-config', {
            headers: { 'X-Session-Id': session.userId },
            cache: 'no-store',
            signal: controller.signal
          })
          if (response.ok) {
            const config = await response.json()
            if (Array.isArray(config.iceServers) && config.iceServers.length) iceServers = config.iceServers
          }
        } catch { /* signaling still works with STUN if the optional config endpoint is unavailable */ }
        finally { window.clearTimeout(timeout) }
      }
      const connection = new RTCPeerConnection({ iceServers })
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
        if (connection.connectionState === 'connected') {
          const current = callRef.current
          if (current?.callId === active.callId) updateCall({ ...current, status: 'active' })
        } else if (connection.connectionState === 'failed') {
          const current = callRef.current
          if (current?.callId === active.callId) {
            updateCall({ ...current, status: 'failed' })
            setFeedback('The media path could not connect. This network may require a TURN relay; check the deployment ICE/TURN configuration.')
          }
        }
      }
      peerConnectionRef.current = connection
      return connection
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
        const connection = await createPeerConnection(active)
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
        const connection = peerConnectionRef.current || await createPeerConnection(active)
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
      try { await connection.addIceCandidate(new RTCIceCandidate(signal.candidate)) } catch { /* ignore candidates from a closed negotiation */ }
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
      if (current.status !== 'reconnecting') callBeforeSignalDropRef.current = current.status
      updateCall({ ...current, status: 'reconnecting' })
    }
    const onSignalReconnect = () => {
      const current = callRef.current
      if (!signalDroppedRef.current) return
      signalDroppedRef.current = false
      if (!current || current.status === 'incoming') {
        callBeforeSignalDropRef.current = null
        return
      }
      const previousStatus = callBeforeSignalDropRef.current
      callBeforeSignalDropRef.current = null
      const connection = peerConnectionRef.current
      const peerState = connection?.connectionState
      const recoveredStatus = peerState === 'connected' ? 'active'
        : peerState === 'failed' || peerState === 'closed' ? 'failed'
          : peerState === 'disconnected' ? 'connecting'
            : previousStatus || 'connecting'
      // Signaling and media recover independently; derive call status from the
      // peer connection instead of assuming the pre-disconnect state survived.
      updateCall({ ...current, status: recoveredStatus })
    }
    socket.on('disconnect', onSignalDisconnect)
    socket.on('connect', onSignalReconnect)
    socket.on('presence', refreshPeers)
    socket.on('call:incoming', onIncoming)
    socket.on('call:accepted', onAccepted)
    socket.on('call:offer', onOffer)
    socket.on('call:answer', onAnswer)
    socket.on('call:ice', onIce)
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
      socket.off('call:declined', onDeclined)
      socket.off('call:end', onEnded)
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
  }
}
