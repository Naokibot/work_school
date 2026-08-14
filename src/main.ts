import { Rating, State, type Grade } from 'ts-fsrs'
import './styles.css'
import {
  deleteCard,
  exportBackup,
  getAllCards,
  getAllReviews,
  getSettings,
  importBackup,
  putCard,
  putCards,
  saveReviewResult,
  saveSettings,
} from './db'
import { exportCardsToCsv, importCardsFromCsv } from './csv'
import { createSchedule, previewIntervals, reviewCard } from './scheduler'
import { syncGoogleSheet } from './sheets'
import type { MemoryCard } from './types'

type Page = 'home' | 'study' | 'add' | 'cards' | 'stats' | 'settings'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('App root was not found')

let currentPage: Page = 'home'
let editingId: string | null = null
let searchTerm = ''
let studyQueue: MemoryCard[] = []
let studyPosition = 0
let studyAnswerVisible = false
let studyQueueInitialized = false
let syncInProgress = false
let lastAutoSyncError = ''

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
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
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
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatDue(value: number): string {
  const diff = value - Date.now()
  if (diff <= 0) return '復習時刻です'
  const minutes = Math.max(1, Math.round(diff / 60_000))
  if (minutes < 60) return `${minutes}分後`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}時間後`
  const days = Math.round(hours / 24)
  return `${days}日後`
}

function formatInterval(value: Date): string {
  return formatDue(value.getTime())
}

function computeStreak(reviewTimes: number[]): number {
  const days = new Set(reviewTimes.map(localDateKey))
  const cursor = new Date()
  cursor.setHours(0, 0, 0, 0)
  if (!days.has(localDateKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1)
  }

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
        <div class="sidebar-meta">FSRSで復習時期を自動調整<br>データはこの端末に保存</div>
      </aside>
      <main class="main">${content}</main>
      <nav class="mobile-nav">${mobileNav}</nav>
    </div>
  `
}

async function renderHome(): Promise<string> {
  const [cards, reviews, settings] = await Promise.all([getAllCards(), getAllReviews(), getSettings()])
  const active = cards.filter((card) => !card.archived)
  const now = Date.now()
  const dueReviews = active.filter((card) => card.fsrs.state !== State.New && card.fsrs.due <= now).length
  const newCards = active.filter((card) => card.fsrs.state === State.New).length
  const availableNew = Math.min(settings.newCardsPerDay, newCards)
  const today = localDateKey(now)
  const todayReviews = reviews.filter((review) => localDateKey(review.reviewedAt) === today).length
  const streak = computeStreak(reviews.map((review) => review.reviewedAt))
  const sheetCards = active.filter((card) => card.source === 'google-sheet').length

  return `
    <header class="page-header">
      <div>
        <h1>今日の学習</h1>
        <p>期限が来たカードから進めます。</p>
      </div>
      <div class="sync-status"><span class="dot ${navigator.onLine ? '' : 'offline'}"></span>${navigator.onLine ? 'オンライン' : 'オフライン'}</div>
    </header>

    <div class="grid">
      <section class="panel span-8">
        <div class="metric">
          <span class="metric-label">今日取り組めるカード</span>
          <span class="metric-value">${dueReviews + availableNew}</span>
        </div>
        <p class="muted">復習 ${dueReviews}枚 ＋ 新規 ${availableNew}枚${newCards > availableNew ? `（未学習 ${newCards}枚）` : ''}</p>
        <div class="actions">
          <button class="primary" type="button" data-action="start-study" ${dueReviews + availableNew === 0 ? 'disabled' : ''}>学習を始める</button>
          <button class="secondary" type="button" data-action="sync-sheet" ${syncInProgress ? 'disabled' : ''}>スプレッドシート同期</button>
        </div>
      </section>

      <section class="panel span-4">
        <div class="metric"><span class="metric-label">連続学習</span><span class="metric-value">${streak}日</span></div>
        <p class="muted">今日の回答 ${todayReviews}回</p>
      </section>

      <section class="panel span-6 flat">
        <h3>Google Sheets</h3>
        <p class="muted">同期済み ${sheetCards}枚</p>
        <div class="sync-status"><span class="dot"></span>最終同期 ${escapeHtml(formatDateTime(settings.lastSyncAt))}</div>
        <p class="small muted">A列を問題、B列を答えとして読み込みます。サイトを開いている間は自動同期します。</p>
      </section>

      <section class="panel span-6 flat">
        <h3>カード</h3>
        <p class="muted">合計 ${active.length}枚</p>
        <div class="actions">
          <button class="secondary" type="button" data-page="add">サイトから追加</button>
          <button class="secondary" type="button" data-page="cards">一覧を見る</button>
        </div>
      </section>
    </div>
  `
}

