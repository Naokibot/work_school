import type { MemoryCard, ReviewRecord, Settings } from './types'

const DB_NAME = 'work-school-memory'
const DB_VERSION = 1
const CARD_STORE = 'cards'
const REVIEW_STORE = 'reviews'
const SETTINGS_STORE = 'settings'

const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  sheetId: '147eZ_4pocwkxQSs3QRC0SevZaojcdwK8V7777td_xos',
  sheetGid: '0',
  autoSync: true,
  newCardsPerDay: 20,
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

export async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(CARD_STORE)) {
        const cards = db.createObjectStore(CARD_STORE, { keyPath: 'id' })
        cards.createIndex('due', 'fsrs.due')
        cards.createIndex('sourceKey', 'sourceKey', { unique: false })
        cards.createIndex('sourceSheetId', 'sourceSheetId', { unique: false })
        cards.createIndex('updatedAt', 'updatedAt')
      }

      if (!db.objectStoreNames.contains(REVIEW_STORE)) {
        const reviews = db.createObjectStore(REVIEW_STORE, { keyPath: 'id' })
        reviews.createIndex('cardId', 'cardId')
        reviews.createIndex('reviewedAt', 'reviewedAt')
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
  return cards as MemoryCard[]
}

export async function getCard(id: string): Promise<MemoryCard | undefined> {
  const db = await openDatabase()
  const tx = db.transaction(CARD_STORE, 'readonly')
  const card = await requestToPromise(tx.objectStore(CARD_STORE).get(id))
  await transactionDone(tx)
  db.close()
  return card as MemoryCard | undefined
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

export async function deleteCard(id: string): Promise<void> {
  const db = await openDatabase()
  const tx = db.transaction([CARD_STORE, REVIEW_STORE], 'readwrite')
  tx.objectStore(CARD_STORE).delete(id)

  const reviewIndex = tx.objectStore(REVIEW_STORE).index('cardId')
  const range = IDBKeyRange.only(id)
  const cursorRequest = reviewIndex.openKeyCursor(range)
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
  return reviews as ReviewRecord[]
}

export async function getSettings(): Promise<Settings> {
  const db = await openDatabase()
  const tx = db.transaction(SETTINGS_STORE, 'readonly')
  const stored = await requestToPromise(tx.objectStore(SETTINGS_STORE).get('settings'))
  await transactionDone(tx)
  db.close()
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings> | undefined) }
}

export async function saveSettings(settings: Settings): Promise<void> {
  const db = await openDatabase()
  const tx = db.transaction(SETTINGS_STORE, 'readwrite')
  tx.objectStore(SETTINGS_STORE).put(settings)
  await transactionDone(tx)
  db.close()
}

export async function exportBackup(): Promise<string> {
  const [cards, reviews, settings] = await Promise.all([
    getAllCards(),
    getAllReviews(),
    getSettings(),
  ])
  return JSON.stringify({ version: 1, exportedAt: Date.now(), cards, reviews, settings }, null, 2)
}

export async function importBackup(raw: string): Promise<void> {
  const parsed = JSON.parse(raw) as {
    version?: number
    cards?: MemoryCard[]
    reviews?: ReviewRecord[]
    settings?: Settings
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.cards) || !Array.isArray(parsed.reviews)) {
    throw new Error('このバックアップ形式には対応していません。')
  }

  const db = await openDatabase()
  const tx = db.transaction([CARD_STORE, REVIEW_STORE, SETTINGS_STORE], 'readwrite')
  const cardStore = tx.objectStore(CARD_STORE)
  const reviewStore = tx.objectStore(REVIEW_STORE)
  cardStore.clear()
  reviewStore.clear()
  parsed.cards.forEach((card) => cardStore.put(card))
  parsed.reviews.forEach((review) => reviewStore.put(review))
  if (parsed.settings) tx.objectStore(SETTINGS_STORE).put(parsed.settings)
  await transactionDone(tx)
  db.close()
}
