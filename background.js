/**
 * background.js  — MV3 Service Worker
 *
 * Responsibilities:
 *  1. Profile storage helpers (chrome.storage.local)
 *  2. Relay Anthropic API calls from content script (avoids CORS restrictions)
 *  3. Handle profile get/set messages from popup / options / onboarding
 */

'use strict';

// ─── Side panel: clicking the toolbar icon opens the docked side panel ───────
// instead of the old dropdown popup, so the UI stays open across page clicks
// and tab switches instead of collapsing on blur.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(err => console.error('[JobPilot] sidePanel setup failed:', err));

// ─── Default profile (empty — onboarding collects real values) ────────────────

const DEFAULT_PROFILE = {
  firstName: '', lastName: '', fullName: '', email: '', phone: '',
  location: '', city: '', state: '', zip: '',
  linkedin: '', website: '', github: '',
  currentTitle: '', currentCompany: '', yearsExperience: '',
  education: '', university: '', graduationYear: '',
  salaryExpectation: '', noticePeriod: '',
  workAuthorized: 'Yes', requireSponsorship: 'No',
  willingToRelocate: 'No', openToRemote: 'Yes', currentlyEmployed: 'Yes',
  veteranStatus: "I am not a protected veteran",
  disabilityStatus: "I don't wish to answer",
  gender: "I don't wish to answer",
  ethnicity: "I don't wish to answer",
  pronouns: '', summary: '', skills: '',
  anthropicApiKey: '', anthropicModel: 'claude-haiku-4-5-20251001',
  resumeText: '',
};

// ─── Storage helpers ──────────────────────────────────────────────────────────

async function getProfile() {
  return new Promise(resolve => {
    chrome.storage.local.get('profile', data => {
      resolve(Object.assign({}, DEFAULT_PROFILE, data.profile || {}));
    });
  });
}

async function saveProfile(profile) {
  // Merge rather than overwrite: callers (options page, onboarding) each only
  // populate the fields their own form knows about, so a raw overwrite would
  // silently wipe out any field absent from that particular form (e.g. saving
  // Settings — which has no resumeText input — would erase resumeText).
  const current = await getProfile();
  const merged = Object.assign({}, current, profile);
  return new Promise(resolve => {
    chrome.storage.local.set({ profile: merged }, resolve);
  });
}

async function getPref(key) {
  return new Promise(resolve => {
    chrome.storage.local.get(key, data => resolve(data[key] ?? null));
  });
}

async function savePref(key, value) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

// ─── Recurring JD-gap insights ─────────────────────────────────────────────
//
// Every time a JD match runs, the "missing" requirements are folded into a
// running tally keyed by a semantic concept id (not the raw phrase), so that
// e.g. "change management" and "managing organizational change" accumulate
// under one entry instead of being tracked as unrelated strings. The concept
// id is assigned by the same Claude call that does the matching (see
// matchProfileToJob) — it's handed the concept ids seen so far and asked to
// reuse one when a new missing item is the same underlying thing, or mint a
// new one otherwise. A local slugify is only a fallback if the model omits it.
//
// Each JD is only counted once (by a hash of its text) so re-clicking "Check
// Profile Match" on the same posting doesn't inflate the counters.

const MAX_SEEN_JD_HASHES = 300;
const MAX_INSIGHT_REASONS = 5;

