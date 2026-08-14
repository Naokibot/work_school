# Memory / work_school

Memory is an iPad-first spaced-repetition web app built with TypeScript, Vite, IndexedDB, FSRS, GitHub Pages, and a small Google Apps Script bridge for a private Google Spreadsheet.

## Highlights

- Three-choice study cards optimized for iPad touch input
- Spreadsheet layout: **A = question, B = correct answer, C/D = distractors, E = tags**
- Answer choices are shuffled for every question
- The correct answer is shown after the learner chooses an option
- Scheduling still uses the learner's own **Correct / Incorrect** judgement rather than automatic grading
  - Correct -> FSRS `Good`
  - Incorrect -> FSRS `Again`
- Tag-based study filters
- Custom study modes inspired by Anki:
  - scheduled reviews + new cards
  - due reviews only
  - all cards in the selected tags
  - forgotten / high-lapse cards
  - marked cards
  - add 10 extra new cards for the current day
- Mark / favorite cards
- Bury a card until the next day
- Suspend and resume cards
- Leech-style detection with an adjustable lapse threshold and optional automatic suspension
- Undo the latest review while it is still local and has not been uploaded
- Per-question countdown timer
- Large scratch canvas for calculations, equations, diagrams, and notes
  - works with Pointer Events, including iPad touch and compatible stylus input
  - automatically clears when moving to the next question
- Create, edit, delete, search, and tag cards in the website
- **Import memorization cards** button for the private spreadsheet
- Review logging to the second sheet
- IndexedDB local storage
- Offline-capable PWA shell
- CSV import/export
- JSON backup/restore including FSRS state and review history
- Study statistics and streaks
- GitHub Actions CI and GitHub Pages deployment

## Card format in Google Sheets

The problem sheet uses five columns:

| Column | Meaning |
| --- | --- |
| A | Question |
| B | Correct answer |
| C | Wrong answer 1 |
| D | Wrong answer 2 |
| E | Tags |

Tags can be separated with commas, semicolons, or `|`.

Example:

| Question | Correct answer | Wrong answer 1 | Wrong answer 2 | Tags |
| --- | --- | --- | --- | --- |
| Which planet is closest to the Sun? | Mercury | Venus | Mars | science,astronomy |

The browser receives the three answers and shuffles their display order for each question. Column B remains the source-of-truth correct answer, but the app does not automatically feed that comparison into FSRS. The learner still presses **Correct** or **Incorrect** after answering.

Rows missing the question, correct answer, or either distractor are ignored.

## Private Google Sheets architecture

The Google Spreadsheet itself should stay **private / Restricted**. It no longer needs link-public sharing.

The browser does not contain the spreadsheet ID. Instead:

```text
Private Google Spreadsheet
        ^
        | SpreadsheetApp.openById(...)
        |
Google Apps Script Web App
        ^
        | ACCESS_TOKEN
        |
GitHub Pages / iPad browser
```

The spreadsheet ID and access token are stored in Apps Script Script Properties. The browser stores only the Web App URL and `ACCESS_TOKEN` in its local IndexedDB settings.

This keeps the spreadsheet ID, private card data, and review sheet out of the deployed GitHub Pages files.

## One-time Apps Script setup

1. Keep the Google Spreadsheet's **General access** set to **Restricted**.
2. Open the spreadsheet, then choose **Extensions -> Apps Script**.
3. Replace the editor contents with `apps-script/Code.gs` from this repository.
4. Open **Project Settings -> Script Properties**.
5. Add these properties:
   - `SPREADSHEET_ID` = the ID of your spreadsheet
   - `PROBLEM_SHEET_GID` = `0` unless your problem sheet uses another gid
   - `ACCESS_TOKEN` = a long random secret generated for this app
6. Deploy the Apps Script project as a **Web app**.
7. Configure it to execute as the deploying account. The web app must be reachable by the iPad browser; the application-level `ACCESS_TOKEN` protects card reads and review writes.
8. Copy the production `/exec` URL.
9. In Memory, open **Settings** and enter:
   - the `/exec` Web App URL
   - the same `ACCESS_TOKEN`
10. Press **Import memorization cards** to verify that cards appear.
11. Complete a test review, then press **Send pending records** and confirm that a row appears in the second sheet.

Never commit `ACCESS_TOKEN` to GitHub. If it is exposed, replace the Script Property and update the app setting on the iPad.

## Review log in Sheet 2

Reviews are always written to IndexedDB first. They are uploaded only after the local save succeeds.

By default, Sheet 2 receives privacy-minimized records:

