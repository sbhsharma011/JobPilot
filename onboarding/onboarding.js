'use strict';

const TOTAL_STEPS = 4;
let currentStep = 1;
let extractedResumeText = '';
let parsedFromResume = {};

// ── Step navigation ───────────────────────────────────────────────────────────

function showStep(n) {
  document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
  const target = n > TOTAL_STEPS ? document.getElementById('stepDone') : document.getElementById(`step${n}`);
  if (target) target.classList.add('active');

  const pct = Math.min((n - 1) / TOTAL_STEPS * 100, 100);
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('stepLabel').textContent =
    n > TOTAL_STEPS ? 'Complete!' : `Step ${n} of ${TOTAL_STEPS}`;

  currentStep = n;
}

// ── Step 1: API Key ───────────────────────────────────────────────────────────

document.getElementById('toggleKey').addEventListener('click', () => {
  const inp = document.getElementById('apiKey');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

document.getElementById('step1Next').addEventListener('click', async () => {
  const key = document.getElementById('apiKey').value.trim();
  // Save key immediately so resume step can use it
  await chrome.runtime.sendMessage({
    action: 'savePref',
    key: 'anthropicApiKey',
    value: key,
  });
  showStep(2);
});

// ── Step 2: Resume Upload ─────────────────────────────────────────────────────

const uploadZone  = document.getElementById('uploadZone');
const fileInput   = document.getElementById('resumeFile');
const uploadStatus = document.getElementById('uploadStatus');
const step2Next   = document.getElementById('step2Next');

uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleResumeFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleResumeFile(fileInput.files[0]);
});

function setUploadStatus(text, type = 'info') {
  uploadStatus.textContent = text;
  uploadStatus.className = `upload-status ${type}`;
  uploadStatus.classList.remove('hidden');
}

async function handleResumeFile(file) {
  if (file.size > JobPilotResume.MAX_FILE_BYTES) {
    setUploadStatus('File too large (max 5 MB).', 'error');
    return;
  }

  setUploadStatus('Reading file…', 'info');
  uploadZone.classList.add('processing');

  try {
    const { resumeText, pdfBase64 } = await JobPilotResume.readResumeFile(file);
    extractedResumeText = resumeText;

    // Try to parse with Claude if API key is available
    const prefResp = await chrome.runtime.sendMessage({ action: 'getPref', key: 'anthropicApiKey' });
    const apiKey = prefResp?.value || '';

    if (apiKey) {
      setUploadStatus('Parsing resume with Claude AI…', 'info');
      const parseResp = await chrome.runtime.sendMessage({
        action: 'parseResume',
        resumeText: extractedResumeText,
        pdfBase64,
        apiKey,
      });

      if (parseResp?.profile) {
        parsedFromResume = parseResp.profile;
        setUploadStatus('✅ Resume parsed — your details have been pre-filled.', 'success');
      } else {
        setUploadStatus('⚠️ Could not parse resume — fill in details manually.', 'warn');
      }
    } else {
      setUploadStatus('✅ File loaded. Add an API key to auto-extract details.', 'success');
    }

    step2Next.disabled = false;
    // For txt/docx we already have the real extracted text — that's the best
    // source. For PDFs there is no local extraction (Claude reads the PDF
    // directly), so extractedResumeText is empty; fall back to the detailed
    // narrative Claude produced during parsing so profile matching still has
    // real resume detail to work with instead of just the short summary field.
    const resumeTextToStore = extractedResumeText || parsedFromResume.detailedBackground || '';
    await chrome.runtime.sendMessage({ action: 'savePref', key: 'resumeText', value: resumeTextToStore });

  } catch (err) {
    setUploadStatus('Error reading file: ' + err.message, 'error');
  } finally {
    uploadZone.classList.remove('processing');
  }
}

document.getElementById('step2Back').addEventListener('click', () => showStep(1));
document.getElementById('step2Skip').addEventListener('click', () => showStep(3));
document.getElementById('step2Next').addEventListener('click', () => {
  prefillStep3(parsedFromResume);
  showStep(3);
});

// ── Step 3: Personal Details ──────────────────────────────────────────────────
//
// Every field the resume parser can plausibly extract gets filled here and
// marked "from resume". Anything Claude couldn't find is marked "needs your
// input" (only when a resume was actually parsed) so the user knows exactly
// which fields still need their attention instead of re-checking all of them.

const STEP3_FIELD_IDS = [
  's3FirstName', 's3LastName', 's3Email', 's3Phone', 's3Location',
  's3LinkedIn', 's3Website', 's3Github', 's3CurrentTitle', 's3CurrentCompany',
  's3YearsExp', 's3Summary', 's3Skills', 's3Education', 's3University', 's3GradYear',
];

function setFieldBadge(el, text, type) {
  const group = el.closest('.form-group');
  if (!group) return;
  group.classList.remove('field-filled', 'field-needs-input');
  const label = group.querySelector('label');
  let badge = label && label.querySelector('.field-badge');
  if (!text) {
    if (badge) badge.remove();
    return;
  }
  group.classList.add(type === 'filled' ? 'field-filled' : 'field-needs-input');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'field-badge';
    label.appendChild(badge);
  }
  badge.textContent = text;
  badge.className = `field-badge field-badge--${type}`;
}