async function initializeStudyQueue(): Promise<void> {
  const [cards, settings] = await Promise.all([getAllCards(), getSettings()])
  const now = Date.now()
  const active = cards.filter((card) => !card.archived)
  const due = active
    .filter((card) => card.fsrs.state !== State.New && card.fsrs.due <= now)
    .sort((a, b) => a.fsrs.due - b.fsrs.due)
  const fresh = active
    .filter((card) => card.fsrs.state === State.New)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, settings.newCardsPerDay)

  studyQueue = [...due, ...fresh]
  studyPosition = 0
  studyAnswerVisible = false
  studyQueueInitialized = true
}

async function renderStudy(): Promise<string> {
  if (!studyQueueInitialized) await initializeStudyQueue()
  const card = studyQueue[studyPosition]

  if (!card) {
    return `
      <header class="page-header"><div><h1>学習</h1><p>今回のセッションは完了です。</p></div></header>
      <section class="panel empty">
        <strong>おつかれさまでした</strong>
        次の復習時刻になると、またホームにカードが表示されます。
        <div class="actions" style="justify-content:center;margin-top:22px"><button class="primary" data-page="home" type="button">ホームへ</button></div>
      </section>
    `
  }

  const progress = `${studyPosition + 1} / ${studyQueue.length}`
  let bottom = `<button class="primary" type="button" data-action="show-answer">答えを見る</button>`

  if (studyAnswerVisible) {
    const preview = previewIntervals(card)
    bottom = `
      <div class="rating-grid">
        <button class="rating again" type="button" data-rating="${Rating.Again}">もう一度<span>${escapeHtml(formatInterval(preview[Rating.Again]))}</span></button>
        <button class="rating" type="button" data-rating="${Rating.Hard}">難しい<span>${escapeHtml(formatInterval(preview[Rating.Hard]))}</span></button>
        <button class="rating" type="button" data-rating="${Rating.Good}">普通<span>${escapeHtml(formatInterval(preview[Rating.Good]))}</span></button>
        <button class="rating easy" type="button" data-rating="${Rating.Easy}">簡単<span>${escapeHtml(formatInterval(preview[Rating.Easy]))}</span></button>
      </div>
    `
  }

  return `
    <header class="page-header">
      <div><h1>学習</h1><p>思い出してから答えを表示してください。</p></div>
      <button class="ghost" type="button" data-action="end-study">終了</button>
    </header>
    <section class="panel study-card">
      <div class="study-top"><span>${escapeHtml(card.deck)}</span><span>${progress}</span></div>
      <div class="study-content">
        <div>
          <div class="study-front">${textBlock(card.front)}</div>
          ${studyAnswerVisible ? `<div class="study-answer">${textBlock(card.back)}</div>${card.note ? `<div class="study-note">${textBlock(card.note)}</div>` : ''}` : ''}
        </div>
      </div>
      <div>${bottom}</div>
    </section>
    <p class="small muted" style="text-align:center">外付けキーボード: Spaceで答え / 1〜4で評価</p>
  `
}

