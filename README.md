# Memory / work_school

An iPad-first spaced-repetition web app built with TypeScript, Vite, IndexedDB, FSRS, GitHub Pages, and Google Sheets.

## Features

- Four-choice study cards
- No automatic correctness judgement
- The learner selects one of four answers, then self-reports **Correct** or **Incorrect**
- FSRS scheduling based on the learner's self-assessment
  - Correct -> `Good`
  - Incorrect -> `Again`
- Per-question countdown timer
- Large answer buttons designed for iPad touch input
- Scratch canvas for calculations, equations, diagrams, and notes
  - Works with touch and Apple Pencil pointer events
  - Automatically clears when moving to the next question
- Card creation, editing, deletion, and search in the website
- Google Sheets problem import
- Review logging to the second sheet through a small Google Apps Script web app
- IndexedDB local storage
- Offline-capable PWA shell
- CSV import/export
- JSON backup/restore including FSRS state and review history
- Study statistics and streaks
- GitHub Actions production build and GitHub Pages deployment

## Card format

Each card contains:

1. Question
2. Answer 1
3. Answer 2
4. Answer 3
5. Answer 4

The application intentionally does **not** store which answer is correct. During study, the learner chooses an answer and then decides whether their response was correct or incorrect.

## Google Sheets problem import

The default spreadsheet is:

- Spreadsheet ID: `147eZ_4pocwkxQSs3QRC0SevZaojcdwK8V7777td_xos`
- Problem sheet gid: `0`

Columns are interpreted as:

| Column | Value |
| --- | --- |
| A | Question |
| B | Answer 1 |
| C | Answer 2 |
| D | Answer 3 |
| E | Answer 4 |

A row is imported only when all five cells are present. A header row such as `Question / Answer1 / Answer2 / Answer3 / Answer4` or the equivalent Japanese labels is ignored automatically.

The problem sheet must be readable by the website, for example by allowing link-based viewing. Private Sheets that require authenticated API access cannot be read directly by a static GitHub Pages site with this implementation.

Problem import runs when the app starts, returns online, becomes visible again, and approximately every 60 seconds while open when auto-sync is enabled. Manual sync is also available.

Deleting a row in Google Sheets does not automatically delete the corresponding local card. This is intentional so an accidental spreadsheet deletion cannot silently destroy local FSRS history.

## Review log in Sheet 2

A static GitHub Pages site cannot directly write to Google Sheets. Review logging therefore uses the Google Apps Script web app in:

```text
apps-script/Code.gs
```

The browser always saves a review to IndexedDB first. When the web app is configured and the device is online, pending reviews are uploaded to the second sheet. Each review has a unique ID, and the Apps Script checks that ID before appending a row so retries do not normally create duplicates.

The second sheet receives these columns:

| Column | Value |
| --- | --- |
| A | Review ID |
| B | Reviewed at |
| C | Card ID |
| D | Question |
| E | Selected choice number |
| F | Selected answer text |
| G | Self result (`correct` / `incorrect`) |
| H | Response time in seconds |
| I | FSRS rating |

If the spreadsheet does not yet have a second sheet, the Apps Script creates one named `Review Log`.

### One-time Apps Script setup

1. Open the target Google Spreadsheet.
2. Open **Extensions -> Apps Script**.
3. Replace the editor contents with `apps-script/Code.gs` from this repository.
4. Open **Project Settings -> Script Properties**.
5. Add:
   - `SPREADSHEET_ID` = `147eZ_4pocwkxQSs3QRC0SevZaojcdwK8V7777td_xos`
   - `WRITE_TOKEN` = a long random secret you create yourself
6. Deploy the script as a **Web app**.
7. Configure it to execute as the deploying user and allow the intended users to access it. For a personal device-only workflow, anonymous access can be used together with the `WRITE_TOKEN` check in the script.
8. Copy the production URL ending in `/exec`.
9. In Memory, open **Settings** and enter:
   - the `/exec` Web App URL
   - the same `WRITE_TOKEN`
10. Use **Send pending records** once to verify that rows appear in Sheet 2.

Do not put the `WRITE_TOKEN` in this GitHub repository. The site stores the entered token only in the browser's IndexedDB settings on that device.

## Timer

The default question timer is 180 seconds. It can be changed in Settings from 10 to 3600 seconds.

The timer starts automatically for each question. It can be paused, resumed, or reset. Reaching `00:00` does not automatically mark the question wrong; the learner still chooses the result manually.

## Scratch canvas

The study screen contains a scratch canvas for calculations and handwritten work. It uses Pointer Events, so it works with a mouse, touch, and compatible stylus input including Apple Pencil through Safari's pointer handling.

The scratch canvas is intentionally ephemeral. It is not saved to IndexedDB and is recreated empty when the next question is shown.

## Legacy data migration

Older versions used a two-field `front/back` card format. Existing IndexedDB data is retained and normalized at read time. Legacy cards that do not yet have all four answer choices are shown in the card list as incomplete and are excluded from study until they are edited or replaced by a complete Google Sheets row.

Version 1 JSON backups are still accepted and migrated on import.

## CSV format

CSV import/export uses:

```text
question,answer1,answer2,answer3,answer4,deck,tags,note
```

Rows without a question and all four answers are skipped on import.

## Local storage and backups

Cards, FSRS state, reviews, settings, and pending review uploads are stored in IndexedDB. iPad and desktop browsers therefore have separate local datasets even when they use the same URL.

Before replacing or resetting an iPad, use **Settings -> JSON backup**.

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

The main deployment workflow is:

```text
.github/workflows/deploy-pages.yml
```

Pushing to `main` builds and deploys the application.

The expected public URL is normally:

```text
https://naokibot.github.io/work_school/
```

### First-time Pages setup

If GitHub Pages has not yet been enabled for the repository:

1. Open the `work_school` repository.
2. Go to **Settings -> Pages**.
3. Under **Build and deployment**, choose **GitHub Actions** as the source.
4. Open **Actions -> Deploy GitHub Pages** and run the workflow once.

After that, pushes to `main` are deployed automatically.

## iPad installation

Open the published URL in Safari, use the Share menu, then choose **Add to Home Screen**. The app shell and locally stored study data remain usable offline. Google Sheets import and review upload require an internet connection.

## Security notes

- Never commit Google OAuth secrets or the review `WRITE_TOKEN`.
- The review logger validates a per-device token and restricts writes to the spreadsheet ID configured in Apps Script Script Properties.
- Sheet text is escaped before `appendRow` when it begins with formula-like characters to reduce spreadsheet formula injection risk.
- The browser saves reviews locally before attempting any network upload.
- A public Apps Script endpoint protected only by a shared token is suitable for a small personal study tool, not for a high-security multi-user service.
