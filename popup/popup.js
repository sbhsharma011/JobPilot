/**
 * popup.js — JobPilot popup controller
 */

'use strict';

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const fillBtn       = document.getElementById('fillBtn');
const statusEl      = document.getElementById('status');
const spinnerEl     = document.getElementById('spinner');
const phaseText     = document.getElementById('phaseText');
const progressEl    = document.getElementById('progressBar');
const progressFill  = document.getElementById('progressFill');
const fieldLog      = document.getElementById('fieldLog');
const settingsLink  = document.getElementById('settingsLink');
const setupRequired = document.getElementById('setupRequired');
const fillUI        = document.getElementById('fillUI');
const setupBtn      = document.getElementById('setupBtn');

// Cover letter
const clToggleBtn   = document.getElementById('clToggleBtn');
const clChevron     = document.getElementById('clChevron');
const clPanel       = document.getElementById('clPanel');
const jobDescription = document.getElementById('jobDescription');
const genCoverBtn   = document.getElementById('genCoverBtn');
const clResult      = document.getElementById('clResult');
const coverLetterText = document.getElementById('coverLetterText');
const copyCoverBtn  = document.getElementById('copyCoverBtn');
const downloadCoverBtn = document.getElementById('downloadCoverBtn');
const clStatus      = document.getElementById('clStatus');

// Applied tracker
const appliedSection   = document.getElementById('appliedSection');
const appliedWarning   = document.getElementById('appliedWarning');
const markAppliedBtn   = document.getElementById('markAppliedBtn');
const appliedBtnTitle  = document.getElementById('appliedBtnTitle');
const appliedBtnMeta   = document.getElementById('appliedBtnMeta');

// Profile match
const matchBtn         = document.getElementById('matchBtn');
const matchResult       = document.getElementById('matchResult');
const matchScoreBadge   = document.getElementById('matchScoreBadge');
const matchSummaryEl    = document.getElementById('matchSummary');
const matchedChipsEl    = document.getElementById('matchedChips');
const missingChipsEl    = document.getElementById('missingChips');

let lastJobTitle = '';
let lastJobCompany = '';
let lastCandidateName = '';

// Applied tracker state — set by initAppliedTracker() for the active tab.
// Deliberately separate from lastJobTitle/lastJobCompany above: those are
// restored from storage asynchronously by restoreCoverLetterState() (which
// runs concurrently, not sequentially, with initAppliedTracker() at the
// bottom of this file) and could otherwise clobber the freshly-detected
// current-tab values with stale data from a previous session/tab.
let appliedJobId = '';
let appliedJobUrl = '';
let appliedJobCompany = '';
let appliedJobTitleFull = '';
let appliedTrackerRequestId = 0; // guards against out-of-order refreshes clobbering a newer one
let trackedTabId = null; // tab whose content currently populates the cover-letter box

// ─── Fill state ───────────────────────────────────────────────────────────────

let fillTotal = 0;
let fillCount = 0;
let isFilling = false;

// ─── Fill UI helpers ──────────────────────────────────────────────────────────

function setStatus(text, type = 'idle') {
  statusEl.textContent = text;
  statusEl.className   = `status status--${type}`;
}

function showSpinner(visible) {
  spinnerEl.classList.toggle('hidden', !visible);
  statusEl.classList.toggle('hidden',  visible);
  // Field log is NOT hidden when spinner goes away — it stays visible after fill
}

function setPhase(text) {
  phaseText.textContent = text;
}

function updateBar(filled, total) {
  if (total === 0) return;
  progressEl.classList.remove('hidden');
  progressFill.style.width = Math.round((filled / total) * 100) + '%';
}

function addLogEntry(label, state) {
  const icons = { filling: '⟳', ok: '✓', skip: '–', llm: '✦' };
  const entry = document.createElement('div');
  entry.className = `field-entry field-entry--${state}`;
  entry.innerHTML =
    `<span class="fe-icon">${icons[state] || '·'}</span>` +
    `<span class="fe-label">${escapeHtml(label)}</span>`;
  fieldLog.appendChild(entry);
  fieldLog.scrollTop = fieldLog.scrollHeight;
  return entry;
}

