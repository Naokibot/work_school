const REVIEW_HEADERS = [
  'review_id',
  'reviewed_at',
  'card_id',
  'question',
  'selected_choice',
  'selected_answer',
  'self_result',
  'response_seconds',
  'fsrs_rating',
];

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function safeCell_(value) {
  const text = String(value == null ? '' : value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function reviewSheet_(spreadsheet) {
  const sheets = spreadsheet.getSheets();
  const sheet = sheets[1] || spreadsheet.insertSheet('Review Log');
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

function doGet() {
  return json_({ ok: true, service: 'work_school review logger' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return json_({ ok: false, error: 'busy' });

  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const properties = PropertiesService.getScriptProperties();
    const writeToken = properties.getProperty('WRITE_TOKEN');
    const spreadsheetId = properties.getProperty('SPREADSHEET_ID');

    if (!writeToken || !spreadsheetId) {
      return json_({ ok: false, error: 'server_not_configured' });
    }
    if (body.token !== writeToken) {
      return json_({ ok: false, error: 'unauthorized' });
    }
    if (body.spreadsheetId && body.spreadsheetId !== spreadsheetId) {
      return json_({ ok: false, error: 'spreadsheet_mismatch' });
    }

    const review = body.review || {};
    const reviewId = String(review.reviewId || '').trim();
    if (!reviewId) return json_({ ok: false, error: 'missing_review_id' });

    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const sheet = reviewSheet_(spreadsheet);
    if (alreadyRecorded_(sheet, reviewId)) {
      return json_({ ok: true, duplicate: true });
    }

    sheet.appendRow([
      safeCell_(reviewId),
      review.reviewedAt ? new Date(review.reviewedAt) : new Date(),
      safeCell_(review.cardId),
      safeCell_(review.question),
      Number(review.selectedChoice) || '',
      safeCell_(review.selectedAnswer),
      review.correct === true ? 'correct' : 'incorrect',
      Number(review.responseSeconds) || 0,
      Number(review.fsrsRating) || 0,
    ]);

    return json_({ ok: true });
  } catch (error) {
    console.error(error);
    return json_({ ok: false, error: 'internal_error' });
  } finally {
    lock.releaseLock();
  }
}
