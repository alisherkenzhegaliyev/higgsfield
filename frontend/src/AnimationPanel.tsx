import type { CSSProperties } from 'react'
import { useState } from 'react'
import { useEditor, useValue, createShapeId, AssetRecordType, toRichText } from 'tldraw'
import { useGenerationContext } from './GenerationContext'
import { startGeneration, uploadLocalImage, proxyUrl } from './api'

export default function AnimationPanel() {
  const editor = useEditor()
  const { pendingGenerations, onThinkingStart, onThinkingEnd, onGenerationComplete } = useGenerationContext()

  const [expanded, setExpanded] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [videoModel, setVideoModel] = useState('dop_standard')
  const [duration, setDuration] = useState(5)
  const [uploading, setUploading] = useState(false)

  const selected = useValue(
    'selected-image',
    () => {
      const shapes = editor.getSelectedShapes()
      if (shapes.length !== 1) return null
      const shape = shapes[0]
      if (shape.type !== 'image') return null
      const props = shape.props as unknown as Record<string, unknown>
      const assetId = props.assetId
      if (!assetId) return null
      const asset = editor.getAsset(assetId as any)
      if (!asset) return null
      const src = (asset.props as any).src as string
      const originalUrl = (asset.meta as any)?.originalUrl as string | undefined
      const bounds = editor.getShapePageBounds(shape)
      if (!bounds) return null
      // Position below the image
      const vp = editor.pageToViewport({ x: bounds.midX, y: bounds.maxY })
      return {
        shapeId: shape.id as string,
        src,
        originalUrl,
        x: shape.x,
        y: shape.y,
        w: (props.w as number) ?? 640,
        h: (props.h as number) ?? 360,
        vpX: vp.x,
        vpY: vp.y,
      }
    },
    [editor]
  )

  // Don't show for images in the pending approval flow (they have their own Animate button)
  const isPending = selected ? pendingGenerations.some((g) => g.shapeId === selected.shapeId) : false

  if (!selected || isPending) return null

  const rawUrl = selected.originalUrl ?? selected.src
  const isLocal = rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')

  async function handleAnimate() {
    if (!selected) return
    setExpanded(false)

    let imageUrl = rawUrl
    if (isLocal) {
      setUploading(true)
      try {
        // blob: URLs must be read in-browser before sending to backend
        let dataUrl = rawUrl
        if (rawUrl.startsWith('blob:')) {
          const blob = await fetch(rawUrl).then((r) => r.blob())
          dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.readAsDataURL(blob)
          })
        }
        imageUrl = await uploadLocalImage(dataUrl)
      } catch (e: any) {
        setUploading(false)
        alert(`Failed to upload image: ${e.message}`)
        return
      }
      setUploading(false)
    }

    const vidX = selected.x + selected.w + 24
    const vidY = selected.y
    const thinkingId = `thinking-anim-${Date.now()}`
    const label = prompt.trim() || 'cinematic animation'

    const placeholderId = createShapeId()
    editor.createShapes([{
      id: placeholderId,
      type: 'geo',
      x: vidX, y: vidY,
      props: {
        geo: 'rectangle' as const,
        w: selected.w, h: selected.h,
        richText: toRichText(`Generating video…\n"${label.slice(0, 80)}"`),
        color: 'violet' as any,
        fill: 'semi' as const,
        dash: 'dashed' as const,
      },
    }])

    onThinkingStart({ id: thinkingId, x: vidX, y: vidY, w: selected.w, h: selected.h, prompt: label, type: 'video' })

    startGeneration(
      {
        type: 'video',
        prompt: prompt.trim() || 'smooth cinematic camera movement',
        x: vidX, y: vidY,
        image_url: imageUrl,
        model: videoModel,
        duration,
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
            props: { w: selected.w, h: selected.h, name: label.slice(0, 40), isAnimated: true, mimeType: 'video/mp4', src: proxyUrl(status.url!) },
            meta: { originalUrl: status.url },
          }])
          editor.createShapes([{
            id: videoId, type: 'video', x: vidX, y: vidY, opacity: 0.4,
            props: { w: selected.w, h: selected.h, assetId, playing: true, url: '' },
          }])
          onGenerationComplete({
            shapeId: videoId as unknown as string,
            assetId: assetId as unknown as string,
            x: vidX, y: vidY, w: selected.w, h: selected.h,
            prompt: label, mediaUrl: status.url, type: 'video',
          })
        }
      }
    )
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: selected.vpX,
        top: selected.vpY + 10,
        transform: 'translateX(-50%)',
        pointerEvents: 'all',
        zIndex: 400,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0px',
      }}
    >
      {/* Collapsed trigger button */}
      <button
        onClick={() => !uploading && setExpanded((v) => !v)}
        title={uploading ? 'Uploading image…' : 'Animate image'}
        style={{
          ...triggerBtn,
          cursor: uploading ? 'wait' : 'pointer',
          background: expanded ? '#7c3aed' : 'rgba(10,10,22,0.88)',
          borderColor: expanded ? '#7c3aed' : 'rgba(124,58,237,0.5)',
          color: expanded ? '#fff' : '#a78bfa',
        }}
      >
        {uploading ? '⏳' : '🎬'}
      </button>

      {/* Expanded panel */}
      {expanded && (
        <div style={panel}>
          {isLocal && (
            <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'system-ui' }}>
              📤 Local image — will be uploaded to a public host first
            </div>
          )}
          <input
            autoFocus
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAnimate()}
            placeholder="Describe the motion… (optional)"
            style={inputStyle}
          />
          <div style={{ display: 'flex', gap: '6px' }}>
            <select value={videoModel} onChange={(e) => setVideoModel(e.target.value)} style={selectStyle}>
              <option value="dop_standard">DoP Standard</option>
              <option value="dop_turbo">DoP Turbo</option>
              <option value="kling">Kling 3.0</option>
            </select>
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} style={selectStyle}>
              <option value={3}>3s</option>
              <option value={5}>5s</option>
              <option value={7}>7s</option>
              <option value={10}>10s</option>
            </select>
            <button onClick={handleAnimate} style={goBtn}>▶ Go</button>
          </div>
        </div>
      )}
    </div>
  )
}

const triggerBtn: CSSProperties = {
  border: '1px solid',
  borderRadius: '8px',
  width: '32px',
  height: '32px',
  fontSize: '15px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'system-ui',
  transition: 'background 0.15s, color 0.15s',
  boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
}

const panel: CSSProperties = {
  marginTop: '6px',
  background: 'rgba(10, 10, 22, 0.95)',
  border: '1px solid rgba(124, 58, 237, 0.5)',
  borderRadius: '10px',
  padding: '10px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: '7px',
  boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
  backdropFilter: 'blur(8px)',
  minWidth: '240px',
}

const inputStyle: CSSProperties = {
  background: '#0f172a',
  color: '#e0e0f0',
  border: '1px solid #334155',
  borderRadius: '6px',
  padding: '5px 8px',
  fontSize: '12px',
  fontFamily: 'system-ui, sans-serif',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}

const selectStyle: CSSProperties = {
  flex: 1,
  background: '#1e293b',
  color: '#cbd5e1',
  border: '1px solid #334155',
  borderRadius: '6px',
  padding: '4px 5px',
  fontSize: '11px',
  fontFamily: 'system-ui, sans-serif',
  cursor: 'pointer',
  outline: 'none',
  minWidth: 0,
}

const goBtn: CSSProperties = {
  background: '#7c3aed',
  color: '#fff',
  border: 'none',
  borderRadius: '6px',
  padding: '5px 12px',
  fontSize: '11px',
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'system-ui, sans-serif',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}
