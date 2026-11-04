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
  const [pickerMode, setPickerMode] = useState(null)
  const [feedback, setFeedback] = useState('')
  const [muted, setMuted] = useState(false)
  const [cameraOff, setCameraOff] = useState(false)
  const callRef = useRef(null)
  const peerConnectionRef = useRef(null)
  const pendingIceRef = useRef([])
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
    peerConnectionRef.current = null
    if (connection) {
      connection.onicecandidate = null
      connection.ontrack = null
      connection.onconnectionstatechange = null
      connection.close()
    }
    current?.localStream?.getTracks().forEach((track) => track.stop())
    pendingIceRef.current = []
    setRemoteStream(null)
    setMuted(false)
    setCameraOff(false)
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

    const createPeerConnection = (active) => {
      const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS })
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
        const stream = event.streams?.[0] || new MediaStream([event.track])
        setRemoteStream(stream)
      }
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === 'connected') {
          const current = callRef.current
          if (current?.callId === active.callId) updateCall({ ...current, status: 'active' })
        } else if (connection.connectionState === 'failed') {
          const current = callRef.current
          if (current?.callId === active.callId) updateCall({ ...current, status: 'failed' })
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

    socket.on('presence', refreshPeers)
    socket.on('call:incoming', onIncoming)
    socket.on('call:accepted', onAccepted)
    socket.on('call:offer', onOffer)
    socket.on('call:answer', onAnswer)
    socket.on('call:ice', onIce)
    socket.on('call:declined', onDeclined)
    socket.on('call:end', onEnded)

    return () => {
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
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream
    if (remoteAudioRef.current && remoteStream) remoteAudioRef.current.srcObject = remoteStream
    if (localVideoRef.current && call?.localStream) localVideoRef.current.srcObject = call.localStream
  }, [remoteStream, call])

  /**
   * Collapsing or floating the call window unmounts the <video>, and a fresh
   * element starts with an empty srcObject. The stream never left the peer
   * connection, so the elements are simply re-bound.
   */
  const reattachMedia = () => {
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream
    if (remoteAudioRef.current && remoteStream) remoteAudioRef.current.srcObject = remoteStream
    if (localVideoRef.current && callRef.current?.localStream) localVideoRef.current.srcObject = callRef.current.localStream
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
        video: mode === 'video' ? { facingMode: 'user' } : false,
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
    if (!active || active.direction !== 'incoming' || !navigator.mediaDevices?.getUserMedia) {
      setFeedback('This browser cannot access a microphone or camera for calls.')
      return
    }
    try {
      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: active.mode === 'video' ? { facingMode: 'user' } : false,
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
    const nextOff = !cameraOff
    callRef.current?.localStream?.getVideoTracks().forEach((track) => { track.enabled = !nextOff })
    setCameraOff(nextOff)
  }

  return {
    peers,
    call,
    remoteStream,
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
  }
}
