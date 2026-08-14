import { Rating, State } from 'ts-fsrs'
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
} from './db'
import { exportCardsToCsv, importCardsFromCsv } from './csv'
import { createSchedule, isCardComplete, reviewCard } from './scheduler'
import { flushPendingReviews } from './review-sync'
import { syncGoogleSheet } from './sheets'
import type { MemoryCard } from './types'

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
let selectedChoice: 1 | 2 | 3 | 4 | null = null
let studyQueueInitialized = false
let syncInProgress = false
let lastAutoSyncError = ''

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
  if (!value) return 'まだ同期していません'
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
  window.setTimeout(() => toast.remove(), 3200)
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

async function renderHome(): Promise<string> {
  const [cards, reviews, settings, pending] = await Promise.all([
    getAllCards(), getAllReviews(), getSettings(), getPendingReviews(),
  ])
  const active = cards.filter((card) => !card.archived)
  const complete = active.filter(isCardComplete)
  const incomplete = active.length - complete.length
  const now = Date.now()
  const dueReviews = complete.filter((card) => card.fsrs.state !== State.New && card.fsrs.due <= now).length
  const newCards = complete.filter((card) => card.fsrs.state === State.New).length
  const availableNew = Math.min(settings.newCardsPerDay, newCards)
  const today = localDateKey(now)
  const todayReviews = reviews.filter((review) => localDateKey(review.reviewedAt) === today).length
  const correctToday = reviews.filter((review) => localDateKey(review.reviewedAt) === today && review.correct).length
  const streak = computeStreak(reviews.map((review) => review.reviewedAt))

  return `
    <header class="page-header">
      <div><h1>今日の学習</h1><p>4択で回答し、正誤は自分で選びます。</p></div>
      <div class="sync-status"><span class="dot ${navigator.onLine ? '' : 'offline'}"></span>${navigator.onLine ? 'オンライン' : 'オフライン'}</div>
    </header>
    <div class="grid">
      <section class="panel span-8">
        <div class="metric"><span class="metric-label">今日取り組めるカード</span><span class="metric-value">${dueReviews + availableNew}</span></div>
        <p class="muted">復習 ${dueReviews}枚 ＋ 新規 ${availableNew}枚</p>
        <div class="actions"><button class="primary" type="button" data-action="start-study" ${dueReviews + availableNew === 0 ? 'disabled' : ''}>学習を始める</button><button class="secondary" type="button" data-action="sync-sheet">問題を同期</button></div>
      </section>
      <section class="panel span-4"><div class="metric"><span class="metric-label">連続学習</span><span class="metric-value">${streak}日</span></div><p class="muted">今日 ${todayReviews}問 / 正解 ${correctToday}問</p></section>
      <section class="panel span-6 flat"><h3>Google Sheets</h3><p class="muted">最終同期 ${escapeHtml(formatDateTime(settings.lastSyncAt))}</p><p class="small muted">A: 問題文 / B〜E: 答え1〜4</p></section>
      <section class="panel span-6 flat"><h3>データ状態</h3><p class="muted">カード ${complete.length}枚${incomplete ? ` / 未完成 ${incomplete}枚` : ''}</p><p class="small muted">Sheet2未送信の回答記録 ${pending.length}件</p></section>
    </div>
  `
}

async function initializeStudyQueue(): Promise<void> {
  const [cards, settings] = await Promise.all([getAllCards(), getSettings()])
  const now = Date.now()
  const active = cards.filter((card) => !card.archived && isCardComplete(card))
  const due = active.filter((card) => card.fsrs.state !== State.New && card.fsrs.due <= now).sort((a, b) => a.fsrs.due - b.fsrs.due)
  const fresh = active.filter((card) => card.fsrs.state === State.New).sort((a, b) => a.createdAt - b.createdAt).slice(0, settings.newCardsPerDay)
  studyQueue = [...due, ...fresh]
  studyPosition = 0
  selectedChoice = null
  studyQueueInitialized = true
  resetQuestionTimer(settings.questionTimerSeconds)
}

