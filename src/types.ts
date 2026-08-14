import type { CardInput, Grade } from 'ts-fsrs'

export type CardSource = 'manual' | 'google-sheet'

export interface MemoryCard {
  id: string
  front: string
  back: string
  note: string
  deck: string
  tags: string[]
  source: CardSource
  sourceKey?: string
  sourceSheetId?: string
  sourceGid?: string
  sourceRow?: number
  createdAt: number
  updatedAt: number
  archived: boolean
  fsrs: SerializedFsrsCard
}

export interface SerializedFsrsCard {
  due: number
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: number
  last_review?: number
}

export interface ReviewRecord {
  id: string
  cardId: string
  rating: Grade
  reviewedAt: number
  scheduledDays: number
  elapsedDays: number
  stateBefore: number
  stateAfter: number
}

export interface Settings {
  id: 'settings'
  sheetId: string
  sheetGid: string
  autoSync: boolean
  lastSyncAt?: number
  lastSyncMessage?: string
}

export interface SheetRow {
  row: number
  front: string
  back: string
}

export interface SyncSummary {
  created: number
  updated: number
  unchanged: number
  skipped: number
  totalRows: number
}

export type FsrsCardInput = CardInput