function resetFillState() {
  fillTotal = 0;
  fillCount = 0;
  progressFill.style.width = '0%';
  progressEl.classList.add('hidden');
  fieldLog.innerHTML = '';
  fieldLog.classList.add('hidden');
}

// ─── fillProgress listener (receives events streamed from content.js) ─────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== 'fillProgress') return;

  if (msg.phase === 'scan') {
    fillTotal = msg.total;
    fillCount = 0;
    if (msg.total > 0) {
      setPhase(`Found ${msg.total} field${msg.total === 1 ? '' : 's'} — filling…`);
      fieldLog.classList.remove('hidden');
    } else {
      setPhase('No form fields found');
    }
    return;
  }

  if (msg.phase === 'llm-start') {
    setPhase(`AI filling ${msg.count} field${msg.count === 1 ? '' : 's'}…`);
    addLogEntry(`Claude analyzing ${msg.count} field${msg.count === 1 ? '' : 's'}…`, 'llm');
    return;
  }

  if (msg.phase === 'filling') {
    const label = (msg.label || `Field ${(msg.index || 0) + 1}`).replace(/\*/g, '').trim();
    addLogEntry(label, 'filling');
    return;
  }

  if (msg.phase === 'filled') {
    fillCount++;
    // Update the last "filling" entry in-place
    const entries = fieldLog.querySelectorAll('.field-entry--filling');
    const last = entries[entries.length - 1];
    if (last) {
      const icon = last.querySelector('.fe-icon');
      if (icon) icon.textContent = msg.success ? '✓' : '–';
      last.classList.remove('field-entry--filling');
      last.classList.add(msg.success ? 'field-entry--ok' : 'field-entry--skip');
    }
    updateBar(fillCount, fillTotal);
    setPhase(`Filling ${fillCount}/${fillTotal}…`);
  }
});

// ─── Settings ─────────────────────────────────────────────────────────────────

settingsLink.addEventListener('click', e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ─── Detect job context ───────────────────────────────────────────────────────

// Pulls "<Title> at <Company>" (optionally prefixed "... for ") apart. Several
// ATS platforms (Ashby among them) render this whole phrase as both the page
// <title> and the <h1>, with no separate company element — treating it as a
// single field previously meant the entire sentence got used as the company
// name, and the title kept its "for ... at Company" wrapper too.
function splitAtPattern(str) {
  if (!str) return null;
  const m = str.match(/^(?:.*?\bfor\s+)?(.+?)\s+\bat\b\s+([^|·\-–—]+?)\s*$/i);
  return m ? { title: m[1].trim(), company: m[2].trim() } : null;
}

// The core role, dropping a trailing qualifier after a comma/dash (e.g.
// "Technical Program Manager, Compute Qualification" → "Technical Program
// Manager") — used anywhere we need something short and stable: filenames,
// button labels, dedupe matching.
function getCoreTitle(title) {
  return (title || '').split(/[,–—-]/)[0].trim();
}

function hashText(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Pulls a stable job identifier out of the URL path — most ATS platforms put
// one in there (Greenhouse: numeric ID, Ashby/Lever: UUID, Workday: REQ-style
// alphanumeric code). Falls back to a hash of the path so every job page still
// gets a consistent synthetic ID even when nothing recognizable is present.
function extractIdFromUrl(pathname) {
  const segments = (pathname || '').split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return seg;
    if (/^\d{4,}$/.test(seg)) return seg;
    if (/^[a-z0-9_-]{6,}$/i.test(seg) && /\d/.test(seg)) return seg;
  }
  return `h_${hashText(pathname || '')}`;
}

async function detectJobContext(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const h1     = document.querySelector('h1')?.innerText?.trim() || '';
        const ogSite = document.querySelector('meta[property="og:site_name"]')?.content?.trim() || '';
        const title  = document.title || '';
        const url    = location.href;
        const pathname = location.pathname;

        // JSON-LD JobPosting schema (Greenhouse, Lever, Workday, Ashby, etc.
        // commonly embed this) is the most reliable source when present —
        // it gives a clean title/company pair with no sentence-parsing needed.
        let ldTitle = '', ldCompany = '', ldId = '';
        try {
          for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
            let data;
            try { data = JSON.parse(s.textContent); } catch (_) { continue; }
            for (const item of Array.isArray(data) ? data : [data]) {
              const types = Array.isArray(item?.['@type']) ? item['@type'] : [item?.['@type']];
              if (types.includes('JobPosting')) {
                ldTitle = item.title || '';
                ldCompany = item.hiringOrganization?.name || '';
                ldId = (typeof item.identifier === 'string' ? item.identifier : item.identifier?.value) || '';
              }
              if (ldTitle || ldCompany) break;
            }
            if (ldTitle || ldCompany) break;
          }
        } catch (_) {}

        return { h1, ogSite, title, url, pathname, ldTitle, ldCompany, ldId };
      },
    });
    const info = results?.[0]?.result || {};

    let jobTitle   = info.ldTitle || '';
    let jobCompany = info.ldCompany || info.ogSite || '';

    if (!jobTitle || !jobCompany) {
      const split = splitAtPattern(info.h1) || splitAtPattern(info.title);
      if (split) {
        jobTitle   = jobTitle   || split.title;
        jobCompany = jobCompany || split.company;
      }
    }

    jobTitle   = jobTitle   || info.h1 || info.title.split(' - ')[0] || '';
    jobCompany = jobCompany || info.title.split(' - ').slice(-1)[0] || '';
    const jobId = info.ldId || extractIdFromUrl(info.pathname);

    return { jobTitle, jobCompany, jobId, url: info.url || '', coverLetter: '' };
  } catch (_) {
    return { jobTitle: '', jobCompany: '', jobId: '', url: '', coverLetter: '' };
  }
}