| Column | Value |
| --- | --- |
| A | Review ID |
| B | Reviewed at |
| C | Card ID |
| D | Tags |
| E | Self result (`correct` / `incorrect`) |
| F | Response time in seconds |
| G | FSRS rating |
| H | Question, optional |
| I | Selected answer, optional |

Columns H and I are blank by default. Enable **detailed review logging** in Settings only when you actually need the question and selected-answer text in the log.

The Apps Script checks unique review IDs before appending, and the browser confirms that the ID exists in Sheet 2 before marking the local record as sent. Formula-like text is escaped before being written to the spreadsheet.

## Tags and custom study

The home screen lists tags found in imported and manually created cards. Tap one or more tags to limit the study queue.

Selecting multiple tags uses OR semantics: a card is eligible if it contains at least one selected tag.

Available study modes:

- **Scheduled**: due reviews plus the daily new-card limit
- **Due only**: currently due review cards
- **All in tags**: every eligible card matching the selected tags
- **Forgotten**: cards with one or more lapses, hardest first
- **Marked**: only cards explicitly marked with a star

The **+10 new today** button temporarily increases the current day's new-card queue without changing the saved daily limit.

## Bury, suspend, mark, and leeches

- **Bury until tomorrow** removes the current card from study until the next local midnight.
- **Suspend** removes a card from normal and custom study until it is manually resumed.
- **Mark** is a persistent favorite/flag-like state and can be used as its own study mode.
- A card becomes a leech-style difficult card after the configured number of lapses. The default threshold is 8. Automatic suspension can be disabled in Settings.

## Undo

The most recent review can be undone while it remains pending locally. Undo restores the card's previous FSRS state and removes that review record.

Once a review has been confirmed in Sheet 2, it is intentionally no longer undoable from the client so the local history cannot silently diverge from the spreadsheet log.

## Timer

The default question timer is 180 seconds and can be changed from 10 to 3600 seconds.

The timer starts automatically for each question and can be paused, resumed, or reset. Reaching `00:00` does not automatically mark a question wrong.

## Scratch canvas

The study screen contains an ephemeral scratch canvas for calculations and handwritten work. The canvas is not stored in IndexedDB and is recreated empty for the next question.

## Manual cards and duplicate warning

Cards can also be created directly in the website with:

- question
- correct answer
- two distractors
- deck
- tags
- optional note

If a card with the same question already exists, the editor asks for confirmation before creating another copy.

## CSV format

CSV import/export uses:

```text
question,correct_answer,wrong_answer1,wrong_answer2,tags,deck,note
```

Rows without all four required question/answer fields are skipped.

## Local storage and backups

Cards, FSRS state, reviews, settings, and pending uploads are stored in IndexedDB. Different browsers and devices have separate local databases.

Before replacing or resetting an iPad, use **Settings -> JSON backup**.

For privacy, the JSON backup intentionally removes `ACCESS_TOKEN`. After restoring a backup, enter the token again in Settings.

## Privacy and security recommendations

- Keep the Google Spreadsheet **Restricted**.
- Never commit `ACCESS_TOKEN`, Google credentials, JSON backups, or exported personal study data.
- Keep detailed review logging disabled unless question text is actually required in Sheet 2.
- Use a long random `ACCESS_TOKEN` and rotate it immediately if it is exposed.
- Do not put secrets in GitHub Issues, pull requests, Actions logs, or artifacts.
- Enable GitHub Dependabot alerts, secret scanning, push protection, and code scanning where available.
- Keep GitHub Actions permissions at the minimum required level.
- Protect `main` with required pull requests and the CI status check when multiple people contribute.

See `SECURITY.md` for the repository-specific policy.

## Legacy data migration

Older local versions are normalized when read:

- old `front/back` cards are retained
- old four-choice cards use their first stored choice as the migrated correct-answer candidate
- incomplete legacy cards remain visible but are excluded from study until edited or replaced by a complete imported row
- backup versions 1, 2, and 3 are accepted

## Local development

Node.js 22.12 or newer is required.

```bash
npm install
npm run dev
```

Type-check and production build:

```bash
npm run build
```

## GitHub Pages

The deployment workflow is:

```text
.github/workflows/deploy-pages.yml
```

The independent CI workflow runs strict TypeScript checking and a production Vite build.

If Pages has not yet been enabled:

1. Open the `work_school` repository.
2. Go to **Settings -> Pages**.
3. Under **Build and deployment**, choose **GitHub Actions**.
4. Open **Actions -> Deploy GitHub Pages** and run the workflow once.

The expected project Pages URL is normally:

```text
https://naokibot.github.io/work_school/
```

## iPad installation

Open the deployed site in Safari, use the Share menu, and choose **Add to Home Screen**. The application shell and locally stored cards remain available offline; private spreadsheet import and review upload require a network connection.
