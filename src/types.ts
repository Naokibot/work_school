import type { CardInput, Grade } from 'ts-fsrs'

export type CardSource = 'manual' | 'google-sheet'
export type ReviewSyncStatus = 'pending' | 'sent'
export type ChoicePosition = 1 | 2 | 3
export type StudyMode = 'scheduled' | 'due' | 'all' | 'forgotten' | 'marked'

export interface MemoryCard {
  id: string
  question: string
  correctAnswer: string
  distractors: [string, string]
  note: string
  deck: string
  tags: string[]
  source: CardSource
  sourceKey?: string
  sourceRow?: number
  createdAt: number
  updatedAt: number
  archived: boolean
  suspended: boolean
  marked: boolean
  buriedUntil?: number
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
  tags: string[]
  selectedChoice: ChoicePosition
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
  cardBefore?: SerializedFsrsCard
  cardUpdatedAtBefore?: number
}

export interface Settings {
  id: 'settings'
  autoSync: boolean
  newCardsPerDay: number
  questionTimerSeconds: number
  appsScriptUrl: string
  accessToken: string
  detailedReviewLogging: boolean
  autoSuspendLeeches: boolean
  leechThreshold: number
  lastSyncAt?: number
  lastSyncMessage?: string
}

export interface SheetRow {
  row: number
  question: string
  correctAnswer: string
  distractors: [string, string]
  tags: string[]
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
  tags: string[]
  correct: boolean
  responseSeconds: number
  fsrsRating: number
  question?: string
  selectedAnswer?: string
}

export type FsrsCardInput = CardInput