// ─── Inject scripts ───────────────────────────────────────────────────────────

async function injectScripts(tabId) {
  for (const file of ['utils/matcher.js', 'utils/filler.js', 'content.js']) {
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
  }
}

// ─── Fill button ──────────────────────────────────────────────────────────────

fillBtn.addEventListener('click', async () => {
  if (isFilling) return;
  isFilling = true;
  fillBtn.disabled = true;
  resetFillState();
  showSpinner(true);
  setPhase('Scanning fields…');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found.');

    const url = tab.url || '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
      throw new Error('Cannot fill on this page.');
    }

    const profileResp = await chrome.runtime.sendMessage({ action: 'getProfile' });
    const profile     = profileResp?.profile;
    if (!profile) throw new Error('Could not load profile.');

    const jobContext = await detectJobContext(tab.id);

    try {
      await injectScripts(tab.id);
    } catch (injectErr) {
      if (!injectErr.message?.includes('already been injected')) {
        console.warn('[JobPilot] Injection warning:', injectErr.message);
      }
    }

    await new Promise(r => setTimeout(r, 80));

    const result = await chrome.tabs.sendMessage(tab.id, { action: 'fill', profile, jobContext });

    showSpinner(false);

    if (result?.error) {
      setStatus('Error: ' + result.error, 'error');
    } else {
      const filled = result?.filled ?? 0;
      const total  = result?.total  ?? 0;
      const ai     = result?.llmUsed ? ' · AI assisted' : '';

      if (total === 0) {
        setStatus('No form fields found on this page.', 'warn');
      } else {
        const pct = total > 0 ? Math.round((filled / total) * 100) : 0;
        setStatus(`${filled}/${total} fields filled${ai}`, filled === total ? 'success' : filled > 0 ? 'info' : 'warn');
        updateBar(filled, total);
      }
    }
  } catch (err) {
    showSpinner(false);
    const msg = err.message || 'Unknown error';
    if (msg.includes('Could not establish connection') || msg.includes('Receiving end does not exist')) {
      setStatus('Reload the page and try again.', 'warn');
    } else {
      setStatus(msg, 'error');
    }
    console.error('[JobPilot] Fill error:', err);
  } finally {
    fillBtn.disabled = false;
    isFilling = false;
  }
});

// ─── Cover Letter Generator ───────────────────────────────────────────────────

let clOpen = false;

clToggleBtn.addEventListener('click', async () => {
  clOpen = !clOpen;
  clPanel.classList.toggle('hidden', !clOpen);
  clChevron.classList.toggle('open', clOpen);

  if (clOpen && !jobDescription.value.trim()) {
    await autoDetectJobDescription();
  }
});

