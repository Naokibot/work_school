import { State } from 'ts-fsrs'
import './styles.css'
import {
  deleteCard,
  exportBackup,
  getAllCards,
  getAllReviews,
  getPendingReviews,
  getSettings,
  importBackup,
  putCard,
  putCards,
  saveReviewResult,
  saveSettings,
  undoPendingReview,
} from './db'
import { exportCardsToCsv, importCardsFromCsv } from './csv'
import { createSchedule, isCardComplete, reviewCard } from './scheduler'
import { flushPendingReviews } from './review-sync'
import { syncGoogleSheet } from './sheets'
import type { ChoicePosition, MemoryCard, StudyMode } from './types'

type Page = 'home' | 'study' | 'add' | 'cards' | 'stats' | 'settings'

const root = document.getElementById('app')
if (!(root instanceof HTMLDivElement)) throw new Error('App root was not found')
const app = root

let currentPage: Page = 'home'
let editingId: string | null = null
let searchTerm = ''
let searchTimer: number | undefined
let studyQueue: MemoryCard[] = []
let studyPosition = 0
let selectedChoice: ChoicePosition | null = null
let studyQueueInitialized = false
let syncInProgress = false
let lastAutoSyncError = ''
let studyMode: StudyMode = 'scheduled'
let extraNewCards = 0
let selectedStudyTags = new Set<string>()
let shuffledCardId: string | null = null
let shuffledChoices: string[] = []
let lastUndoReviewId: string | null = null

let timerDurationMs = 180_000
let timerAccumulatedMs = 0
let timerStartedAt = 0
let timerRunning = false
let timerTickId: number | undefined

const navItems: Array<{ page: Page; label: string; short: string }> = [
  { page: 'home', label: 'ホーム', short: 'ホーム' },
  { page: 'study', label: '学習', short: '学習' },
  { page: 'add', label: 'カード追加', short: '追加' },
  { page: 'cards', label: 'カード一覧', short: 'カード' },
  { page: 'stats', label: '統計', short: '統計' },
  { page: 'settings', label: '設定', short: '設定' },
]

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char] ?? char)
}

function textBlock(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br>')
}

