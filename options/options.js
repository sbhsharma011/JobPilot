/**
 * options.js — JobPilot settings page controller
 *
 * Loads the saved profile into the form on page load,
 * saves it back on submit.
 */

'use strict';

// All field names that map directly to an input/select/textarea by id
const FIELD_NAMES = [
  'firstName', 'lastName', 'email', 'phone', 'location', 'city', 'state', 'zip',
  'linkedin', 'website', 'github',
  'currentTitle', 'currentCompany', 'yearsExperience', 'salaryExpectation',
  'noticePeriod', 'summary', 'skills',
  'education', 'university', 'graduationYear',
  'workAuthorized', 'requireSponsorship', 'willingToRelocate', 'openToRemote', 'currentlyEmployed',
  'veteranStatus', 'disabilityStatus', 'gender', 'ethnicity', 'pronouns',
  'anthropicApiKey', 'anthropicModel',
];

const form         = document.getElementById('profileForm');
const saveBtn      = document.getElementById('saveBtn');
const saveConfirm  = document.getElementById('saveConfirm');
const toggleKeyBtn = document.getElementById('toggleKey');
const apiKeyInput  = document.getElementById('anthropicApiKey');

const resumeUploadZone   = document.getElementById('resumeUploadZone');
const resumeFileInput    = document.getElementById('resumeFileInput');
const resumeUploadStatus = document.getElementById('resumeUploadStatus');

const insightsEmpty     = document.getElementById('insightsEmpty');
const insightsTableWrap = document.getElementById('insightsTableWrap');
const insightsBody      = document.getElementById('insightsBody');
const clearInsightsBtn  = document.getElementById('clearInsightsBtn');

// ─── Load profile into form ───────────────────────────────────────────────────

async function loadProfile() {
  const response = await chrome.runtime.sendMessage({ action: 'getProfile' });
  const profile  = response?.profile;
  if (!profile) return;

  for (const name of FIELD_NAMES) {
    const el = document.getElementById(name);
    if (!el) continue;
    const value = profile[name] ?? '';
    if (el.tagName === 'SELECT') {
      // Set select value; fall back to first option if not found
      const exists = [...el.options].some(o => o.value === value);
      el.value = exists ? value : el.options[0]?.value || '';
    } else {
      el.value = value;
    }
  }
}

// ─── Collect form values into profile object ──────────────────────────────────

function collectProfile() {
  const profile = {};
  for (const name of FIELD_NAMES) {
    const el = document.getElementById(name);
    profile[name] = el ? el.value.trim() : '';
  }

  // Derived full name
  profile.fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');

  return profile;
}

// ─── Save handler ─────────────────────────────────────────────────────────────

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  saveBtn.disabled = true;

  const profile = collectProfile();

  try {
    await chrome.runtime.sendMessage({ action: 'saveProfile', profile });
    // Show "Saved!" briefly
    saveConfirm.classList.remove('hidden');
    // Reset animation by re-inserting element
    void saveConfirm.offsetWidth;
    saveConfirm.style.animation = 'none';
    requestAnimationFrame(() => {
      saveConfirm.style.animation = '';
      setTimeout(() => saveConfirm.classList.add('hidden'), 2600);
    });
  } catch (err) {
    console.error('[JobPilot] Save failed:', err);
    alert('Failed to save profile: ' + err.message);
  } finally {
    saveBtn.disabled = false;
  }
});

// ─── Toggle API key visibility ────────────────────────────────────────────────

toggleKeyBtn.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';

  // Swap icon
  const icon = document.getElementById('eyeIcon');
  if (isPassword) {
    // Eye with slash (hidden state)
    icon.innerHTML = `
      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>
      <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    `;
  } else {
    // Open eye
    icon.innerHTML = `
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    `;
  }
});

// ─── Update Resume: rebuild Summary & Skills from a new upload ────────────────

function setResumeUploadStatus(text, type = 'info') {
  resumeUploadStatus.textContent = text;
  resumeUploadStatus.className = `upload-status ${type}`;
  resumeUploadStatus.classList.remove('hidden');
}