// Invalidate the box the moment the tracked tab actually navigates or
// refreshes, or the user switches to a different tab — rather than trying to
// guess "did the job change" from content, just drop stale content on any
// real navigation signal and let the next "Generate" click do a fresh read.
// tabId-based (not URL-based) so this also fires for list+preview job boards
// that swap the displayed listing via JS on the same URL.

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (trackedTabId !== null && tabId !== trackedTabId) {
    clearCoverLetterBox('Switched to a different page');
  }
  initAppliedTracker();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (trackedTabId !== null && tabId === trackedTabId && changeInfo.status === 'loading') {
    clearCoverLetterBox('Page changed');
  }
  if (tab?.active && changeInfo.status === 'complete') {
    initAppliedTracker();
  }
});

async function clearCoverLetterBox(reason) {
  const hasMatch = !matchResult.classList.contains('hidden');
  if (!jobDescription.value.trim() && !coverLetterText.value.trim() && !hasMatch) return;

  jobDescription.value = '';
  coverLetterText.value = '';
  clResult.classList.add('hidden');
  matchResult.classList.add('hidden');
  lastJobTitle = '';
  lastJobCompany = '';
  trackedTabId = null;

  if (clOpen) showClStatus(`📄 ${reason} — click "Generate Cover Letter with AI" to read this page fresh.`, 'info');

  await Promise.all([
    chrome.runtime.sendMessage({ action: 'savePref', key: 'clJobDescription', value: '' }),
    chrome.runtime.sendMessage({ action: 'savePref', key: 'clCoverLetter', value: '' }),
    chrome.runtime.sendMessage({ action: 'savePref', key: 'clJobTitle', value: '' }),
    chrome.runtime.sendMessage({ action: 'savePref', key: 'clJobCompany', value: '' }),
    chrome.runtime.sendMessage({ action: 'savePref', key: 'clMatchResult', value: null }),
  ]);
}

// Heuristic scrape of the current tab: try common ATS job-description
// containers first, fall back to the whole page body. The LLM prompt is
// tolerant of surrounding nav/footer noise, so a generous fallback is fine.
async function autoDetectJobDescription() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const url = tab.url || '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) return;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const candidates = [
          'main', 'article',
          '[data-automation-id="jobPostingDescription"]',
          '.posting-description', '.job__description', '.jobs-description',
          '[class*="job-description" i]', '[class*="jobdescription" i]',
          '[id*="job-description" i]', '#content',
        ];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          const text = el?.innerText?.trim() || '';
          if (text.length > 200) return text;
        }
        return document.body.innerText.trim();
      },
    });

    const text = (results?.[0]?.result || '').slice(0, 10000);
    if (text.length > 200) {
      jobDescription.value = text;
      trackedTabId = tab.id;
      showClStatus('📄 Auto-detected the job description from this page — edit if needed.', 'info');
    }
  } catch (err) {
    console.warn('[JobPilot] JD auto-detect failed:', err);
  }
}

// ─── Profile Match ────────────────────────────────────────────────────────────