async function renderEditor(): Promise<string> {
  const existing = editingId ? (await getAllCards()).find((card) => card.id === editingId) : undefined
  const title = existing ? 'カードを編集' : 'カードを追加'

  return `
    <header class="page-header"><div><h1>${title}</h1><p>問題と答えを登録します。</p></div></header>
    <section class="panel">
      ${existing?.source === 'google-sheet' ? '<div class="notice" style="margin-bottom:18px">このカードはGoogle Sheets由来です。ここで問題・答えを変更しても、次回同期時にA/B列の内容へ戻ります。</div>' : ''}
      <form class="form" id="card-form">
        <div class="field"><label for="front">問題</label><textarea id="front" name="front" required autocomplete="off" placeholder="例：lend の意味は？">${existing ? escapeHtml(existing.front) : ''}</textarea></div>
        <div class="field"><label for="back">答え</label><textarea id="back" name="back" required autocomplete="off" placeholder="例：貸す">${existing ? escapeHtml(existing.back) : ''}</textarea></div>
        <div class="field-row">
          <div class="field"><label for="deck">デッキ</label><input id="deck" name="deck" value="${escapeHtml(existing?.deck ?? '一般')}" maxlength="80"></div>
          <div class="field"><label for="tags">タグ</label><input id="tags" name="tags" value="${escapeHtml(existing?.tags.join(', ') ?? '')}" placeholder="英語, 高専"></div>
        </div>
        <div class="field"><label for="note">メモ</label><textarea id="note" name="note" placeholder="補足や例文">${existing ? escapeHtml(existing.note) : ''}</textarea></div>
        <div class="actions"><button class="primary" type="submit">${existing ? '保存' : '登録'}</button>${existing ? '<button class="secondary" type="button" data-page="cards">キャンセル</button>' : ''}</div>
      </form>
    </section>
  `
}

