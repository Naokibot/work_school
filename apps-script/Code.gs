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
  return properties_().getProperty('ACCESS_TOKEN') || '';
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

function findSheetByGid_(spreadsheet, propertyName, fallbackIndex) {
  const configured = properties_().getProperty(propertyName);
  const sheets = spreadsheet.getSheets();
  if (configured) {
    const requestedGid = Number(configured);
    if (!Number.isInteger(requestedGid) || requestedGid < 0) {
      throw new Error(propertyName + ' is invalid');
    }
    const matched = sheets.find(function (sheet) { return sheet.getSheetId() === requestedGid; });
    if (!matched) throw new Error(propertyName + ' does not match an existing sheet');
    return matched;
  }
  return sheets[fallbackIndex] || null;
}

function problemSheet_(spreadsheet) {
  const sheet = findSheetByGid_(spreadsheet, 'PROBLEM_SHEET_GID', 0);
  if (!sheet) throw new Error('Problem sheet was not found');
  return sheet;
}

function reviewSheet_(spreadsheet, initialize) {
  const problem = problemSheet_(spreadsheet);
  let sheet = findSheetByGid_(spreadsheet, 'REVIEW_SHEET_GID', 1);
  if (!sheet && initialize !== false) sheet = spreadsheet.insertSheet('Review Log');
  if (!sheet) return null;
  if (sheet.getSheetId() === problem.getSheetId()) {
    throw new Error('Problem sheet and review sheet must be different');
  }
  if (initialize !== false && sheet.getLastRow() === 0) {
    sheet.appendRow(REVIEW_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function alreadyRecorded_(sheet, reviewId) {
  if (!sheet) return false;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  return sheet
    .getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(reviewId)
    .matchEntireCell(true)
    .findNext() !== null;
}

function normalizeTags_(value) {
  const seen = {};
  return String(value == null ? '' : value)
    .split(/[,;|]/)
    .map(function (tag) { return tag.trim(); })
    .filter(function (tag) {
      if (!tag || seen[tag]) return false;
      seen[tag] = true;
      return true;
    });
}

function isHeaderRow_(rowNumber, question, correctAnswer) {
  if (rowNumber !== 1) return false;
  const first = question.replace(/\s/g, '').toLowerCase();
  const second = correctAnswer.replace(/\s/g, '').toLowerCase();
  return ['問題', '問題文', 'question'].indexOf(first) >= 0
    && ['正解', 'correct', 'correctanswer', 'answer'].indexOf(second) >= 0;
}

function readCards_(spreadsheet) {
  const sheet = problemSheet_(spreadsheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return { cards: [], skipped: 0 };
  const values = sheet.getRange(1, 1, lastRow, 5).getDisplayValues();
  const cards = [];
  let skipped = 0;

  values.forEach(function (row, index) {
    const question = String(row[0] || '').trim();
    const correctAnswer = String(row[1] || '').trim();
    const wrongAnswer1 = String(row[2] || '').trim();
    const wrongAnswer2 = String(row[3] || '').trim();
    const tags = normalizeTags_(row[4]);
    const rowNumber = index + 1;

    if (isHeaderRow_(rowNumber, question, correctAnswer)) return;
    if (!question && !correctAnswer && !wrongAnswer1 && !wrongAnswer2 && tags.length === 0) return;
    if (!question || !correctAnswer || !wrongAnswer1 || !wrongAnswer2) {
      skipped += 1;
      return;
    }
    const choices = [correctAnswer, wrongAnswer1, wrongAnswer2];
    if (new Set(choices).size !== choices.length) {
      skipped += 1;
      return;
    }

    cards.push({
      row: rowNumber,
      question: question,
      correctAnswer: correctAnswer,
      wrongAnswer1: wrongAnswer1,
      wrongAnswer2: wrongAnswer2,
      tags: tags,
    });
  });
  return { cards: cards, skipped: skipped };
}

function diagnostics_(spreadsheet) {
  const problem = problemSheet_(spreadsheet);
  const review = reviewSheet_(spreadsheet, false);
  const loaded = readCards_(spreadsheet);
  return {
    ok: true,
    spreadsheetTitle: spreadsheet.getName(),
    problemSheet: {
      title: problem.getName(),
      gid: problem.getSheetId(),
      lastRow: problem.getLastRow(),
      validCards: loaded.cards.length,
      skippedRows: loaded.skipped,
    },
    reviewSheet: review ? {
      title: review.getName(),
      gid: review.getSheetId(),
      lastRow: review.getLastRow(),
      loggedReviews: Math.max(0, review.getLastRow() - 1),
    } : null,
  };
}

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const callback = String(params.callback || '');
  const action = String(params.action || 'health');

  if (action === 'health') return json_({ ok: true, service: 'work_school private study API' });
  if (!authorized_(params.token)) {
    return callback
      ? jsonp_(callback, { ok: false, error: 'unauthorized' })
      : json_({ ok: false, error: 'unauthorized' });
  }

  try {
    const spreadsheet = configuredSpreadsheet_();
    if (action === 'cards') {
      const loaded = readCards_(spreadsheet);
      return jsonp_(callback, { ok: true, cards: loaded.cards, skipped: loaded.skipped });
    }
    if (action === 'diagnostics') {
      return callback ? jsonp_(callback, diagnostics_(spreadsheet)) : json_(diagnostics_(spreadsheet));
    }
    if (action === 'review-status') {
      const reviewId = String(params.reviewId || '').trim();
      if (!reviewId) return jsonp_(callback, { ok: false, error: 'missing_review_id', recorded: false });
      const recorded = alreadyRecorded_(reviewSheet_(spreadsheet, true), reviewId);
      return jsonp_(callback, { ok: true, recorded: recorded });
    }
    return callback
      ? jsonp_(callback, { ok: false, error: 'unknown_action' })
      : json_({ ok: false, error: 'unknown_action' });
  } catch (error) {
    console.error(error);
    return callback
      ? jsonp_(callback, { ok: false, error: 'internal_error' })
      : json_({ ok: false, error: 'internal_error' });
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
    const sheet = reviewSheet_(spreadsheet, true);
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