function renderMatchResult(match) {
  const score = match.score ?? 0;
  matchScoreBadge.textContent = `${score}%`;
  matchScoreBadge.classList.remove('match-high', 'match-mid', 'match-low');
  matchScoreBadge.classList.add(score >= 75 ? 'match-high' : score >= 45 ? 'match-mid' : 'match-low');

  matchSummaryEl.textContent = match.summary || '';

  matchedChipsEl.innerHTML = (match.matched || [])
    .map(item => `<span class="match-chip">${escapeHtml(item)}</span>`).join('');

  // Each missing item is judged safe (a genuine, honest extension of the
  // existing profile) or risky (would misrepresent the candidate — e.g. an
  // uncredentialed certification) — shown via color + icon, reason on hover.
  missingChipsEl.innerHTML = (match.missing || [])
    .map(item => {
      const keyword = typeof item === 'string' ? item : item.keyword;
      const safeToAdd = typeof item === 'object' && item.safeToAdd === true;
      const reason = typeof item === 'object' ? (item.reason || '') : '';
      const cls   = safeToAdd ? 'match-chip--safe' : 'match-chip--risky';
      const icon  = safeToAdd ? '✓' : '⚠';
      const title = reason ? ` title="${escapeHtml(reason)}"` : '';
      return `<span class="match-chip ${cls}"${title}>${icon} ${escapeHtml(keyword)}</span>`;
    }).join('');

  matchResult.classList.remove('hidden');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

matchBtn.addEventListener('click', async () => {
  // Some job boards swap the displayed listing via client-side JS without a
  // real navigation event (same tab, same URL) — tab listeners alone miss
  // that, so re-detect the job on every explicit "check this job" click too.
  initAppliedTracker();

  let jd = jobDescription.value.trim();
  if (!jd) {
    await autoDetectJobDescription();
    jd = jobDescription.value.trim();
  }
  if (!jd) {
    showClStatus('Could not detect a job description on this page — paste it manually.', 'error');
    return;
  }

  matchBtn.disabled = true;
  matchBtn.textContent = '⟳ Checking…';
  clStatus.classList.add('hidden');

  try {
    const profileResp = await chrome.runtime.sendMessage({ action: 'getProfile' });
    const profile = profileResp?.profile;
    if (!profile?.anthropicApiKey?.trim()) {
      showClStatus('Add your Anthropic API key in Settings first.', 'error');
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) trackedTabId = tab.id;

    const resp = await chrome.runtime.sendMessage({ action: 'matchProfile', profile, jobDescription: jd });

    if (resp?.error) {
      showClStatus(resp.error, 'error');
    } else {
      renderMatchResult(resp.match);
      await chrome.runtime.sendMessage({ action: 'savePref', key: 'clMatchResult', value: resp.match });
    }
  } catch (err) {
    showClStatus(err.message || 'Unknown error', 'error');
  } finally {
    matchBtn.disabled = false;
    matchBtn.innerHTML = '<span>&#127919;</span> Check Profile Match';
  }
});

genCoverBtn.addEventListener('click', async () => {
  initAppliedTracker();

  let jd = jobDescription.value.trim();
  if (!jd) {
    await autoDetectJobDescription();
    jd = jobDescription.value.trim();
  }
  if (!jd) {
    showClStatus('Could not detect a job description on this page — paste it manually.', 'error');
    return;
  }

  genCoverBtn.disabled = true;
  genCoverBtn.textContent = '⟳ Generating…';
  clResult.classList.add('hidden');
  clStatus.classList.add('hidden');

  try {
    const profileResp = await chrome.runtime.sendMessage({ action: 'getProfile' });
    const profile = profileResp?.profile;
    if (!profile?.anthropicApiKey?.trim()) {
      showClStatus('Add your Anthropic API key in Settings first.', 'error');
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const jobCtx    = tab?.id ? await detectJobContext(tab.id) : { jobTitle: '', jobCompany: '' };
    const jobTitle  = jobCtx.jobTitle || tab?.title?.split(' - ')?.[0] || '';
    const jobCompany = jobCtx.jobCompany || '';
    lastJobTitle = jobTitle;
    lastJobCompany = jobCompany;
    lastCandidateName = profile.fullName || [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    // Tie this content to the tab it was generated for — even a manually
    // pasted JD gets tracked, so the onActivated/onUpdated listeners above
    // know to invalidate it once this tab navigates or loses focus.
    if (tab?.id) trackedTabId = tab.id;

    const resp = await chrome.runtime.sendMessage({
      action:         'generateCoverLetter',
      profile,
      jobDescription: jd,
      jobTitle,
      jobCompany,
    });

    if (resp?.error) {
      showClStatus(resp.error, 'error');
    } else {
      coverLetterText.value = resp.coverLetter || '';
      clResult.classList.remove('hidden');
      // Clear the JD box once the letter is generated — leaving the raw
      // scraped/pasted JD text sitting next to the finished letter was
      // confusing. trackedTabId (set above) still points at this tab, so
      // page-change detection keeps working even with the box now empty.
      jobDescription.value = '';
      // Persist so the panel survives a full close/reopen without losing the letter.
      await chrome.runtime.sendMessage({ action: 'savePref', key: 'clJobDescription', value: '' });
      await chrome.runtime.sendMessage({ action: 'savePref', key: 'clCoverLetter', value: resp.coverLetter || '' });
      await chrome.runtime.sendMessage({ action: 'savePref', key: 'clJobTitle', value: jobTitle });
      await chrome.runtime.sendMessage({ action: 'savePref', key: 'clJobCompany', value: jobCompany });
    }
  } catch (err) {
    showClStatus(err.message || 'Unknown error', 'error');
  } finally {
    genCoverBtn.disabled = false;
    genCoverBtn.innerHTML = '<span>&#10022;</span> Generate Cover Letter with AI';
  }
});

copyCoverBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(coverLetterText.value);
    copyCoverBtn.textContent = 'Copied!';
    copyCoverBtn.classList.add('copied');
    setTimeout(() => {
      copyCoverBtn.textContent = 'Copy';
      copyCoverBtn.classList.remove('copied');
    }, 2000);
  } catch (_) {
    coverLetterText.select();
    document.execCommand('copy');
  }
});

