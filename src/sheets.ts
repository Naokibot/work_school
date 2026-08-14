import { getAllCards, getSettings, putCards, saveSettings } from './db'
import { createSchedule } from './scheduler'
import type { MemoryCard, SheetRow, SyncSummary } from './types'

interface ApiCard {
  row?: unknown
  question?: unknown
  correctAnswer?: unknown
  wrongAnswer1?: unknown
  wrongAnswer2?: unknown
  tags?: unknown
}

interface CardsResponse {
  ok?: boolean
  error?: string
  cards?: ApiCard[]
}

const CALLBACK_PREFIX = '__workSchoolCards_'

function isWebAppUrl(value: string): boolean {
  return /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/.test(value)
}

function normalizeTags(value: unknown): string[] {
  const source = Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[,;|]/)
  return [...new Set(source.map((tag) => tag.trim()).filter(Boolean))]
}

function loadCards(webAppUrl: string, token: string): Promise<CardsResponse> {
  return new Promise((resolve, reject) => {
    const callbackName = `${CALLBACK_PREFIX}${crypto.randomUUID().replace(/-/g, '')}`
    const target = window as unknown as Record<string, unknown>
    const script = document.createElement('script')
    let settled = false

    const finish = (result: CardsResponse | null, error?: Error) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      delete target[callbackName]
      script.remove()
      if (error) reject(error)
      else resolve(result ?? { ok: false, error: 'empty_response' })
    }

    const timeout = window.setTimeout(
      () => finish(null, new Error('暗記カードの読み込みがタイムアウトしました。')),
      15_000,
    )

    target[callbackName] = (result: CardsResponse) => finish(result)
    const url = new URL(webAppUrl)
    url.searchParams.set('action', 'cards')
    url.searchParams.set('token', token)
    url.searchParams.set('callback', callbackName)
    url.searchParams.set('_', String(Date.now()))
    script.src = url.toString()
    script.async = true
    script.onerror = () => finish(null, new Error('暗記カードを読み込めません。Apps Scriptの設定を確認してください。'))
    document.head.appendChild(script)
  })
}

function parseRows(response: CardsResponse): { rows: SheetRow[]; skipped: number } {
  if (response.ok !== true) {
    if (response.error === 'unauthorized') throw new Error('ACCESS_TOKENが一致しません。')
    throw new Error('Apps Scriptから暗記カードを取得できませんでした。')
  }

  const rows: SheetRow[] = []
  let skipped = 0
  for (const item of response.cards ?? []) {
    const row = Number(item.row)
    const question = String(item.question ?? '').trim()
    const correctAnswer = String(item.correctAnswer ?? '').trim()
    const wrongAnswer1 = String(item.wrongAnswer1 ?? '').trim()
    const wrongAnswer2 = String(item.wrongAnswer2 ?? '').trim()
    if (!Number.isInteger(row) || row < 1 || !question || !correctAnswer || !wrongAnswer1 || !wrongAnswer2) {
      skipped += 1
      continue
    }
    rows.push({
      row,
      question,
      correctAnswer,
      distractors: [wrongAnswer1, wrongAnswer2],
      tags: normalizeTags(item.tags),
    })
  }
  return { rows, skipped }
}

function sourceKey(row: number): string {
  return `google-sheet:row:${row}`
}

function sameContent(card: MemoryCard, row: SheetRow): boolean {
  if (card.question !== row.question || card.correctAnswer !== row.correctAnswer) return false
  if (!card.distractors.every((choice, index) => choice === row.distractors[index])) return false
  const left = [...card.tags].sort().join('\u0000')
  const right = [...row.tags].sort().join('\u0000')
  return left === right
}

export async function fetchSheetRows(): Promise<{ rows: SheetRow[]; skipped: number }> {
  const settings = await getSettings()
  if (!settings.appsScriptUrl || !settings.accessToken) {
    throw new Error('設定でApps Script URLとACCESS_TOKENを入力してください。')
  }
  if (!isWebAppUrl(settings.appsScriptUrl)) {
    throw new Error('Apps Script Web App URLが正しくありません。')
  }
  return parseRows(await loadCards(settings.appsScriptUrl, settings.accessToken))
}

export async function syncGoogleSheet(): Promise<SyncSummary> {
  const settings = await getSettings()
  const loaded = await fetchSheetRows()
  const rows = loaded.rows
  const existing = await getAllCards()
  const sheetCards = existing.filter((card) => card.source === 'google-sheet')

  const unused = new Set(sheetCards.map((card) => card.id))
  const bySourceKey = new Map(sheetCards.filter((card) => card.sourceKey).map((card) => [card.sourceKey!, card]))
  const toSave: MemoryCard[] = []
  const now = Date.now()
  const summary: SyncSummary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: loaded.skipped,
    totalRows: rows.length + loaded.skipped,
  }

  for (const row of rows) {
    const key = sourceKey(row.row)
    let matched = sheetCards.find((card) => unused.has(card.id) && sameContent(card, row))
    if (!matched) {
      const rowMatch = bySourceKey.get(key)
      if (rowMatch && unused.has(rowMatch.id)) matched = rowMatch
    }

    if (matched) {
      unused.delete(matched.id)
      const changed = !sameContent(matched, row) || matched.sourceKey !== key || matched.sourceRow !== row.row
      if (changed) {
        toSave.push({
          ...matched,
          question: row.question,
          correctAnswer: row.correctAnswer,
          distractors: row.distractors,
          tags: row.tags,
          sourceKey: key,
          sourceRow: row.row,
          updatedAt: now,
          archived: false,
        })
        summary.updated += 1
      } else {
        summary.unchanged += 1
      }
      continue
    }

    toSave.push({
      id: crypto.randomUUID(),
      question: row.question,
      correctAnswer: row.correctAnswer,
      distractors: row.distractors,
      note: '',
      deck: 'Google Sheets',
      tags: row.tags,
      source: 'google-sheet',
      sourceKey: key,
      sourceRow: row.row,
      createdAt: now,
      updatedAt: now,
      archived: false,
      suspended: false,
      marked: false,
      fsrs: createSchedule(new Date(now)),
    })
    summary.created += 1
  }

  await putCards(toSave)
  await saveSettings({
    ...settings,
    lastSyncAt: now,
    lastSyncMessage: `${summary.created}件追加・${summary.updated}件更新・${summary.skipped}件スキップ`,
  })
  return summary
}
