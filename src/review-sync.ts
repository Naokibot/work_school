import { getPendingReviews, getSettings, markReviewSent } from './db'
import type { ReviewRecord, ReviewSubmission, Settings } from './types'

const CALLBACK_PREFIX = '__workSchoolReviewCheck_'

function toSubmission(review: ReviewRecord, settings: Settings): ReviewSubmission {
  const base: ReviewSubmission = {
    reviewId: review.id,
    reviewedAt: new Date(review.reviewedAt).toISOString(),
    cardId: review.cardId,
    tags: [...review.tags],
    correct: review.correct,
    responseSeconds: Math.round(review.elapsedMs / 100) / 10,
    fsrsRating: review.rating,
  }
  if (settings.detailedReviewLogging) {
    base.question = review.question
    base.selectedAnswer = review.selectedAnswer
  }
  return base
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function confirmRecorded(webAppUrl: string, accessToken: string, reviewId: string): Promise<boolean> {
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
    url.searchParams.set('action', 'review-status')
    url.searchParams.set('token', accessToken)
    url.searchParams.set('reviewId', reviewId)
    url.searchParams.set('callback', callbackName)
    url.searchParams.set('_', String(Date.now()))
    script.src = url.toString()
    script.async = true
    script.onerror = () => finish(false)
    document.head.appendChild(script)
  })
}

async function sendReview(review: ReviewRecord): Promise<boolean> {
  const settings = await getSettings()
  if (!settings.appsScriptUrl || !settings.accessToken || !navigator.onLine) return false
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/.test(settings.appsScriptUrl)) return false

  const payload = JSON.stringify({
    token: settings.accessToken,
    action: 'review',
    review: toSubmission(review, settings),
  })

  try {
    await fetch(settings.appsScriptUrl, {
      method: 'POST',
      mode: 'no-cors',
      cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: payload,
      keepalive: true,
    })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await delay(500 * attempt)
      if (await confirmRecorded(settings.appsScriptUrl, settings.accessToken, review.id)) {
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