function hashText(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

function slugifyFallback(phrase) {
  return (phrase || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'unknown';
}

async function getKeywordInsights() {
  return new Promise(resolve => {
    chrome.storage.local.get('keywordInsights', data => resolve(data.keywordInsights || {}));
  });
}

async function getSeenJDHashes() {
  return new Promise(resolve => {
    chrome.storage.local.get('insightsSeenJDHashes', data => resolve(data.insightsSeenJDHashes || []));
  });
}

async function recordMissingKeywords(missing, jobDescription) {
  if (!Array.isArray(missing) || missing.length === 0) return;

  const jdHash = hashText(jobDescription.trim());
  const seenHashes = await getSeenJDHashes();
  if (seenHashes.includes(jdHash)) return; // already counted this exact JD

  const insights = await getKeywordInsights();
  const now = new Date().toISOString();

  for (const item of missing) {
    const phrase = (item.keyword || '').trim();
    if (!phrase) continue;
    const id = (item.canonical && String(item.canonical).trim()) || slugifyFallback(phrase);

    const entry = insights[id] || {
      canonical: id,
      label: phrase,
      variants: {},
      count: 0,
      safeCount: 0,
      riskyCount: 0,
      reasons: [],
      firstSeen: now,
      lastSeen: now,
    };

    entry.count += 1;
    if (item.safeToAdd) entry.safeCount += 1; else entry.riskyCount += 1;
    entry.variants[phrase] = (entry.variants[phrase] || 0) + 1;
    // Display label tracks the most frequently-seen phrasing for this concept.
    const topVariant = Object.entries(entry.variants).sort((a, b) => b[1] - a[1])[0];
    if (topVariant) entry.label = topVariant[0];
    if (item.reason && !entry.reasons.includes(item.reason)) {
      entry.reasons.push(item.reason);
      if (entry.reasons.length > MAX_INSIGHT_REASONS) entry.reasons.shift();
    }
    entry.lastSeen = now;

    insights[id] = entry;
  }

  const updatedHashes = [...seenHashes, jdHash].slice(-MAX_SEEN_JD_HASHES);

  await new Promise(resolve => {
    chrome.storage.local.set({ keywordInsights: insights, insightsSeenJDHashes: updatedHashes }, resolve);
  });
}

async function clearKeywordInsights() {
  return new Promise(resolve => {
    chrome.storage.local.set({ keywordInsights: {}, insightsSeenJDHashes: [] }, resolve);
  });
}

// ─── Applied-job tracking ───────────────────────────────────────────────────
//
// There's no way to detect a real form submission from here — the user
// clicks "Submit" on the job site itself, outside anything the extension
// controls. So this is deliberately a manual record: the popup shows a
// "Mark as Applied" button labeled with the detected company/title/job ID,
// the user confirms after actually submitting, and that's what gets stored.
//
// Keyed primarily by jobId (extracted from the page — see popup.js), with a
// fallback fuzzy match on normalized company + core job title for postings
// where a clean ID couldn't be pulled out of the URL, or where the same role
// is revisited via a slightly different URL.

function normalizeForMatch(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function coreTitleForMatch(title) {
  return normalizeForMatch((title || '').split(/[,–—-]/)[0]);
}

async function getAppliedJobs() {
  return new Promise(resolve => {
    chrome.storage.local.get('appliedJobs', data => resolve(data.appliedJobs || {}));
  });
}

async function findAppliedJobMatch(jobId, company, jobTitle) {
  const jobs = await getAppliedJobs();
  if (jobId && jobs[jobId]) return { exact: true, entry: jobs[jobId] };

  const companyNorm = normalizeForMatch(company);
  const titleNorm    = coreTitleForMatch(jobTitle);
  if (!companyNorm || !titleNorm) return null;

  for (const entry of Object.values(jobs)) {
    if (normalizeForMatch(entry.company) === companyNorm && coreTitleForMatch(entry.jobTitle) === titleNorm) {
      return { exact: false, entry };
    }
  }
  return null;
}

async function recordAppliedJob({ jobId, company, jobTitle, url }) {
  const jobs = await getAppliedJobs();
  const id = jobId || `h_${hashText(url || `${company}|${jobTitle}`)}`;
  const entry = {
    jobId: id,
    company:  company  || '',
    jobTitle: jobTitle || '',
    url:      url      || '',
    appliedAt: new Date().toISOString(),
  };
  jobs[id] = entry;
  await new Promise(resolve => chrome.storage.local.set({ appliedJobs: jobs }, resolve));
  return entry;
}

// ─── On install: open onboarding if setup not done ────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  const setupComplete = await getPref('setupComplete');
  if (!setupComplete) {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
  }
});

// ─── Resume parsing via Claude ────────────────────────────────────────────────

async function parseResumeWithClaude(resumeText, apiKey, pdfBase64 = null) {
  const instructions = `Extract structured profile information from this resume and return ONLY a JSON object with these exact keys (use empty string "" for anything not found):

{
  "firstName": "",
  "lastName": "",
  "email": "",
  "phone": "",
  "location": "",
  "linkedin": "",
  "website": "",
  "github": "",
  "currentTitle": "",
  "currentCompany": "",
  "yearsExperience": "",
  "education": "",
  "university": "",
  "graduationYear": "",
  "summary": "",
  "skills": "",
  "detailedBackground": ""
}

Rules:
- location: "City, State" format (e.g. "Atlanta, GA")
- skills: comma-separated list of key skills
- yearsExperience: number only (e.g. "8")
- graduationYear: 4-digit year string
- summary: 1-2 sentence professional summary
- detailedBackground: a thorough plain-text transcription of the candidate's actual experience — every role with employer, dates, and its real responsibilities/achievements (keep concrete metrics, tools, and technologies verbatim), plus notable projects, certifications, and any other substantive resume content. This is the field a later AI step will use to judge fit against job descriptions in detail, so prioritize completeness and specificity over brevity — do not compress into vague generalities. Plain text, no markdown formatting. Up to ~700 words.
- Return ONLY the JSON object — no markdown, no explanation`;

  // PDFs go straight to Claude as a native document block — Claude reads the
  // actual PDF content. This avoids ever needing to extract PDF text client-side.
  const content = pdfBase64
    ? [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: instructions },
      ]
    : `${instructions}\n\nRESUME TEXT:\n${(resumeText || '').substring(0, 6000)}`;

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey.trim(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content }],
      }),
    });
  } catch (err) {
    return { error: `Network error: ${err.message}` };
  }

  if (!response.ok) {
    let body = '';
    try { body = await response.text(); } catch (_) {}
    return { error: `API error ${response.status}: ${body}` };
  }

  let data;
  try { data = await response.json(); } catch (err) {
    return { error: 'Failed to parse API response' };
  }

  const rawText = data?.content?.[0]?.text || '';

  let profile;
  try {
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    profile = JSON.parse(cleaned);
  } catch (_) {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) {
      try { profile = JSON.parse(match[0]); } catch (_) {
        return { error: 'Could not parse resume extraction response' };
      }
    } else {
      return { error: 'No JSON found in resume extraction response' };
    }
  }

  return { profile };
}

// ─── Cover letter generation ──────────────────────────────────────────────────

