import type { MemoryCard, ReviewRecord, Settings } from './types'

const DB_NAME = 'work-school-memory'
const DB_VERSION = 2
const CARD_STORE = 'cards'
const REVIEW_STORE = 'reviews'
const SETTINGS_STORE = 'settings'

const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  autoSync: false,
  newCardsPerDay: 20,
  questionTimerSeconds: 180,
  appsScriptUrl: '',
  accessToken: '',
  detailedReviewLogging: false,
  autoSuspendLeeches: true,
  leechThreshold: 8,
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(String).map((tag) => tag.trim()).filter(Boolean))]
}

function normalizeCard(raw: unknown): MemoryCard {
  const source = raw as Partial<MemoryCard> & {
    front?: string
    back?: string
    choices?: string[]
    distractors?: string[]
  }
  const legacyChoices = Array.isArray(source.choices) ? source.choices : []
  const rawDistractors = Array.isArray(source.distractors) ? source.distractors : legacyChoices.slice(1, 3)
  const buriedUntil = Number(source.buriedUntil)

  return {
    ...(source as MemoryCard),
    id: String(source.id ?? crypto.randomUUID()),
    question: String(source.question ?? source.front ?? '').trim(),
    correctAnswer: String(source.correctAnswer ?? legacyChoices[0] ?? source.back ?? '').trim(),
    distractors: [
      String(rawDistractors[0] ?? '').trim(),
      String(rawDistractors[1] ?? '').trim(),
    ],
    note: String(source.note ?? ''),
    deck: String(source.deck ?? '一般'),
    tags: normalizeTags(source.tags),
    source: source.source === 'google-sheet' ? 'google-sheet' : 'manual',
    createdAt: Number(source.createdAt) || Date.now(),
    updatedAt: Number(source.updatedAt) || Date.now(),
    archived: Boolean(source.archived),
    suspended: Boolean(source.suspended),
    marked: Boolean(source.marked),
    buriedUntil: Number.isFinite(buriedUntil) && buriedUntil > 0 ? buriedUntil : undefined,
  }
}

function normalizeReview(raw: unknown): ReviewRecord {
  const source = raw as Partial<ReviewRecord> & { selectedChoice?: number }
  const legacyCorrect = Number(source.rating) >= 3
  const selected = Number(source.selectedChoice)
  const selectedChoice = ([1, 2, 3].includes(selected) ? selected : 1) as 1 | 2 | 3
  return {
    ...(source as ReviewRecord),
    question: String(source.question ?? ''),
    tags: normalizeTags(source.tags),
    selectedChoice,
    selectedAnswer: String(source.selectedAnswer ?? ''),
    correct: typeof source.correct === 'boolean' ? source.correct : legacyCorrect,
    elapsedMs: Number.isFinite(source.elapsedMs) ? Number(source.elapsedMs) : 0,
    sheetSyncStatus: source.sheetSyncStatus === 'sent' ? 'sent' : 'pending',
  }
}

function normalizeSettings(raw: unknown): Settings {
  const source = (raw ?? {}) as Partial<Settings> & {
    reviewWebAppUrl?: string
    reviewWriteToken?: string
  }
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    id: 'settings',
    appsScriptUrl: String(source.appsScriptUrl ?? source.reviewWebAppUrl ?? ''),
    accessToken: String(source.accessToken ?? source.reviewWriteToken ?? ''),
    detailedReviewLogging: Boolean(source.detailedReviewLogging),
    autoSuspendLeeches: source.autoSuspendLeeches !== false,
    leechThreshold: Math.min(50, Math.max(2, Number(source.leechThreshold) || 8)),
  }
}

export async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      const tx = request.transaction
      if (!tx) return

      if (!db.objectStoreNames.contains(CARD_STORE)) {
        const cards = db.createObjectStore(CARD_STORE, { keyPath: 'id' })
        cards.createIndex('due', 'fsrs.due')
        cards.createIndex('sourceKey', 'sourceKey', { unique: false })
        cards.createIndex('updatedAt', 'updatedAt')
      }

      if (!db.objectStoreNames.contains(REVIEW_STORE)) {
        const reviews = db.createObjectStore(REVIEW_STORE, { keyPath: 'id' })
        reviews.createIndex('cardId', 'cardId')
        reviews.createIndex('reviewedAt', 'reviewedAt')
        reviews.createIndex('sheetSyncStatus', 'sheetSyncStatus')
      } else {
        const reviews = tx.objectStore(REVIEW_STORE)
        if (!reviews.indexNames.contains('sheetSyncStatus')) {
          reviews.createIndex('sheetSyncStatus', 'sheetSyncStatus')
        }
      }

      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: 'id' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'))
  })
}

export async function getAllCards(): Promise<MemoryCard[]> {
  const db = await openDatabase()
  const tx = db.transaction(CARD_STORE, 'readonly')
  const cards = await requestToPromise(tx.objectStore(CARD_STORE).getAll())
  await transactionDone(tx)
  db.close()
  return (cards as unknown[]).map(normalizeCard)
}

export async function putCard(card: MemoryCard): Promise<void> {
  const db = await openDatabase()
  const tx = db.transaction(CARD_STORE, 'readwrite')
  tx.objectStore(CARD_STORE).put(card)
  await transactionDone(tx)
  db.close()
}

