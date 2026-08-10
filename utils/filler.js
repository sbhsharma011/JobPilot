/**
 * filler.js
 * React/Vue-compatible field filling helpers.
 * Injected before content.js so functions are available in content script scope.
 */

// Native setters bypass React's synthetic event system and trigger re-renders properly.
const _nativeInputSetter    = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,   'value').set;
const _nativeTextareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;

/**
 * Fill a text input or textarea, triggering input/change/blur so
 * React, Vue, and Angular controlled inputs pick up the new value.
 */
function fillInput(el, value) {
  if (el.tagName === 'TEXTAREA') {
    _nativeTextareaSetter.call(el, value);
  } else {
    _nativeInputSetter.call(el, value);
  }
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur',   { bubbles: true }));
}

/**
 * Simulates a real click as closely as a synthetic event can: dispatching
 * `.click()` alone only fires the 'click' event, but many custom dropdown
 * widgets (react-select, MUI Autocomplete, Radix, downshift-based combobox
 * libraries) bind their open/select handlers to 'pointerdown'/'mousedown'
 * instead, so a click-only simulation silently does nothing on those.
 */
function simulateClick(el) {
  const opts = { bubbles: true, cancelable: true, view: window };
  try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
}

function isElementVisible(el) {
  if (!el) return false;
  const s = window.getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * Detects a JS-driven "combobox" dropdown rendered as a plain-looking
 * <input> (react-select, MUI Autocomplete, Greenhouse/Ashby custom selects,
 * etc.) rather than a native <select>. Programmatically setting .value on
 * these types the text visually but never registers as "an option was
 * chosen" with the framework — only clicking a rendered option element does
 * that — so treating them like a normal text input leaves the underlying
 * form state empty/invalid and the page fails validation on submit.
 */
function isComboboxInput(el) {
  if (el.tagName !== 'INPUT') return false;
  const type = (el.type || 'text').toLowerCase();
  if (!['text', 'search'].includes(type)) return false;
  if ((el.getAttribute('role') || '').toLowerCase() === 'combobox') return true;
  if (el.hasAttribute('aria-autocomplete')) return true;
  if ((el.getAttribute('aria-haspopup') || '').toLowerCase() === 'listbox') return true;
  if (el.readOnly && (el.hasAttribute('aria-controls') || el.hasAttribute('aria-owns'))) return true;
  return false;
}

function findComboboxListbox(el) {
  const controlsId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
  if (controlsId) {
    const byId = document.getElementById(controlsId);
    if (byId) return byId;
  }
  // Popups are frequently portaled to <body> rather than nested under the
  // input, so fall back to whichever listbox on the page is actually visible.
  const listboxes = [...document.querySelectorAll('[role="listbox"]')].filter(isElementVisible);
  return listboxes[listboxes.length - 1] || null;
}

/**
 * Polls for the dropdown's rendered options and returns the best text match,
 * waiting for async/debounced filtering (typeahead searches, network-backed
 * autocompletes) to settle rather than reading the DOM once too early.
 */
async function waitForComboboxOption(el, target, timeoutMs = 1600) {
  const targetLower = target.toLowerCase();
  const deadline = Date.now() + timeoutMs;
  let stableSingleCount = 0;

  while (Date.now() < deadline) {
    const listbox = findComboboxListbox(el);
    const candidates = listbox
      ? [...listbox.querySelectorAll('[role="option"], li')]
      : [...document.querySelectorAll('[role="option"]')];
    const visible = candidates.filter(o => isElementVisible(o) && o.getAttribute('aria-disabled') !== 'true');

    if (visible.length) {
      const norm = o => (o.innerText || o.textContent || '').trim().toLowerCase();
      const exact = visible.find(o => norm(o) === targetLower);
      if (exact) return exact;
      const partial = visible.find(o => {
        const n = norm(o);
        return n && (n.includes(targetLower) || targetLower.includes(n));
      });
      if (partial) return partial;
      // The framework's own filtering narrowed the list to exactly one
      // option that doesn't textually match what we typed (e.g. an ID-keyed
      // option whose visible label differs) — require it to stay the sole
      // option across two polls before trusting it, so a transient loading
      // state isn't mistaken for a real narrowed-down match.
      if (visible.length === 1) {
        stableSingleCount++;
        if (stableSingleCount >= 2) return visible[0];
      } else {
        stableSingleCount = 0;
      }
    }
    await new Promise(r => setTimeout(r, 70));
  }
  return null;
}

/**
 * Opens a combobox input, types the target value to trigger its filtering,
 * then clicks the matching rendered option so the framework's own selection
 * handler fires — this is what actually registers the value with the page,
 * not the input's raw text content.
 */
async function fillCombobox(el, value) {
  const target = String(value).trim();
  if (!target) return false;

  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();
  simulateClick(el); // opens the dropdown on most implementations

  if (!el.readOnly) {
    _nativeInputSetter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    for (const ch of target) {
      _nativeInputSetter.call(el, el.value + ch);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 12));
    }
  }

  const option = await waitForComboboxOption(el, target);

  if (!option) {
    // No confident match — leave the field visibly empty rather than typed
    // text that looks like an answer but was never actually selected.
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    if (!el.readOnly) {
      _nativeInputSetter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.blur();
    return false;
  }

  option.scrollIntoView({ block: 'nearest' });
  simulateClick(option);
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  return true;
}

