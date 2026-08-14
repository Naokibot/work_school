import type { CardInput, Grade } from 'ts-fsrs'

export type CardSource = 'manual' | 'google-sheet'
export type ReviewSyncStatus = 'pending' | 'sent'

export interface MemoryCard {
  id: string
  question: string
  choices: [string, string, string, string]
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
  question: string
  selectedChoice: 1 | 2 | 3 | 4
  selectedAnswer: string
  correct: boolean
  elapsedMs: number
  rating: Grade
  reviewedAt: number
  scheduledDays: number
  elapsedDays: number
  stateBefore: number
  stateAfter: number
  sheetSyncStatus: ReviewSyncStatus
}

export interface Settings {
  id: 'settings'
  sheetId: string
  sheetGid: string
  autoSync: boolean
  newCardsPerDay: number
  questionTimerSeconds: number
  reviewWebAppUrl: string
  reviewWriteToken: string
  lastSyncAt?: number
  lastSyncMessage?: string
}

export interface SheetRow {
  row: number
  question: string
  choices: [string, string, string, string]
}

export interface SyncSummary {
  created: number
  updated: number
  unchanged: number
  skipped: number
  totalRows: number
}

export interface ReviewSubmission {
  reviewId: string
  reviewedAt: string
  cardId: string
  question: string
  selectedChoice: number
  selectedAnswer: string
  correct: boolean
  responseSeconds: number
  fsrsRating: number
}

export type FsrsCardInput = CardInput
