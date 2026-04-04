import { createContext, useContext } from 'react'

export type PendingGeneration = {
  shapeId: string
  assetId: string
  x: number
  y: number
  w: number
  h: number
  prompt: string
  mediaUrl: string
  type: 'image' | 'video'
}

export type ThinkingGeneration = {
  id: string
  x: number
  y: number
  w: number
  h: number
  prompt: string
  type: 'image' | 'video'
}

type GenerationContextType = {
  pendingGenerations: PendingGeneration[]
  thinkingGenerations: ThinkingGeneration[]
  onGenerationComplete: (gen: PendingGeneration) => void
  onThinkingStart: (gen: ThinkingGeneration) => void
  onThinkingEnd: (id: string) => void
  onApprove: (shapeId: string, type: 'image' | 'video') => void
  onDismiss: (shapeId: string) => void
}

export const GenerationContext = createContext<GenerationContextType | null>(null)

export function useGenerationContext() {
  const ctx = useContext(GenerationContext)
  if (!ctx) throw new Error('useGenerationContext used outside GenerationContext.Provider')
  return ctx
}
