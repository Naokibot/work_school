const REVIEW_HEADERS = [
  'review_id',
  'reviewed_at',
  'card_id',
  'tags',
  'self_result',
  'response_seconds',
  'fsrs_rating',
  'question_optional',
  'selected_answer_optional',
];

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonp_(callback, value) {
  const safeCallback = /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback || '') ? callback : '';
  if (!safeCallback) return json_({ ok: false, error: 'invalid_callback' });
  return ContentService
    .createTextOutput(safeCallback + '(' + JSON.stringify(value) + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function safeCell_(value) {
  const text = String(value == null ? '' : value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function properties_() {
  return PropertiesService.getScriptProperties();
}

function accessToken_() {
  const properties = properties_();
  return properties.getProperty('ACCESS_TOKEN') || properties.getProperty('WRITE_TOKEN') || '';
}

function authorized_(token) {
  const expected = accessToken_();
  return Boolean(expected) && String(token || '') === expected;
}

function configuredSpreadsheet_() {
  const spreadsheetId = properties_().getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID is not configured');
  return SpreadsheetApp.openById(spreadsheetId);
}

function problemSheet_(spreadsheet) {
  const requestedGid = Number(properties_().getProperty('PROBLEM_SHEET_GID') || '0');
  const sheets = spreadsheet.getSheets();
  const byId = sheets.find(function (sheet) { return sheet.getSheetId() === requestedGid; });
  return byId || sheets[0];
}

function reviewSheet_(spreadsheet) {
  const sheets = spreadsheet.getSheets();
  let sheet = sheets.find(function (candidate) { return candidate.getName() === 'Review Log'; });
  if (!sheet) sheet = sheets[1] || spreadsheet.insertSheet('Review Log');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(REVIEW_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function alreadyRecorded_(sheet, reviewId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  return sheet
    .getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(reviewId)
    .matchEntireCell(true)
    .findNext() !== null;
}

function normalizeTags_(value) {
  return String(value == null ? '' : value)
    .split(/[,;|]/)
    .map(function (tag) { return tag.trim(); })
    .filter(Boolean);
}

function cards_() {
  const spreadsheet = configuredSpreadsheet_();
  const sheet = problemSheet_(spreadsheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return [];
  const values = sheet.getRange(1, 1, lastRow, 5).getDisplayValues();
  const cards = [];

  values.forEach(function (row, index) {
    const question = String(row[0] || '').trim();
    const correctAnswer = String(row[1] || '').trim();
    const wrongAnswer1 = String(row[2] || '').trim();
    const wrongAnswer2 = String(row[3] || '').trim();
    const tags = normalizeTags_(row[4]);
    const rowNumber = index + 1;

    const first = question.replace(/\s/g, '').toLowerCase();
    const second = correctAnswer.replace(/\s/g, '').toLowerCase();
    if (rowNumber === 1 && ['問題', '問題文', 'question'].indexOf(first) >= 0
        && ['正解', 'correct', 'correctanswer', 'answer'].indexOf(second) >= 0) return;
    if (!question && !correctAnswer && !wrongAnswer1 && !wrongAnswer2) return;
    if (!question || !correctAnswer || !wrongAnswer1 || !wrongAnswer2) return;

    cards.push({
      row: rowNumber,
      question: question,
      correctAnswer: correctAnswer,
      wrongAnswer1: wrongAnswer1,
      wrongAnswer2: wrongAnswer2,
      tags: tags,
    });
  });
  return cards;
}

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const callback = String(params.callback || '');
  const action = String(params.action || 'health');

  if (action === 'health') return json_({ ok: true, service: 'work_school private study API' });
  if (!authorized_(params.token)) return callback ? jsonp_(callback, { ok: false, error: 'unauthorized' }) : json_({ ok: false, error: 'unauthorized' });

  try {
    if (action === 'cards') {
      return jsonp_(callback, { ok: true, cards: cards_() });
    }
    if (action === 'review-status') {
      const reviewId = String(params.reviewId || '').trim();
      if (!reviewId) return jsonp_(callback, { ok: false, error: 'missing_review_id', recorded: false });
      const recorded = alreadyRecorded_(reviewSheet_(configuredSpreadsheet_()), reviewId);
      return jsonp_(callback, { ok: true, recorded: recorded });
    }
    return callback ? jsonp_(callback, { ok: false, error: 'unknown_action' }) : json_({ ok: false, error: 'unknown_action' });
  } catch (error) {
    console.error(error);
    return callback ? jsonp_(callback, { ok: false, error: 'internal_error' }) : json_({ ok: false, error: 'internal_error' });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return json_({ ok: false, error: 'busy' });

  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!authorized_(body.token)) return json_({ ok: false, error: 'unauthorized' });
    if (body.action && body.action !== 'review') return json_({ ok: false, error: 'unknown_action' });

    const review = body.review || {};
    const reviewId = String(review.reviewId || '').trim();
    if (!reviewId) return json_({ ok: false, error: 'missing_review_id' });

    const spreadsheet = configuredSpreadsheet_();
    const sheet = reviewSheet_(spreadsheet);
    if (alreadyRecorded_(sheet, reviewId)) return json_({ ok: true, duplicate: true });

    const reviewedAt = review.reviewedAt ? new Date(review.reviewedAt) : new Date();
    const safeDate = isNaN(reviewedAt.getTime()) ? new Date() : reviewedAt;
    const tags = Array.isArray(review.tags) ? review.tags.join('|') : '';

    sheet.appendRow([
      safeCell_(reviewId),
      safeDate,
      safeCell_(review.cardId),
      safeCell_(tags),
      review.correct === true ? 'correct' : 'incorrect',
      Number(review.responseSeconds) || 0,
      Number(review.fsrsRating) || 0,
      safeCell_(review.question || ''),
      safeCell_(review.selectedAnswer || ''),
    ]);

    return json_({ ok: true });
  } catch (error) {
    console.error(error);
    return json_({ ok: false, error: 'internal_error' });
  } finally {
    lock.releaseLock();
  }
}