export async function putCards(cards: MemoryCard[]): Promise<void> {
  if (cards.length === 0) return
  const db = await openDatabase()
  const tx = db.transaction(CARD_STORE, 'readwrite')
  const store = tx.objectStore(CARD_STORE)
  cards.forEach((card) => store.put(card))
  await transactionDone(tx)
  db.close()
}

export async function saveReviewResult(card: MemoryCard, review: ReviewRecord): Promise<void> {
  const db = await openDatabase()
  const tx = db.transaction([CARD_STORE, REVIEW_STORE], 'readwrite')
  tx.objectStore(CARD_STORE).put(card)
  tx.objectStore(REVIEW_STORE).put(review)
  await transactionDone(tx)
  db.close()
}

export async function undoPendingReview(id: string): Promise<MemoryCard | null> {
  const db = await openDatabase()
  const tx = db.transaction([CARD_STORE, REVIEW_STORE], 'readwrite')
  const reviewStore = tx.objectStore(REVIEW_STORE)
  const cardStore = tx.objectStore(CARD_STORE)
  const rawReview = await requestToPromise(reviewStore.get(id))
  if (!rawReview) {
    tx.abort()
    db.close()
    return null
  }
  const review = normalizeReview(rawReview)
  if (review.sheetSyncStatus === 'sent' || !review.cardBefore) {
    tx.abort()
    db.close()
    return null
  }
  const rawCard = await requestToPromise(cardStore.get(review.cardId))
  if (!rawCard) {
    tx.abort()
    db.close()
    return null
  }
  const current = normalizeCard(rawCard)
  const restored: MemoryCard = {
    ...current,
    fsrs: review.cardBefore,
    updatedAt: review.cardUpdatedAtBefore ?? current.updatedAt,
  }
  cardStore.put(restored)
  reviewStore.delete(review.id)
  await transactionDone(tx)
  db.close()
  return restored
}

export async function markReviewSent(id: string): Promise<void> {
  const db = await openDatabase()
  const tx = db.transaction(REVIEW_STORE, 'readwrite')
  const store = tx.objectStore(REVIEW_STORE)
  const raw = await requestToPromise(store.get(id))
  if (raw) store.put({ ...raw, sheetSyncStatus: 'sent' })
  await transactionDone(tx)
  db.close()
}

export async function deleteCard(id: string): Promise<void> {
  const db = await openDatabase()
  const tx = db.transaction([CARD_STORE, REVIEW_STORE], 'readwrite')
  tx.objectStore(CARD_STORE).delete(id)
  const reviewIndex = tx.objectStore(REVIEW_STORE).index('cardId')
  const cursorRequest = reviewIndex.openKeyCursor(IDBKeyRange.only(id))
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result
    if (cursor) {
      tx.objectStore(REVIEW_STORE).delete(cursor.primaryKey)
      cursor.continue()
    }
  }
  await transactionDone(tx)
  db.close()
}

export async function getAllReviews(): Promise<ReviewRecord[]> {
  const db = await openDatabase()
  const tx = db.transaction(REVIEW_STORE, 'readonly')
  const reviews = await requestToPromise(tx.objectStore(REVIEW_STORE).getAll())
  await transactionDone(tx)
  db.close()
  return (reviews as unknown[]).map(normalizeReview)
}

export async function getPendingReviews(): Promise<ReviewRecord[]> {
  const reviews = await getAllReviews()
  return reviews.filter((review) => review.sheetSyncStatus !== 'sent')
}

export async function getSettings(): Promise<Settings> {
  const db = await openDatabase()
  const tx = db.transaction(SETTINGS_STORE, 'readonly')
  const stored = await requestToPromise(tx.objectStore(SETTINGS_STORE).get('settings'))
  await transactionDone(tx)
  db.close()
  return normalizeSettings(stored)
}

export async function saveSettings(settings: Settings): Promise<void> {
  const db = await openDatabase()
  const tx = db.transaction(SETTINGS_STORE, 'readwrite')
  tx.objectStore(SETTINGS_STORE).put(settings)
  await transactionDone(tx)
  db.close()
}

export async function exportBackup(): Promise<string> {
  const [cards, reviews, settings] = await Promise.all([getAllCards(), getAllReviews(), getSettings()])
  const safeSettings = { ...settings, accessToken: '' }
  return JSON.stringify({ version: 3, exportedAt: Date.now(), cards, reviews, settings: safeSettings }, null, 2)
}

export async function importBackup(raw: string): Promise<void> {
  const parsed = JSON.parse(raw) as {
    version?: number
    cards?: unknown[]
    reviews?: unknown[]
    settings?: unknown
  }
  if (![1, 2, 3].includes(parsed.version ?? 0) || !Array.isArray(parsed.cards) || !Array.isArray(parsed.reviews)) {
    throw new Error('このバックアップ形式には対応していません。')
  }

  const importedSettings = normalizeSettings(parsed.settings)
  importedSettings.accessToken = ''

  const db = await openDatabase()
  const tx = db.transaction([CARD_STORE, REVIEW_STORE, SETTINGS_STORE], 'readwrite')
  const cardStore = tx.objectStore(CARD_STORE)
  const reviewStore = tx.objectStore(REVIEW_STORE)
  cardStore.clear()
  reviewStore.clear()
  parsed.cards.map(normalizeCard).forEach((card) => cardStore.put(card))
  parsed.reviews.map(normalizeReview).forEach((review) => reviewStore.put(review))
  tx.objectStore(SETTINGS_STORE).put(importedSettings)
  await transactionDone(tx)
  db.close()
}
