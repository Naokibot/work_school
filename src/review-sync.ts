import { getPendingReviews, getSettings, markReviewSent } from './db'
import type { ReviewRecord, ReviewSubmission } from './types'

function toSubmission(review: ReviewRecord): ReviewSubmission {
  return {
    reviewId: review.id,
    reviewedAt: new Date(review.reviewedAt).toISOString(),
    cardId: review.cardId,
    question: review.question,
    selectedChoice: review.selectedChoice,
    selectedAnswer: review.selectedAnswer,
    correct: review.correct,
    responseSeconds: Math.round(review.elapsedMs / 100) / 10,
    fsrsRating: review.rating,
  }
}

async function sendReview(review: ReviewRecord): Promise<boolean> {
  const settings = await getSettings()
  if (!settings.reviewWebAppUrl || !settings.reviewWriteToken || !navigator.onLine) return false
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/.test(settings.reviewWebAppUrl)) {
    return false
  }

  const payload = JSON.stringify({
    token: settings.reviewWriteToken,
    spreadsheetId: settings.sheetId,
    review: toSubmission(review),
  })

  try {
    await fetch(settings.reviewWebAppUrl, {
      method: 'POST',
      mode: 'no-cors',
      cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: payload,
      keepalive: true,
    })
    await markReviewSent(review.id)
    return true
  } catch {
    return false
  }
}

export async function flushPendingReviews(limit = 25): Promise<{ sent: number; pending: number }> {
  const pending = (await getPendingReviews()).slice(0, limit)
  let sent = 0
  for (const review of pending) {
    if (await sendReview(review)) sent += 1
  }
  return { sent, pending: Math.max(0, pending.length - sent) }
}