function prefillStep3(data) {
  const map = {
    s3FirstName:    data.firstName    || '',
    s3LastName:     data.lastName     || '',
    s3Email:        data.email        || '',
    s3Phone:        data.phone        || '',
    s3Location:     data.location     || '',
    s3LinkedIn:     data.linkedin     || '',
    s3Website:      data.website      || '',
    s3Github:       data.github       || '',
    s3CurrentTitle: data.currentTitle || '',
    s3CurrentCompany: data.currentCompany || '',
    s3YearsExp:     data.yearsExperience || '',
    s3Summary:      data.summary      || '',
    s3Skills:       data.skills       || '',
    s3Education:    data.education    || '',
    s3University:   data.university   || '',
    s3GradYear:     data.graduationYear || '',
  };

  const resumeWasParsed = Object.values(data).some(v => v);

  for (const [id, val] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (val) {
      el.value = val;
      setFieldBadge(el, '✓ From resume', 'filled');
    } else if (resumeWasParsed) {
      setFieldBadge(el, 'Needs your input', 'needed');
    } else {
      setFieldBadge(el, '', null);
    }
  }
}

// Once the user edits a field themselves, drop the "needs your input" flag —
// it's been addressed.
for (const id of STEP3_FIELD_IDS) {
  const el = document.getElementById(id);
  if (!el) continue;
  el.addEventListener('input', () => {
    if (el.value.trim()) setFieldBadge(el, '', null);
  });
}

document.getElementById('step3Back').addEventListener('click', () => showStep(2));
document.getElementById('step3Next').addEventListener('click', () => showStep(4));

// ── Step 4: Defaults + Finish ─────────────────────────────────────────────────

document.getElementById('step4Back').addEventListener('click', () => showStep(3));

document.getElementById('step4Finish').addEventListener('click', async () => {
  const profile = buildProfile();

  // The API key and resume text were saved as standalone prefs earlier (Step 1
  // and Step 2, so the resume parser could use them immediately) — pull them
  // back in here so they actually end up on the profile object content.js and
  // the matcher check. Without this, they never reach saveProfile below since
  // buildProfile() doesn't set them itself.
  const keyResp  = await chrome.runtime.sendMessage({ action: 'getPref', key: 'anthropicApiKey' });
  const textResp = await chrome.runtime.sendMessage({ action: 'getPref', key: 'resumeText' });
  profile.anthropicApiKey = keyResp?.value || '';
  profile.resumeText      = textResp?.value || '';

  await chrome.runtime.sendMessage({ action: 'saveProfile', profile });
  await chrome.runtime.sendMessage({ action: 'savePref', key: 'setupComplete', value: true });
  showStep(5);
});

function buildProfile() {
  return {
    firstName:          document.getElementById('s3FirstName').value.trim(),
    lastName:           document.getElementById('s3LastName').value.trim(),
    fullName:           [document.getElementById('s3FirstName').value.trim(), document.getElementById('s3LastName').value.trim()].filter(Boolean).join(' '),
    email:              document.getElementById('s3Email').value.trim(),
    phone:              document.getElementById('s3Phone').value.trim(),
    location:           document.getElementById('s3Location').value.trim(),
    city:               document.getElementById('s3Location').value.split(',')[0]?.trim() || '',
    state:              document.getElementById('s3Location').value.split(',')[1]?.trim() || '',
    linkedin:           document.getElementById('s3LinkedIn').value.trim(),
    website:            document.getElementById('s3Website').value.trim(),
    github:             document.getElementById('s3Github').value.trim(),
    currentTitle:       document.getElementById('s3CurrentTitle').value.trim(),
    currentCompany:     document.getElementById('s3CurrentCompany').value.trim(),
    yearsExperience:    document.getElementById('s3YearsExp').value.trim(),
    summary:            document.getElementById('s3Summary').value.trim(),
    skills:             document.getElementById('s3Skills').value.trim(),
    education:          document.getElementById('s3Education').value.trim(),
    university:         document.getElementById('s3University').value.trim(),
    graduationYear:     document.getElementById('s3GradYear').value.trim(),
    salaryExpectation:  document.getElementById('s4Salary').value.trim(),
    noticePeriod:       document.getElementById('s4Notice').value.trim(),
    workAuthorized:     document.getElementById('s4WorkAuth').value,
    requireSponsorship: document.getElementById('s4Sponsorship').value,
    openToRemote:       document.getElementById('s4Remote').value,
    willingToRelocate:  document.getElementById('s4Relocate').value,
    veteranStatus:      document.getElementById('s4Veteran').value,
    disabilityStatus:   document.getElementById('s4Disability').value,
    gender:             document.getElementById('s4Gender').value,
    ethnicity:          document.getElementById('s4Ethnicity').value,
    currentlyEmployed:  'Yes',
    anthropicModel:     'claude-haiku-4-5-20251001',
    zip: '', pronouns: '',
  };
}

// ── Done ──────────────────────────────────────────────────────────────────────

document.getElementById('closeBtn').addEventListener('click', () => window.close());

// ── Init ──────────────────────────────────────────────────────────────────────

showStep(1);
