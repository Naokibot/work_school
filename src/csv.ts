import { createSchedule } from './scheduler'
import type { MemoryCard } from './types'

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        value += char
      }
      continue
    }

    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(value)
      value = ''
    } else if (char === '\n') {
      row.push(value.replace(/\r$/, ''))
      rows.push(row)
      row = []
      value = ''
    } else {
      value += char
    }
  }

  if (quoted) throw new Error('CSVの引用符が閉じられていません。')
  if (value.length > 0 || row.length > 0) {
    row.push(value.replace(/\r$/, ''))
    rows.push(row)
  }
  return rows
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

export function importCardsFromCsv(text: string): MemoryCard[] {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ''))
  if (rows.length === 0) return []

  let start = 0
  const first = rows[0]?.map((value) => value.trim().toLowerCase()) ?? []
  if (['front', '問題', '単語', 'question'].includes(first[0] ?? '') && ['back', '答え', '意味', 'answer'].includes(first[1] ?? '')) {
    start = 1
  }

  const now = Date.now()
  return rows.slice(start).flatMap((row): MemoryCard[] => {
    const front = (row[0] ?? '').trim()
    const back = (row[1] ?? '').trim()
    if (!front || !back) return []

    const deck = (row[2] ?? '').trim() || 'CSV'
    const tags = (row[3] ?? '')
      .split(/[|;]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
    const note = (row[4] ?? '').trim()

    return [{
      id: crypto.randomUUID(),
      front,
      back,
      note,
      deck,
      tags,
      source: 'manual',
      createdAt: now,
      updatedAt: now,
      archived: false,
      fsrs: createSchedule(new Date(now)),
    }]
  })
}

export function exportCardsToCsv(cards: MemoryCard[]): string {
  const lines = [['front', 'back', 'deck', 'tags', 'note'].map(csvCell).join(',')]
  cards.filter((card) => !card.archived).forEach((card) => {
    lines.push([
      card.front,
      card.back,
      card.deck,
      card.tags.join('|'),
      card.note,
    ].map(csvCell).join(','))
  })
  return `\uFEFF${lines.join('\r\n')}`
}
