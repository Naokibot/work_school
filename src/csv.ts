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
      } else if (char === '"') quoted = false
      else value += char
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
    const correctAnswer = (row[1] ?? '').trim()
    const wrongAnswer1 = (row[2] ?? '').trim()
    const wrongAnswer2 = (row[3] ?? '').trim()
    if (!question || !correctAnswer || !wrongAnswer1 || !wrongAnswer2) return []

    const tags = (row[4] ?? '').split(/[,|;]/).map((tag) => tag.trim()).filter(Boolean)
    const deck = (row[5] ?? '').trim() || 'CSV'
    const note = (row[6] ?? '').trim()

    return [{
      id: crypto.randomUUID(),
      question,
      correctAnswer,
      distractors: [wrongAnswer1, wrongAnswer2],
      note,
      deck,
      tags: [...new Set(tags)],
      source: 'manual',
      createdAt: now,
      updatedAt: now,
      archived: false,
      suspended: false,
      marked: false,
      fsrs: createSchedule(new Date(now)),
    }]
  })
}

export function exportCardsToCsv(cards: MemoryCard[]): string {
  const header = ['question', 'correct_answer', 'wrong_answer1', 'wrong_answer2', 'tags', 'deck', 'note']
  const lines = [header.map(csvCell).join(',')]
  cards.filter((card) => !card.archived).forEach((card) => {
    lines.push([
      card.question,
      card.correctAnswer,
      card.distractors[0],
      card.distractors[1],
      card.tags.join('|'),
      card.deck,
      card.note,
    ].map(csvCell).join(','))
  })
  return `\uFEFF${lines.join('\r\n')}`
}