downloadCoverBtn.addEventListener('click', () => {
  const text = coverLetterText.value.trim();
  if (!text) return;

  try {
    downloadTextAsPdf(text, buildCoverLetterFilename());
    downloadCoverBtn.textContent = 'Downloaded!';
    setTimeout(() => { downloadCoverBtn.textContent = 'Download PDF'; }, 2000);
  } catch (err) {
    console.error('[JobPilot] PDF generation failed:', err);
    showClStatus('Could not generate PDF: ' + err.message, 'error');
  }
});

function buildCoverLetterFilename() {
  const sanitize = (s) => (s || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
  const parts = [lastCandidateName, lastJobCompany, getCoreTitle(lastJobTitle)].map(sanitize).filter(Boolean);
  const base = parts.length ? parts.join('_') : 'Cover_Letter';
  return `${base}_CL.pdf`;
}

function showClStatus(msg, type) {
  clStatus.textContent = msg;
  clStatus.className   = `cl-status ${type}`;
  clStatus.classList.remove('hidden');
}

// ─── Applied tracker ────────────────────────────────────────────────────────
//
// There's no signal available here for "the user actually clicked Submit on
// the site" — that happens entirely outside the extension. So this is a
// manual, explicit record: detect company/title/job ID for the current tab,
// show a button labeled with them, and let the user confirm once they've
// actually submitted. On open, it also checks past records and warns if this
// job (or a same-company/same-core-title match) was already marked applied.

function formatAppliedDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch (_) { return ''; }
}

function renderAppliedWarning(match) {
  if (!match) {
    appliedWarning.classList.add('hidden');
    return;
  }
  const when = formatAppliedDate(match.entry.appliedAt);
  appliedWarning.textContent = match.exact
    ? `⚠️ You already marked this job as applied on ${when}.`
    : `⚠️ You already applied to a similar role at this company on ${when} (${match.entry.jobTitle}).`;
  appliedWarning.classList.remove('hidden');
}

async function initAppliedTracker() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    if (!tab?.id || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
      appliedSection.classList.add('hidden');
      return;
    }

    const ctx = await detectJobContext(tab.id);
    if (!ctx.jobTitle && !ctx.jobCompany) {
      appliedSection.classList.add('hidden');
      return;
    }

    // Bail out early if this is a stale call for a job the user has already
    // navigated away from — otherwise a slow checkAppliedJob response for an
    // old tab/job can land after a newer refresh and overwrite it with
    // outdated info (a classic out-of-order-response race).
    const requestId = ++appliedTrackerRequestId;

    appliedJobId        = ctx.jobId;
    appliedJobUrl        = ctx.url;
    appliedJobCompany    = ctx.jobCompany;
    appliedJobTitleFull  = ctx.jobTitle;

    // Reset any "already applied" indicator left over from whatever job was
    // shown before this refresh — otherwise it silently carries over onto a
    // new job that hasn't actually been applied to yet.
    markAppliedBtn.classList.remove('already');
    appliedBtnTitle.textContent = 'Mark as Applied';
    appliedWarning.classList.add('hidden');
    appliedWarning.classList.remove('applied-warning--done');

    const coreTitle = getCoreTitle(ctx.jobTitle);
    const shortId    = ctx.jobId && !ctx.jobId.startsWith('h_') ? `#${ctx.jobId.slice(0, 8)}` : '';
    appliedBtnMeta.textContent = [ctx.jobCompany, coreTitle, shortId].filter(Boolean).join(' · ');
    appliedSection.classList.remove('hidden');

    const resp = await chrome.runtime.sendMessage({
      action: 'checkAppliedJob', jobId: ctx.jobId, company: ctx.jobCompany, jobTitle: ctx.jobTitle,
    });
    if (requestId !== appliedTrackerRequestId) return; // superseded by a newer refresh

    if (resp?.match) {
      renderAppliedWarning(resp.match);
      markAppliedBtn.classList.add('already');
      appliedBtnTitle.textContent = 'Mark as Applied Again';
    }
  } catch (err) {
    console.warn('[JobPilot] Applied-tracker init failed:', err);
    appliedSection.classList.add('hidden');
  }
}

