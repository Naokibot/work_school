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
    if (char === '"') quoted = true
    else if (char === ',') {
      row.push(value)
      value = ''
    } else if (char === '\n') {
      row.push(value.replace(/\r$/, ''))
      rows.push(row)
      row = []
      value = ''
    } else value += char
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
  if (['question', '問題', '問題文'].includes(first[0] ?? '')) start = 1

  const now = Date.now()
  return rows.slice(start).flatMap((row): MemoryCard[] => {
    const question = (row[0] ?? '').trim()
    const choices: [string, string, string, string] = [
      (row[1] ?? '').trim(),
      (row[2] ?? '').trim(),
      (row[3] ?? '').trim(),
      (row[4] ?? '').trim(),
    ]
    if (!question || choices.some((choice) => !choice)) return []

    const deck = (row[5] ?? '').trim() || 'CSV'
    const tags = (row[6] ?? '').split(/[|;]/).map((tag) => tag.trim()).filter(Boolean)
    const note = (row[7] ?? '').trim()

    return [{
      id: crypto.randomUUID(),
      question,
      choices,
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
  const header = ['question', 'answer1', 'answer2', 'answer3', 'answer4', 'deck', 'tags', 'note']
  const lines = [header.map(csvCell).join(',')]
  cards.filter((card) => !card.archived).forEach((card) => {
    lines.push([
      card.question,
      ...card.choices,
      card.deck,
      card.tags.join('|'),
      card.note,
    ].map(csvCell).join(','))
  })
  return `\uFEFF${lines.join('\r\n')}`
}
