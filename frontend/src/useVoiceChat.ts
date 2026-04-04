import { useEffect, useRef, useState, useCallback } from 'react'
import { StreamAction } from './api'

export type VoiceUser = {
  username: string
  speaking: boolean
}

export type TranscriptEntry = {
  username: string
  text: string
  ts: number
}

export type VoiceChatCallbacks = {
  onAgentAction: (action: StreamAction) => void
  onCanvasRestoreFull: (snapshot: unknown) => void
  onCanvasSnapshot: (shapes: unknown[]) => void
}

type UseVoiceChatReturn = {
  users: VoiceUser[]
  transcripts: TranscriptEntry[]
  isMuted: boolean
  isConnected: boolean
  isListenerActive: boolean
  toggleMute: () => void
  sendWsMessage: (msg: Record<string, unknown>) => void
}

const WS_URL = 'ws://localhost:8000/ws'
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]
const MAX_TRANSCRIPTS = 20
const CHUNK_INTERVAL_MS = 5000
const RECORDER_WARMUP_MS = 300

export function useVoiceChat(
  roomId: string,
  username: string,
  callbacks: VoiceChatCallbacks,
): UseVoiceChatReturn {
  const [users, setUsers] = useState<VoiceUser[]>([])
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([])
  const [isMuted, setIsMuted] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [isListenerActive, setIsListenerActive] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const audioElemsRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  const localStreamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const isMutedRef = useRef(false)
  const speakingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // Keep callbacks in a ref so the WS onmessage closure always sees the latest version.
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  const addTranscript = useCallback((entry: TranscriptEntry) => {
    setTranscripts((prev) => [...prev.slice(-(MAX_TRANSCRIPTS - 1)), entry])
  }, [])

  const setSpeaking = useCallback((u: string, speaking: boolean) => {
    setUsers((prev) =>
      prev.map((user) => (user.username === u ? { ...user, speaking } : user)),
    )
  }, [])

  const clearSpeakingTimer = useCallback((u: string) => {
    const t = speakingTimersRef.current.get(u)
    if (t) clearTimeout(t)
  }, [])

  const markSpeaking = useCallback(
    (u: string) => {
      clearSpeakingTimer(u)
      setSpeaking(u, true)
      const t = setTimeout(() => setSpeaking(u, false), 1500)
      speakingTimersRef.current.set(u, t)
    },
    [clearSpeakingTimer, setSpeaking],
  )

  const sendWsMessage = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  // --- WebRTC helpers ---

  const createPeer = useCallback(
    (remoteUsername: string, polite: boolean): RTCPeerConnection => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

      localStreamRef.current?.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current!)
      })

      pc.onicecandidate = ({ candidate }) => {
        if (candidate && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'ice', to: remoteUsername, candidate }))
        }
      }

      pc.ontrack = ({ streams }) => {
        let audio = audioElemsRef.current.get(remoteUsername)
        if (!audio) {
          audio = new Audio()
          audioElemsRef.current.set(remoteUsername, audio)
        }
        audio.srcObject = streams[0]
        audio.play().catch(() => {})
      }

      if (!polite) {
        pc.onnegotiationneeded = async () => {
          try {
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            wsRef.current?.send(
              JSON.stringify({ type: 'offer', to: remoteUsername, sdp: pc.localDescription }),
            )
          } catch (e) {
            console.error('offer error', e)
          }
        }
      }

      peersRef.current.set(remoteUsername, pc)
      return pc
    },
    [],
  )

  const closePeer = useCallback((remoteUsername: string) => {
    peersRef.current.get(remoteUsername)?.close()
    peersRef.current.delete(remoteUsername)
    const audio = audioElemsRef.current.get(remoteUsername)
    if (audio) {
      audio.srcObject = null
      audioElemsRef.current.delete(remoteUsername)
    }
  }, [])

  // --- MediaRecorder + VAD ---

  const startRecorder = useCallback((stream: MediaStream) => {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'

    const audioCtx = new AudioContext()
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    const source = audioCtx.createMediaStreamSource(stream)
    source.connect(analyser)
    const dataArray = new Uint8Array(analyser.frequencyBinCount)

    function getRms(): number {
      analyser.getByteTimeDomainData(dataArray)
      let sum = 0
      for (const v of dataArray) {
        const normalized = v / 128 - 1
        sum += normalized * normalized
      }
      return Math.sqrt(sum / dataArray.length)
    }

    function startNewChunk() {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
      if (isMutedRef.current) {
        setTimeout(startNewChunk, CHUNK_INTERVAL_MS)
        return
      }

      const recorder = new MediaRecorder(stream, { mimeType })
      recorderRef.current = recorder

      let maxRms = 0
      let sampleInterval: ReturnType<typeof setInterval>

      recorder.ondataavailable = (e) => {
        clearInterval(sampleInterval)
        const hasVoice = maxRms > 0.08
        console.log(`[vad] maxRms=${maxRms.toFixed(4)} hasVoice=${hasVoice}`)
        if (!hasVoice || e.data.size < 100) {
          startNewChunk()
          return
        }
        const reader = new FileReader()
        reader.onloadend = () => {
          const b64 = (reader.result as string).split(',')[1]
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'audio_chunk', data: b64 }))
          }
          startNewChunk()
        }
        reader.readAsDataURL(e.data)
      }

      recorder.start()
      setTimeout(() => {
        sampleInterval = setInterval(() => {
          maxRms = Math.max(maxRms, getRms())
        }, 200)
        setTimeout(() => {
          if (recorder.state === 'recording') recorder.stop()
        }, CHUNK_INTERVAL_MS)
      }, RECORDER_WARMUP_MS)
    }

    startNewChunk()
  }, [])

  // --- Main WS + setup effect ---

  useEffect(() => {
    let cancelled = false

    async function setup() {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      } catch (e) {
        console.warn('Microphone access denied, voice disabled', e)
        stream = new MediaStream()
      }
      localStreamRef.current = stream
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }

      const ws = new WebSocket(`${WS_URL}/${roomId}/${encodeURIComponent(username)}`)
      wsRef.current = ws

      ws.onopen = () => {
        if (!cancelled) {
          setIsConnected(true)
          startRecorder(stream)
        }
      }

      ws.onerror = (e) => console.error('[ws] error', e)

      ws.onclose = () => {
        if (!cancelled) setIsConnected(false)
      }

      ws.onmessage = async (evt) => {
        if (cancelled) return
        let msg: Record<string, any>
        try {
          msg = JSON.parse(evt.data)
        } catch {
          return
        }
        const t = msg.type

        if (t === 'room_update') {
          const incoming: VoiceUser[] = (msg.users as { username: string }[]).map((u) => ({
            username: u.username,
            speaking: false,
          }))
          setUsers(incoming)
        } else if (t === 'existing_peers') {
          for (const peer of msg.peers as string[]) {
            if (!peersRef.current.has(peer)) createPeer(peer, false)
          }
        } else if (t === 'canvas_restore_full') {
          if (msg.snapshot) {
            callbacksRef.current.onCanvasRestoreFull(msg.snapshot)
          }
        } else if (t === 'canvas_snapshot') {
          callbacksRef.current.onCanvasSnapshot((msg.shapes ?? []) as unknown[])
        } else if (t === 'offer') {
          const from: string = msg.from
          let pc = peersRef.current.get(from)
          if (!pc) pc = createPeer(from, true)
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          ws.send(JSON.stringify({ type: 'answer', to: from, sdp: pc.localDescription }))
        } else if (t === 'answer') {
          const pc = peersRef.current.get(msg.from)
          if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
        } else if (t === 'ice') {
          const pc = peersRef.current.get(msg.from)
          if (pc && msg.candidate) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
            } catch (_) {}
          }
        } else if (t === 'transcript') {
          markSpeaking(msg.username)
          addTranscript({ username: msg.username, text: msg.text, ts: Date.now() })
        } else if (t === 'agent_action') {
          console.log('[agent_action] received:', msg.action)
          setIsListenerActive(true)
          callbacksRef.current.onAgentAction(msg.action as StreamAction)
          setTimeout(() => setIsListenerActive(false), 2000)
        } else if (t === 'user_left') {
          closePeer(msg.username)
        }
      }
    }

    setup()

    return () => {
      cancelled = true
      recorderRef.current?.stop()
      peersRef.current.forEach((pc) => pc.close())
      peersRef.current.clear()
      audioElemsRef.current.forEach((a) => {
        a.srcObject = null
      })
      audioElemsRef.current.clear()
      wsRef.current?.close()
      localStreamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [roomId, username]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMute = useCallback(() => {
    const next = !isMutedRef.current
    isMutedRef.current = next
    setIsMuted(next)
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next
    })
  }, [])

  return { users, transcripts, isMuted, isConnected, isListenerActive, toggleMute, sendWsMessage }
}
