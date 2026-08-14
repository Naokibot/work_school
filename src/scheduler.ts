import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from 'ts-fsrs'
import type { MemoryCard, ReviewRecord, SerializedFsrsCard } from './types'

const scheduler = fsrs({
  request_retention: 0.9,
  maximum_interval: 36500,
  enable_fuzz: true,
  enable_short_term: true,
  learning_steps: ['1m', '10m'],
  relearning_steps: ['10m'],
})

function serialize(card: Card): SerializedFsrsCard {
  return {
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review?.getTime(),
  }
}

function deserialize(card: SerializedFsrsCard): Card {
  return {
    due: new Date(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as State,
    last_review: card.last_review ? new Date(card.last_review) : undefined,
  }
}

export function createSchedule(now = new Date()): SerializedFsrsCard {
  return serialize(createEmptyCard(now))
}

export function reviewCard(
  card: MemoryCard,
  correct: boolean,
  selectedChoice: 1 | 2 | 3 | 4,
  elapsedMs: number,
  now = new Date(),
): { card: MemoryCard; review: ReviewRecord } {
  const before = deserialize(card.fsrs)
  const grade: Grade = correct ? Rating.Good : Rating.Again
  const result = scheduler.next(before, now, grade)

  return {
    card: {
      ...card,
      fsrs: serialize(result.card),
      updatedAt: now.getTime(),
    },
    review: {
      id: crypto.randomUUID(),
      cardId: card.id,
      question: card.question,
      selectedChoice,
      selectedAnswer: card.choices[selectedChoice - 1] ?? '',
      correct,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
      rating: grade,
      reviewedAt: now.getTime(),
      scheduledDays: result.card.scheduled_days,
      elapsedDays: result.log.elapsed_days,
      stateBefore: before.state,
      stateAfter: result.card.state,
      sheetSyncStatus: 'pending',
    },
  }
}

export function isCardComplete(card: MemoryCard): boolean {
  return Boolean(card.question.trim()) && card.choices.every((choice) => Boolean(choice.trim()))
}