function localDateKey(value: number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatDateTime(value?: number): string {
  if (!value) return 'まだ読み込んでいません'
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function computeStreak(reviewTimes: number[]): number {
  const days = new Set(reviewTimes.map(localDateKey))
  const cursor = new Date()
  cursor.setHours(0, 0, 0, 0)
  if (!days.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  while (days.has(localDateKey(cursor))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

function downloadFile(name: string, content: string, type: string): void {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function showToast(message: string): void {
  document.querySelector('.toast')?.remove()
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.textContent = message
  document.body.appendChild(toast)
  window.setTimeout(() => toast.remove(), 3600)
}

function shell(content: string): string {
  const nav = navItems.map((item) => `
    <button type="button" class="${currentPage === item.page ? 'active' : ''}" data-page="${item.page}">${item.label}</button>
  `).join('')
  const mobileNav = navItems.map((item) => `
    <button type="button" class="${currentPage === item.page ? 'active' : ''}" data-page="${item.page}">${item.short}</button>
  `).join('')
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">M</span><span>Memory</span></div>
        <nav class="nav">${nav}</nav>
        <div class="sidebar-meta">FSRSで復習時期を自動調整<br>正誤は自分で判定</div>
      </aside>
      <main class="main">${content}</main>
      <nav class="mobile-nav">${mobileNav}</nav>
    </div>
  `
}

function timerElapsedMs(): number {
  return timerAccumulatedMs + (timerRunning ? Math.max(0, Date.now() - timerStartedAt) : 0)
}

function resetQuestionTimer(seconds: number): void {
  timerDurationMs = Math.max(1, Math.round(seconds)) * 1000
  timerAccumulatedMs = 0
  timerStartedAt = Date.now()
  timerRunning = true
  updateTimerDisplay()
}

function pauseTimer(): void {
  if (!timerRunning) return
  timerAccumulatedMs += Math.max(0, Date.now() - timerStartedAt)
  timerRunning = false
  updateTimerDisplay()
}

function resumeTimer(): void {
  if (timerRunning) return
  timerStartedAt = Date.now()
  timerRunning = true
  updateTimerDisplay()
}

function stopTimerTicker(): void {
  if (timerTickId !== undefined) window.clearInterval(timerTickId)
  timerTickId = undefined
}

function updateTimerDisplay(): void {
  const display = document.getElementById('question-timer')
  if (!display) return
  const remainingMs = Math.max(0, timerDurationMs - timerElapsedMs())
  const totalSeconds = Math.ceil(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  display.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  display.classList.toggle('time-up', remainingMs <= 0)
  const toggle = document.querySelector<HTMLButtonElement>('[data-action="timer-toggle"]')
  if (toggle) toggle.textContent = timerRunning ? '一時停止' : '再開'
}

function startTimerTicker(): void {
  stopTimerTicker()
  updateTimerDisplay()
  timerTickId = window.setInterval(updateTimerDisplay, 250)
}

function isBuried(card: MemoryCard, now = Date.now()): boolean {
  return Boolean(card.buriedUntil && card.buriedUntil > now)
}

function matchesSelectedTags(card: MemoryCard): boolean {
  if (selectedStudyTags.size === 0) return true
  return card.tags.some((tag) => selectedStudyTags.has(tag))
}

function availableCards(cards: MemoryCard[], now = Date.now()): MemoryCard[] {
  return cards.filter((card) => !card.archived && !card.suspended && !isBuried(card, now) && isCardComplete(card) && matchesSelectedTags(card))
}

function modeLabel(mode: StudyMode): string {
  const labels: Record<StudyMode, string> = {
    scheduled: '通常（期限＋新規）',
    due: '復習のみ',
    all: 'タグ内すべて',
    forgotten: '苦手カード',
    marked: 'お気に入り',
  }
  return labels[mode]
}

function queueForMode(cards: MemoryCard[], newLimit: number, now = Date.now()): MemoryCard[] {
  const active = availableCards(cards, now)
  const due = active
    .filter((card) => card.fsrs.state !== State.New && card.fsrs.due <= now)
    .sort((a, b) => a.fsrs.due - b.fsrs.due)
  const fresh = active
    .filter((card) => card.fsrs.state === State.New)
    .sort((a, b) => a.createdAt - b.createdAt)

  switch (studyMode) {
    case 'due': return due
    case 'all': return [...active].sort((a, b) => a.fsrs.due - b.fsrs.due)
    case 'forgotten': return active.filter((card) => card.fsrs.lapses > 0).sort((a, b) => b.fsrs.lapses - a.fsrs.lapses)
    case 'marked': return active.filter((card) => card.marked).sort((a, b) => a.fsrs.due - b.fsrs.due)
    default: return [...due, ...fresh.slice(0, newLimit + extraNewCards)]
  }
}

function allTags(cards: MemoryCard[]): string[] {
  return [...new Set(cards.flatMap((card) => card.tags))].sort((a, b) => a.localeCompare(b, 'ja'))
}

function randomIndex(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0
  const buffer = new Uint32Array(1)
  crypto.getRandomValues(buffer)
  return (buffer[0] ?? 0) % maxExclusive
}

function shuffle(values: string[]): string[] {
  const result = [...values]
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1)
    const left = result[i] ?? ''
    result[i] = result[j] ?? ''
    result[j] = left
  }
  return result
}

function choicesForCard(card: MemoryCard): string[] {
  if (shuffledCardId !== card.id) {
    shuffledCardId = card.id
    shuffledChoices = shuffle([card.correctAnswer, card.distractors[0], card.distractors[1]])
  }
  return shuffledChoices
}

function resetChoiceState(): void {
  selectedChoice = null
  shuffledCardId = null
  shuffledChoices = []
}

async function renderHome(): Promise<string> {
  const [cards, reviews, settings, pending] = await Promise.all([
    getAllCards(), getAllReviews(), getSettings(), getPendingReviews(),
  ])
  const active = cards.filter((card) => !card.archived)
  const complete = active.filter(isCardComplete)
  const incomplete = active.length - complete.length
  const candidates = queueForMode(cards, settings.newCardsPerDay)
  const today = localDateKey(Date.now())
  const todayReviews = reviews.filter((review) => localDateKey(review.reviewedAt) === today)
  const correctToday = todayReviews.filter((review) => review.correct).length
  const streak = computeStreak(reviews.map((review) => review.reviewedAt))
  const tags = allTags(complete)
  const tagButtons = tags.map((tag) => `
    <button type="button" class="tag-chip${selectedStudyTags.has(tag) ? ' selected' : ''}" data-study-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>
  `).join('')

  return `
    <header class="page-header">
      <div><h1>今日の学習</h1><p>選択肢は毎回シャッフルされ、正誤は自分で判定します。</p></div>
      <div class="sync-status"><span class="dot ${navigator.onLine ? '' : 'offline'}"></span>${navigator.onLine ? 'オンライン' : 'オフライン'}</div>
    </header>
    <div class="grid">
      <section class="panel span-8">
        <div class="metric"><span class="metric-label">現在の条件で学習するカード</span><span class="metric-value">${candidates.length}</span></div>
        <p class="muted">${escapeHtml(modeLabel(studyMode))}${selectedStudyTags.size ? ` / タグ ${[...selectedStudyTags].map((tag) => `#${tag}`).join(' ')}` : ' / 全タグ'}</p>
        <div class="actions">
          <button class="primary large-action" type="button" data-action="start-study" ${candidates.length === 0 ? 'disabled' : ''}>学習を始める</button>
          <button class="secondary large-action" type="button" data-action="import-cards" ${syncInProgress ? 'disabled' : ''}>暗記カードを読み込む</button>
          ${studyMode === 'scheduled' ? '<button class="secondary" type="button" data-action="extra-new">今日だけ新規＋10</button>' : ''}
        </div>
      </section>
      <section class="panel span-4"><div class="metric"><span class="metric-label">連続学習</span><span class="metric-value">${streak}日</span></div><p class="muted">今日 ${todayReviews.length}問 / 正解 ${correctToday}問</p></section>

      <section class="panel span-12 flat">
        <div class="study-filter-head"><div><h3>学習範囲</h3><p class="small muted">AnkiのCustom Studyに近い使い方です。</p></div><select id="study-mode" class="study-mode-select">
          ${(['scheduled', 'due', 'all', 'forgotten', 'marked'] as StudyMode[]).map((mode) => `<option value="${mode}" ${studyMode === mode ? 'selected' : ''}>${escapeHtml(modeLabel(mode))}</option>`).join('')}
        </select></div>
        <div class="tag-toolbar"><button type="button" class="tag-chip ${selectedStudyTags.size === 0 ? 'selected' : ''}" data-action="clear-study-tags">すべて</button>${tagButtons || '<span class="small muted">タグ付きカードを読み込むとここに表示されます。</span>'}</div>
      </section>

      <section class="panel span-6 flat"><h3>Google Sheets</h3><p class="muted">最終読込 ${escapeHtml(formatDateTime(settings.lastSyncAt))}</p><p class="small muted">A=問題 / B=正解 / C・D=誤答 / E=タグ。スプレッドシート本体は非公開のまま利用できます。</p></section>
      <section class="panel span-6 flat"><h3>データ状態</h3><p class="muted">カード ${complete.length}枚${incomplete ? ` / 未完成 ${incomplete}枚` : ''}</p><p class="small muted">停止 ${active.filter((card) => card.suspended).length}枚 / お気に入り ${active.filter((card) => card.marked).length}枚 / Sheet2未送信 ${pending.length}件</p></section>
    </div>
  `
}

async function initializeStudyQueue(): Promise<void> {
  const [cards, settings] = await Promise.all([getAllCards(), getSettings()])
  studyQueue = queueForMode(cards, settings.newCardsPerDay)
  studyPosition = 0
  resetChoiceState()
  studyQueueInitialized = true
  resetQuestionTimer(settings.questionTimerSeconds)
}

async function renderStudy(): Promise<string> {
  if (!studyQueueInitialized) await initializeStudyQueue()
  const card = studyQueue[studyPosition]
  if (!card) {
    pauseTimer()
    return `
      <header class="page-header"><div><h1>学習完了</h1><p>今回のセッションは終了です。</p></div>${lastUndoReviewId ? '<button class="secondary" type="button" data-action="undo-last">直前の回答を取り消す</button>' : ''}</header>
      <section class="panel empty"><strong>おつかれさまでした</strong>回答履歴は端末に保存され、設定済みならSheet2へ送信されます。<div class="actions center-actions"><button class="primary" data-page="home" type="button">ホームへ</button></div></section>
    `
  }

  const choices = choicesForCard(card)
  const choiceButtons = choices.map((choice, index) => `
    <button class="choice-button${selectedChoice === index + 1 ? ' selected' : ''}" type="button" data-choice="${index + 1}">
      <span class="choice-number">${index + 1}</span><span>${textBlock(choice)}</span>
    </button>
  `).join('')
  const tagBadges = card.tags.map((tag) => `<span class="badge">#${escapeHtml(tag)}</span>`).join('')

  return `
    <header class="page-header study-header">
      <div><h1>学習</h1><p>${studyPosition + 1} / ${studyQueue.length}　${escapeHtml(card.deck)}</p></div>
      <div class="study-header-actions">${lastUndoReviewId ? '<button class="secondary compact" type="button" data-action="undo-last">Undo</button>' : ''}<div id="question-timer" class="question-timer">00:00</div><button class="ghost" type="button" data-action="end-study">終了</button></div>
    </header>
    <section class="study-layout">
      <div class="panel question-panel">
        <div class="study-meta"><div class="badges">${tagBadges}</div><div class="card-tools"><button class="mini-tool${card.marked ? ' active' : ''}" type="button" data-action="mark-current">${card.marked ? '★ お気に入り' : '☆ お気に入り'}</button><button class="mini-tool" type="button" data-action="bury-current">今日だけ隠す</button><button class="mini-tool" type="button" data-action="suspend-current">停止</button></div></div>
        <div class="study-question">${textBlock(card.question)}</div>
        <div class="choice-grid three-choice">${choiceButtons}</div>
        <div id="self-assessment" class="self-assessment" ${selectedChoice ? '' : 'hidden'}>
          <div class="correct-answer-box"><span class="small muted">正解</span><strong>${textBlock(card.correctAnswer)}</strong></div>
          <div><strong>自分の回答はどうでしたか？</strong><span id="selected-answer-label" class="muted small">${selectedChoice ? `選択肢${selectedChoice}を選択` : ''}</span></div>
          <div class="self-buttons"><button class="self-button correct" type="button" data-self-result="correct">正解だった</button><button class="self-button incorrect" type="button" data-self-result="incorrect">間違えた</button></div>
        </div>
        ${card.note ? `<div class="study-note">${textBlock(card.note)}</div>` : ''}
      </div>
      <aside class="panel scratch-panel">
        <div class="scratch-toolbar"><div><strong>計算・メモ</strong><span class="small muted">次の問題で自動消去</span></div><button class="secondary compact" type="button" data-action="clear-scratch">全消去</button></div>
        <canvas id="scratchpad" class="scratchpad" aria-label="計算やメモを書く領域"></canvas>
        <div class="timer-controls"><button class="secondary" type="button" data-action="timer-toggle">一時停止</button><button class="secondary" type="button" data-action="timer-reset">タイマーをリセット</button></div>
      </aside>
    </section>
    <p class="small muted keyboard-help">外付けキーボード: 1〜3で回答 / Cで正解 / Xで不正解 / UでUndo</p>
  `
}

async function renderEditor(): Promise<string> {
  const existing = editingId ? (await getAllCards()).find((card) => card.id === editingId) : undefined
  const title = existing ? 'カードを編集' : 'カードを追加'
  return `
    <header class="page-header"><div><h1>${title}</h1><p>正解1つと誤答2つを登録します。学習時の表示順は自動でシャッフルされます。</p></div></header>
    <section class="panel">
      ${existing?.source === 'google-sheet' ? '<div class="notice">Sheets由来のカードは次回読込時にA〜E列の内容へ戻ります。</div>' : ''}
      <form class="form" id="card-form">
        <div class="field"><label for="question">問題文</label><textarea id="question" name="question" required autocomplete="off">${existing ? escapeHtml(existing.question) : ''}</textarea></div>
        <div class="field correct-field"><label for="correctAnswer">正解</label><textarea id="correctAnswer" name="correctAnswer" required>${existing ? escapeHtml(existing.correctAnswer) : ''}</textarea></div>
        <div class="answer-editor-grid"><div class="field"><label for="wrongAnswer1">誤答1</label><textarea id="wrongAnswer1" name="wrongAnswer1" required>${existing ? escapeHtml(existing.distractors[0]) : ''}</textarea></div><div class="field"><label for="wrongAnswer2">誤答2</label><textarea id="wrongAnswer2" name="wrongAnswer2" required>${existing ? escapeHtml(existing.distractors[1]) : ''}</textarea></div></div>
        <div class="field-row"><div class="field"><label for="deck">デッキ</label><input id="deck" name="deck" value="${escapeHtml(existing?.deck ?? '一般')}" maxlength="80"></div><div class="field"><label for="tags">タグ</label><input id="tags" name="tags" value="${escapeHtml(existing?.tags.join(', ') ?? '')}" placeholder="数学, 図形, 高専"></div></div>
        <div class="field"><label for="note">メモ</label><textarea id="note" name="note" placeholder="任意の補足">${existing ? escapeHtml(existing.note) : ''}</textarea></div>
        <div class="actions"><button class="primary" type="submit">${existing ? '保存' : '登録'}</button>${existing ? '<button class="secondary" type="button" data-page="cards">キャンセル</button>' : ''}</div>
      </form>
    </section>
  `
}

async function renderCards(): Promise<string> {
  const [allCards, settings] = await Promise.all([getAllCards(), getSettings()])
  const all = allCards.filter((card) => !card.archived)
  const query = searchTerm.trim().toLowerCase()
  const filtered = query ? all.filter((card) => [card.question, card.correctAnswer, ...card.distractors, card.deck, card.note, ...card.tags].some((value) => value.toLowerCase().includes(query))) : all
  filtered.sort((a, b) => Number(b.marked) - Number(a.marked) || b.updatedAt - a.updatedAt)
  const shown = filtered.slice(0, 300)
  const rows = shown.map((card) => {
    const state = card.suspended ? '停止中' : isBuried(card) ? '今日だけ非表示' : isCardComplete(card) ? '学習可能' : '未完成'
    const leech = card.fsrs.lapses >= settings.leechThreshold
    return `
      <article class="card-row${card.suspended ? ' suspended-row' : ''}">
        <div><div class="card-front">${card.marked ? '★ ' : ''}${textBlock(card.question)}</div><ol class="choice-preview"><li><strong>正解:</strong> ${textBlock(card.correctAnswer || '未登録')}</li><li>誤答: ${textBlock(card.distractors[0] || '未登録')}</li><li>誤答: ${textBlock(card.distractors[1] || '未登録')}</li></ol><div class="badges"><span class="badge">${escapeHtml(card.deck)}</span><span class="badge">${card.source === 'google-sheet' ? `Sheets${card.sourceRow ? ` #${card.sourceRow}` : ''}` : 'サイト登録'}</span><span class="badge">${state}</span>${leech ? '<span class="badge warning-badge">苦手</span>' : ''}${card.tags.map((tag) => `<span class="badge">#${escapeHtml(tag)}</span>`).join('')}</div></div>
        <div class="actions"><button class="icon-button" type="button" data-mark-card="${card.id}">${card.marked ? '★' : '☆'}</button><button class="icon-button" type="button" data-suspend-card="${card.id}">${card.suspended ? '再開' : '停止'}</button>${isBuried(card) ? `<button class="icon-button" type="button" data-unbury-card="${card.id}">戻す</button>` : ''}<button class="icon-button" type="button" data-edit-card="${card.id}">編集</button><button class="icon-button" type="button" data-delete-card="${card.id}">削除</button></div>
      </article>
    `
  }).join('')
  return `
    <header class="page-header"><div><h1>カード</h1><p>${filtered.length}枚${filtered.length > 300 ? '（先頭300枚を表示）' : ''}</p></div><button class="primary" type="button" data-page="add">＋ 追加</button></header>
    <div class="search-wrap"><input class="search" id="card-search" type="search" value="${escapeHtml(searchTerm)}" placeholder="問題・正解・タグ・デッキを検索"></div>
    <div class="card-list">${rows || '<section class="panel empty"><strong>カードがありません</strong>「暗記カードを読み込む」またはサイトから追加できます。</section>'}</div>
  `
}

async function renderStats(): Promise<string> {
  const [reviews, cards, settings] = await Promise.all([getAllReviews(), getAllCards(), getSettings()])
  const today = localDateKey(Date.now())
  const todayReviews = reviews.filter((review) => localDateKey(review.reviewedAt) === today)
  const correct = reviews.filter((review) => review.correct).length
  const incorrect = reviews.length - correct
  const pending = reviews.filter((review) => review.sheetSyncStatus !== 'sent').length
  const streak = computeStreak(reviews.map((review) => review.reviewedAt))
  const leeches = cards.filter((card) => !card.archived && card.fsrs.lapses >= settings.leechThreshold).length
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - (6 - index))
    const key = localDateKey(date)
    return { label: new Intl.DateTimeFormat('ja-JP', { weekday: 'short' }).format(date), count: reviews.filter((review) => localDateKey(review.reviewedAt) === key).length }
  })
  const max = Math.max(1, ...days.map((day) => day.count))
  const averageSeconds = reviews.length ? Math.round(reviews.reduce((sum, review) => sum + review.elapsedMs, 0) / reviews.length / 1000) : 0

  return `
    <header class="page-header"><div><h1>統計</h1><p>自己申告した正誤と回答時間です。</p></div></header>
    <div class="grid">
      <section class="panel span-3"><div class="metric"><span class="metric-label">今日</span><span class="metric-value">${todayReviews.length}</span></div><p class="muted">回答</p></section>
      <section class="panel span-3"><div class="metric"><span class="metric-label">正解</span><span class="metric-value">${correct}</span></div><p class="muted">累計</p></section>
      <section class="panel span-3"><div class="metric"><span class="metric-label">不正解</span><span class="metric-value">${incorrect}</span></div><p class="muted">累計</p></section>
      <section class="panel span-3"><div class="metric"><span class="metric-label">苦手</span><span class="metric-value">${leeches}</span></div><p class="muted">${settings.leechThreshold}回以上失敗</p></section>
      <section class="panel span-8"><h3>直近7日</h3><div class="bar-list">${days.map((day) => `<div class="bar-row"><span>${day.label}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round((day.count / max) * 100)}%"></div></div><strong>${day.count}</strong></div>`).join('')}</div></section>
      <section class="panel span-4"><h3>学習状況</h3><p class="small muted">平均回答時間 ${averageSeconds}秒</p><p class="small muted">連続学習 ${streak}日</p><p class="small muted">Sheet2未送信 ${pending}件</p><p class="small muted">FSRS: 自己申告の正解→Good / 不正解→Again</p></section>
    </div>
  `
}

async function renderSettings(): Promise<string> {
  const settings = await getSettings()
  const theme = document.documentElement.dataset.theme ?? 'light'
  return `
    <header class="page-header"><div><h1>設定</h1><p>非公開Google Sheets、学習量、タイマー、記録を設定します。</p></div></header>
    <div class="grid">
      <section class="panel span-12"><h3>Google Sheets / Apps Script</h3><div class="notice"><strong>スプレッドシートは非公開のままで構いません。</strong><br>A=問題、B=正解、C・D=誤答、E=タグです。Apps ScriptのScript PropertiesにSpreadsheet IDを置き、ブラウザにはURLとACCESS_TOKENだけを保存します。</div><form class="form" id="settings-form">
        <div class="field"><label for="appsScriptUrl">Apps Script Web App URL</label><input id="appsScriptUrl" name="appsScriptUrl" type="url" value="${escapeHtml(settings.appsScriptUrl)}" placeholder="https://script.google.com/macros/s/.../exec"></div>
        <div class="field"><label for="accessToken">ACCESS_TOKEN</label><input id="accessToken" name="accessToken" type="password" value="${escapeHtml(settings.accessToken)}" autocomplete="off"></div>
        <div class="field-row"><div class="field"><label for="newCardsPerDay">1日の新規カード上限</label><input id="newCardsPerDay" name="newCardsPerDay" type="number" min="0" max="500" value="${settings.newCardsPerDay}" required></div><div class="field"><label for="questionTimerSeconds">1問のタイマー（秒）</label><input id="questionTimerSeconds" name="questionTimerSeconds" type="number" min="10" max="3600" value="${settings.questionTimerSeconds}" required></div></div>
        <div class="field-row"><div class="field"><label for="leechThreshold">苦手カード判定（失敗回数）</label><input id="leechThreshold" name="leechThreshold" type="number" min="2" max="50" value="${settings.leechThreshold}" required></div><div></div></div>
        <label class="check-row"><input id="autoSync" name="autoSync" type="checkbox" ${settings.autoSync ? 'checked' : ''}> アプリを開いている間、自動で暗記カードを読み込む</label>
        <label class="check-row"><input id="autoSuspendLeeches" name="autoSuspendLeeches" type="checkbox" ${settings.autoSuspendLeeches ? 'checked' : ''}> 苦手判定に達したカードを自動で停止する</label>
        <label class="check-row"><input id="detailedReviewLogging" name="detailedReviewLogging" type="checkbox" ${settings.detailedReviewLogging ? 'checked' : ''}> Sheet2へ問題文・選択した答えも記録する（個人情報最小化のため初期値OFF）</label>
        <div class="actions"><button class="primary" type="submit">設定を保存</button><button class="secondary large-action" type="button" data-action="import-cards">暗記カードを読み込む</button><button class="secondary" type="button" data-action="flush-reviews">未送信記録を送る</button></div>
        <p class="help">最終読込: ${escapeHtml(formatDateTime(settings.lastSyncAt))}${settings.lastSyncMessage ? ` / ${escapeHtml(settings.lastSyncMessage)}` : ''}</p>
      </form></section>
      <section class="panel span-6"><h3>バックアップ</h3><p class="small muted">カードとFSRS履歴を保存します。ACCESS_TOKENはバックアップへ含めません。</p><div class="actions"><button class="secondary" type="button" data-action="export-backup">JSON保存</button><label class="secondary file-button">JSON復元<input id="backup-import" type="file" accept="application/json,.json" hidden></label></div></section>
      <section class="panel span-6"><h3>CSV</h3><p class="small muted">question, correct_answer, wrong_answer1, wrong_answer2, tags, deck, note</p><div class="actions"><button class="secondary" type="button" data-action="export-csv">CSV保存</button><label class="secondary file-button">CSV読込<input id="csv-import" type="file" accept="text/csv,.csv" hidden></label></div></section>
      <section class="panel span-12 flat"><h3>表示</h3><button class="secondary" type="button" data-action="toggle-theme">${theme === 'dark' ? 'ライトモード' : 'ダークモード'}へ</button></section>
    </div>
  `
}

async function render(): Promise<void> {
  let content: string
  switch (currentPage) {
    case 'study': content = await renderStudy(); break
    case 'add': content = await renderEditor(); break
    case 'cards': content = await renderCards(); break
    case 'stats': content = await renderStats(); break
    case 'settings': content = await renderSettings(); break
    default: content = await renderHome()
  }
  app.innerHTML = shell(content)
  attachHandlers()
  if (currentPage === 'study' && studyQueue[studyPosition]) {
    attachScratchpad()
    startTimerTicker()
  } else stopTimerTicker()
}

function goTo(page: Page): void {
  if (currentPage === 'study' && page !== 'study') pauseTimer()
  currentPage = page
  editingId = null
  if (page === 'study') studyQueueInitialized = false
  void render()
}

async function runSheetSync(showResult: boolean): Promise<void> {
  if (syncInProgress || !navigator.onLine) {
    if (showResult && !navigator.onLine) showToast('オフラインのため読み込めません。')
    return
  }
  syncInProgress = true
  try {
    const summary = await syncGoogleSheet()
    lastAutoSyncError = ''
    if (showResult) showToast(`読込完了: ${summary.created}件追加・${summary.updated}件更新・${summary.skipped}件スキップ`)
    if (['home', 'cards', 'settings'].includes(currentPage)) await render()
  } catch (error) {
    const message = error instanceof Error ? error.message : '暗記カードの読み込みに失敗しました。'
    if (showResult || message !== lastAutoSyncError) {
      if (showResult) showToast(message)
      lastAutoSyncError = message
    }
  } finally {
    syncInProgress = false
  }
}

async function completeCurrentReview(correct: boolean): Promise<void> {
  const card = studyQueue[studyPosition]
  if (!card || selectedChoice === null) return
  const selectedAnswer = choicesForCard(card)[selectedChoice - 1] ?? ''
  if (!selectedAnswer) return
  pauseTimer()
  const settings = await getSettings()
  const result = reviewCard(card, correct, selectedChoice, selectedAnswer, timerElapsedMs())
  if (!correct && settings.autoSuspendLeeches && result.card.fsrs.lapses >= settings.leechThreshold) {
    result.card.suspended = true
  }
  await saveReviewResult(result.card, result.review)
  lastUndoReviewId = result.review.id
  studyQueue[studyPosition] = result.card
  studyPosition += 1
  resetChoiceState()
  resetQuestionTimer(settings.questionTimerSeconds)
  await render()
}

async function undoLastReview(): Promise<void> {
  if (!lastUndoReviewId) return
  const restored = await undoPendingReview(lastUndoReviewId)
  if (!restored) {
    lastUndoReviewId = null
    showToast('この回答はすでにSheet2へ送信済みのため取り消せません。')
    await render()
    return
  }
  lastUndoReviewId = null
  studyPosition = Math.max(0, studyPosition - 1)
  studyQueue[studyPosition] = { ...restored, suspended: false }
  resetChoiceState()
  const settings = await getSettings()
  resetQuestionTimer(settings.questionTimerSeconds)
  showToast('直前の回答を取り消しました。')
  await render()
}

function selectChoice(choice: ChoicePosition): void {
  selectedChoice = choice
  document.querySelectorAll<HTMLElement>('[data-choice]').forEach((button) => {
    button.classList.toggle('selected', Number(button.dataset.choice) === choice)
  })
  const assessment = document.getElementById('self-assessment')
  if (assessment) assessment.hidden = false
  const label = document.getElementById('selected-answer-label')
  if (label) label.textContent = `選択肢${choice}を選択`
}

function tomorrowStart(): number {
  const date = new Date()
  date.setHours(24, 0, 0, 0)
  return date.getTime()
}

async function skipCurrentCard(mode: 'bury' | 'suspend'): Promise<void> {
  const card = studyQueue[studyPosition]
  if (!card) return
  const updated: MemoryCard = mode === 'bury'
    ? { ...card, buriedUntil: tomorrowStart(), updatedAt: Date.now() }
    : { ...card, suspended: true, buriedUntil: undefined, updatedAt: Date.now() }
  await putCard(updated)
  studyQueue[studyPosition] = updated
  studyPosition += 1
  resetChoiceState()
  const settings = await getSettings()
  resetQuestionTimer(settings.questionTimerSeconds)
  showToast(mode === 'bury' ? 'このカードを明日まで隠しました。' : 'このカードを停止しました。')
  await render()
}

async function toggleCurrentMarked(): Promise<void> {
  const card = studyQueue[studyPosition]
  if (!card) return
  const updated = { ...card, marked: !card.marked, updatedAt: Date.now() }
  await putCard(updated)
  studyQueue[studyPosition] = updated
  const button = document.querySelector<HTMLButtonElement>('[data-action="mark-current"]')
  if (button) {
    button.textContent = updated.marked ? '★ お気に入り' : '☆ お気に入り'
    button.classList.toggle('active', updated.marked)
  }
}

function attachScratchpad(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#scratchpad')
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.max(1, Math.round(rect.width * dpr))
  canvas.height = Math.max(1, Math.round(rect.height * dpr))
  const context = canvas.getContext('2d')
  if (!context) return
  context.scale(dpr, dpr)
  context.lineWidth = 2.2
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#1b1b1a'

  let drawing = false
  const point = (event: PointerEvent) => {
    const bounds = canvas.getBoundingClientRect()
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }
  canvas.addEventListener('pointerdown', (event) => {
    drawing = true
    canvas.setPointerCapture(event.pointerId)
    const p = point(event)
    context.beginPath()
    context.moveTo(p.x, p.y)
  })
  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return
    const p = point(event)
    context.lineTo(p.x, p.y)
    context.stroke()
  })
  const stop = (event: PointerEvent) => {
    drawing = false
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  }
  canvas.addEventListener('pointerup', stop)
  canvas.addEventListener('pointercancel', stop)
  document.querySelector('[data-action="clear-scratch"]')?.addEventListener('click', () => context.clearRect(0, 0, rect.width, rect.height))
}

async function updateCardState(id: string, action: 'mark' | 'suspend' | 'unbury'): Promise<void> {
  const card = (await getAllCards()).find((candidate) => candidate.id === id)
  if (!card) return
  let updated = card
  if (action === 'mark') updated = { ...card, marked: !card.marked, updatedAt: Date.now() }
  if (action === 'suspend') updated = { ...card, suspended: !card.suspended, buriedUntil: undefined, updatedAt: Date.now() }
  if (action === 'unbury') updated = { ...card, buriedUntil: undefined, updatedAt: Date.now() }
  await putCard(updated)
  await render()
}

function attachHandlers(): void {
  document.querySelectorAll<HTMLElement>('[data-page]').forEach((button) => button.addEventListener('click', () => goTo(button.dataset.page as Page)))
  document.querySelector('[data-action="start-study"]')?.addEventListener('click', () => goTo('study'))
  document.querySelector('[data-action="end-study"]')?.addEventListener('click', () => goTo('home'))
  document.querySelectorAll('[data-action="import-cards"]').forEach((button) => button.addEventListener('click', () => void runSheetSync(true)))
  document.querySelector('[data-action="extra-new"]')?.addEventListener('click', async () => {
    extraNewCards += 10
    showToast(`今日の新規カードを${extraNewCards}枚追加しました。`)
    await render()
  })
  document.querySelector('[data-action="clear-study-tags"]')?.addEventListener('click', async () => {
    selectedStudyTags.clear()
    await render()
  })
  document.querySelectorAll<HTMLElement>('[data-study-tag]').forEach((button) => button.addEventListener('click', async () => {
    const tag = button.dataset.studyTag
    if (!tag) return
    if (selectedStudyTags.has(tag)) selectedStudyTags.delete(tag)
    else selectedStudyTags.add(tag)
    await render()
  }))
  const modeSelect = document.querySelector<HTMLSelectElement>('#study-mode')
  modeSelect?.addEventListener('change', async () => {
    const value = modeSelect.value as StudyMode
    if (['scheduled', 'due', 'all', 'forgotten', 'marked'].includes(value)) studyMode = value
    await render()
  })

  document.querySelectorAll<HTMLElement>('[data-choice]').forEach((button) => button.addEventListener('click', () => {
    const choice = Number(button.dataset.choice)
    if ([1, 2, 3].includes(choice)) selectChoice(choice as ChoicePosition)
  }))
  document.querySelectorAll<HTMLElement>('[data-self-result]').forEach((button) => button.addEventListener('click', () => void completeCurrentReview(button.dataset.selfResult === 'correct')))
  document.querySelector('[data-action="undo-last"]')?.addEventListener('click', () => void undoLastReview())
  document.querySelector('[data-action="bury-current"]')?.addEventListener('click', () => void skipCurrentCard('bury'))
  document.querySelector('[data-action="suspend-current"]')?.addEventListener('click', () => void skipCurrentCard('suspend'))
  document.querySelector('[data-action="mark-current"]')?.addEventListener('click', () => void toggleCurrentMarked())
  document.querySelector('[data-action="timer-toggle"]')?.addEventListener('click', () => timerRunning ? pauseTimer() : resumeTimer())
  document.querySelector('[data-action="timer-reset"]')?.addEventListener('click', () => resetQuestionTimer(Math.round(timerDurationMs / 1000)))

  document.querySelector('[data-action="flush-reviews"]')?.addEventListener('click', async () => {
    lastUndoReviewId = null
    const result = await flushPendingReviews(100)
    showToast(result.sent ? `${result.sent}件をSheet2へ送信しました。` : '送信できる記録がありません。設定・通信を確認してください。')
    await render()
  })

  const form = document.querySelector<HTMLFormElement>('#card-form')
  form?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    const question = String(data.get('question') ?? '').trim()
    const correctAnswer = String(data.get('correctAnswer') ?? '').trim()
    const wrongAnswer1 = String(data.get('wrongAnswer1') ?? '').trim()
    const wrongAnswer2 = String(data.get('wrongAnswer2') ?? '').trim()
    if (!question || !correctAnswer || !wrongAnswer1 || !wrongAnswer2) {
      showToast('問題文・正解・誤答2つをすべて入力してください。')
      return
    }
    const now = Date.now()
    const all = await getAllCards()
    const existing = editingId ? all.find((card) => card.id === editingId) : undefined
    const duplicate = all.find((card) => card.id !== existing?.id && card.question.trim().toLowerCase() === question.toLowerCase())
    if (duplicate && !window.confirm('同じ問題文のカードがすでにあります。それでも保存しますか？')) return
    const tags = [...new Set(String(data.get('tags') ?? '').split(/[,;|]/).map((tag) => tag.trim()).filter(Boolean))]
    const card: MemoryCard = existing ? {
      ...existing,
      question,
      correctAnswer,
      distractors: [wrongAnswer1, wrongAnswer2],
      deck: String(data.get('deck') ?? '').trim() || '一般',
      tags,
      note: String(data.get('note') ?? '').trim(),
      updatedAt: now,
    } : {
      id: crypto.randomUUID(),
      question,
      correctAnswer,
      distractors: [wrongAnswer1, wrongAnswer2],
      deck: String(data.get('deck') ?? '').trim() || '一般',
      tags,
      note: String(data.get('note') ?? '').trim(),
      source: 'manual',
      createdAt: now,
      updatedAt: now,
      archived: false,
      suspended: false,
      marked: false,
      fsrs: createSchedule(new Date(now)),
    }
    await putCard(card)
    showToast(existing ? 'カードを更新しました。' : 'カードを登録しました。')
    editingId = null
    currentPage = 'cards'
    await render()
  })

  const search = document.querySelector<HTMLInputElement>('#card-search')
  search?.addEventListener('input', () => {
    searchTerm = search.value
    if (searchTimer !== undefined) window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => { if (currentPage === 'cards') void render() }, 150)
  })

  document.querySelectorAll<HTMLElement>('[data-mark-card]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.markCard) void updateCardState(button.dataset.markCard, 'mark')
  }))
  document.querySelectorAll<HTMLElement>('[data-suspend-card]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.suspendCard) void updateCardState(button.dataset.suspendCard, 'suspend')
  }))
  document.querySelectorAll<HTMLElement>('[data-unbury-card]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.unburyCard) void updateCardState(button.dataset.unburyCard, 'unbury')
  }))
  document.querySelectorAll<HTMLElement>('[data-edit-card]').forEach((button) => button.addEventListener('click', () => {
    editingId = button.dataset.editCard ?? null
    currentPage = 'add'
    void render()
  }))
  document.querySelectorAll<HTMLElement>('[data-delete-card]').forEach((button) => button.addEventListener('click', async () => {
    const id = button.dataset.deleteCard
    if (!id || !window.confirm('このカードと端末内の回答履歴を削除しますか？')) return
    await deleteCard(id)
    showToast('カードを削除しました。')
    await render()
  }))

  const settingsForm = document.querySelector<HTMLFormElement>('#settings-form')
  settingsForm?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const current = await getSettings()
    const data = new FormData(settingsForm)
    const appsScriptUrl = String(data.get('appsScriptUrl') ?? '').trim()
    const accessToken = String(data.get('accessToken') ?? '').trim()
    const newCardsPerDay = Math.min(500, Math.max(0, Number(data.get('newCardsPerDay') ?? 20)))
    const questionTimerSeconds = Math.min(3600, Math.max(10, Number(data.get('questionTimerSeconds') ?? 180)))
    const leechThreshold = Math.min(50, Math.max(2, Number(data.get('leechThreshold') ?? 8)))
    if (appsScriptUrl && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/.test(appsScriptUrl)) {
      showToast('Apps Script Web App URLは /exec のURLを入力してください。')
      return
    }
    await saveSettings({
      ...current,
      appsScriptUrl,
      accessToken,
      autoSync: data.get('autoSync') === 'on',
      newCardsPerDay,
      questionTimerSeconds,
      detailedReviewLogging: data.get('detailedReviewLogging') === 'on',
      autoSuspendLeeches: data.get('autoSuspendLeeches') === 'on',
      leechThreshold,
    })
    showToast('設定を保存しました。')
    await render()
  })

  document.querySelector('[data-action="export-backup"]')?.addEventListener('click', async () => downloadFile(`memory-backup-${localDateKey(Date.now())}.json`, await exportBackup(), 'application/json;charset=utf-8'))
  document.querySelector<HTMLInputElement>('#backup-import')?.addEventListener('change', async (event) => {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file || !window.confirm('現在の端末内データをバックアップ内容で置き換えますか？')) return
    try {
      await importBackup(await file.text())
      studyQueueInitialized = false
      showToast('バックアップを復元しました。ACCESS_TOKENは安全のため復元されません。')
      await render()
    } catch (error) { showToast(error instanceof Error ? error.message : '復元に失敗しました。') }
    finally { input.value = '' }
  })
  document.querySelector('[data-action="export-csv"]')?.addEventListener('click', async () => downloadFile(`memory-cards-${localDateKey(Date.now())}.csv`, exportCardsToCsv(await getAllCards()), 'text/csv;charset=utf-8'))
  document.querySelector<HTMLInputElement>('#csv-import')?.addEventListener('change', async (event) => {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    try {
      const cards = importCardsFromCsv(await file.text())
      await putCards(cards)
      showToast(`${cards.length}枚をCSVから追加しました。`)
      await render()
    } catch (error) { showToast(error instanceof Error ? error.message : 'CSVの読み込みに失敗しました。') }
    finally { input.value = '' }
  })
  document.querySelector('[data-action="toggle-theme"]')?.addEventListener('click', async () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    localStorage.setItem('memory-theme', next)
    await render()
  })
}

function installKeyboardShortcuts(): void {
  document.addEventListener('keydown', (event) => {
    if (currentPage !== 'study') return
    const target = event.target as HTMLElement | null
    if (target?.matches('input, textarea, select')) return
    const choiceKeys: Record<string, ChoicePosition> = { Digit1: 1, Digit2: 2, Digit3: 3 }
    const choice = choiceKeys[event.code]
    if (choice) {
      event.preventDefault()
      selectChoice(choice)
      return
    }
    if (event.code === 'KeyU' && lastUndoReviewId) {
      event.preventDefault()
      void undoLastReview()
      return
    }
    if (selectedChoice === null) return
    if (event.code === 'KeyC') {
      event.preventDefault()
      void completeCurrentReview(true)
    } else if (event.code === 'KeyX') {
      event.preventDefault()
      void completeCurrentReview(false)
    }
  })
}

async function autoSync(): Promise<void> {
  const settings = await getSettings()
  if (settings.autoSync && settings.appsScriptUrl && settings.accessToken && document.visibilityState === 'visible') await runSheetSync(false)
  if (document.visibilityState === 'visible') await flushPendingReviews(25, lastUndoReviewId)
}

async function bootstrap(): Promise<void> {
  const storedTheme = localStorage.getItem('memory-theme')
  document.documentElement.dataset.theme = storedTheme === 'dark' || storedTheme === 'light' ? storedTheme : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  installKeyboardShortcuts()
  await render()
  if ('serviceWorker' in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined)
  window.setTimeout(() => void autoSync(), 500)
  window.setInterval(() => void autoSync(), 60_000)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void autoSync() })
  window.addEventListener('online', () => void autoSync())
  window.addEventListener('offline', () => { if (currentPage === 'home') void render() })
}

void bootstrap().catch((error) => {
  app.innerHTML = `<div class="app-shell"><main class="main"><section class="panel"><h1>起動できませんでした</h1><p class="muted">${escapeHtml(error instanceof Error ? error.message : '不明なエラー')}</p></section></main></div>`
})
