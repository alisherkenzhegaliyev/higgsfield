import type { CSSProperties } from 'react'
import { useEditor, createShapeId, TLShapeId, toRichText, AssetRecordType, useValue } from 'tldraw'
import { useGenerationContext, PendingGeneration, ThinkingGeneration } from './GenerationContext'
import { startGeneration, proxyUrl } from './api'

// Inject pulse animation once
const STYLE = `@keyframes hf-pulse{0%,100%{opacity:.35}50%{opacity:1}}.hf-dot{animation:hf-pulse 1.4s ease-in-out infinite}`

export default function GenerationOverlay() {
  const editor = useEditor()
  const { pendingGenerations, thinkingGenerations, settings, onGenerationComplete, onThinkingStart, onThinkingEnd, onApprove, onDismiss } =
    useGenerationContext()

  // Reactively reposition everything when camera / shapes change
  const thinkingPos = useValue(
    'thinking-positions',
    () =>
      thinkingGenerations.map((gen) => {
        const zoom = editor.getZoomLevel()
        const vp = editor.pageToViewport({ x: gen.x + gen.w / 2, y: gen.y })
        return { ...gen, vpX: vp.x, vpY: vp.y, zoom }
      }),
    [thinkingGenerations, editor]
  )

  const pendingPos = useValue(
    'pending-positions',
    () =>
      pendingGenerations
        .map((gen) => {
          const shape = editor.getShape(gen.shapeId as TLShapeId)
          if (!shape) return null
          const zoom = editor.getZoomLevel()
          const vp = editor.pageToViewport({ x: shape.x, y: shape.y })
          return { ...gen, vpX: vp.x, vpY: vp.y, scaledW: gen.w * zoom }
        })
        .filter((p): p is NonNullable<typeof p> => p !== null),
    [pendingGenerations, editor]
  )

  function handleAnimate(gen: PendingGeneration) {
    onApprove(gen.shapeId, 'image')

    const vidX = gen.x + gen.w + 24
    const vidY = gen.y
    const thinkingId = `thinking-vid-${Date.now()}`

    const placeholderId = createShapeId()
    editor.createShapes([{
      id: placeholderId,
      type: 'geo',
      x: vidX, y: vidY,
      props: {
        geo: 'rectangle' as const,
        w: gen.w, h: gen.h,
        richText: toRichText(`Generating video…\n"${gen.prompt.slice(0, 80)}"`),
        color: 'violet' as any,
        fill: 'semi' as const,
        dash: 'dashed' as const,
      },
    }])

    onThinkingStart({ id: thinkingId, x: vidX, y: vidY, w: gen.w, h: gen.h, prompt: gen.prompt, type: 'video' })

    startGeneration(
      {
        type: 'video', prompt: `Smooth cinematic camera movement. ${gen.prompt}`,
        x: vidX, y: vidY, image_url: gen.mediaUrl,
        model: settings.videoModel,
        duration: settings.videoDuration,
      },
      (status) => {
        if (status.status !== 'completed' && status.status !== 'failed') return
        onThinkingEnd(thinkingId)
        if (status.status === 'failed') {
          editor.updateShapes([{
            id: placeholderId, type: 'geo',
            props: { richText: toRichText(`❌ Video failed\n${status.error ?? ''}`), color: 'red' as any },
          }])
          return
        }
        editor.deleteShapes([placeholderId])
        if (status.url) {
          const videoId = createShapeId()
          const assetId = AssetRecordType.createId()
          editor.createAssets([{
            type: 'video', id: assetId, typeName: 'asset',
            props: { w: gen.w, h: gen.h, name: gen.prompt.slice(0, 40), isAnimated: true, mimeType: 'video/mp4', src: proxyUrl(status.url!) },
            meta: { originalUrl: status.url },
          }])
          editor.createShapes([{
            id: videoId, type: 'video', x: vidX, y: vidY, opacity: 0.4,
            props: { w: gen.w, h: gen.h, assetId, playing: true, url: '' },
          }])
          onGenerationComplete({
            shapeId: videoId as unknown as string,
            assetId: assetId as unknown as string,
            x: vidX, y: vidY, w: gen.w, h: gen.h,
            prompt: gen.prompt, mediaUrl: status.url, type: 'video',
          })
        }
      }
    )
  }

  if (thinkingPos.length === 0 && pendingPos.length === 0) return null

  return (
    <>
      <style>{STYLE}</style>
      <div style={styles.root}>

        {/* ── Thinking panels ── */}
        {thinkingPos.map((gen) => (
          <div
            key={gen.id}
            style={{ ...styles.panel, left: gen.vpX, top: gen.vpY - 48, transform: 'translateX(-50%)' }}
          >
            <span className="hf-dot" style={styles.dot} />
            <span style={styles.label}>
              {gen.type === 'image' ? '🖼' : '🎬'}&nbsp;
              <span style={{ color: '#e2d9f3' }}>Generating {gen.type}…</span>
            </span>
            <span style={styles.promptSnippet}>"{gen.prompt.slice(0, 48)}{gen.prompt.length > 48 ? '…' : ''}"</span>
          </div>
        ))}

        {/* ── Accept / Dismiss / Animate panels ── */}
        {pendingPos.map((pos) => (
          <div
            key={pos.shapeId}
            style={{ ...styles.panel, left: pos.vpX + pos.scaledW / 2, top: pos.vpY - 48, transform: 'translateX(-50%)' }}
          >
            <span style={styles.label}>
              {pos.type === 'image' ? '🖼' : '🎬'}&nbsp;
              <span style={{ color: '#a78bfa' }}>{pos.type === 'image' ? 'Image' : 'Video'} ready</span>
            </span>
            <button onClick={() => onApprove(pos.shapeId, pos.type)} style={btn('#22c55e')}>✓ Accept</button>
            <button onClick={() => onDismiss(pos.shapeId)} style={btn('#ef4444')}>✕ Dismiss</button>
            {pos.type === 'image' && (
              <button onClick={() => handleAnimate(pos)} style={btn('#7c3aed')}>▶ Animate</button>
            )}
          </div>
        ))}

      </div>
    </>
  )
}

function btn(color: string): CSSProperties {
  return {
    background: color,
    color: '#fff',
    border: 'none',
    borderRadius: '7px',
    padding: '5px 13px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'system-ui, sans-serif',
    whiteSpace: 'nowrap',
  }
}

const styles: Record<string, CSSProperties> = {
  root: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    zIndex: 300,
  },
  panel: {
    position: 'absolute',
    pointerEvents: 'all',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    background: 'rgba(10, 10, 22, 0.92)',
    border: '1px solid rgba(124, 58, 237, 0.5)',
    borderRadius: '12px',
    padding: '7px 14px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
    backdropFilter: 'blur(8px)',
    whiteSpace: 'nowrap',
  },
  dot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: '#a78bfa',
    flexShrink: 0,
    display: 'inline-block',
  },
  label: {
    fontSize: '12px',
    color: '#6b7280',
    fontFamily: 'system-ui, sans-serif',
    fontWeight: 500,
  },
  promptSnippet: {
    fontSize: '11px',
    color: '#6b7280',
    fontFamily: 'system-ui, sans-serif',
    fontStyle: 'italic',
    maxWidth: '200px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
}