/**
 * Fill a <select> element.
 * Tries exact match → partial match (option contains answer) → reverse partial (answer contains option).
 */
function fillSelect(el, value) {
  const options = [...el.options];
  const target  = value.toLowerCase().trim();

  const match =
    options.find(o => o.text.toLowerCase().trim() === target) ||
    options.find(o => o.text.toLowerCase().includes(target))  ||
    options.find(o => target.includes(o.text.toLowerCase().trim()) && o.text.trim() !== '');

  if (match) {
    el.value = match.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

/**
 * Fill a radio group.
 * Finds the radio whose label text best matches the value.
 */
function fillRadio(radios, value) {
  const target = value.toLowerCase().trim();
  let best = null;
  let bestScore = -1;

  for (const radio of radios) {
    const labelText = getRadioLabel(radio).toLowerCase().trim();
    if (labelText === target) {
      best = radio;
      bestScore = 2;
      break;
    }
    if (labelText.includes(target) || target.includes(labelText)) {
      if (bestScore < 1) {
        best = radio;
        bestScore = 1;
      }
    }
  }

  if (best) {
    best.checked = true;
    best.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

/**
 * Fill a checkbox group — a multi-select question rendered as several
 * checkboxes sharing one `name` (e.g. "which of these do you have?").
 * Unlike a radio group, more than one option may be checked. Expects a
 * comma-separated list of the option label(s) that should be checked.
 */
function fillCheckboxGroup(checkboxes, value) {
  const selected = String(value)
    .toLowerCase()
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (selected.length === 0) return false;

  let matchedAny = false;
  for (const cb of checkboxes) {
    const labelText = getRadioLabel(cb).toLowerCase().trim();
    const isMatch = selected.some(sel =>
      labelText === sel || labelText.includes(sel) || sel.includes(labelText));
    if (isMatch && !cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      matchedAny = true;
    }
  }
  return matchedAny;
}

/** Get the human-readable label for a radio button. */
function getRadioLabel(radio) {
  // label[for=id]
  if (radio.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
    if (lbl) return lbl.innerText.trim();
  }
  // Wrapping label
  const parent = radio.closest('label');
  if (parent) return parent.innerText.replace(/^\s*/, '').trim();
  // Next sibling text
  const next = radio.nextSibling;
  if (next && next.nodeType === Node.TEXT_NODE) return next.textContent.trim();
  return radio.value || '';
}

/**
 * Fill a checkbox — value "yes"/"true"/"1" → check it.
 */
function fillCheckbox(el, value) {
  const truthy = ['yes', 'true', '1', 'on'].includes(String(value).toLowerCase().trim());
  if (el.checked !== truthy) {
    el.checked = truthy;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/**
 * Master fill dispatcher — routes to the right helper based on element type.
 * Returns true (or a Promise resolving to true/false for comboboxes) if the
 * field was filled.
 */
function fillElement(el, value) {
  if (!value && value !== 0) return false;
  const strVal = String(value);

  const type = (el.type || '').toLowerCase();

  if (el.tagName === 'SELECT') {
    return fillSelect(el, strVal);
  }
  if (type === 'checkbox') {
    fillCheckbox(el, strVal);
    return true;
  }
  if (type === 'radio') {
    // Radio buttons must be handled as a group — caller handles this
    return false;
  }
  if (isComboboxInput(el)) {
    return fillCombobox(el, strVal);
  }
  // text, email, tel, url, number, textarea, etc.
  fillInput(el, strVal);
  return true;
}