async function generateCoverLetter(profile, jobDescription, jobTitle, jobCompany) {
  const apiKey = profile.anthropicApiKey;
  if (!apiKey?.trim()) {
    return { error: 'No Anthropic API key configured. Add your key in Settings.' };
  }

  const compactProfile = {};
  for (const [k, v] of Object.entries(profile)) {
    if (['anthropicApiKey', 'anthropicModel', 'resumeText'].includes(k)) continue;
    if (v) compactProfile[k] = v;
  }

  const name  = profile.fullName || [profile.firstName, profile.lastName].filter(Boolean).join(' ');
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const contactLine = [profile.email, profile.phone, profile.linkedin].filter(Boolean).join(' · ');

  const resumeBlock = profile.resumeText?.trim()
    ? `\nCANDIDATE RESUME DETAIL (full detail behind the profile above — draw on this for concrete, specific achievements, metrics, and tools to reference instead of staying generic. It does not override the profile; both describe the same candidate's real background):\n${profile.resumeText.substring(0, 6000)}\n`
    : '';

  const prompt = `Write a compelling, tailored cover letter for ${name} applying for this role, formatted as a complete, official cover letter — not just the body paragraphs.

CANDIDATE PROFILE (every claim in the letter must be grounded in this or the resume detail below):
${JSON.stringify(compactProfile, null, 2)}
${resumeBlock}
JOB TITLE: ${jobTitle || 'the position'}
COMPANY: ${jobCompany || '(unknown)'}
TODAY'S DATE: ${today}

JOB DESCRIPTION (this may be auto-scraped from the job page and contain some
unrelated site navigation/footer text mixed in — focus on the actual role
responsibilities and requirements, and ignore anything that looks like
site chrome, cookie notices, or unrelated links). Use this ONLY to decide
which of the candidate's real, existing strengths to lead with and how to
frame them — it is not a checklist of things to claim about the candidate:
${jobDescription.substring(0, 8000)}

GROUNDING RULES — the most important constraint on this letter:
- Never state or imply that the candidate has a skill, tool, technology, certification, or experience that is not explicitly present in the CANDIDATE PROFILE or CANDIDATE RESUME DETAIL above, even if the job description asks for it.
- Do not mirror the job description's buzzwords or phrasing back as if they were facts about the candidate. Write from the candidate's actual background, not from the posting's wish list.
- Prefer specifics over generalities: when the resume detail has a concrete metric, tool, or outcome relevant to this role, use it by name instead of a vague paraphrase (e.g. "cut deployment time 40% using Jenkins" beats "improved engineering processes").
- If the profile has strong, direct overlap with the role, highlight that plainly. If the overlap is partial or the profile is a stretch for this role, do NOT force connections that aren't genuinely there — instead, write honestly about the closest real, relevant experience and let it stand on its own rather than exaggerating its relevance.
- It is better for the letter to be modest and accurate than impressive and inflated.

Structure the letter with these parts, in order:
1. HEADER: the candidate's full name on its own line, then a line with ${contactLine ? `their contact details: ${contactLine}` : 'contact details if known'}, then a blank line, then "${today}".
2. GREETING: "Dear Hiring Team," on its own line — always exactly this, never prefixed with the company or job title name.
3. BODY — 3-4 short paragraphs:
   - Opening: hook that references something specific in the role or company — NOT generic phrases like "I am writing to express my interest"
   - Body: 1-2 paragraphs grounded in the candidate's actual, verifiable experience and achievements from the profile, framed in terms relevant to this role; use concrete metrics where the profile provides them, and do not invent ones it doesn't
   - Closing: confident, concise call to action
4. CLOSING: "Sincerely," on its own line, followed by "${name}" on the next line.

Style: professional, direct, confident — never sycophantic, never padded.
Write in natural, flowing sentences. Do NOT use em dashes (—) or en dashes (–) as punctuation anywhere in the letter — use commas, periods, or conjunctions ("and", "so", "which") instead.
Body length: 250–350 words (the header/greeting/closing are additional).
Return ONLY the formatted letter text (header, greeting, body, and closing) — no markdown, no explanation, no placeholder brackets like "[Company Name]".`;

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey.trim(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: profile.anthropicModel || 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (err) {
    return { error: `Network error: ${err.message}` };
  }

  if (!response.ok) {
    let body = '';
    try { body = await response.text(); } catch (_) {}
    return { error: `API error ${response.status}: ${body.substring(0, 200)}` };
  }

  let data;
  try { data = await response.json(); } catch (err) {
    return { error: 'Failed to parse API response' };
  }

  const coverLetter = data?.content?.[0]?.text?.trim() || '';
  return { coverLetter };
}

// ─── Profile / job match scoring ──────────────────────────────────────────────

async function matchProfileToJob(profile, jobDescription) {
  const apiKey = profile.anthropicApiKey;
  if (!apiKey?.trim()) {
    return { error: 'No Anthropic API key configured. Add your key in Settings.' };
  }

  const compactProfile = {};
  for (const [k, v] of Object.entries(profile)) {
    if (['anthropicApiKey', 'anthropicModel', 'resumeText'].includes(k)) continue;
    if (v) compactProfile[k] = v;
  }

  // Known concept ids from prior JD checks, so the model can reuse one instead
  // of minting a near-duplicate (e.g. "change_management" already exists —
  // don't also create "managing_organizational_change" for the same idea).
  const knownInsights = await getKeywordInsights();
  const knownConcepts = Object.values(knownInsights)
    .sort((a, b) => b.count - a.count)
    .slice(0, 60)
    .map(e => `${e.canonical} — "${e.label}"`);

  const resumeBlock = profile.resumeText?.trim()
    ? `\nCANDIDATE RESUME DETAIL (full detail behind the profile above — use this to catch genuine matches the short profile fields don't capture, e.g. a specific tool mentioned in a past role's description. It does not override the profile; both are the same candidate's real background):\n${profile.resumeText.substring(0, 6000)}\n`
    : '';

  const prompt = `Compare this candidate's profile against a job description and score how well they genuinely match.

CANDIDATE PROFILE (skills, title, summary, experience, education):
${JSON.stringify(compactProfile, null, 2)}
${resumeBlock}
JOB DESCRIPTION (may contain some scraped site noise — focus on the actual role requirements and responsibilities, ignore nav/footer/cookie text):
${jobDescription.substring(0, 8000)}

Identify the key skills, tools, qualifications, and experience this job actually asks for, then compare each one against what is explicitly present in the candidate profile and resume detail above.

For each missing item, also judge whether it would be fair and safe for the candidate to add it to their profile, or whether doing so would risk misrepresenting them.

CONCEPT IDS ALREADY TRACKED FROM PAST JOB DESCRIPTIONS (id — example phrasing):
${knownConcepts.length ? knownConcepts.join('\n') : '(none yet)'}

For each missing item, also assign a "canonical" concept id: a short snake_case id for the underlying skill/requirement, independent of exact wording. If a missing item is the same underlying concept as one already tracked above (e.g. "change management" and "managing organizational change" are the same concept), reuse that exact id. Otherwise invent a new concise snake_case id. Do not create a new id for something that is just a reworded version of an existing one.

Return ONLY a JSON object with these exact keys:
{
  "score": 0,
  "matched": [],
  "missing": [
    { "keyword": "", "safeToAdd": false, "reason": "", "canonical": "" }
  ],
  "summary": ""
}

Rules:
- "score": integer 0-100. Be realistic and honest, not generous — a partial or tangential match should score 30-60, a strong direct match 75+, a poor fit below 30. Do not inflate the score to be encouraging.
- "matched": short strings — specific requirements from the job description the candidate genuinely satisfies per their profile (max 8 items, most important first)
- "missing": array of objects, one per requirement from the job description NOT evident anywhere in the candidate's profile (max 8 items, most important first). For each:
  - "keyword": the short requirement text
  - "safeToAdd": true only if it is a natural, honest, low-risk extension of something the candidate's profile ALREADY genuinely demonstrates (e.g. a closely related tool in the same toolchain as one they list, a synonym or common variant of an existing skill, or a direct restatement of experience they already have under different wording). Otherwise false.
  - "safeToAdd" MUST be false for anything requiring a claim the candidate cannot back up: a specific certification, license, degree, or formal credential they don't already list; a technology, domain, or seniority level with no genuine connection to anything in their profile; or years of experience beyond what they actually have. Never mark a certification/license/degree as safe to add just because the job wants it — those are independently verifiable and not something to fabricate.
  - "reason": one short clause explaining the judgment either way — for safeToAdd:true, name the existing profile fact it connects to; for safeToAdd:false, name what would be misrepresented
  - "canonical": snake_case concept id as described above — reuse an existing id whenever the underlying concept matches, even if the wording in this job description differs
  - When genuinely uncertain, default to safeToAdd:false — err conservative, not encouraging
- "summary": exactly one or two sentences, honest and specific about the overall fit
- Base this entirely on the CANDIDATE PROFILE and CANDIDATE RESUME DETAIL above. Do not assume or credit a skill/qualification that isn't actually stated in one of them
- Return ONLY the JSON object — no markdown, no explanation outside the object`;

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey.trim(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: profile.anthropicModel || 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (err) {
    return { error: `Network error: ${err.message}` };
  }

  if (!response.ok) {
    let body = '';
    try { body = await response.text(); } catch (_) {}
    return { error: `API error ${response.status}: ${body.substring(0, 200)}` };
  }

  let data;
  try { data = await response.json(); } catch (err) {
    return { error: 'Failed to parse API response' };
  }

  const rawText = data?.content?.[0]?.text || '';
  const match = parseJsonResponse(rawText);
  if (!match) {
    return { error: `Could not parse match response: ${rawText.substring(0, 150) || '(empty response)'}` };
  }

  match.score   = Math.max(0, Math.min(100, parseInt(match.score, 10) || 0));
  match.matched = Array.isArray(match.matched) ? match.matched.slice(0, 8) : [];
  match.summary = typeof match.summary === 'string' ? match.summary : '';

  // Normalize "missing" into { keyword, safeToAdd, reason, canonical } — fall
  // back gracefully if the model returned plain strings despite the schema,
  // defaulting safeToAdd to false (conservative, not encouraging).
  match.missing = Array.isArray(match.missing)
    ? match.missing.slice(0, 8).map(m => {
        if (typeof m === 'string') return { keyword: m, safeToAdd: false, reason: '', canonical: slugifyFallback(m) };
        const keyword = typeof m?.keyword === 'string' ? m.keyword : '';
        return {
          keyword,
          safeToAdd: m?.safeToAdd === true,
          reason:    typeof m?.reason === 'string' ? m.reason : '',
          canonical: typeof m?.canonical === 'string' && m.canonical.trim() ? m.canonical.trim() : slugifyFallback(keyword),
        };
      }).filter(m => m.keyword)
    : [];

  // Awaited (not fire-and-forget): the MV3 service worker can be suspended
  // right after sendResponse fires, which would drop an in-flight write.
  await recordMissingKeywords(match.missing, jobDescription).catch(err =>
    console.error('[JobPilot] Failed to record keyword insights:', err));

  return { match };
}

// ─── Resume tailoring suggestions ─────────────────────────────────────────────
//
// Compares the candidate's actual resume text against a job description and
// suggests surgical edits — rewording existing content into the JD's own
// vocabulary, or surfacing something already true but not currently written
// down — that a later step (utils/docxEditor.js) can apply directly to the
// uploaded .docx. The one non-negotiable rule: never suggest a way to claim
// a skill, tool, credential, or amount of experience the resume doesn't
// already genuinely demonstrate — that's fabrication, not tailoring, and
// most modern ATS/AI screeners are increasingly tuned to catch it anyway.

// Claude is asked to reproduce resume text verbatim inside JSON string
// fields (the "anchor" must match the source character-for-character so it
// can be located later). Real resume text can contain raw line breaks
// mid-bullet, and the model occasionally echoes one back as a literal
// newline instead of an escaped \n — technically invalid JSON, since raw
// control characters aren't allowed inside a JSON string. This walks the
// text tracking whether we're inside a string literal (respecting escape
// sequences) and escapes any stray control character found there, without
// touching whitespace that's already valid between tokens.
function sanitizeJsonControlChars(str) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { out += ch; inString = false; continue; }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r') { out += '\\r'; continue; }
    if (ch === '\t') { out += '\\t'; continue; }
    out += ch;
  }
  return out;
}