async function renderCards(): Promise<string> {
  const all = (await getAllCards()).filter((card) => !card.archived)
  const query = searchTerm.trim().toLowerCase()
  const filtered = query ? all.filter((card) => [card.front, card.back, card.deck, card.note, ...card.tags].some((value) => value.toLowerCase().includes(query))) : all
  filtered.sort((a, b) => b.updatedAt - a.updatedAt)
  const shown = filtered.slice(0, 300)

  const rows = shown.map((card) => `
    <article class="card-row">
      <div>
        <div class="card-front">${textBlock(card.front)}</div>
        <div class="card-back">${textBlock(card.back)}</div>
        <div class="badges">
          <span class="badge">${escapeHtml(card.deck)}</span>
          <span class="badge">${card.source === 'google-sheet' ? `Sheets${card.sourceRow ? ` #${card.sourceRow}` : ''}` : 'サイト登録'}</span>
          <span class="badge">${escapeHtml(formatDue(card.fsrs.due))}</span>
          ${card.tags.map((tag) => `<span class="badge">#${escapeHtml(tag)}</span>`).join('')}
        </div>
      </div>
      <div class="actions">
        <button class="icon-button" type="button" aria-label="編集" data-edit-card="${card.id}">編集</button>
        <button class="icon-button" type="button" aria-label="削除" data-delete-card="${card.id}">削除</button>
      </div>
    </article>
  `).join('')

  return `
    <header class="page-header">
      <div><h1>カード</h1><p>${filtered.length}枚${filtered.length > 300 ? '（先頭300枚を表示）' : ''}</p></div>
      <button class="primary" type="button" data-page="add">＋ 追加</button>
    </header>
    <div style="margin-bottom:16px"><input class="search" id="card-search" type="search" value="${escapeHtml(searchTerm)}" placeholder="問題・答え・デッキ・タグを検索"></div>
    <div class="card-list">${rows || '<section class="panel empty"><strong>カードがありません</strong>サイトまたはGoogle Sheetsから追加できます。</section>'}</div>
  `
}

async function renderStats(): Promise<string> {
  const reviews = await getAllReviews()
  const today = localDateKey(Date.now())
  const todayCount = reviews.filter((review) => localDateKey(review.reviewedAt) === today).length
  const streak = computeStreak(reviews.map((review) => review.reviewedAt))
  const counts = {
    again: reviews.filter((r) => r.rating === Rating.Again).length,
    hard: reviews.filter((r) => r.rating === Rating.Hard).length,
    good: reviews.filter((r) => r.rating === Rating.Good).length,
    easy: reviews.filter((r) => r.rating === Rating.Easy).length,
  }

  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - (6 - index))
    const key = localDateKey(date)
    return {
      label: new Intl.DateTimeFormat('ja-JP', { weekday: 'short' }).format(date),
      count: reviews.filter((review) => localDateKey(review.reviewedAt) === key).length,
    }
  })
  const max = Math.max(1, ...days.map((day) => day.count))

  return `
    <header class="page-header"><div><h1>統計</h1><p>端末に保存された回答履歴です。</p></div></header>
    <div class="grid">
      <section class="panel span-4"><div class="metric"><span class="metric-label">今日</span><span class="metric-value">${todayCount}</span></div><p class="muted">回答回数</p></section>
      <section class="panel span-4"><div class="metric"><span class="metric-label">連続</span><span class="metric-value">${streak}日</span></div><p class="muted">学習ストリーク</p></section>
      <section class="panel span-4"><div class="metric"><span class="metric-label">累計</span><span class="metric-value">${reviews.length}</span></div><p class="muted">回答回数</p></section>
      <section class="panel span-8">
        <h3>直近7日</h3>
        <div class="bar-list">${days.map((day) => `<div class="bar-row"><span>${day.label}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round((day.count / max) * 100)}%"></div></div><strong>${day.count}</strong></div>`).join('')}</div>
      </section>
      <section class="panel span-4">
        <h3>評価</h3>
        <p class="small muted">もう一度 ${counts.again}</p>
        <p class="small muted">難しい ${counts.hard}</p>
        <p class="small muted">普通 ${counts.good}</p>
        <p class="small muted">簡単 ${counts.easy}</p>
      </section>
    </div>
  `
}

async function renderSettings(): Promise<string> {
  const settings = await getSettings()
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(settings.sheetId)}/edit?gid=${encodeURIComponent(settings.sheetGid)}#gid=${encodeURIComponent(settings.sheetGid)}`
  const theme = document.documentElement.dataset.theme ?? 'light'

  return `
    <header class="page-header"><div><h1>設定</h1><p>同期・学習量・バックアップを管理します。</p></div></header>
    <div class="grid">
      <section class="panel span-12">
        <h3>Google Sheets同期</h3>
        <div class="notice" style="margin-bottom:18px"><strong>A列＝問題、B列＝答え</strong> として読み込みます。シートは「リンクを知っている全員が閲覧可」など、Webサイトから閲覧できる共有設定にしてください。</div>
        <form class="form" id="settings-form">
          <div class="field"><label for="sheetId">Spreadsheet ID</label><input id="sheetId" name="sheetId" value="${escapeHtml(settings.sheetId)}" required></div>
          <div class="field-row">
            <div class="field"><label for="sheetGid">gid</label><input id="sheetGid" name="sheetGid" inputmode="numeric" value="${escapeHtml(settings.sheetGid)}" required></div>
            <div class="field"><label for="newCardsPerDay">1日の新規カード上限</label><input id="newCardsPerDay" name="newCardsPerDay" type="number" min="0" max="500" value="${settings.newCardsPerDay}" required></div>
          </div>
          <label class="actions"><input id="autoSync" name="autoSync" type="checkbox" ${settings.autoSync ? 'checked' : ''}> サイトを開いている間、自動同期する</label>
          <div class="actions"><button class="primary" type="submit">設定を保存</button><button class="secondary" type="button" data-action="sync-sheet">今すぐ同期</button><a class="secondary" href="${sheetUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-grid;place-items:center;text-decoration:none">スプレッドシートを開く</a></div>
          <p class="help">最終同期: ${escapeHtml(formatDateTime(settings.lastSyncAt))}${settings.lastSyncMessage ? ` / ${escapeHtml(settings.lastSyncMessage)}` : ''}</p>
        </form>
      </section>

      <section class="panel span-6">
        <h3>バックアップ</h3>
        <p class="muted small">FSRSの学習履歴を含めてJSONへ保存できます。iPadの端末交換前にも利用してください。</p>
        <div class="actions"><button class="secondary" type="button" data-action="export-backup">JSON保存</button><label class="secondary" style="display:inline-grid;place-items:center;cursor:pointer">JSON復元<input id="backup-import" type="file" accept="application/json,.json" hidden></label></div>
      </section>

      <section class="panel span-6">
        <h3>CSV</h3>
        <p class="muted small">列順: front, back, deck, tags, note。最初の2列だけでも読み込めます。</p>
        <div class="actions"><button class="secondary" type="button" data-action="export-csv">CSV保存</button><label class="secondary" style="display:inline-grid;place-items:center;cursor:pointer">CSV読込<input id="csv-import" type="file" accept="text/csv,.csv" hidden></label></div>
      </section>

      <section class="panel span-12 flat">
        <h3>表示</h3>
        <div class="actions"><button class="secondary" type="button" data-action="toggle-theme">${theme === 'dark' ? 'ライトモード' : 'ダークモード'}へ</button></div>
        <p class="help">iPadではSafariの共有メニューから「ホーム画面に追加」を選ぶとアプリのように起動できます。</p>
      </section>
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
}

function goTo(page: Page): void {
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
    if (showResult) showToast(`同期完了: ${summary.created}件追加・${summary.updated}件更新`)
    if (currentPage === 'home' || currentPage === 'cards' || currentPage === 'settings') await render()
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

function attachHandlers(): void {
  document.querySelectorAll<HTMLElement>('[data-page]').forEach((button) => {
    button.addEventListener('click', () => goTo(button.dataset.page as Page))
  })

  document.querySelector('[data-action="start-study"]')?.addEventListener('click', () => goTo('study'))
  document.querySelector('[data-action="end-study"]')?.addEventListener('click', () => goTo('home'))
  document.querySelector('[data-action="show-answer"]')?.addEventListener('click', () => {
    studyAnswerVisible = true
    void render()
  })
  document.querySelectorAll<HTMLElement>('[data-rating]').forEach((button) => {
    button.addEventListener('click', async () => {
      const current = studyQueue[studyPosition]
      if (!current) return
      const grade = Number(button.dataset.rating) as Grade
      if (![Rating.Again, Rating.Hard, Rating.Good, Rating.Easy].includes(grade)) return
      const result = reviewCard(current, grade)
      await saveReviewResult(result.card, result.review)
      studyQueue[studyPosition] = result.card
      studyPosition += 1
      studyAnswerVisible = false
      await render()
    })
  })

  document.querySelectorAll('[data-action="sync-sheet"]').forEach((button) => {
    button.addEventListener('click', () => void runSheetSync(true))
  })

  const form = document.querySelector<HTMLFormElement>('#card-form')
  form?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    const front = String(data.get('front') ?? '').trim()
    const back = String(data.get('back') ?? '').trim()
    if (!front || !back) return
    const now = Date.now()
    const existing = editingId ? (await getAllCards()).find((card) => card.id === editingId) : undefined
    const card: MemoryCard = existing ? {
      ...existing,
      front,
      back,
      deck: String(data.get('deck') ?? '').trim() || '一般',
      tags: String(data.get('tags') ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
      note: String(data.get('note') ?? '').trim(),
      updatedAt: now,
    } : {
      id: crypto.randomUUID(),
      front,
      back,
      deck: String(data.get('deck') ?? '').trim() || '一般',
      tags: String(data.get('tags') ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
      note: String(data.get('note') ?? '').trim(),
      source: 'manual',
      createdAt: now,
      updatedAt: now,
      archived: false,
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
    window.setTimeout(() => {
      if (currentPage === 'cards') void render()
    }, 120)
  })

  document.querySelectorAll<HTMLElement>('[data-edit-card]').forEach((button) => {
    button.addEventListener('click', () => {
      editingId = button.dataset.editCard ?? null
      currentPage = 'add'
      void render()
    })
  })
  document.querySelectorAll<HTMLElement>('[data-delete-card]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.deleteCard
      if (!id || !window.confirm('このカードと回答履歴を削除しますか？')) return
      await deleteCard(id)
      showToast('カードを削除しました。')
      await render()
    })
  })

  const settingsForm = document.querySelector<HTMLFormElement>('#settings-form')
  settingsForm?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const current = await getSettings()
    const data = new FormData(settingsForm)
    const sheetId = String(data.get('sheetId') ?? '').trim()
    const sheetGid = String(data.get('sheetGid') ?? '').trim()
    const newCardsPerDay = Math.min(500, Math.max(0, Number(data.get('newCardsPerDay') ?? 20)))
    if (!/^[\w-]+$/.test(sheetId) || !/^\d+$/.test(sheetGid)) {
      showToast('Spreadsheet IDまたはgidが正しくありません。')
      return
    }
    await saveSettings({ ...current, sheetId, sheetGid, autoSync: data.get('autoSync') === 'on', newCardsPerDay })
    showToast('設定を保存しました。')
    await render()
  })

  document.querySelector('[data-action="export-backup"]')?.addEventListener('click', async () => {
    const json = await exportBackup()
    downloadFile(`memory-backup-${localDateKey(Date.now())}.json`, json, 'application/json;charset=utf-8')
  })
  document.querySelector<HTMLInputElement>('#backup-import')?.addEventListener('change', async (event) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file || !window.confirm('現在の端末内データをバックアップ内容で置き換えますか？')) return
    try {
      await importBackup(await file.text())
      studyQueueInitialized = false
      showToast('バックアップを復元しました。')
      await render()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '復元に失敗しました。')
    } finally {
      input.value = ''
    }
  })

  document.querySelector('[data-action="export-csv"]')?.addEventListener('click', async () => {
    downloadFile(`memory-cards-${localDateKey(Date.now())}.csv`, exportCardsToCsv(await getAllCards()), 'text/csv;charset=utf-8')
  })
  document.querySelector<HTMLInputElement>('#csv-import')?.addEventListener('change', async (event) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    try {
      const cards = importCardsFromCsv(await file.text())
      await putCards(cards)
      showToast(`${cards.length}枚をCSVから追加しました。`)
      await render()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'CSVの読み込みに失敗しました。')
    } finally {
      input.value = ''
    }
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

    if (event.code === 'Space' && !studyAnswerVisible) {
      event.preventDefault()
      studyAnswerVisible = true
      void render()
      return
    }

    if (!studyAnswerVisible) return
    const grades: Record<string, Grade> = {
      Digit1: Rating.Again,
      Digit2: Rating.Hard,
      Digit3: Rating.Good,
      Digit4: Rating.Easy,
    }
    const grade = grades[event.code]
    if (!grade) return
    event.preventDefault()
    const current = studyQueue[studyPosition]
    if (!current) return
    const result = reviewCard(current, grade)
    void saveReviewResult(result.card, result.review).then(() => {
      studyQueue[studyPosition] = result.card
      studyPosition += 1
      studyAnswerVisible = false
      return render()
    })
  })
}

async function autoSync(): Promise<void> {
  const settings = await getSettings()
  if (settings.autoSync && document.visibilityState === 'visible') await runSheetSync(false)
}

async function bootstrap(): Promise<void> {
  const storedTheme = localStorage.getItem('memory-theme')
  if (storedTheme === 'dark' || storedTheme === 'light') {
    document.documentElement.dataset.theme = storedTheme
  } else {
    document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  installKeyboardShortcuts()
  await render()

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined)
  }

  window.setTimeout(() => void autoSync(), 400)
  window.setInterval(() => void autoSync(), 60_000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void autoSync()
  })
  window.addEventListener('online', () => void autoSync())
  window.addEventListener('offline', () => {
    if (currentPage === 'home') void render()
  })
}

void bootstrap().catch((error) => {
  app.innerHTML = `<div class="app-shell"><main class="main"><section class="panel"><h1>起動できませんでした</h1><p class="muted">${escapeHtml(error instanceof Error ? error.message : '不明なエラー')}</p></section></main></div>`
})