async function renderStudy(): Promise<string> {
  if (!studyQueueInitialized) await initializeStudyQueue()
  const card = studyQueue[studyPosition]
  if (!card) {
    pauseTimer()
    return `
      <header class="page-header"><div><h1>学習完了</h1><p>今回のセッションは終了です。</p></div></header>
      <section class="panel empty"><strong>おつかれさまでした</strong>回答履歴は端末に保存され、設定済みならSheet2へ送信されます。<div class="actions center-actions"><button class="primary" data-page="home" type="button">ホームへ</button></div></section>
    `
  }

  const choices = card.choices.map((choice, index) => `
    <button class="choice-button${selectedChoice === index + 1 ? ' selected' : ''}" type="button" data-choice="${index + 1}">
      <span class="choice-number">${index + 1}</span><span>${textBlock(choice)}</span>
    </button>
  `).join('')

  return `
    <header class="page-header study-header">
      <div><h1>学習</h1><p>${studyPosition + 1} / ${studyQueue.length}　${escapeHtml(card.deck)}</p></div>
      <div class="study-header-actions"><div id="question-timer" class="question-timer">00:00</div><button class="ghost" type="button" data-action="end-study">終了</button></div>
    </header>
    <section class="study-layout">
      <div class="panel question-panel">
        <div class="study-question">${textBlock(card.question)}</div>
        <div class="choice-grid">${choices}</div>
        <div id="self-assessment" class="self-assessment" ${selectedChoice ? '' : 'hidden'}>
          <div><strong>この回答はどうでしたか？</strong><span id="selected-answer-label" class="muted small">${selectedChoice ? `答え${selectedChoice}を選択` : ''}</span></div>
          <div class="self-buttons">
            <button class="self-button correct" type="button" data-self-result="correct">正解だった</button>
            <button class="self-button incorrect" type="button" data-self-result="incorrect">間違えた</button>
          </div>
        </div>
        ${card.note ? `<div class="study-note">${textBlock(card.note)}</div>` : ''}
      </div>
      <aside class="panel scratch-panel">
        <div class="scratch-toolbar"><div><strong>計算・メモ</strong><span class="small muted">次の問題で自動消去</span></div><button class="secondary compact" type="button" data-action="clear-scratch">全消去</button></div>
        <canvas id="scratchpad" class="scratchpad" aria-label="計算やメモを書く領域"></canvas>
        <div class="timer-controls"><button class="secondary" type="button" data-action="timer-toggle">一時停止</button><button class="secondary" type="button" data-action="timer-reset">タイマーをリセット</button></div>
      </aside>
    </section>
    <p class="small muted keyboard-help">外付けキーボード: 1〜4で回答 / Cで正解 / Xで不正解</p>
  `
}

async function renderEditor(): Promise<string> {
  const existing = editingId ? (await getAllCards()).find((card) => card.id === editingId) : undefined
  const title = existing ? 'カードを編集' : 'カードを追加'
  const answerFields = [0, 1, 2, 3].map((index) => `
    <div class="field"><label for="answer${index + 1}">答え${index + 1}</label><textarea id="answer${index + 1}" name="answer${index + 1}" required>${existing ? escapeHtml(existing.choices[index]) : ''}</textarea></div>
  `).join('')

  return `
    <header class="page-header"><div><h1>${title}</h1><p>正解の指定は不要です。4つの選択肢だけ登録します。</p></div></header>
    <section class="panel">
      ${existing?.source === 'google-sheet' ? '<div class="notice">Sheets由来のカードは次回同期時にA〜E列の内容へ戻ります。</div>' : ''}
      <form class="form" id="card-form">
        <div class="field"><label for="question">問題文</label><textarea id="question" name="question" required autocomplete="off">${existing ? escapeHtml(existing.question) : ''}</textarea></div>
        <div class="answer-editor-grid">${answerFields}</div>
        <div class="field-row"><div class="field"><label for="deck">デッキ</label><input id="deck" name="deck" value="${escapeHtml(existing?.deck ?? '一般')}" maxlength="80"></div><div class="field"><label for="tags">タグ</label><input id="tags" name="tags" value="${escapeHtml(existing?.tags.join(', ') ?? '')}" placeholder="数学, 高専"></div></div>
        <div class="field"><label for="note">メモ</label><textarea id="note" name="note" placeholder="任意の補足">${existing ? escapeHtml(existing.note) : ''}</textarea></div>
        <div class="actions"><button class="primary" type="submit">${existing ? '保存' : '登録'}</button>${existing ? '<button class="secondary" type="button" data-page="cards">キャンセル</button>' : ''}</div>
      </form>
    </section>
  `
}

