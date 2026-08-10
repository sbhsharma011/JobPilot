/**
 * content.js — JobPilot form-fill engine
 *
 * Strategy:
 *  1. Extract all visible form fields with labels + attributes
 *  2. Flash scan highlight so user sees what was found
 *  3. LOCAL fill — text/email/tel/url/number inputs only (fast, no token cost)
 *  4. LLM fill  — ALL selects, ALL radios, ALL textareas, + any unmatched text inputs
 *                  LLM receives the full option list so it can match correctly
 *  5. Stream fillProgress events to popup throughout
 */

(function () {
  'use strict';

  // ─── Page-side visual feedback ───────────────────────────────────────────────

  function injectPageStyles() {
    if (document.getElementById('__jf_styles')) return;
    const s = document.createElement('style');
    s.id = '__jf_styles';
    s.textContent = `
      [data-jf]{outline-offset:3px!important;transition:outline .2s,background .2s!important;}
      [data-jf="scan"]{outline:2px solid #6366f1!important;}
      [data-jf="fill"]{outline:2px solid #f59e0b!important;background:rgba(251,191,36,.07)!important;}
      [data-jf="ok"]  {outline:2px solid #16a34a!important;background:rgba(22,163,74,.06)!important;}
      [data-jf="skip"]{outline:1px dashed #d1d5db!important;}
    `;
    document.head.appendChild(s);
  }

  function groupEl(field) {
    return field.el || (field.radios && field.radios[0]) || (field.checkboxes && field.checkboxes[0]);
  }
  function markEl(field, state) {
    const el = groupEl(field);
    if (el) el.setAttribute('data-jf', state);
  }
  function clearMark(field) {
    const el = groupEl(field);
    if (el) el.removeAttribute('data-jf');
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ─── Progress messaging ───────────────────────────────────────────────────────

  function sendProgress(data) {
    try { chrome.runtime.sendMessage({ action: 'fillProgress', ...data }); } catch (_) {}
  }

  // ─── Label extraction ─────────────────────────────────────────────────────────

  function cleanText(str) {
    return (str || '').replace(/\s+/g, ' ').replace(/[*:]+$/, '').trim();
  }

  function getLabel(el) {
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return cleanText(lbl.innerText);
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return cleanText(ariaLabel);

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/)
        .map(id => { const r = document.getElementById(id); return r ? r.innerText : ''; })
        .filter(Boolean);
      if (parts.length) return cleanText(parts.join(' '));
    }
    const ph = el.getAttribute('placeholder');
    if (ph) return cleanText(ph);

    const title = el.getAttribute('title');
    if (title) return cleanText(title);

    const parentLabel = el.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input,select,textarea').forEach(c => c.remove());
      const t = cleanText(clone.innerText);
      if (t) return t;
    }
    return findNearbyLabel(el);
  }

  function findNearbyLabel(el) {
    let node = el;
    for (let depth = 0; depth < 4; depth++) {
      const parent = node.parentElement;
      if (!parent) break;
      let sib = node.previousElementSibling;
      while (sib) {
        const tag = sib.tagName.toLowerCase();
        if (['label','span','div','p','legend','dt','th','h3','h4'].includes(tag)) {
          const text = cleanText(sib.innerText);
          if (text && text.length < 120) return text;
        }
        sib = sib.previousElementSibling;
      }
      const pt = parent.tagName.toLowerCase();
      if (['label','legend','dt','th'].includes(pt)) {
        const clone = parent.cloneNode(true);
        clone.querySelectorAll('input,select,textarea,button').forEach(c => c.remove());
        const text = cleanText(clone.innerText);
        if (text && text.length < 120) return text;
      }
      node = parent;
    }
    return '';
  }

  function getRadioLabel(radio) {
    if (radio.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      if (lbl) return lbl.innerText.trim();
    }
    const parent = radio.closest('label');
    if (parent) return parent.innerText.replace(/^\s*/, '').trim();
    const next = radio.nextSibling;
    if (next && next.nodeType === Node.TEXT_NODE) return next.textContent.trim();
    return radio.value || '';
  }

  function getRadioGroupLabel(radios) {
    let node = radios[0].parentElement;
    for (let i = 0; i < 6; i++) {
      if (!node) break;
      if (node.tagName === 'FIELDSET') {
        const legend = node.querySelector('legend');
        if (legend) return cleanText(legend.innerText);
      }
      node = node.parentElement;
    }
    return '';
  }

  // ─── Visibility check ─────────────────────────────────────────────────────────

  function isVisible(el) {
    if ((el.type || '').toLowerCase() === 'hidden') return false;
    let node = el;
    for (let i = 0; i < 12 && node && node !== document.documentElement; i++) {
      const s = window.getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      node = node.parentElement;
    }
    if (el.tagName !== 'SELECT') {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
    }
    return true;
  }

  // ─── Field extraction ─────────────────────────────────────────────────────────

  function extractFormFields() {
    const selector = [
      'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image])',
      'select',
      'textarea',
    ].join(',');

    const elements   = [...document.querySelectorAll(selector)];
    const fields     = [];
    const seen       = new Set();
    const radioGroups = {};
    const checkboxGroups = {};

    for (const el of elements) {
      if (!isVisible(el)) continue;
      const type = (el.type || el.tagName.toLowerCase()).toLowerCase();

      if (type === 'radio') {
        const name = el.name || String(Math.random());
        if (!radioGroups[name]) radioGroups[name] = [];
        radioGroups[name].push(el);
        continue;
      }
      // Checkboxes sharing a `name` are almost always one multi-select
      // question ("which of these apply?") rather than independent
      // yes/no toggles — group them so the LLM can reason about them
      // as a single question with multiple possible answers.
      if (type === 'checkbox' && el.name) {
        if (!checkboxGroups[el.name]) checkboxGroups[el.name] = [];
        checkboxGroups[el.name].push(el);
        continue;
      }
      if (seen.has(el)) continue;
      seen.add(el);

      const label    = getLabel(el);
      const options  = type === 'select'
        ? [...el.options].filter(o => o.value !== '' && o.text.trim() !== '').map(o => o.text.trim())
        : [];
      const required = el.required || el.getAttribute('aria-required') === 'true';

      fields.push({
        el,
        label,
        name:        el.name || '',
        id:          el.id   || '',
        placeholder: el.placeholder || '',
        type,
        options,
        required,
        filled: false,
      });
    }

    for (const [, radios] of Object.entries(radioGroups)) {
      const groupLabel = getRadioGroupLabel(radios) || getLabel(radios[0]);
      const options    = radios.map(r => getRadioLabel(r));
      const required   = radios.some(r => r.required);
      fields.push({
        el: null, radios,
        label: groupLabel,
        name:  radios[0].name || '',
        id: '', placeholder: '',
        type: 'radio',
        options,
        required,
        filled: false,
      });
    }

    for (const [, checkboxes] of Object.entries(checkboxGroups)) {
      if (checkboxes.length === 1) {
        // Only one checkbox happened to carry this name — it's a standalone
        // yes/no toggle, not a multi-select group.
        const cb = checkboxes[0];
        fields.push({
          el: cb,
          label: getLabel(cb),
          name: cb.name || '',
          id: cb.id || '',
          placeholder: cb.placeholder || '',
          type: 'checkbox',
          options: [],
          required: cb.required || cb.getAttribute('aria-required') === 'true',
          filled: false,
        });
        continue;
      }
      const groupLabel = getRadioGroupLabel(checkboxes) || getLabel(checkboxes[0]);
      const options    = checkboxes.map(cb => getRadioLabel(cb));
      const required   = checkboxes.some(cb => cb.required);
      fields.push({
        el: null, checkboxes,
        label: groupLabel,
        name:  checkboxes[0].name || '',
        id: '', placeholder: '',
        type: 'checkbox-group',
        options,
        required,
        filled: false,
      });
    }

    return fields;
  }

  // ─── Animate a fill action ────────────────────────────────────────────────────

  async function animateFill(field, globalIdx, totalFields, doFill) {
    const label = field.label || field.name || field.type;
    sendProgress({ phase: 'filling', index: globalIdx, total: totalFields, label });
    markEl(field, 'fill');
    await sleep(55);

    // fillElement is async for combobox-style dropdowns (it has to wait for
    // the framework to render options after typing), sync for everything
    // else — awaiting a plain non-Promise value is a no-op, so this handles both.
    const success = await doFill();

    markEl(field, success ? 'ok' : 'skip');
    field.filled = success;
    sendProgress({ phase: 'filled', index: globalIdx, total: totalFields, label, success });
    await sleep(35);
    return success;
  }

  // ─── LOCAL fill pass — text-type inputs only ──────────────────────────────────
  //
  // Selects, radios, and textareas are intentionally skipped here.
  // They go to the LLM which can see the option list and make intelligent choices
  // (e.g. "Prefer not to say" for gender, or custom pronoun options).

  const TEXT_TYPES = new Set(['text', 'email', 'tel', 'url', 'number', 'search', 'date']);

  async function localFill(fields, profile) {
    let filled = 0;

    for (const field of fields) {
      field.profileKey = matchFieldToKey(field.label, field.name, field.id, field.placeholder);
    }

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      // Only fill simple text-type inputs locally; everything else goes to LLM
      if (!TEXT_TYPES.has(field.type)) continue;
      if (!field.profileKey) continue;
      const value = profile[field.profileKey];
      if (!value && value !== 0) continue;

      const ok = await animateFill(field, i, fields.length, () => fillElement(field.el, value));
      if (ok) filled++;
    }

    return filled;
  }

  // ─── LLM fill pass ────────────────────────────────────────────────────────────
  //
  // Handles: selects, radios, textareas, and any unmatched/unfilled text inputs.
  // Sends the full options list per field so Claude can pick the exact option text.

  async function llmFill(fields, profile, jobContext) {
    const unfilled = [];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (f.filled) continue;
      if (f.type === 'file' || f.type === 'hidden') continue;
      unfilled.push({
        globalIdx: i,
        ref: f,
        payload: {
          index:       unfilled.length,
          label:       f.label,
          name:        f.name,
          placeholder: f.placeholder,
          type:        f.type,
          options:     f.options || [],
          required:    f.required,
        },
      });
    }

    if (unfilled.length === 0) return 0;

    sendProgress({ phase: 'llm-start', count: unfilled.length });

    let answers;
    try {
      const resp = await chrome.runtime.sendMessage({
        action:         'callLLM',
        unfilledFields: unfilled.map(u => u.payload),
        profile,
        jobContext,
      });
      if (resp?.error) { console.warn('[JobPilot] LLM error:', resp.error); return 0; }
      answers = resp?.answers || {};
    } catch (err) {
      console.warn('[JobPilot] LLM call failed:', err);
      return 0;
    }

    let filled = 0;

    for (const [idxStr, value] of Object.entries(answers)) {
      const idx = parseInt(idxStr, 10);
      if (isNaN(idx) || !unfilled[idx]) continue;
      const { globalIdx, ref: field } = unfilled[idx];
      if (!value) continue;

      const ok = await animateFill(field, globalIdx, fields.length, () => {
        if (field.type === 'radio')          return fillRadio(field.radios, String(value));
        if (field.type === 'checkbox-group')  return fillCheckboxGroup(field.checkboxes, String(value));
        if (field.el)                         return fillElement(field.el, value);
        return false;
      });
      if (ok) filled++;
    }

    return filled;
  }

  // ─── Main handler ─────────────────────────────────────────────────────────────

  async function handleFill(message) {
    const { profile, jobContext } = message;

    injectPageStyles();

    const fields = extractFormFields();
    const total  = fields.length;

    sendProgress({
      phase:  'scan',
      total,
      fields: fields.map(f => ({ label: f.label || f.name || f.type, type: f.type })),
    });

    if (total === 0) return { filled: 0, total: 0, llmUsed: false };

    // Flash all fields blue so user sees what was detected
    fields.forEach(f => markEl(f, 'scan'));
    await sleep(380);

    const localFilled = await localFill(fields, profile);

    const hasKey  = !!(profile.anthropicApiKey?.trim());
    let llmFilled = 0;

    if (hasKey) {
      llmFilled = await llmFill(fields, profile, jobContext);
    }

    // Fade out marks after 5 seconds
    setTimeout(() => fields.forEach(f => clearMark(f)), 5000);

    return { filled: localFilled + llmFilled, total, llmUsed: hasKey };
  }

  // ─── Listener (deduplicated per page load) ────────────────────────────────────

  if (!window.__jfListenerActive) {
    window.__jfListenerActive = true;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.action !== 'fill') return false;
      handleFill(message)
        .then(r  => sendResponse({ action: 'fillComplete', ...r }))
        .catch(e => sendResponse({ action: 'fillComplete', filled: 0, total: 0, llmUsed: false, error: e.message }));
      return true;
    });
  }

})();
