import { useRef, useEffect } from 'react'
import { VoiceUser, TranscriptEntry } from './useVoiceChat'

interface VoiceChatProps {
  users: VoiceUser[]
  transcripts: TranscriptEntry[]
  isMuted: boolean
  isConnected: boolean
  isListenerActive: boolean
  toggleMute: () => void
  username?: string
}

export default function VoiceChat({
  users, transcripts, isMuted, isConnected, isListenerActive, toggleMute, username = '',
}: VoiceChatProps) {
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [transcripts])

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={{ ...styles.dot, background: isConnected ? '#4ade80' : '#6b7280' }} />
        <span style={styles.title}>Voice Room</span>
        {isListenerActive && <span style={styles.listenerBadge}>agent acting…</span>}
      </div>

      <div style={styles.users}>
        {users.map((u) => (
          <UserRow key={u.username} user={u} isMe={u.username === username} />
        ))}
        {users.length === 0 && (
          <div style={styles.empty}>Connecting…</div>
        )}
      </div>

      <div style={styles.logLabel}>Transcript</div>
      <div ref={logRef} style={styles.log}>
        {transcripts.length === 0
          ? <span style={styles.logEmpty}>nothing yet…</span>
          : transcripts.map((e, i) => <TranscriptRow key={i} entry={e} isMe={e.username === username} />)
        }
      </div>

      <button
        style={{
          ...styles.muteBtn,
          background: isMuted ? '#1f1f1f' : '#16a34a',
          border: isMuted ? '1.5px solid #ef4444' : '1.5px solid #16a34a',
          color: isMuted ? '#ef4444' : '#fff',
        }}
        onClick={toggleMute}
      >
        {isMuted ? '🔇 Muted — click to unmute' : '🎙 Live'}
      </button>
    </div>
  )
}

function UserRow({ user, isMe }: { user: VoiceUser; isMe: boolean }) {
  return (
    <div style={styles.userRow}>
      <div style={{ ...styles.avatar, ...(user.speaking ? styles.avatarSpeaking : {}) }}>
        {user.username[0].toUpperCase()}
      </div>
      <span style={styles.userName}>
        {user.username}
        {isMe && <span style={styles.meTag}> (you)</span>}
      </span>
    </div>
  )
}

function TranscriptRow({ entry, isMe }: { entry: TranscriptEntry; isMe: boolean }) {
  return (
    <div style={styles.logRow}>
      <span style={{ ...styles.logName, color: isMe ? '#818cf8' : '#94a3b8' }}>
        {entry.username.split(' ')[0]}:
      </span>{' '}
      <span style={styles.logText}>{entry.text}</span>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'absolute',
    bottom: '24px',
    left: '24px',
    width: '220px',
    background: '#1a1a2e',
    border: '1px solid #2a2a4a',
    borderRadius: '12px',
    padding: '12px',
    fontFamily: 'system-ui, sans-serif',
    color: '#e0e0f0',
    zIndex: 500,
    boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginBottom: '10px',
  },
  dot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  title: {
    fontSize: '12px',
    fontWeight: 600,
    flex: 1,
  },
  listenerBadge: {
    fontSize: '10px',
    color: '#a78bfa',
    fontStyle: 'italic',
  },
  users: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    marginBottom: '10px',
    minHeight: '28px',
  },
  userRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  avatar: {
    width: '26px',
    height: '26px',
    borderRadius: '50%',
    background: '#4f46e5',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '11px',
    fontWeight: 700,
    flexShrink: 0,
    transition: 'box-shadow 0.15s',
  },
  avatarSpeaking: {
    boxShadow: '0 0 0 3px #4ade80',
  },
  userName: {
    fontSize: '12px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meTag: {
    color: '#6b7280',
    fontSize: '11px',
  },
  empty: {
    fontSize: '11px',
    color: '#6b7280',
    fontStyle: 'italic',
  },
  logLabel: {
    fontSize: '10px',
    color: '#475569',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: '4px',
  },
  log: {
    background: '#0f172a',
    border: '1px solid #1e293b',
    borderRadius: '6px',
    padding: '6px 8px',
    height: '100px',
    overflowY: 'auto',
    marginBottom: '10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
  },
  logEmpty: {
    fontSize: '11px',
    color: '#334155',
    fontStyle: 'italic',
  },
  logRow: {
    fontSize: '11px',
    lineHeight: '1.4',
    wordBreak: 'break-word',
  },
  logName: {
    fontWeight: 600,
  },
  logText: {
    color: '#94a3b8',
  },
  muteBtn: {
    width: '100%',
    padding: '6px 0',
    border: 'none',
    borderRadius: '8px',
    color: '#fff',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
  },
}