markAppliedBtn.addEventListener('click', async () => {
  const company = appliedJobCompany || '(unknown company)';
  const title   = getCoreTitle(appliedJobTitleFull) || '(unknown role)';
  if (!confirm(`Mark this application as submitted?\n\n${company} — ${title}`)) return;

  markAppliedBtn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'recordAppliedJob',
      jobId: appliedJobId,
      company: appliedJobCompany,
      jobTitle: appliedJobTitleFull,
      url: appliedJobUrl,
    });
    if (resp?.entry) {
      markAppliedBtn.classList.add('already');
      appliedBtnTitle.textContent = 'Mark as Applied Again';
      appliedWarning.textContent = `✅ Marked as applied on ${formatAppliedDate(resp.entry.appliedAt)}.`;
      appliedWarning.classList.remove('hidden');
      appliedWarning.classList.add('applied-warning--done');
    }
  } finally {
    markAppliedBtn.disabled = false;
  }
});

// ─── Setup gate ───────────────────────────────────────────────────────────────

setupBtn.addEventListener('click', () => {
  // No window.close() here — the panel is meant to stay docked open, not
  // collapse, while onboarding runs in its own tab.
  chrome.runtime.sendMessage({ action: 'openOnboarding' });
});

async function checkSetup() {
  const resp = await chrome.runtime.sendMessage({ action: 'getPref', key: 'setupComplete' });
  if (!resp?.value) {
    fillUI.classList.add('hidden');
    setupRequired.classList.remove('hidden');
  }
}

// Restore the last job description / cover letter so re-opening the panel
// (or a browser restart) doesn't lose a previously generated letter.
// trackedTabId is deliberately NOT restored — tab IDs from a previous
// browser session no longer exist, so the box stays un-tracked until the
// user's next open/generate action re-establishes it against a live tab.
async function restoreCoverLetterState() {
  try {
    const [jdResp, letterResp, titleResp, companyResp, matchResp, profileResp] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'getPref', key: 'clJobDescription' }),
      chrome.runtime.sendMessage({ action: 'getPref', key: 'clCoverLetter' }),
      chrome.runtime.sendMessage({ action: 'getPref', key: 'clJobTitle' }),
      chrome.runtime.sendMessage({ action: 'getPref', key: 'clJobCompany' }),
      chrome.runtime.sendMessage({ action: 'getPref', key: 'clMatchResult' }),
      chrome.runtime.sendMessage({ action: 'getProfile' }),
    ]);
    if (jdResp?.value) jobDescription.value = jdResp.value;
    if (titleResp?.value) lastJobTitle = titleResp.value;
    if (companyResp?.value) lastJobCompany = companyResp.value;
    const restoredProfile = profileResp?.profile;
    if (restoredProfile) {
      lastCandidateName = restoredProfile.fullName
        || [restoredProfile.firstName, restoredProfile.lastName].filter(Boolean).join(' ');
    }
    if (letterResp?.value) {
      coverLetterText.value = letterResp.value;
      clResult.classList.remove('hidden');
      clOpen = true;
      clPanel.classList.remove('hidden');
      clChevron.classList.add('open');
    }
    if (matchResp?.value) {
      renderMatchResult(matchResp.value);
      clOpen = true;
      clPanel.classList.remove('hidden');
      clChevron.classList.add('open');
    }
  } catch (_) { /* best-effort restore */ }
}

checkSetup();
restoreCoverLetterState();
initAppliedTracker();