async function renderCards(): Promise<string> {
  const all = (await getAllCards()).filter((card) => !card.archived)
  const query = searchTerm.trim().toLowerCase()
  const filtered = query ? all.filter((card) => [card.question, ...card.choices, card.deck, card.note, ...card.tags].some((value) => value.toLowerCase().includes(query))) : all
  filtered.sort((a, b) => b.updatedAt - a.updatedAt)
  const shown = filtered.slice(0, 300)
  const rows = shown.map((card) => `
    <article class="card-row">
      <div><div class="card-front">${textBlock(card.question)}</div><ol class="choice-preview">${card.choices.map((choice) => `<li>${choice ? textBlock(choice) : '<em>未登録</em>'}</li>`).join('')}</ol><div class="badges"><span class="badge">${escapeHtml(card.deck)}</span><span class="badge">${card.source === 'google-sheet' ? `Sheets${card.sourceRow ? ` #${card.sourceRow}` : ''}` : 'サイト登録'}</span><span class="badge">${isCardComplete(card) ? '学習可能' : '未完成'}</span>${card.tags.map((tag) => `<span class="badge">#${escapeHtml(tag)}</span>`).join('')}</div></div>
      <div class="actions"><button class="icon-button" type="button" data-edit-card="${card.id}">編集</button><button class="icon-button" type="button" data-delete-card="${card.id}">削除</button></div>
    </article>
  `).join('')
  return `
    <header class="page-header"><div><h1>カード</h1><p>${filtered.length}枚${filtered.length > 300 ? '（先頭300枚を表示）' : ''}</p></div><button class="primary" type="button" data-page="add">＋ 追加</button></header>
    <div class="search-wrap"><input class="search" id="card-search" type="search" value="${escapeHtml(searchTerm)}" placeholder="問題・答え・デッキ・タグを検索"></div>
    <div class="card-list">${rows || '<section class="panel empty"><strong>カードがありません</strong>サイトまたはGoogle Sheetsから追加できます。</section>'}</div>
  `
}

async function renderStats(): Promise<string> {
  const reviews = await getAllReviews()
  const today = localDateKey(Date.now())
  const todayReviews = reviews.filter((review) => localDateKey(review.reviewedAt) === today)
  const correct = reviews.filter((review) => review.correct).length
  const incorrect = reviews.length - correct
  const pending = reviews.filter((review) => review.sheetSyncStatus !== 'sent').length
  const streak = computeStreak(reviews.map((review) => review.reviewedAt))
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
      <section class="panel span-3"><div class="metric"><span class="metric-label">平均</span><span class="metric-value">${averageSeconds}秒</span></div><p class="muted">回答時間</p></section>
      <section class="panel span-8"><h3>直近7日</h3><div class="bar-list">${days.map((day) => `<div class="bar-row"><span>${day.label}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round((day.count / max) * 100)}%"></div></div><strong>${day.count}</strong></div>`).join('')}</div></section>
      <section class="panel span-4"><h3>同期</h3><p class="small muted">連続学習 ${streak}日</p><p class="small muted">Sheet2未送信 ${pending}件</p><p class="small muted">FSRS: 正解→Good / 不正解→Again</p></section>
    </div>
  `
}

async function renderSettings(): Promise<string> {
  const settings = await getSettings()
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(settings.sheetId)}/edit?gid=${encodeURIComponent(settings.sheetGid)}#gid=${encodeURIComponent(settings.sheetGid)}`
  const theme = document.documentElement.dataset.theme ?? 'light'
  return `
    <header class="page-header"><div><h1>設定</h1><p>問題同期、タイマー、Sheet2記録を設定します。</p></div></header>
    <div class="grid">
      <section class="panel span-12"><h3>Google Sheets 問題同期</h3><div class="notice"><strong>A=問題文 / B=答え1 / C=答え2 / D=答え3 / E=答え4</strong><br>5項目が揃わない行はスキップします。</div><form class="form" id="settings-form">
        <div class="field"><label for="sheetId">Spreadsheet ID</label><input id="sheetId" name="sheetId" value="${escapeHtml(settings.sheetId)}" required></div>
        <div class="field-row"><div class="field"><label for="sheetGid">問題シート gid</label><input id="sheetGid" name="sheetGid" inputmode="numeric" value="${escapeHtml(settings.sheetGid)}" required></div><div class="field"><label for="newCardsPerDay">1日の新規カード上限</label><input id="newCardsPerDay" name="newCardsPerDay" type="number" min="0" max="500" value="${settings.newCardsPerDay}" required></div></div>
        <div class="field"><label for="questionTimerSeconds">1問のタイマー（秒）</label><input id="questionTimerSeconds" name="questionTimerSeconds" type="number" min="10" max="3600" value="${settings.questionTimerSeconds}" required></div>
        <label class="check-row"><input id="autoSync" name="autoSync" type="checkbox" ${settings.autoSync ? 'checked' : ''}> サイトを開いている間、自動同期する</label>
        <hr class="divider"><h3>Sheet2 回答記録</h3><p class="help">Apps Script Web Appを1回デプロイし、そのURLとWRITE_TOKENを入力します。トークンはGitHubには保存されず、この端末のIndexedDBだけに保存されます。</p>
        <div class="field"><label for="reviewWebAppUrl">Apps Script Web App URL</label><input id="reviewWebAppUrl" name="reviewWebAppUrl" type="url" value="${escapeHtml(settings.reviewWebAppUrl)}" placeholder="https://script.google.com/macros/s/.../exec"></div>
        <div class="field"><label for="reviewWriteToken">WRITE_TOKEN</label><input id="reviewWriteToken" name="reviewWriteToken" type="password" value="${escapeHtml(settings.reviewWriteToken)}" autocomplete="off"></div>
        <div class="actions"><button class="primary" type="submit">設定を保存</button><button class="secondary" type="button" data-action="sync-sheet">問題を同期</button><button class="secondary" type="button" data-action="flush-reviews">未送信記録を送る</button><a class="secondary link-button" href="${sheetUrl}" target="_blank" rel="noopener noreferrer">スプレッドシートを開く</a></div>
        <p class="help">最終問題同期: ${escapeHtml(formatDateTime(settings.lastSyncAt))}${settings.lastSyncMessage ? ` / ${escapeHtml(settings.lastSyncMessage)}` : ''}</p>
      </form></section>
      <section class="panel span-6"><h3>バックアップ</h3><p class="small muted">カード、FSRS履歴、設定をJSONへ保存します。</p><div class="actions"><button class="secondary" type="button" data-action="export-backup">JSON保存</button><label class="secondary file-button">JSON復元<input id="backup-import" type="file" accept="application/json,.json" hidden></label></div></section>
      <section class="panel span-6"><h3>CSV</h3><p class="small muted">question, answer1, answer2, answer3, answer4, deck, tags, note</p><div class="actions"><button class="secondary" type="button" data-action="export-csv">CSV保存</button><label class="secondary file-button">CSV読込<input id="csv-import" type="file" accept="text/csv,.csv" hidden></label></div></section>
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
    if (showResult && !navigator.onLine) showToast('オフラインのため同期できません。')
    return
  }
  syncInProgress = true
  try {
    const summary = await syncGoogleSheet()
    lastAutoSyncError = ''
    if (showResult) showToast(`同期完了: ${summary.created}件追加・${summary.updated}件更新・${summary.skipped}件スキップ`)
    if (['home', 'cards', 'settings'].includes(currentPage)) await render()
  } catch (error) {
    const message = error instanceof Error ? error.message : '同期に失敗しました。'
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
  pauseTimer()
  const result = reviewCard(card, correct, selectedChoice, timerElapsedMs())
  await saveReviewResult(result.card, result.review)
  studyQueue[studyPosition] = result.card
  studyPosition += 1
  selectedChoice = null
  const settings = await getSettings()
  resetQuestionTimer(settings.questionTimerSeconds)
  await render()
  void flushPendingReviews()
}

function selectChoice(choice: 1 | 2 | 3 | 4): void {
  selectedChoice = choice
  document.querySelectorAll<HTMLElement>('[data-choice]').forEach((button) => {
    button.classList.toggle('selected', Number(button.dataset.choice) === choice)
  })
  const assessment = document.getElementById('self-assessment')
  if (assessment) assessment.hidden = false
  const label = document.getElementById('selected-answer-label')
  if (label) label.textContent = `答え${choice}を選択`
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

  document.querySelector('[data-action="clear-scratch"]')?.addEventListener('click', () => {
    context.clearRect(0, 0, rect.width, rect.height)
  })
}

function attachHandlers(): void {
  document.querySelectorAll<HTMLElement>('[data-page]').forEach((button) => button.addEventListener('click', () => goTo(button.dataset.page as Page)))
  document.querySelector('[data-action="start-study"]')?.addEventListener('click', () => goTo('study'))
  document.querySelector('[data-action="end-study"]')?.addEventListener('click', () => goTo('home'))
  document.querySelectorAll<HTMLElement>('[data-choice]').forEach((button) => button.addEventListener('click', () => {
    const choice = Number(button.dataset.choice)
    if ([1, 2, 3, 4].includes(choice)) selectChoice(choice as 1 | 2 | 3 | 4)
  }))
  document.querySelectorAll<HTMLElement>('[data-self-result]').forEach((button) => button.addEventListener('click', () => void completeCurrentReview(button.dataset.selfResult === 'correct')))

  document.querySelector('[data-action="timer-toggle"]')?.addEventListener('click', () => timerRunning ? pauseTimer() : resumeTimer())
  document.querySelector('[data-action="timer-reset"]')?.addEventListener('click', () => resetQuestionTimer(Math.round(timerDurationMs / 1000)))
  document.querySelectorAll('[data-action="sync-sheet"]').forEach((button) => button.addEventListener('click', () => void runSheetSync(true)))
  document.querySelector('[data-action="flush-reviews"]')?.addEventListener('click', async () => {
    const result = await flushPendingReviews(100)
    showToast(result.sent ? `${result.sent}件をSheet2へ送信しました。` : '送信できる記録がありません。設定・通信を確認してください。')
    await render()
  })

  const form = document.querySelector<HTMLFormElement>('#card-form')
  form?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    const question = String(data.get('question') ?? '').trim()
    const choices: [string, string, string, string] = [1, 2, 3, 4].map((index) => String(data.get(`answer${index}`) ?? '').trim()) as [string, string, string, string]
    if (!question || choices.some((choice) => !choice)) {
      showToast('問題文と4つの答えをすべて入力してください。')
      return
    }
    const now = Date.now()
    const existing = editingId ? (await getAllCards()).find((card) => card.id === editingId) : undefined
    const card: MemoryCard = existing ? {
      ...existing, question, choices,
      deck: String(data.get('deck') ?? '').trim() || '一般',
      tags: String(data.get('tags') ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
      note: String(data.get('note') ?? '').trim(), updatedAt: now,
    } : {
      id: crypto.randomUUID(), question, choices,
      deck: String(data.get('deck') ?? '').trim() || '一般',
      tags: String(data.get('tags') ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
      note: String(data.get('note') ?? '').trim(), source: 'manual', createdAt: now, updatedAt: now, archived: false,
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
    const sheetId = String(data.get('sheetId') ?? '').trim()
    const sheetGid = String(data.get('sheetGid') ?? '').trim()
    const reviewWebAppUrl = String(data.get('reviewWebAppUrl') ?? '').trim()
    const reviewWriteToken = String(data.get('reviewWriteToken') ?? '').trim()
    const newCardsPerDay = Math.min(500, Math.max(0, Number(data.get('newCardsPerDay') ?? 20)))
    const questionTimerSeconds = Math.min(3600, Math.max(10, Number(data.get('questionTimerSeconds') ?? 180)))
    if (!/^[\w-]+$/.test(sheetId) || !/^\d+$/.test(sheetGid)) {
      showToast('Spreadsheet IDまたはgidが正しくありません。')
      return
    }
    if (reviewWebAppUrl && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/.test(reviewWebAppUrl)) {
      showToast('Apps Script Web App URLは /exec で終わるURLを入力してください。')
      return
    }
    await saveSettings({ ...current, sheetId, sheetGid, autoSync: data.get('autoSync') === 'on', newCardsPerDay, questionTimerSeconds, reviewWebAppUrl, reviewWriteToken })
    showToast('設定を保存しました。')
    await render()
    void flushPendingReviews()
  })

  document.querySelector('[data-action="export-backup"]')?.addEventListener('click', async () => downloadFile(`memory-backup-${localDateKey(Date.now())}.json`, await exportBackup(), 'application/json;charset=utf-8'))
  document.querySelector<HTMLInputElement>('#backup-import')?.addEventListener('change', async (event) => {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file || !window.confirm('現在の端末内データをバックアップ内容で置き換えますか？')) return
    try {
      await importBackup(await file.text())
      studyQueueInitialized = false
      showToast('バックアップを復元しました。')
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
    const choiceKeys: Record<string, 1 | 2 | 3 | 4> = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4 }
    const choice = choiceKeys[event.code]
    if (choice) {
      event.preventDefault()
      selectChoice(choice)
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
  if (settings.autoSync && document.visibilityState === 'visible') await runSheetSync(false)
  if (document.visibilityState === 'visible') await flushPendingReviews()
}

async function bootstrap(): Promise<void> {
  const storedTheme = localStorage.getItem('memory-theme')
  document.documentElement.dataset.theme = storedTheme === 'dark' || storedTheme === 'light' ? storedTheme : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  installKeyboardShortcuts()
  await render()
  if ('serviceWorker' in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined)
  window.setTimeout(() => void autoSync(), 400)
  window.setInterval(() => void autoSync(), 60_000)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void autoSync() })
  window.addEventListener('online', () => void autoSync())
  window.addEventListener('offline', () => { if (currentPage === 'home') void render() })
}

void bootstrap().catch((error) => {
  app.innerHTML = `<div class="app-shell"><main class="main"><section class="panel"><h1>起動できませんでした</h1><p class="muted">${escapeHtml(error instanceof Error ? error.message : '不明なエラー')}</p></section></main></div>`
})