// Shared JSON-from-Claude parsing: strips markdown code fences, tries a
// direct parse, then falls back to a control-character-sanitized parse (see
// above), then narrows to the first {...} block and repeats both attempts —
// covers both "wrapped in prose" and "invalid control character" failure
// modes without giving up after just one shape of malformed response.
function parseJsonResponse(rawText) {
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const candidates = [cleaned, sanitizeJsonControlChars(cleaned)];

  const blockMatch = rawText.match(/\{[\s\S]*\}/);
  if (blockMatch) candidates.push(blockMatch[0], sanitizeJsonControlChars(blockMatch[0]));

  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch (_) { /* try next candidate */ }
  }
  return null;
}

// Tailoring needs exact verbatim anchors and careful "is this genuinely
// evidenced?" judgment — the two things Haiku is weakest at — so it's bumped
// to Sonnet unless the user explicitly picked a non-Haiku model in Settings.
const TAILOR_DEFAULT_MODEL = 'claude-sonnet-5';

function pickTailorModel(profile) {
  const m = profile.anthropicModel;
  return m && !/haiku/i.test(m) ? m : TAILOR_DEFAULT_MODEL;
}

// Resume text arrives already capped by the popup; this is just a backstop
// so a pathological upload can't blow the context budget.
const TAILOR_RESUME_CHARS = 15000;
const TAILOR_JD_CHARS = 10000;

