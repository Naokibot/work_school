import { getPendingReviews, getSettings, markReviewSent } from './db'
import type { ReviewRecord, ReviewSubmission } from './types'

const CALLBACK_PREFIX = '__workSchoolReviewCheck_'

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function confirmRecorded(webAppUrl: string, reviewId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const callbackName = `${CALLBACK_PREFIX}${crypto.randomUUID().replace(/-/g, '')}`
    const target = window as unknown as Record<string, unknown>
    const script = document.createElement('script')
    let settled = false

    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      delete target[callbackName]
      script.remove()
      resolve(value)
    }

    const timeout = window.setTimeout(() => finish(false), 8_000)
    target[callbackName] = (result: { recorded?: boolean }) => finish(result.recorded === true)

    const url = new URL(webAppUrl)
    url.searchParams.set('reviewId', reviewId)
    url.searchParams.set('callback', callbackName)
    script.src = url.toString()
    script.async = true
    script.onerror = () => finish(false)
    document.head.appendChild(script)
  })
}

async function sendReview(review: ReviewRecord): Promise<boolean> {
  const settings = await getSettings()
  if (!settings.reviewWebAppUrl || !settings.reviewWriteToken || !navigator.onLine) return false
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/.test(settings.reviewWebAppUrl)) return false

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

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await delay(500 * attempt)
      if (await confirmRecorded(settings.reviewWebAppUrl, review.id)) {
        await markReviewSent(review.id)
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

export async function flushPendingReviews(limit = 25): Promise<{ sent: number; pending: number }> {
  const allPending = await getPendingReviews()
  const batch = allPending.slice(0, limit)
  let sent = 0
  for (const review of batch) {
    if (await sendReview(review)) sent += 1
  }
  return { sent, pending: Math.max(0, allPending.length - sent) }
}
