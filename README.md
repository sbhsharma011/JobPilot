# JobPilot — Chrome Extension

Auto-fills job application forms on any company career portal (Greenhouse, Lever, Workday, iCIMS, and custom ATS), with AI assistance for cover letters, profile-to-job matching, and duplicate-application tracking.

## How it works

**Form filling — two-layer approach:**

1. **Local matching** — instantly fills obvious text fields (name, email, phone, etc.) using keyword pattern matching against field labels. Zero API calls, zero latency.
2. **LLM fallback** — for complex fields (selects, radios, screening questions, custom JS-driven dropdowns like react-select/MUI Autocomplete), sends a single batched request to the Anthropic Claude API, which sees the full option list per field and picks the right answer.

**AI-assisted extras**, all opt-in and gated behind your own Anthropic API key:

- **Check Profile Match** — scores your profile against the current job description and shows which requirements you match, which are missing but safe to claim, and which would be a stretch.
- **Generate Cover Letter** — writes a tailored cover letter grounded in your profile and resume detail; copy it or download it as a PDF.
- **Resume upload & parsing** — upload a PDF/DOCX/TXT resume (during onboarding, or later from Settings) and Claude extracts your profile fields, professional summary, and skills automatically.

**Duplicate-application tracking** — "Mark as Applied" records the company/role/job ID for the page you're on; JobPilot warns you if you've already applied to the same posting (or a similar role at the same company) before you apply again.

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the repository folder (the one containing `manifest.json`)
6. The JobPilot icon will appear in your toolbar, opening a docked side panel

## First-time setup

On install, JobPilot opens a 4-step onboarding wizard:

1. **API key** — (optional) paste your Anthropic API key. Get one at https://console.anthropic.com/. Basic field filling works without a key; AI features (resume parsing, cover letters, profile match) require one.
2. **Resume upload** — upload a PDF/DOCX/TXT resume; with a key set, Claude extracts your details automatically.
3. **Personal details** — review and complete anything the parser missed.
4. **Application defaults** — work authorization, sponsorship, relocation, remote preference, and EEO defaults used to answer common screening questions.

You can revisit all of this anytime from **Settings** (linked at the bottom of the side panel), which also lets you re-upload a newer resume to rebuild your summary/skills, and shows a running tally of requirements that keep showing up as gaps across job descriptions you've checked.

## Usage

1. Navigate to a job application page
2. Open the JobPilot side panel (toolbar icon)
3. Click **Fill This Page** to auto-fill the form
4. Optionally click **Check Profile Match** or **Generate Cover Letter with AI** first
5. After submitting on the site, click **Mark as Applied** to record it and avoid duplicate applications later

## Permissions

`manifest.json` requests `host_permissions: ["<all_urls>", "https://api.anthropic.com/"]`. The `<all_urls>` grant is intentionally broad because JobPilot's entire purpose is filling forms on whatever career site you happen to be on — Greenhouse, Lever, Workday, iCIMS, and countless custom ATS portals across arbitrary company domains — so it can't be scoped to a fixed domain list the way a single-site extension could be. `activeTab`/`scripting` are used to read and fill the form on the current tab on demand; `https://api.anthropic.com/` is the only external host contacted, and only when an API key is configured.

## File structure

```
manifest.json          — MV3 manifest
background.js          — Service worker: Claude API calls, profile/insights storage
content.js              — Injected on demand: field extraction + fill orchestration
utils/
  matcher.js            — Label → profile key pattern matching
  filler.js             — React/Vue/Angular-compatible fill helpers (incl. custom comboboxes)
  resumeParser.js        — Shared resume file reading (PDF/DOCX/TXT extraction)
  pdf.js                — Dependency-free PDF generation for cover letter downloads
popup/                  — Side panel UI (fill, match, cover letter, applied tracker)
options/                — Settings page (profile editor, resume rebuild, gap insights)
onboarding/             — First-run setup wizard
icons/
LICENSE
README.md
```

## Privacy

- Your profile data stays in `chrome.storage.local` on your machine
- The Anthropic API key is never synced via `chrome.storage.sync`
- LLM calls only send the field labels/options and a compact version of your profile — the API key itself is never included in any prompt

## Supported ATS platforms

Tested patterns work well on:
- **Greenhouse** — standard input/textarea forms
- **Lever** — React-controlled inputs (native setter + synthetic events)
- **Workday** — complex dropdowns and radio groups
- **iCIMS** — multi-step forms with varied label patterns
- Any custom career portal with standard HTML form elements

Portals that render their form fields entirely inside Shadow DOM (some Angular/Web-Components-based ATS platforms) aren't supported yet — the content script only scans the light DOM.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Reload the page and try again" | The content script lost connection. Reload the job page and click Fill again. |
| "Cannot fill on this page" | The extension cannot run on `chrome://` or browser-internal pages. Navigate to a job listing. |
| Fields not filling | Open DevTools console on the job page and look for `[JobPilot]` log messages for clues. |
| AI fill not working | Check that your Anthropic API key is set in Settings and starts with `sk-ant-`. |

## License

MIT — see [LICENSE](LICENSE).
