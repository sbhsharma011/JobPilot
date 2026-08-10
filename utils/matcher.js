/**
 * matcher.js
 * Field label → profile key pattern matching.
 * Injected before content.js.
 */

const PATTERNS = {
  firstName:          ['first name', 'given name', 'forename', 'first_name', 'fname'],
  lastName:           ['last name', 'family name', 'surname', 'last_name', 'lname'],
  fullName:           ['full name', 'your name', 'legal name', 'candidate name', 'applicant name', 'complete name'],
  email:              ['email', 'e-mail', 'email address'],
  phone:              ['phone', 'mobile', 'cell', 'telephone', 'contact number', 'phone number'],
  linkedin:           ['linkedin'],
  website:            ['website', 'portfolio', 'personal url', 'personal site'],
  github:             ['github'],
  location:           ['location', 'city, state', 'city/state', 'city & state', 'where are you based', 'current location'],
  city:               ['city'],
  state:              ['state', 'province'],
  zip:                ['zip', 'postal code', 'zip code'],
  currentTitle:       ['current title', 'current role', 'current position', 'job title', 'position title', 'your title', 'professional title'],
  currentCompany:     ['current company', 'current employer', 'current organization', 'employer name', 'company name', 'organization name'],
  yearsExperience:    ['years of experience', 'years experience', 'how many years', 'total experience', 'years of relevant', 'total years'],
  education:          ['degree', 'highest education', 'level of education', 'education level', 'highest degree', 'highest level'],
  university:         ['university', 'college', 'school', 'institution', 'alma mater'],
  graduationYear:     ['graduation year', 'year of graduation', 'graduated', 'year graduated'],
  summary:            ['summary', 'professional summary', 'brief summary', 'background', 'about yourself', 'tell us about you', 'professional background', 'bio'],
  skills:             ['skills', 'key skills', 'technical skills', 'core skills', 'expertise', 'competencies', 'technologies'],
  salaryExpectation:  ['salary', 'compensation', 'expected salary', 'desired salary', 'pay expectation', 'salary expectation', 'expected compensation', 'target salary'],
  workAuthorized:     ['authorized to work', 'work authorization', 'legally authorized', 'eligible to work', 'right to work', 'work legally', 'authorized in the us', 'legally eligible'],
  requireSponsorship: ['sponsorship', 'visa sponsorship', 'require sponsorship', 'need sponsorship', 'work visa', 'visa support', 'employer sponsorship'],
  willingToRelocate:  ['relocate', 'relocation', 'willing to relocate', 'open to relocation'],
  openToRemote:       ['remote', 'work remotely', 'open to remote', 'remote work', 'work from home'],
  noticePeriod:       ['notice period', 'how soon', 'available to start', 'start date', 'when can you start', 'earliest start', 'availability'],
  currentlyEmployed:  ['currently employed', 'are you employed', 'current employment status', 'employment status'],
  veteranStatus:      ['veteran', 'military', 'protected veteran'],
  disabilityStatus:   ['disability', 'disabled', 'disability status'],
  gender:             ['gender', 'sex', 'gender identity'],
  ethnicity:          ['ethnicity', 'race', 'racial', 'ethnic'],
  pronouns:           ['pronoun'],
  coverLetter:        ['cover letter', 'why do you want', 'why are you interested', 'why this company', 'why this role', 'tell us about yourself', 'additional information', 'anything else', 'introduce yourself', 'message to hiring'],
  resume:             ['resume', 'cv', 'curriculum vitae', 'upload resume', 'attach resume'],
};

/**
 * Parse a name/id attribute into human-readable label text.
 * e.g. "applicant[first_name]" → "first name"
 *      "s3FirstName" → "first name"
 *      "current_job_title" → "current job title"
 */
function parseAttrToLabel(attr) {
  if (!attr) return '';
  // Strip bracket notation: applicant[first_name] → first_name
  let s = attr.replace(/^[^\[]+\[/, '').replace(/\].*/, '');
  // If no brackets existed, use original
  if (s === attr.replace(/^[^\[]+\[/, '').replace(/\].*/, '')) s = attr;
  // camelCase → spaced: firstName → first Name
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Convert separators
  s = s.replace(/[_\-\.]/g, ' ').trim().toLowerCase();
  return s;
}

/**
 * Match a field to a profile key.
 * Tries label first, then falls back to name → id → placeholder.
 * Returns the best matching profile key or null.
 */
function matchFieldToKey(label, name, id, placeholder) {
  const sources = [label, parseAttrToLabel(name), parseAttrToLabel(id), placeholder]
    .filter(Boolean)
    .map(s => s.toLowerCase().trim());

  let bestKey = null;
  let bestLength = 0;

  for (const source of sources) {
    for (const [key, keywords] of Object.entries(PATTERNS)) {
      for (const kw of keywords) {
        if (source.includes(kw) && kw.length > bestLength) {
          bestKey = key;
          bestLength = kw.length;
        }
      }
    }
    // Stop at first source that produces a match (prefer label > name > id > placeholder)
    if (bestKey) break;
  }

  return bestKey;
}