async function callClaudeForJson(apiKey, model, prompt, maxTokens) {
  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey.trim(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (err) {
    return { error: `Network error: ${err.message}` };
  }

  if (!response.ok) {
    let body = '';
    try { body = await response.text(); } catch (_) {}
    return { error: `API error ${response.status}: ${body.substring(0, 200)}` };
  }

  let data;
  try { data = await response.json(); } catch (err) {
    return { error: 'Failed to parse API response' };
  }

  const rawText = (data?.content || []).find(b => b?.type === 'text')?.text || '';
  const parsed = parseJsonResponse(rawText);
  if (!parsed) {
    const cutOff = data?.stop_reason === 'max_tokens' ? ' (response was cut off)' : '';
    return { error: `Could not parse response${cutOff}: ${rawText.substring(0, 150) || '(empty response)'}` };
  }
  return { parsed };
}

// ── Step 1: the ATS keyword list ─────────────────────────────────────────────
//
// Claude only extracts the list; scoring against it is deterministic and
// happens in the popup (utils/atsScore.js), so the match % is repeatable and
// the model can't grade its own homework.

const ATS_CATEGORIES = new Set(['hard_skill', 'tool', 'certification', 'title', 'domain', 'soft_skill']);

async function extractAtsKeywords(profile, jobDescription) {
  const apiKey = profile.anthropicApiKey;
  if (!apiKey?.trim()) {
    return { error: 'No Anthropic API key configured. Add your key in Settings.' };
  }

  const prompt = `You are emulating the keyword-extraction step of an applicant tracking system (ATS) such as Workday, Greenhouse, Lever, iCIMS or Taleo — the step that decides which terms a resume is scored against.

JOB DESCRIPTION (may contain scraped site noise — ignore navigation, benefits, EEO/legal boilerplate and company marketing):
<job_description>
${jobDescription.substring(0, TAILOR_JD_CHARS)}
</job_description>

List the keywords an ATS would score a resume against for THIS role: hard skills, tools/technologies/platforms, certifications/licenses/degrees, the job title, domain/industry knowledge, and the few soft skills the JD explicitly emphasizes.

For each keyword return:
- "term": the exact phrasing used in the JD. ATS matching is literal, so keep the JD's wording ("stakeholder management", not "managing stakeholders").
- "variants": other spellings an ATS treats as the same term — acronym ↔ full form ("SEO" ↔ "Search Engine Optimization"), alternate spellings ("Postgres" ↔ "PostgreSQL", "Node.js" ↔ "NodeJS"). Do NOT include broader, narrower or merely related concepts ("AWS" is not a variant of "cloud computing"). Empty array if none.
- "category": "hard_skill" | "tool" | "certification" | "title" | "domain" | "soft_skill"
- "importance": "required" if it appears in required/minimum qualifications or is central/repeated in the role; "preferred" if it's nice-to-have/bonus or mentioned only in passing.

Rules:
- 15 to 40 keywords, most important first. Prefer specific, scannable terms ("Python", "A/B testing", "SOC 2") over generic phrases ("fast-paced environment", "passion for excellence").
- At most 6 soft skills.
- Exactly one "title" keyword: the role's core job title without level suffixes ("Senior Product Manager", not "Senior Product Manager II, Payments").
- Never list one concept twice under different wording — put alternates in "variants".
- Return ONLY a JSON object: { "jobTitle": "", "keywords": [ { "term": "", "variants": [], "category": "", "importance": "" } ] }
- Return ONLY the JSON object — no markdown, no explanation outside it`;

  const { parsed, error } = await callClaudeForJson(apiKey, pickTailorModel(profile), prompt, 3000);
  if (error) return { error };

  const seen = new Set();
  const keywords = [];
  for (const k of Array.isArray(parsed?.keywords) ? parsed.keywords : []) {
    const term = typeof k?.term === 'string' ? k.term.trim() : '';
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    keywords.push({
      term,
      variants: (Array.isArray(k.variants) ? k.variants : [])
        .filter(v => typeof v === 'string' && v.trim())
        .map(v => v.trim()),
      category: ATS_CATEGORIES.has(k.category) ? k.category : 'hard_skill',
      importance: k.importance === 'preferred' ? 'preferred' : 'required',
    });
    if (keywords.length >= 40) break;
  }

  if (!keywords.length) return { error: 'Could not identify any keywords in this job description.' };
  return { jobTitle: typeof parsed?.jobTitle === 'string' ? parsed.jobTitle : '', keywords };
}

// ── Step 2: the edits ────────────────────────────────────────────────────────
//
// Called up to three ways by the popup:
//   1. first pass — every missing keyword is fair game
//   2. gap pass — same, but restricted to keywords still missing after the
//      first pass, with the first pass's edits shown so it doesn't collide
//   3. confirmed pass — keywords the candidate ticked as "I genuinely have
//      this"; the only route by which something not already evidenced in
//      the resume text gets written in, and only on the candidate's say-so

const EDIT_KINDS = new Set(['skills', 'summary', 'headline', 'reword', 'insert-bullet']);
const EDIT_EVIDENCE = new Set(['evidenced', 'adjacent', 'confirmed']);
const LEADING_BULLET_RE = /^[\s•▪◦‣·●○■□◆◇➢➤►✓✔*-]+/;

function formatKeywordLine(k) {
  const variants = k.variants?.length ? ` [variants: ${k.variants.join(', ')}]` : '';
  return `- ${k.term}${variants} (${k.importance}, ${k.category})`;
}

async function suggestResumeEdits(profile, resumeText, jobDescription, options = {}) {
  const apiKey = profile.anthropicApiKey;
  if (!apiKey?.trim()) {
    return { error: 'No Anthropic API key configured. Add your key in Settings.' };
  }
  if (!resumeText?.trim()) {
    return { error: 'No resume text to work from — upload a resume first.' };
  }

  const {
    matchedKeywords = [], missingKeywords = [], existingEdits = [], confirmedTerms = [], focusTerms = [],
  } = options;

  const keywordsBlock = `ATS KEYWORDS FOR THIS JOB — a literal keyword scanner checks whether each term (or a listed variant) appears anywhere in the resume:
Already present:
${matchedKeywords.length ? matchedKeywords.map(formatKeywordLine).join('\n') : '(none)'}
Missing:
${missingKeywords.length ? missingKeywords.map(formatKeywordLine).join('\n') : '(none)'}`;

  const existingBlock = existingEdits.length
    ? `
EDITS ALREADY PROPOSED (assume these will be applied; their anchors refer to the ORIGINAL resume text above):
${existingEdits.map(e => `- [${e.kind}] "${e.anchor}" → "${e.newText}"`).join('\n')}
If you need to change a line one of these already targets, return an edit with the SAME anchor whose newText contains both that edit's changes and yours — it will replace the earlier one. Otherwise never touch those anchors or text overlapping them.
`
    : '';

  const focusBlock = focusTerms.length
    ? `
FOCUS: only write edits that add these keywords: ${focusTerms.join(', ')}. Everything else is already handled.
`
    : '';

  const confirmedBlock = confirmedTerms.length
    ? `
CANDIDATE-CONFIRMED EXPERIENCE: the candidate has explicitly confirmed they genuinely have real experience with: ${confirmedTerms.join(', ')}.
These are not in the resume text, so you cannot know where they used them. Add each to an existing Skills line (preferred). Add one to an experience bullet only if that bullet already describes work where it would clearly have been used, and phrase it modestly. Mark these edits "evidence": "confirmed".
`
    : '';

  const prompt = `You are an expert resume writer tailoring a resume so it scores highly on an applicant tracking system (ATS) keyword match for a specific job — using ONLY the candidate's real experience. You never invent or fabricate anything.

CANDIDATE'S CURRENT RESUME TEXT (exact text extracted from their .docx — one line per paragraph):
<resume>
${resumeText.substring(0, TAILOR_RESUME_CHARS)}
</resume>

JOB DESCRIPTION (may contain scraped site noise — focus on actual role requirements):
<job_description>
${jobDescription.substring(0, TAILOR_JD_CHARS)}
</job_description>

${keywordsBlock}
${existingBlock}${focusBlock}${confirmedBlock}
HOW ATS MATCHING WORKS — write for it:
- Matching is literal: "stakeholder management" is not matched by "managed stakeholders". Use the JD's exact term (or a listed variant).
- For acronyms, use both forms once, e.g. "Search Engine Optimization (SEO)".
- The Skills section and Summary are scanned like everything else and are the cleanest place to add exact terms; an experience bullet using the term in context is what a human reviewer then trusts.
- A critical required term appearing 2–3 times (Summary, Skills, a bullet) helps; beyond that is keyword stuffing and hurts with human reviewers.

YOUR TASK
For each MISSING keyword (required ones first), decide honestly:
(a) EVIDENCED — the resume already shows this in different words (resume says "K8s", JD says "Kubernetes"; resume says "led a team of 5", JD says "people management"; resume lists "PostgreSQL", JD says "SQL"). → Write an edit that puts the JD's exact term in.
(b) ADJACENT — the resume shows something closely related that honestly supports a modest claim (built dashboards in Tableau → "data visualization"; built REST services in Python → "API development"). → Write an edit using the exact term in a modest, accurate framing.
(c) ABSENT — nothing in the resume supports it. → Write NO edit. The candidate will be asked separately whether they have it.

Edit kinds (all are applied as text edits to the existing .docx):
- "skills": replace an existing Skills / Technical Skills / Core Competencies line with the same line plus the added terms. Combine ALL additions to one line into ONE edit. If the resume has no skills line, put these terms in the summary instead.
- "summary": replace an existing summary/profile sentence with a version that works in the job title and the JD's top required terms — every claim still true to the resume.
- "headline": replace the headline/title line under the candidate's name with one aligned to the job title, ONLY if their actual role is genuinely equivalent.
- "reword": replace a phrase or sentence in an experience bullet so it uses the JD's exact term, 100% consistent with what actually happened.
- "insert-bullet": add a new line after an existing one, only when a directly-stated fact in the resume supports it.

For EACH edit return:
- "kind": "skills" | "summary" | "headline" | "reword" | "insert-bullet"
- "anchor": EXACT existing text copied character-for-character from ONE line of the resume above — never spanning a line break, no leading bullet symbol. For "insert-bullet", the existing line (or a distinctive exact part of it) the new line goes after.
- "newText": for replace kinds, the full replacement for exactly the anchor span. For "insert-bullet", the full new line with no bullet symbol (formatting is copied from the anchor line).
- "keywords": the missing keyword terms (spelled exactly as listed above) this edit adds
- "reason": one short clause — the JD requirement it targets and the real resume fact it's grounded in
- "evidence": "evidenced" | "adjacent" | "confirmed"

Rules:
- NEVER add a skill, tool, certification, degree, employer, metric or years of experience the resume doesn't evidence, unless the candidate confirmed it above. If unsure whether it's evidenced, treat it as absent.
- Never change dates, employers, past job titles, degrees or numbers.
- Each anchor is used by at most one edit, and anchors must not overlap each other.
- Keep each line's length and tone close to the original — no buzzword lists crammed into sentences.
- Cover as many missing required keywords as honestly possible. Up to 25 edits, most impactful first.
- Return ONLY a JSON object: { "edits": [ { "kind": "", "anchor": "", "newText": "", "keywords": [], "reason": "", "evidence": "" } ] }
- Return ONLY the JSON object — no markdown, no explanation outside it`;

  const { parsed, error } = await callClaudeForJson(apiKey, pickTailorModel(profile), prompt, 8000);
  if (error) return { error };

  // IDs are assigned by the popup, not here: it merges several passes into
  // one list and needs them unique across all of them.
  const suggestions = (Array.isArray(parsed?.edits) ? parsed.edits : [])
    .slice(0, 25)
    .map(s => {
      const kind = EDIT_KINDS.has(s?.kind) ? s.kind : 'reword';
      return {
        kind,
        type: kind === 'insert-bullet' ? 'insert-bullet' : 'replace',
        anchor: typeof s?.anchor === 'string' ? s.anchor.replace(LEADING_BULLET_RE, '').trim() : '',
        newText: typeof s?.newText === 'string' ? s.newText.replace(LEADING_BULLET_RE, '').trim() : '',
        keywords: (Array.isArray(s?.keywords) ? s.keywords : []).filter(k => typeof k === 'string'),
        reason: typeof s?.reason === 'string' ? s.reason : '',
        evidence: EDIT_EVIDENCE.has(s?.evidence) ? s.evidence : 'evidenced',
      };
    })
    .filter(s => s.anchor && s.newText && s.anchor !== s.newText);

  return { suggestions };
}

// ─── Build LLM prompt ────────────────────────────────────────────────────────

function buildPrompt(profile, jobContext, unfilledFields) {
  const compactProfile = {};
  for (const [k, v] of Object.entries(profile)) {
    if (k === 'anthropicApiKey' || k === 'anthropicModel' || k === 'resumeText') continue;
    if (v !== '' && v !== null && v !== undefined) {
      compactProfile[k] = v;
    }
  }

  const profileJSON = JSON.stringify(compactProfile, null, 2);
  const fieldsJSON  = JSON.stringify(unfilledFields, null, 2);

  let jobContextBlock = '';
  if (jobContext) {
    jobContextBlock = `
JOB CONTEXT (if available):
Title: ${jobContext.jobTitle || ''}
Company: ${jobContext.jobCompany || ''}
Cover Letter: ${jobContext.coverLetter || ''}
`.trim();
  }

  return `You are filling a job application for ${profile.fullName || (profile.firstName + ' ' + profile.lastName).trim()}.

PROFILE:
${profileJSON}

${jobContextBlock}

UNFILLED FIELDS — fill ALL of these. Each field has: label (visible text), name (HTML name attr), placeholder, type, options (for selects/radios/checkbox-groups):
${fieldsJSON}

Rules:
- Return ONLY a JSON object: {"fieldIndex": "answer"} (keys are the index numbers as strings)
- Use label + name + placeholder together to identify what the field is asking
- For work authorization / "authorized to work" → "Yes"
- For sponsorship / "require sponsorship" → "No"
- For salary fields → number only: "${profile.salaryExpectation || '100000'}"
- For cover letter / why interested / additional info → write 2-3 sentences using profile facts, in natural flowing prose — do NOT use em dashes (—) or en dashes (–); use commas, periods, or conjunctions instead
- For select/radio fields, your answer MUST exactly match one of the provided options
- For type "checkbox" (a single standalone checkbox with no options — e.g. a consent, certification, or "this is true of me" box): return "Yes" if it should be checked based on the profile or context, "No" if it should stay unchecked, or "" if genuinely ambiguous
- For type "checkbox-group" (multiple checkboxes under one question — options list provided, e.g. "which of these do you have?"): more than one may apply. Return a comma-separated list of the exact option text values supported by the candidate's profile/skills (e.g. "Python, AWS, Docker"). Return "" if none clearly apply
- For EEO fields (veteran, disability, gender, ethnicity) use the profile values
- Skip file upload fields (type=file) — return "" for those
- If truly unknown, return ""
- Do NOT include commentary, markdown, or explanation — ONLY the JSON object

Return ONLY the JSON object.`;
}

// ─── Anthropic API call for form filling ─────────────────────────────────────

async function callAnthropicAPI(profile, jobContext, unfilledFields) {
  const apiKey = profile.anthropicApiKey;
  if (!apiKey || !apiKey.trim()) {
    return { error: 'No Anthropic API key configured. Add your key in Settings.' };
  }

  const model      = profile.anthropicModel || 'claude-haiku-4-5-20251001';
  const promptText = buildPrompt(profile, jobContext, unfilledFields);

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey.trim(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: promptText }],
      }),
    });
  } catch (fetchErr) {
    return { error: `Network error calling Anthropic API: ${fetchErr.message}` };
  }

  if (!response.ok) {
    let errBody = '';
    try { errBody = await response.text(); } catch (_) {}
    return { error: `Anthropic API error ${response.status}: ${errBody}` };
  }

  let data;
  try {
    data = await response.json();
  } catch (parseErr) {
    return { error: `Failed to parse Anthropic response: ${parseErr.message}` };
  }

  const rawText = data?.content?.[0]?.text || '';

  let answers = {};
  try {
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    answers = JSON.parse(cleaned);
  } catch (parseErr) {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        answers = JSON.parse(match[0]);
      } catch (_) {
        return { error: `Could not parse LLM JSON response: ${rawText.substring(0, 200)}` };
      }
    } else {
      return { error: `LLM returned non-JSON response: ${rawText.substring(0, 200)}` };
    }
  }

  return { answers };
}

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {

    case 'getProfile':
      getProfile().then(profile => sendResponse({ profile }));
      return true;

    case 'saveProfile':
      saveProfile(message.profile).then(() => sendResponse({ ok: true }));
      return true;

    case 'getPref':
      getPref(message.key).then(value => sendResponse({ value }));
      return true;

    case 'savePref':
      savePref(message.key, message.value).then(() => sendResponse({ ok: true }));
      return true;

    case 'parseResume': {
      const { resumeText, apiKey, pdfBase64 } = message;
      parseResumeWithClaude(resumeText, apiKey, pdfBase64)
        .then(result => sendResponse(result));
      return true;
    }

    case 'callLLM': {
      const { unfilledFields, profile, jobContext } = message;
      callAnthropicAPI(profile, jobContext, unfilledFields)
        .then(result => sendResponse(result));
      return true;
    }

    case 'openOnboarding':
      chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
      sendResponse({ ok: true });
      return true;

    case 'generateCoverLetter': {
      const { profile, jobDescription, jobTitle, jobCompany } = message;
      generateCoverLetter(profile, jobDescription, jobTitle, jobCompany)
        .then(result => sendResponse(result));
      return true;
    }

    case 'matchProfile': {
      const { profile, jobDescription } = message;
      matchProfileToJob(profile, jobDescription)
        .then(result => sendResponse(result));
      return true;
    }

    case 'extractAtsKeywords': {
      const { profile, jobDescription } = message;
      extractAtsKeywords(profile, jobDescription)
        .then(result => sendResponse(result));
      return true;
    }

    case 'suggestResumeEdits': {
      const { profile, resumeText, jobDescription, options } = message;
      suggestResumeEdits(profile, resumeText, jobDescription, options)
        .then(result => sendResponse(result));
      return true;
    }

    case 'getKeywordInsights':
      getKeywordInsights().then(insights => {
        const list = Object.values(insights).sort((a, b) => b.count - a.count);
        sendResponse({ insights: list });
      });
      return true;

    case 'clearKeywordInsights':
      clearKeywordInsights().then(() => sendResponse({ ok: true }));
      return true;

    case 'checkAppliedJob': {
      const { jobId, company, jobTitle } = message;
      findAppliedJobMatch(jobId, company, jobTitle).then(match => sendResponse({ match }));
      return true;
    }

    case 'recordAppliedJob':
      recordAppliedJob(message).then(entry => sendResponse({ entry }));
      return true;

    case 'fillProgress':
      // Progress events from content.js; popup listens independently
      sendResponse({ ok: true });
      return true;

    default:
      return false;
  }
});