async function handleResumeUpload(file) {
  resumeUploadZone.classList.add('processing');
  setResumeUploadStatus('Reading file…', 'info');

  try {
    const { resumeText, pdfBase64 } = await JobPilotResume.readResumeFile(file);

    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      setResumeUploadStatus('Add and save an Anthropic API key above first, then re-upload to rebuild.', 'warn');
      return;
    }

    setResumeUploadStatus('Parsing resume with Claude AI…', 'info');
    const parseResp = await chrome.runtime.sendMessage({
      action: 'parseResume',
      resumeText,
      pdfBase64,
      apiKey,
    });

    if (!parseResp?.profile) {
      setResumeUploadStatus('⚠️ ' + (parseResp?.error || 'Could not parse resume.'), 'error');
      return;
    }

    const { summary, skills, detailedBackground } = parseResp.profile;

    if (summary) document.getElementById('summary').value = summary;
    if (skills)  document.getElementById('skills').value  = skills;

    // The full resume detail (used for job-match/cover-letter grounding) isn't
    // a visible field on this form — persist it directly rather than waiting
    // on "Save Profile". For PDFs there's no local text extraction (Claude
    // reads the PDF natively), so fall back to Claude's own detailed narrative.
    const resumeTextToStore = resumeText || detailedBackground || '';
    if (resumeTextToStore) {
      await chrome.runtime.sendMessage({ action: 'saveProfile', profile: { resumeText: resumeTextToStore } });
    }

    setResumeUploadStatus('✅ Rebuilt Summary & Skills from your resume — review below, then click Save Profile.', 'success');
  } catch (err) {
    setResumeUploadStatus('Error: ' + err.message, 'error');
  } finally {
    resumeUploadZone.classList.remove('processing');
  }
}

resumeUploadZone.addEventListener('click', () => resumeFileInput.click());
resumeUploadZone.addEventListener('dragover', e => { e.preventDefault(); resumeUploadZone.classList.add('dragover'); });
resumeUploadZone.addEventListener('dragleave', () => resumeUploadZone.classList.remove('dragover'));
resumeUploadZone.addEventListener('drop', e => {
  e.preventDefault();
  resumeUploadZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleResumeUpload(file);
});
resumeFileInput.addEventListener('change', () => {
  if (resumeFileInput.files[0]) handleResumeUpload(resumeFileInput.files[0]);
  resumeFileInput.value = '';
});

// ─── Recurring gap insights ───────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch (_) { return ''; }
}

function renderInsights(insights) {
  if (!insights.length) {
    insightsEmpty.classList.remove('hidden');
    insightsTableWrap.classList.add('hidden');
    return;
  }

  insightsEmpty.classList.add('hidden');
  insightsTableWrap.classList.remove('hidden');

  insightsBody.innerHTML = insights.map(entry => {
    // "Worth adding" = recurred more than once and mostly judged safe —
    // a requirement several different companies have asked for that isn't
    // a stretch given the existing profile.
    const worthAdding = entry.count > 1 && entry.safeCount >= entry.riskyCount;
    const variantCount = Object.keys(entry.variants || {}).length;
    const hint = variantCount > 1
      ? `<span class="insights-keyword-hint">${variantCount} phrasings seen</span>`
      : '';

    return `
      <tr class="${worthAdding ? 'insights-row--worth' : ''}">
        <td class="insights-keyword">${escapeHtml(entry.label)}${hint}</td>
        <td class="insights-count">${entry.count}</td>
        <td>${entry.safeCount ? `<span class="insights-badge insights-badge--safe">${entry.safeCount}</span>` : '<span class="insights-badge insights-badge--zero">0</span>'}</td>
        <td>${entry.riskyCount ? `<span class="insights-badge insights-badge--risky">${entry.riskyCount}</span>` : '<span class="insights-badge insights-badge--zero">0</span>'}</td>
        <td>${formatDate(entry.lastSeen)}</td>
      </tr>`;
  }).join('');
}

async function loadInsights() {
  const resp = await chrome.runtime.sendMessage({ action: 'getKeywordInsights' });
  renderInsights(resp?.insights || []);
}

clearInsightsBtn.addEventListener('click', async () => {
  if (!confirm('Clear all tracked recurring gaps? This cannot be undone.')) return;
  clearInsightsBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ action: 'clearKeywordInsights' });
    await loadInsights();
  } finally {
    clearInsightsBtn.disabled = false;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

loadProfile().catch(err => console.error('[JobPilot] Load error:', err));
loadInsights().catch(err => console.error('[JobPilot] Insights load error:', err));
