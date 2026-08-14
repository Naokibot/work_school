import { createEmptyCard, fsrs, Rating, type Card, type Grade } from 'ts-fsrs'
import type { MemoryCard, ReviewRecord, SerializedFsrsCard } from './types'

const scheduler = fsrs({
  request_retention: 0.9,
  maximum_interval: 36500,
  enable_fuzz: true,
  enable_short_term: true,
  learning_steps: ['1m', '10m'],
  relearning_steps: ['10m'],
})

export const RATINGS = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const

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
    state: card.state,
    last_review: card.last_review ? new Date(card.last_review) : undefined,
  }
}

export function createSchedule(now = new Date()): SerializedFsrsCard {
  return serialize(createEmptyCard(now))
}

export function previewIntervals(card: MemoryCard, now = new Date()): Record<Grade, Date> {
  const preview = scheduler.repeat(deserialize(card.fsrs), now)
  return {
    [Rating.Again]: preview[Rating.Again].card.due,
    [Rating.Hard]: preview[Rating.Hard].card.due,
    [Rating.Good]: preview[Rating.Good].card.due,
    [Rating.Easy]: preview[Rating.Easy].card.due,
  }
}

export function reviewCard(card: MemoryCard, grade: Grade, now = new Date()): {
  card: MemoryCard
  review: ReviewRecord
} {
  const before = deserialize(card.fsrs)
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
      rating: grade,
      reviewedAt: now.getTime(),
      scheduledDays: result.card.scheduled_days,
      elapsedDays: result.log.elapsed_days,
      stateBefore: before.state,
      stateAfter: result.card.state,
    },
  }
}

export function isDue(card: MemoryCard, now = Date.now()): boolean {
  return !card.archived && card.fsrs.due <= now
}

export function retrievability(card: MemoryCard, now = new Date()): number {
  return scheduler.get_retrievability(deserialize(card.fsrs), now, false)
}
