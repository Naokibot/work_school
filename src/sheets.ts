import { getAllCards, getSettings, putCards, saveSettings } from './db'
import { createSchedule } from './scheduler'
import type { MemoryCard, SheetRow, SyncSummary } from './types'

interface GvizCell {
  v?: unknown
  f?: string
}

interface GvizResponse {
  status?: string
  errors?: Array<{ message?: string; detailed_message?: string }>
  table?: {
    rows?: Array<{ c?: Array<GvizCell | null> }>
  }
}

const CALLBACK_PREFIX = '__workSchoolSheetCallback_'

function asCellText(cell: GvizCell | null | undefined): string {
  if (!cell) return ''
  if (typeof cell.f === 'string') return cell.f.trim()
  if (cell.v === null || cell.v === undefined) return ''
  return String(cell.v).trim()
}

function isHeaderRow(front: string, back: string): boolean {
  const f = front.replace(/\s/g, '').toLowerCase()
  const b = back.replace(/\s/g, '').toLowerCase()
  return (
    (['問題', 'question', 'front'].includes(f) && ['答え', '回答', 'answer', 'back'].includes(b)) ||
    (f === '単語' && ['意味', '答え'].includes(b))
  )
}

function parseRows(response: GvizResponse): SheetRow[] {
  if (response.status && response.status !== 'ok') {
    const detail = response.errors?.map((error) => error.detailed_message || error.message).filter(Boolean).join(' / ')
    throw new Error(detail || 'Googleスプレッドシートの読み込みに失敗しました。')
  }

  const rows = response.table?.rows ?? []
  const parsed: SheetRow[] = []

  rows.forEach((row, index) => {
    const front = asCellText(row.c?.[0])
    const back = asCellText(row.c?.[1])
    const rowNumber = index + 1

    if (!front && !back) return
    if (rowNumber === 1 && isHeaderRow(front, back)) return
    if (!front || !back) return
    parsed.push({ row: rowNumber, front, back })
  })

  return parsed
}

function loadViaScriptInjection(sheetId: string, gid: string): Promise<GvizResponse> {
  return new Promise((resolve, reject) => {
    const callbackName = `${CALLBACK_PREFIX}${crypto.randomUUID().replace(/-/g, '')}`
    const callbackWindow = window as unknown as Record<string, unknown>
    const script = document.createElement('script')
    let settled = false

    const cleanup = () => {
      delete callbackWindow[callbackName]
      script.remove()
    }

    const timeout = window.setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Googleスプレッドシートへの接続がタイムアウトしました。'))
    }, 15_000)

    callbackWindow[callbackName] = (response: GvizResponse) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      cleanup()
      resolve(response)
    }

    script.onerror = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      cleanup()
      reject(new Error('Googleスプレッドシートを読み込めません。共有設定と通信状態を確認してください。'))
    }

    const params = new URLSearchParams({
      gid,
      headers: '0',
      tq: 'select A, B',
      tqx: `out:json;responseHandler:${callbackName}`,
    })
    script.src = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?${params.toString()}`
    script.async = true
    document.head.appendChild(script)
  })
}

function sourceKey(sheetId: string, gid: string, row: number): string {
  return `google-sheet:${sheetId}:${gid}:row:${row}`
}

function sameContent(card: MemoryCard, row: SheetRow): boolean {
  return card.front === row.front && card.back === row.back
}

export async function fetchSheetRows(sheetId: string, gid: string): Promise<SheetRow[]> {
  if (!/^[\w-]+$/.test(sheetId) || !/^\d+$/.test(gid)) {
    throw new Error('スプレッドシートIDまたはgidが正しくありません。')
  }
  return parseRows(await loadViaScriptInjection(sheetId, gid))
}

export async function syncGoogleSheet(): Promise<SyncSummary> {
  const settings = await getSettings()
  const rows = await fetchSheetRows(settings.sheetId, settings.sheetGid)
  const existing = await getAllCards()
  const sheetCards = existing.filter(
    (card) => card.source === 'google-sheet' && card.sourceSheetId === settings.sheetId && card.sourceGid === settings.sheetGid,
  )

  const unused = new Set(sheetCards.map((card) => card.id))
  const bySourceKey = new Map(sheetCards.filter((card) => card.sourceKey).map((card) => [card.sourceKey!, card]))
  const toSave: MemoryCard[] = []
  const now = Date.now()
  const summary: SyncSummary = { created: 0, updated: 0, unchanged: 0, skipped: 0, totalRows: rows.length }

  for (const row of rows) {
    const key = sourceKey(settings.sheetId, settings.sheetGid, row.row)

    // First preserve learning history across row insertions/sorting by matching unchanged content.
    let matched = sheetCards.find((card) => unused.has(card.id) && sameContent(card, row))

    // If the content was edited in place, fall back to the row identity.
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
          front: row.front,
          back: row.back,
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
      front: row.front,
      back: row.back,
      note: '',
      deck: 'Google Sheets',
      tags: [],
      source: 'google-sheet',
      sourceKey: key,
      sourceSheetId: settings.sheetId,
      sourceGid: settings.sheetGid,
      sourceRow: row.row,
      createdAt: now,
      updatedAt: now,
      archived: false,
      fsrs: createSchedule(new Date(now)),
    })
    summary.created += 1
  }

  await putCards(toSave)
  await saveSettings({
    ...settings,
    lastSyncAt: now,
    lastSyncMessage: `${summary.created}件追加・${summary.updated}件更新`,
  })

  return summary
}
