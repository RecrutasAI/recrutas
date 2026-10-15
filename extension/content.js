/**
 * Recrutas Auto-Fill — Content Script (Vision-Powered)
 *
 * Injected into job application pages (auto on known ATS sites, or on demand).
 * Scrapes form fields and page context, sends them (with screenshot via
 * background.js) to the backend where Gemini 2.0 Flash vision analyzes
 * the form and returns structured actions.
 * Executes each action: type, select, click_then_type, upload_resume, check.
 * Reports fill stats back to background for tracking.
 */

(function () {
  'use strict';

  // Cross-browser messaging — always returns a Promise
  function sendMessage(msg) {
    if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
      return browser.runtime.sendMessage(msg);
    }
    return chrome.runtime.sendMessage(msg);
  }

  // Prevent double-injection on SPAs. A second injection (the popup's "Fill this page" or the
  // keyboard shortcut, on a page the extension already loaded) runs the first copy's fill:
  // calling this copy's triggerFill here threw, because its `let isFilling` below isn't set yet.
  if (window.__recruitasInjected) {
    window.__recruitasFill?.();
    return;
  }
  window.__recruitasInjected = true;

  // ── Native value setter (React/Angular/Vue compatible) ─────────────────────

  // The element's own value setter, looked up in the element's window (a field
  // in a same-origin iframe belongs to that frame's classes). Null when the
  // element isn't an input / textarea / select: calling another class's setter
  // on it throws ("'set value' called on an object that does not implement
  // interface HTMLInputElement" in Firefox, "Illegal invocation" in Chrome).
  function valueSetterFor(el) {
    const wins = [el?.ownerDocument?.defaultView, window].filter(Boolean);
    for (const w of wins) {
      for (const C of [w.HTMLInputElement, w.HTMLTextAreaElement, w.HTMLSelectElement]) {
        if (C && el instanceof C) return Object.getOwnPropertyDescriptor(C.prototype, 'value')?.set || null;
      }
    }
    return null;
  }

  // The element that actually holds the text. The model sometimes names a
  // wrapper: a web component (SmartRecruiters) or a div around the real field.
  function valueTarget(el) {
    if (!el || valueSetterFor(el) || el.isContentEditable) return el;
    const inner = el.shadowRoot?.querySelector('input:not([type=hidden]), textarea, select, [contenteditable="true"]')
      || el.querySelector?.('input:not([type=hidden]), textarea, select, [contenteditable="true"]');
    return inner || el;
  }

  // Set a field's value so React/Angular/Vue see it. Returns false (instead of
  // throwing) when the element can't hold a value, so one odd field can't abort
  // the whole fill.
  function setNativeValue(el, value, { change = true } = {}) {
    const target = valueTarget(el);
    if (!target) return false;
    const setter = valueSetterFor(target);
    try {
      if (setter) {
        setter.call(target, value);
      } else if (target.isContentEditable) {
        target.focus();
        target.textContent = value;
      } else if ('value' in target) {
        target.value = value;
      } else {
        return false;
      }
    } catch (err) {
      console.debug('[Recrutas] Could not set value:', err.message);
      return false;
    }
    target.dispatchEvent(new Event('input', { bubbles: true }));
    if (change) target.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // ── Shadow-DOM-aware queries ───────────────────────────────────────────────
  // Some application systems (SmartRecruiters' one-click apply) build the whole
  // form from web components, so every field sits inside a shadow root that a
  // plain document.querySelectorAll never sees. The extension found zero fields
  // there and never even showed its button. These search the document and every
  // OPEN shadow root (closed ones are unreachable by design).

  function shadowRoots(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (n.shadowRoot) {
        out.push(n.shadowRoot);
        out.push(...shadowRoots(n.shadowRoot));
      }
    }
    return out;
  }

  function deepQueryAll(selector, root = document) {
    const found = Array.from(root.querySelectorAll(selector));
    for (const sr of shadowRoots(root)) found.push(...sr.querySelectorAll(selector));
    return found;
  }

  function deepQuery(selector, root = document) {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    for (const sr of shadowRoots(root)) {
      const hit = sr.querySelector(selector);
      if (hit) return hit;
    }
    return null;
  }

  // By id, preferring the element's own tree (a label's `for` or an
  // aria-labelledby id refers to the same shadow root as the field).
  function byId(id, near) {
    const scope = near && near.getRootNode ? near.getRootNode() : document;
    return (scope.getElementById && scope.getElementById(id))
      || (scope.querySelector && scope.querySelector(`[id="${CSS.escape(id)}"]`))
      || deepQuery(`[id="${CSS.escape(id)}"]`);
  }

  // ── Label text resolver ────────────────────────────────────────────────────

  // The question a control belongs to, for controls the label[for] lookup can't
  // name: radio groups labelled by a sibling <label> (Ashby puts the question in a
  // <label for=…> that points at no input), autocompletes with only a placeholder,
  // yes/no button pairs. Walks up a few levels for a label/legend that wraps no
  // control and doesn't point at one of `skip` (an option's own label).
  function questionLabel(el, skip = []) {
    const skipIds = new Set(skip.map(x => x.id).filter(Boolean));
    let node = el.parentElement;
    for (let depth = 0; node && node.tagName !== 'FORM' && depth < 6; depth++, node = node.parentElement) {
      for (const c of node.children) {
        if (!/^(LABEL|LEGEND)$/.test(c.tagName)) continue;
        if (c.querySelector('input, select, textarea')) continue;
        const f = c.getAttribute('for');
        if (f && skipIds.has(f)) continue;
        const t = c.textContent?.trim();
        if (t) return t;
      }
    }
    return '';
  }

  // The question a control answers when the page doesn't tie it to a <label> or <legend>:
  // Lever writes "Legal First Name ✱" or "Will you require sponsorship? ✱" in a <div>
  // beside the input, so the fill sent the AI "Type your response" (the placeholder) and,
  // for Yes/No radios, the first option's text "Yes" as the question (2026-10-15, Hermeus).
  // Climb from the control(s) to the first ancestor holding text that isn't inside any form
  // control's own subtree (option labels, neighbouring questions); that text is the question.
  const CONTROL = 'input:not([type="hidden"]), select, textarea, button, [role="listbox"], [role="combobox"]';
  function textOutsideControls(node) {
    let out = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { out += ' ' + c.textContent; continue; }
      if (c.nodeType !== 1) continue;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(c.tagName)) continue;
      if (c.matches(CONTROL) || c.querySelector(CONTROL)) continue;
      if (c.closest('#recrutas-fill-btn, #recrutas-banner, .recrutas-banner')) continue;
      if (c.hidden || c.getAttribute('aria-hidden') === 'true') continue;
      // Hidden validation messages ("A resume is required", Breezy) are not the question.
      const cs = getComputedStyle(c);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      out += ' ' + (c.innerText ?? c.textContent);
    }
    return out.replace(/\s+/g, ' ').trim();
  }
  const GENERIC_PLACEHOLDER = /^(type|enter|write|add|select|choose|start typing|search|your answer|answer|response|e\.g\.|eg\b|\.\.\.|…)/i;
  function questionNear(controls) {
    let node = controls[0].parentElement;
    while (node && !controls.every(c => node.contains(c))) node = node.parentElement;
    for (let depth = 0; node && node.tagName !== 'FORM' && node !== document.body && depth < 5; depth++, node = node.parentElement) {
      const text = textOutsideControls(node);
      // A paragraph (instructions, a job description) is not the question.
      if (text.length > 250) return { text: '', node: null };
      if (text.length >= 2) return { text, node };
    }
    return { text: '', node: null };
  }
  // Required, as the page shows it: the attribute, aria-required on the control or its group,
  // or the visible marks forms use instead (Lever's "✱" and .required-field, a trailing "*").
  function isRequired(controls, label, near) {
    if (controls.some(c => c.required || c.getAttribute('aria-required') === 'true')) return true;
    if (controls[0].closest('[role="radiogroup"][aria-required="true"], [role="group"][aria-required="true"]')) return true;
    if (/✱|\*\s*$|\(required\)\s*$/i.test(label || '')) return true;
    const scope = near || controls[0].parentElement;
    return !!(scope && (scope.matches('.required-field, .required, .is-required, [data-required="true"]')
      || scope.querySelector(':scope > .required-field, :scope .application-field.required-field, :scope > * > .required')));
  }

  function getLabelText(el) {
    if (el.id) {
      const scope = el.getRootNode ? el.getRootNode() : document;
      const label = scope.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        || deepQuery(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent?.trim() || '';
    }
    // aria-labelledby → resolve the referenced element(s) and join their text.
    const labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledby) {
      const txt = labelledby.split(/\s+/)
        .map(id => byId(id, el)?.textContent?.trim() || '')
        .filter(Boolean)
        .join(' ');
      if (txt) return txt;
    }
    // Walk ancestors for a wrapping <label>; remember the nearest <fieldset>'s
    // <legend> as a last resort (grouped controls — radios, split date selects —
    // are labelled only by the legend).
    let node = el.parentElement;
    let legend = '';
    while (node && node.tagName !== 'FORM') {
      if (node.tagName === 'LABEL') return node.textContent?.trim() || '';
      if (node.tagName === 'FIELDSET' && !legend) {
        const lg = node.querySelector(':scope > legend');
        if (lg) legend = lg.textContent?.trim() || '';
      }
      node = node.parentElement;
    }
    const prev = el.previousElementSibling;
    if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'P')) {
      return prev.textContent?.trim() || '';
    }
    return legend || '';
  }

  // ── Scrape all form fields ─────────────────────────────────────────────────

  function scrapeFields() {
    const fields = [];
    const seen = new Set();

    // Standard form elements
    const elements = deepQueryAll('input, textarea, select');
    // Checkboxes sharing a name ("Select all that apply") are one question, collected as a
    // group further down; listing each option alone showed every option as a question.
    const groupNames = checkboxGroupNames();

    for (const el of elements) {
      const type = (el.type || el.tagName.toLowerCase()).toLowerCase();

      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
      if (el.readOnly || el.disabled) continue;
      // Helper inputs nobody types into: react-select's hidden "required" twin (no
      // id/name, aria-hidden or out of the tab order) and the phone widget's own
      // country search. Sending them made the model answer the same question twice.
      if (!el.id && !el.name && (el.getAttribute('aria-hidden') === 'true' || el.tabIndex < 0)) continue;
      if (el.closest('.iti__dropdown-content, .iti__country-list') || /^iti-\d+__/.test(el.id || '')) continue;
      // Radios are collected as grouped fields (one per name) further down, so
      // the model sees the question + all options instead of N disconnected inputs.
      if (type === 'radio') continue;
      // Yes/No button pairs are collected further down, as one choice field.
      if (type === 'checkbox' && toggleButtons(el).length >= 2) continue;
      if (type === 'checkbox' && groupNames.has(el.name)) continue;

      // Allow visually-hidden inputs (React Select, comboboxes use opacity:0 / position:absolute)
      const isFileInput = el.type === 'file';
      const isReactSelect = el.getAttribute('role') === 'combobox' ||
        el.closest('[class*="select"], [class*="Select"], [class*="combobox"]');
      // Strong combobox signal (Greenhouse/Workday/react-select render their
      // dropdowns as <input> elements — without this they'd be reported as plain
      // text and the model would type into them, which react-select discards).
      const looksLikeCombobox =
        el.getAttribute('role') === 'combobox' ||
        el.getAttribute('aria-haspopup') === 'listbox' ||
        el.getAttribute('aria-autocomplete') === 'list';
      if (el.offsetParent === null && !isFileInput && !isReactSelect) continue;

      const fieldId = el.id || el.name || `recrutas_${fields.length}`;
      if (seen.has(fieldId)) continue;
      seen.add(fieldId);
      if (!el.id && !el.name) el.setAttribute('data-recrutas-id', fieldId);

      const near = questionNear([el]);
      // A specific placeholder ("Full Name", Breezy) is a better label than text found nearby;
      // a generic one ("Type your response", Lever) is not a label at all.
      const placeholder = (el.getAttribute('placeholder') || '').trim();
      const specific = placeholder && !GENERIC_PLACEHOLDER.test(placeholder) ? placeholder : '';
      const label = getLabelText(el) || el.getAttribute('aria-label') || questionLabel(el) || specific || near.text || placeholder || '';
      const field = {
        id: fieldId,
        type: type,
        label,
        name: el.getAttribute('name') || '',
        required: isRequired([el], label, near.node),
      };

      if (el.tagName === 'SELECT') {
        field.options = Array.from(el.options)
          .filter(opt => opt.value && opt.value !== '')
          .map(opt => opt.text?.trim() || opt.value);
        field.type = 'select';
      }

      if (type === 'checkbox') {
        field.type = type;
      }

      // Mark <input>-based dropdowns so the model fills them via click_then_type
      // (open menu → type → click option) rather than typing free text.
      if (looksLikeCombobox && field.type !== 'select') {
        field.type = 'custom_select';
      }

      // Flag multi-value pickers (native <select multiple>, react-select multi)
      // so the model can return several answers as a pipe-delimited list.
      const isMulti = el.multiple === true ||
        el.getAttribute('aria-multiselectable') === 'true' ||
        !!el.closest('[class*="is-multi"], [class*="multiselect"], [class*="multi-select"], [class*="MultiValue"]');
      if (isMulti) field.multiple = true;

      fields.push(field);
    }

    // Radio groups — collect all radios sharing a name into ONE field carrying the
    // group question (fieldset/legend) + every option label. Detecting them
    // individually loses the question and, for name-only radios, collapses the
    // whole group to a single option (the rest dedupe away on `name`).
    const radioGroups = new Map();
    for (const r of deepQueryAll('input[type="radio"]')) {
      if (r.disabled) continue;
      const name = r.getAttribute('name') || '';
      const key = name || r.id;
      if (!key) continue;
      if (!radioGroups.has(key)) radioGroups.set(key, { name, radios: [] });
      radioGroups.get(key).radios.push(r);
    }
    for (const [key, group] of radioGroups) {
      if (seen.has(key)) continue;
      seen.add(key);
      const options = group.radios
        .map(r => getLabelText(r) || r.value || '')
        .map(s => s.trim())
        .filter(Boolean);
      // Group question: the fieldset/legend (or aria-label) shared by the radios,
      // not any single option's label.
      const first = group.radios[0];
      const fieldset = first.closest('fieldset');
      const near = questionNear(group.radios);
      const groupLabel =
        (fieldset?.querySelector(':scope > legend')?.textContent?.trim()) ||
        first.getAttribute('aria-label') ||
        (first.getAttribute('aria-labelledby')
          ? byId(first.getAttribute('aria-labelledby'), first)?.textContent?.trim() || ''
          : '') ||
        questionLabel(first, group.radios) ||
        near.text ||
        getLabelText(first);  // last resort: an option's own text is not the question
      fields.push({
        id: key,
        type: 'radio',
        label: groupLabel || '',
        name: group.name,
        required: isRequired(group.radios, groupLabel, near.node),
        options: options.length > 0 ? options : undefined,
      });
    }

    // Checkbox groups: one field per shared name, with the group question and every option.
    for (const name of groupNames) {
      if (seen.has(name)) continue;
      seen.add(name);
      const boxes = groupBoxes(name);
      const first = boxes[0];
      const fieldset = first.closest('fieldset');
      const near = questionNear(boxes);
      const label =
        (fieldset?.querySelector(':scope > legend')?.textContent?.trim()) ||
        first.getAttribute('aria-label') ||
        questionLabel(first, boxes) || near.text || '';
      fields.push({
        id: name,
        type: 'checkbox',
        label,
        name,
        required: isRequired(boxes, label, near.node),
        options: boxes.map(b => (getLabelText(b) || b.value || '').trim()).filter(Boolean),
        multiple: true,
      });
    }

    // Yes/No button pairs (Ashby): the answer is a pressed button; the checkbox
    // beside them is hidden. Reported as a single-choice field so the model and
    // the truth rules see the question and its options.
    for (const box of deepQueryAll('input[type="checkbox"]')) {
      const buttons = toggleButtons(box);
      if (buttons.length < 2) continue;
      const fieldId = box.id || box.name || `recrutas_${fields.length}`;
      if (seen.has(fieldId)) continue;
      seen.add(fieldId);
      if (!box.id && !box.name) box.setAttribute('data-recrutas-id', fieldId);
      fields.push({
        id: fieldId,
        type: 'radio',
        label: getLabelText(box) || questionLabel(box) || '',
        name: box.getAttribute('name') || '',
        required: box.required || box.getAttribute('aria-required') === 'true',
        options: buttons.map(b => b.textContent.trim()),
      });
    }

    // Custom dropdown elements (Workday, iCIMS, Taleo use div[role="listbox"] instead of <select>)
    const customDropdowns = deepQueryAll(
      '[role="listbox"], [role="combobox"], [data-automation-id*="select"], [data-automation-id*="dropdown"]'
    );
    for (const el of customDropdowns) {
      // An <input role="combobox"> was already collected by the first loop; tagging
      // it again here gave it a second made-up id and lost the first.
      if (el.matches('input, select, textarea')) continue;
      // Skip if we already captured a child input from this container
      if (el.querySelector('input, select') &&
          Array.from(el.querySelectorAll('input, select')).some(child =>
            seen.has(child.id || child.name || child.getAttribute('data-recrutas-id')))) {
        continue;
      }

      if (el.closest('.iti') || /^iti-\d+__/.test(el.id || '')) continue;  // the phone widget's country list
      const fieldId = el.id || el.getAttribute('data-automation-id') || `recrutas_custom_${fields.length}`;
      if (seen.has(fieldId)) continue;
      seen.add(fieldId);
      if (!el.id && !el.getAttribute('data-automation-id')) el.setAttribute('data-recrutas-id', fieldId);

      const options = Array.from(el.querySelectorAll('[role="option"], li, [data-value]'))
        .map(opt => opt.textContent?.trim())
        .filter(Boolean);

      fields.push({
        id: fieldId,
        type: 'custom_select',
        label: getLabelText(el) || el.getAttribute('aria-label') || questionLabel(el) || questionNear([el]).text || '',
        name: '',
        required: isRequired([el], getLabelText(el) || questionNear([el]).text, questionNear([el]).node),
        options: options.length > 0 ? options : undefined,
      });
    }

    return fields;
  }

  // ── Extract job context from the page ──────────────────────────────────────

  const ATS_PATTERNS = {
    greenhouse: /greenhouse\.io|job-boards\.greenhouse\.io/i,
    lever: /lever\.co/i,
    ashby: /ashbyhq\.com|jobs\.ashbyhq\.com/i,
    workday: /myworkdayjobs\.com|myworkdaysite\.com/i,
    icims: /icims\.com/i,
    smartrecruiters: /smartrecruiters\.com/i,
    jobvite: /jobvite\.com/i,
    bamboohr: /bamboohr\.com/i,
    workable: /workable\.com/i,
    breezy: /breezy\.hr/i,
    jazz: /jazz\.co|jazzhr\.com/i,
    taleo: /taleo\.net/i,
    successfactors: /successfactors\.com/i,
    ultipro: /ultipro\.com/i,
    paylocity: /paylocity\.com/i,
    paycom: /paycomonline\.net/i,
    rippling: /rippling\.com/i,
    deel: /deel\.com/i,
  };

  function detectATSType() {
    const hostname = window.location.hostname;
    for (const [ats, pattern] of Object.entries(ATS_PATTERNS)) {
      if (pattern.test(hostname)) return ats;
    }
    return 'unknown';
  }

  function extractJobContext() {
    const h1 = document.querySelector('h1');
    const title = h1?.textContent?.trim() || document.title || '';

    const company =
      document.querySelector('[class*="company"], [data-company]')?.textContent?.trim() ||
      document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ||
      '';

    const desc = document.querySelector(
      '[class*="description"], [class*="job-description"], [data-testid*="description"]'
    )?.textContent?.trim()?.slice(0, 1000) || '';

    return {
      text: `${title}${company ? ' at ' + company : ''}${desc ? '\n' + desc : ''}`.slice(0, 2000),
      atsType: detectATSType(),
    };
  }

  // ── Find DOM element by field ID ───────────────────────────────────────────

  function findElement(fieldId) {
    return document.getElementById(fieldId)
      || deepQuery(`[data-recrutas-id="${CSS.escape(fieldId)}"]`)
      || deepQuery(`[name="${CSS.escape(fieldId)}"]`)
      || deepQuery(`[id="${CSS.escape(fieldId)}"]`);
  }

  // ── Action executors ───────────────────────────────────────────────────────

  function highlightFilled(el) {
    el.style.backgroundColor = '#d1fae5';
    el.style.transition = 'background-color 0.3s ease';
    setTimeout(() => { el.style.backgroundColor = ''; }, 2500);
  }

  function highlightFailed(el) {
    el.style.backgroundColor = '#fef2f2';
    el.style.transition = 'background-color 0.3s ease';
    setTimeout(() => { el.style.backgroundColor = ''; }, 3000);
  }

  // ACTION: type
  function executeType(el, value) {
    el.focus();
    const ok = setNativeValue(el, value);
    el.blur();
    if (ok) highlightFilled(el);
    return ok;
  }

  // ACTION: select
  function executeSelect(el, value) {
    if (el.tagName !== 'SELECT') return false;

    const valueLower = value.toLowerCase();
    const option = Array.from(el.options).find(opt =>
      opt.text?.trim().toLowerCase() === valueLower ||
      opt.value?.toLowerCase() === valueLower
    );

    if (!option) {
      const fuzzy = Array.from(el.options).find(opt =>
        opt.text?.trim().toLowerCase().includes(valueLower) ||
        valueLower.includes(opt.text?.trim().toLowerCase())
      );
      if (fuzzy && setNativeValue(el, fuzzy.value)) {
        highlightFilled(el);
        return true;
      }
      return false;
    }

    if (!setNativeValue(el, option.value)) return false;
    highlightFilled(el);
    return true;
  }

  // The container element that owns the dropdown (react-select control, listbox, etc.).
  // CRUCIAL: a react-select's own <input> carries role="combobox", so a naive
  // closest() that lists [role="combobox"] returns the INPUT itself — and the
  // committed value chip (.select__single-value) lives in the parent
  // `.select__control`, not the input, so success detection would always read
  // false. Resolve to the control wrapper first; only fall back to a generic
  // combobox/listbox ancestor for non-react-select widgets (Workday, etc.).
  function dropdownContainer(el) {
    const control = el.closest('.select__control, [class*="-control"]');
    if (control && control !== el) return control;
    return el.closest('[class*="select__"], [class*="combobox"], [class*="dropdown"], [role="combobox"], [role="listbox"]')
      || el.parentElement
      || el;
  }

  // Currently-rendered, selectable option nodes for THIS dropdown's menu. We
  // deliberately exclude intl-tel-input's phone-country list (`iti__*`, always in
  // the DOM) and any element nested in a phone widget, which otherwise hijacks the
  // match. react-select renders its menu in a portal, so we search document-wide
  // but only within real menu/listbox containers.
  function visibleOptionNodes() {
    const nodes = deepQueryAll(
      '.select__menu .select__option, [class*="menu-list"] [class*="option"], [class*="select__menu"] [role="option"], [role="listbox"]:not([class*="iti__"]) [role="option"], [class*="MenuList"] [role="option"]'
    );
    return Array.from(nodes).filter(o =>
      !o.className?.toString().includes('iti__') &&
      !o.closest('[class*="iti__"], .iti, [class*="intl-tel"]') &&
      (o.offsetParent !== null || o.getClientRects().length > 0)
    );
  }

  // Greenhouse's react-select dropdowns render their options only while open, so the fill sent
  // them with no options and the AI typed answers the menu didn't have ("Job board", "Master's
  // degree" into a Yes/No; Centria, 2026-10-15). Open each one briefly and read its options.
  // Opening selects nothing; Escape closes it. Bounded so a long form can't stall the fill.
  async function readDropdownOptions(fields) {
    const started = Date.now();
    for (const f of fields) {
      if (f.type !== 'custom_select' || f.options?.length) continue;
      if (Date.now() - started > 6000) break;
      const el = findElement(f.id);
      if (!el || !el.closest('.select__control, [class*="-control"]')) continue;
      try {
        pointerPress(dropdownContainer(el));
        let opts = [];
        for (let i = 0; i < 6 && !opts.length; i++) {
          await new Promise(r => setTimeout(r, 80));
          opts = visibleOptionNodes().map(o => o.textContent.trim()).filter(t => t && !/^no options$/i.test(t));
        }
        if (opts.length) f.options = [...new Set(opts)].slice(0, 80);
      } catch { /* leave it without options */ }
      sendKey(el, 'Escape', 27);
      el.blur();
      await new Promise(r => setTimeout(r, 40));
    }
  }

  // Full pointer+mouse press. react-select v5 opens/commits on POINTER events, not
  // a bare `mousedown` — dispatching the whole pointerdown→mousedown→pointerup→
  // mouseup→click sequence (with button/buttons/composed set) is what actually
  // drives it. Verified on real Firefox: a lone mousedown never opens the menu;
  // this sequence does. `composed:true` lets it cross the react-select shadow-ish
  // event boundary; `view:window` makes React treat it as a genuine interaction.
  function pointerPress(node) {
    const seq = [['pointerdown', PointerEvent], ['mousedown', MouseEvent], ['pointerup', PointerEvent], ['mouseup', MouseEvent], ['click', MouseEvent]];
    for (const [type, Ctor] of seq) {
      try {
        node.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, isPrimary: true, view: window }));
      } catch { node.dispatchEvent(new MouseEvent(type === 'pointerdown' ? 'mousedown' : type === 'pointerup' ? 'mouseup' : type, { bubbles: true, cancelable: true, button: 0, view: window })); }
    }
  }

  function clickOption(opt) {
    pointerPress(opt);
  }

  function sendKey(el, key, keyCode) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, keyCode, which: keyCode, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, keyCode, which: keyCode, bubbles: true }));
  }

  function committedValue(container, el) {
    // Search from the react-select control wrapper (holds the value chip) as well
    // as the passed container, so detection is robust no matter which element the
    // caller resolved as the container.
    const scope = el.closest('.select__control') || container;
    const chip = scope.querySelector('.select__single-value, .select__multi-value, [class*="singleValue"], [class*="multiValue"]');
    if (chip && chip.textContent.trim()) return true;
    if (el.tagName === 'SELECT' && el.value) return true;
    return false;
  }

  // Poll `pred` until it returns truthy or `maxMs` elapses. Replaces brittle fixed
  // sleeps — headless react-select menus render at variable latency.
  async function waitFor(pred, maxMs = 1500, step = 100) {
    const start = Date.now();
    for (;;) {
      try { const v = pred(); if (v) return v; } catch { /* keep polling */ }
      if (Date.now() - start >= maxMs) return null;
      await sleep(step);
    }
  }

  // Type into a react-select search box: native setter + 'input' ONLY (a 'change'
  // event is read as a blur and closes the menu empty).
  function typeFilter(input, value) {
    if (!input || input.value === undefined) return;
    setNativeValue(input, value, { change: false });
  }

  const isDialCode = s => /^\+?\d[\d\s().-]*$/.test((s || '').trim());

  // "Decline to answer" phrasings vary widely per site: "Decline to self-identify",
  // "I don't wish to answer", "I do not want to answer", "Prefer not to say/disclose".
  // Match wish AND want (a common miss), plus opt-out/rather-not.
  const DECLINE_RE = /decline|prefer not|opt out|rather not|do(?:\s+not|n'?t)\s+(?:wish|want)|(?:wish|want)\s+not to/i;
  // Affirmative acknowledgments: the model often returns "yes" while the option
  // reads "Confirmed" / "I agree" / "I acknowledge" — treat them as equivalent.
  const AFFIRM_RE = /^\s*(yes|yeah|i\s+agree|agree|i\s+acknowledge|acknowledge|i\s+understand|understand|i\s+certify|certify|i\s+accept|accept|confirm(?:ed)?|affirm(?:ative)?|true)\b/i;

  // One attempt at opening the dropdown and committing the option for `wanted`.
  async function attemptDropdown(el, container, searchInput, wanted, isDecline, isAffirm, strict) {
    const txt = o => (o.textContent || '').trim().toLowerCase();
    // When the desired value is a word (e.g. "United States"), never accept a bare
    // dial-code option ("+1") — that's the phone widget leaking in.
    const wantNumeric = isDialCode(wanted);
    const matchInMenu = () => {
      const opts = visibleOptionNodes().filter(o => wantNumeric || !isDialCode(txt(o)));
      // Strict (the server asked for it): the option is the value or starts with it, so
      // "job board" picks "Job Boards" but never "College Job Boards".
      if (strict) return opts.find(o => txt(o) === wanted) || opts.find(o => txt(o).startsWith(wanted)) || null;
      return opts.find(o => txt(o) === wanted)
        || opts.find(o => txt(o) && (txt(o).includes(wanted) || wanted.includes(txt(o))))
        || (isDecline ? opts.find(o => DECLINE_RE.test(txt(o))) : null)
        // Affirmative acknowledgment: match any yes/agree/confirm-family option;
        // if the widget offers a single option (e.g. only "Confirmed"), take it —
        // there is no wrong choice on a one-option acknowledgment.
        || (isAffirm ? (opts.find(o => AFFIRM_RE.test(txt(o))) || (opts.length === 1 ? opts[0] : null)) : null);
    };
    const committed = () => committedValue(container, el);
    const hasMenu = () => visibleOptionNodes().length > 0;

    // Open: full pointer press on the control (react-select v5 opens on the pointer
    // sequence — a bare mousedown does NOT, verified on real Firefox), then focus +
    // ArrowDown as a belt-and-suspenders nudge for widgets that open on keyboard.
    pointerPress(container);
    searchInput.focus?.();
    sendKey(searchInput, 'ArrowDown', 40);
    // Poll for the menu. waitFor returns as soon as options appear, so a fast
    // dropdown pays ~nothing here; the cap only bounds slow/dead widgets.
    let opened = await waitFor(hasMenu, 1000, 100);
    // Retry the open press a couple of times: in headless a react-select that
    // hasn't finished hydrating can swallow the first pointer sequence, which was
    // showing up as whole-run 0/N flakes. Costs nothing on the fast path.
    for (let o = 0; !opened && o < 2; o++) {
      pointerPress(container);
      opened = await waitFor(hasMenu, 800, 100);
    }

    // EEO "decline" / affirmative acknowledgment: the AI's phrasing rarely matches
    // the site's exact wording ("I do not want to answer", "Confirmed"), so scan the
    // OPEN menu directly — typing the AI value would filter the real option away.
    if ((isDecline || isAffirm) && opened) {
      const opt = await waitFor(matchInMenu, 900, 120);
      if (opt) { clickOption(opt); if (await waitFor(committed, 800, 100)) return true; }
    }

    // Type to filter. Some typed-filter widgets only render options AFTER input,
    // so if the menu never opened on ArrowDown, typing gets one more short poll.
    typeFilter(searchInput, wanted);
    if (!opened) {
      opened = await waitFor(hasMenu, 700, 100);
      // FAST-BAIL: no menu on open AND none after typing → this widget isn't
      // responding; don't burn the match/commit waits guessing at a dead field.
      if (!opened) { sendKey(searchInput, 'Escape', 27); typeFilter(searchInput, ''); return false; }
    }

    // Click an exact menu match; else keyboard-commit the highlighted option.
    // (react-select filtering is case-insensitive.)
    let opt = await waitFor(matchInMenu, 1500, 120);
    if (!opt) {
      // Re-type once: on a cold/slow control the first input event can race the
      // async filtered render, so the target option isn't in the DOM yet when the
      // first poll expires. Clear + retype, then poll again before giving up. This
      // was the main cause of typed-filter (Country/Degree) misses on slow runs.
      typeFilter(searchInput, '');
      await sleep(120);
      typeFilter(searchInput, wanted);
      opt = await waitFor(matchInMenu, 1200, 120);
    }
    // Only an option that matches is ever chosen. Committing the highlighted option when
    // nothing matched picked an unrelated answer ("Career/ College Fair" for "how did you
    // hear", 2026-10-12): an empty field the candidate fills beats a wrong one.
    if (!opt) {
      sendKey(searchInput, 'Escape', 27);
      typeFilter(searchInput, '');
      return false;
    }
    clickOption(opt);
    if (await waitFor(committed, 800, 100)) return true;

    // Reset before the caller retries: close the menu and clear leftover text.
    sendKey(searchInput, 'Escape', 27);
    typeFilter(searchInput, '');
    return false;
  }

  // Select ONE option in an open-on-click dropdown (react-select, combobox, etc.).
  // react-select is keyboard-driven and renders at variable latency in headless, so
  // we poll for the menu/commit and retry the whole sequence. Returns true only on a
  // committed value chip (search text alone is NOT success — it clears on blur).
  async function selectDropdownOption(el, value, strict = false) {
    const container = dropdownContainer(el);
    const wanted = value.trim().toLowerCase();
    const isDecline = DECLINE_RE.test(wanted);
    const isAffirm = !isDecline && AFFIRM_RE.test(wanted);
    const searchInput = container.querySelector('input[role="combobox"], input[type="text"], input:not([type])') || el;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(250);
      if (committedValue(container, el)) return true;
      if (await attemptDropdown(el, container, searchInput, wanted, isDecline, isAffirm, strict)) return true;
    }
    return false;
  }

  // ACTION: click_then_type. A multi-select value is sent as a pipe-delimited list
  // ("New York | Remote") so we can select each option without colliding with the
  // commas inside "City, State" option labels.
  async function executeClickThenType(el, value, strict = false) {
    const parts = value.includes('|')
      ? value.split('|').map(s => s.trim()).filter(Boolean)
      : [value];

    let anySuccess = false;
    try {
      for (const part of parts) {
        const ok = await withTimeout(
          selectDropdownOption(el, part, strict),
          7000,
          'Dropdown selection timed out'
        );
        anySuccess = anySuccess || ok;
        if (parts.length > 1) await sleep(250);
      }
    } catch (err) {
      console.debug('[Recrutas] click_then_type failed:', err.message);
    }

    if (anySuccess) highlightFilled(el);
    else highlightFailed(el);
    return anySuccess;
  }

  // The buttons that answer a yes/no question rendered as a button pair.
  function toggleButtons(box) {
    return Array.from(box.parentElement?.querySelectorAll(':scope > button[aria-pressed]') || [])
      .filter(b => b.textContent?.trim());
  }

  // ACTION: pick the button whose text matches `value` in a yes/no button pair.
  async function executeToggle(box, value) {
    const wanted = value.trim().toLowerCase();
    const buttons = toggleButtons(box);
    const text = b => b.textContent.trim().toLowerCase();
    const btn = buttons.find(b => text(b) === wanted)
      || buttons.find(b => /^(yes|true)\b/.test(wanted) && /^yes\b/.test(text(b)))
      || buttons.find(b => /^(no|false)\b/.test(wanted) && /^no\b/.test(text(b)));
    if (!btn) return false;
    if (btn.getAttribute('aria-pressed') !== 'true') pointerPress(btn);
    const ok = await waitFor(() => btn.getAttribute('aria-pressed') === 'true', 800, 100);
    if (ok) highlightFilled(btn);
    return !!ok;
  }

  // Plain (non-toggle) checkboxes with this name, when two or more share it.
  function groupBoxes(name) {
    if (!name) return [];
    const boxes = deepQueryAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`)
      .filter(b => !b.disabled && toggleButtons(b).length < 2);
    return boxes.length >= 2 ? boxes : [];
  }

  function checkboxGroupNames() {
    const names = new Set();
    for (const b of deepQueryAll('input[type="checkbox"][name]')) {
      if (!names.has(b.name) && groupBoxes(b.name).length) names.add(b.name);
    }
    return names;
  }

  // ACTION: check the options of a checkbox group named in `value` (pipe-separated). Only exact
  // option matches are checked; nothing is unchecked.
  function executeCheckboxGroup(el, value) {
    const wanted = String(value || '').split('|').map(v => v.trim().toLowerCase()).filter(Boolean);
    let any = false;
    for (const box of groupBoxes(el.getAttribute('name'))) {
      const label = (getLabelText(box) || box.value || '').trim().toLowerCase();
      if (!wanted.includes(label)) continue;
      any = executeCheck(box) || any;
    }
    return any;
  }

  // ACTION: check
  function executeCheck(el) {
    if (el.type !== 'checkbox') return false;
    if (!el.checked) {
      el.click();
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    highlightFilled(el);
    return true;
  }

  // ACTION: radio — pick the option in the group whose label/value matches `value`.
  // `el` is any radio in the group (findElement resolves the group's `name` to the
  // first one); we search all radios sharing that name.
  function executeRadio(el, value) {
    const name = el.getAttribute('name');
    const radios = name
      ? deepQueryAll(`input[type="radio"][name="${CSS.escape(name)}"]`)
      : [el];
    const wanted = value.trim().toLowerCase();
    if (!wanted) return false;
    const labelOf = r => (getLabelText(r) || r.value || '').trim().toLowerCase();

    let match = radios.find(r => labelOf(r) === wanted);
    if (!match) {
      match = radios.find(r => {
        const t = labelOf(r);
        return t && (t.includes(wanted) || wanted.includes(t));
      });
    }
    if (!match) return false;

    if (!match.checked) {
      match.click();
      match.checked = true;
      match.dispatchEvent(new Event('change', { bubbles: true }));
    }
    highlightFilled(match);
    return true;
  }

  // ACTION: upload_resume
  async function executeUploadResume(el, resumeUrl) {
    if (!resumeUrl || el.type !== 'file') return false;

    try {
      const fileData = await sendMessage({
        type: 'DOWNLOAD_RESUME',
        url: resumeUrl,
      });

      if (!fileData.success) return false;

      const binary = atob(fileData.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: fileData.mimeType });
      const file = new File([blob], fileData.filename, { type: fileData.mimeType });

      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event('change', { bubbles: true }));

      highlightFilled(el);
      return true;
    } catch (err) {
      console.debug('[Recrutas] Resume upload failed:', err.message);
      return false;
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Promise with timeout
  function withTimeout(promise, ms, errorMsg = 'Operation timed out') {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms))
    ]);
  }

  // ── Execute all actions with retry ────────────────────────────────────────

  async function executeActions(actions, resumeUrl) {
    let filled = 0;
    const failed = [];
    // Wall-clock backstop for the slow (dropdown) actions. Each one owns its own
    // retry/timeout, but serially they can still outrun the client/harness window
    // and cut the banner off mid-fill. Once the budget is spent we fail remaining
    // dropdowns instantly so the run finishes and reports an HONEST count.
    const dropdownDeadline = Date.now() + 50000;

    for (const action of actions) {
      if (action.action === 'skip') continue;

      const el = findElement(action.fieldId);
      if (!el) {
        failed.push(action.fieldId);
        console.debug(`[Recrutas] Element not found: ${action.fieldId}`);
        continue;
      }

      let success = false;
      // A react-select / combobox element must be driven as a dropdown no matter
      // what action the model emitted. The model frequently returns `type` or
      // `select` for these (they look like a text input / <select>), which types
      // free text that react-select discards on blur → the field stays blank. This
      // is the #1 cause of typed-dropdown (Country, Degree, …) misses.
      const elIsCombobox =
        el.getAttribute('role') === 'combobox' ||
        el.getAttribute('aria-autocomplete') === 'list' ||
        el.getAttribute('aria-haspopup') === 'listbox' ||
        !!el.closest('.select__control, [class*="-control"], [class*="select__"]');
      const isDropdown = action.action === 'click_then_type' || action.action === 'click_option' || elIsCombobox;

      // Dropdown actions retry internally (selectDropdownOption), so the outer
      // retry only multiplies their cost — run them once. Cheap actions (type /
      // select / check) keep the 2× retry.
      const maxAttempts = isDropdown ? 1 : 2;

      for (let attempt = 0; attempt < maxAttempts && !success; attempt++) {
        if (attempt > 0) await sleep(300);
        // One field that throws must not abort the rest of the form.
        try {

        // Radio groups: whatever action the model emitted (select / radio /
        // click_then_type), selecting the matching option is the only sane fill.
        if (el.type === 'radio') {
          success = executeRadio(el, action.value || '');
          continue;
        }
        if (el.type === 'checkbox' && toggleButtons(el).length >= 2) {
          success = await executeToggle(el, action.value || '');
          continue;
        }
        if (el.type === 'checkbox' && groupBoxes(el.getAttribute('name')).length) {
          success = executeCheckboxGroup(el, action.value || '');
          continue;
        }

        // Combobox/react-select: route to the dropdown driver regardless of the
        // model's action, honouring the same time budget as click_then_type.
        if (elIsCombobox) {
          if (Date.now() > dropdownDeadline) { success = false; break; }
          success = await executeClickThenType(el, action.value || '', !!action.strict);
          continue;
        }

        switch (action.action) {
          case 'type':
            success = executeType(el, action.value || '');
            break;
          case 'select':
            success = executeSelect(el, action.value || '');
            break;
          case 'click_then_type':
          case 'click_option':
            // Custom dropdowns (react-select / role="listbox"): open, then commit
            // the matching option. Skip fast once the dropdown budget is spent.
            if (Date.now() > dropdownDeadline) {
              console.debug(`[Recrutas] Dropdown budget exhausted, skipping: ${action.fieldId}`);
              success = false;
            } else {
              success = await executeClickThenType(el, action.value || '', !!action.strict);
            }
            break;
          case 'check':
            success = executeCheck(el);
            break;
          case 'upload_resume':
            success = await executeUploadResume(el, resumeUrl);
            break;
          default:
            console.debug(`[Recrutas] Unknown action: ${action.action}`);
        }
        } catch (err) {
          console.debug(`[Recrutas] Field ${action.fieldId} failed:`, err.message);
          success = false;
        }
      }

      if (success) {
        filled++;
      } else {
        failed.push(action.fieldId);
        highlightFailed(el);
      }

      await sleep(100);
    }

    return { filled, failed };
  }

  // ── Banner / toast ─────────────────────────────────────────────────────────

  function showBanner(message, type = 'success') {
    const existing = document.getElementById('recrutas-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'recrutas-banner';
    banner.className = `recrutas-banner recrutas-banner--${type}`;
    banner.textContent = message;
    document.body.appendChild(banner);

    // Errors and warnings stay long enough to read; success can go sooner.
    setTimeout(() => banner.remove(), type === 'success' ? 6000 : 15000);
  }

  // ── Where each answer came from ────────────────────────────────────────────

  const SOURCE_LABEL = { profile: 'Profile', resume: 'Resume', answer: 'Your answer', default: 'Default', draft: 'Draft, review it' };

  // A small tag after each filled field saying where its value came from, so the
  // candidate can check it before submitting. Evidence (e.g. "About 6 years of
  // experience on your resume") shows on hover.
  function tagSources(actions, failed) {
    const failedSet = new Set(failed);
    document.querySelectorAll('.recrutas-src').forEach(t => t.remove());
    for (const a of actions) {
      if (!a.source || a.action === 'skip' || failedSet.has(a.fieldId)) continue;
      const el = findElement(a.fieldId);
      if (!el || el.type === 'hidden') continue;
      const anchor = el.closest('.select__container, .select-shell, [class*="select__control"]') || el;
      const tag = document.createElement('span');
      tag.className = `recrutas-src recrutas-src--${String(a.source).replace(/[^a-z]/g, '')}`;
      tag.textContent = SOURCE_LABEL[a.source] || String(a.source);
      if (a.evidence) tag.title = String(a.evidence);
      anchor.insertAdjacentElement('afterend', tag);
    }
  }

  // Facts we never guess (work authorization, sponsorship, salary…): list them,
  // outline the fields, and offer to save the answers once in Recrutas.
  // Nothing required is left empty without saying so: after the fill, any required question that
  // is still unanswered and not already listed joins "needs you" (an answer that didn't apply, or
  // one the server had nothing for). The benchmark found required fields left silently empty.
  function fieldAnswered(f) {
    if (f.type === 'radio' || f.type === 'checkbox') {
      const name = f.name || f.id;
      const group = document.querySelectorAll(`input[name="${CSS.escape(name)}"]`);
      if (group.length) return Array.from(group).some(i => i.checked);
    }
    const el = findElement(f.id);
    if (!el) return true;  // can't see it: don't claim it's empty
    if (el.type === 'file') return !!el.files?.length;
    if (f.type === 'custom_select') return committedValue(dropdownContainer(el), el) || !!(el.value || '').trim();
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked;
    return !!(el.value || '').trim();
  }
  function addUnansweredRequired(fields, needsYou) {
    const listed = new Set(needsYou.map(n => n.fieldId));
    for (const f of fields) {
      if (!f.required || listed.has(f.id) || f.type === 'hidden') continue;
      if (fieldAnswered(f)) continue;
      needsYou.push({ fieldId: f.id, label: (f.label || f.name || f.id).trim().slice(0, 140), fact: 'other' });
      listed.add(f.id);
    }
  }

  function showNeedsYou(needsYou, answersUrl) {
    document.getElementById('recrutas-needs')?.remove();
    document.querySelectorAll('.recrutas-needs-field').forEach(e => e.classList.remove('recrutas-needs-field'));
    if (!needsYou.length) return;
    // Every element is watched for an answer to remember; the panel lists each question once
    // (a form can render one question as two elements).
    for (const n of needsYou) offerToRemember(n);
    const seenLabels = new Set();
    needsYou = needsYou.filter(n => {
      const k = String(n.label || n.fieldId).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (seenLabels.has(k)) return false;
      seenLabels.add(k);
      return true;
    });

    const panel = document.createElement('div');
    panel.id = 'recrutas-needs';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'recrutas-needs-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', () => panel.remove());
    const title = document.createElement('strong');
    title.textContent = `${needsYou.length} question${needsYou.length === 1 ? ' needs' : 's need'} you`;
    const intro = document.createElement('p');
    intro.textContent = 'We only fill what we know.';
    // Two groups, so the questions worth answering once come first: facts we can keep in
    // Recrutas (sponsorship, relocation, salary…) are filled on every later form; the rest
    // belong to this employer's form only.
    const everyForm = needsYou.filter(n => n.saveAs);
    const thisForm = needsYou.filter(n => !n.saveAs);
    const group = (heading, items) => {
      const box = document.createElement('div');
      box.className = 'recrutas-needs-group';
      const h = document.createElement('p');
      h.className = 'recrutas-needs-heading';
      h.textContent = `${heading} (${items.length})`;
      const list = document.createElement('ul');
      for (const n of items) {
        const el = findElement(n.fieldId);
        if (el) (el.closest('.select__container, .select-shell') || el).classList.add('recrutas-needs-field');
        const li = document.createElement('li');
        li.textContent = String(n.label || n.fieldId).replace(/\s*\*\s*$/, '');
        if (el) {
          li.tabIndex = 0;
          li.addEventListener('click', () => { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus?.(); });
        }
        list.appendChild(li);
      }
      box.append(h, list);
      return box;
    };
    panel.append(close, title, intro);
    if (everyForm.length) {
      panel.appendChild(group('Answer once, filled on every form', everyForm));
      if (typeof answersUrl === 'string' && /^https:\/\//.test(answersUrl)) {
        const link = document.createElement('a');
        link.href = answersUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Save these once in Recrutas';
        panel.appendChild(link);
      }
    }
    if (thisForm.length) {panel.appendChild(group('Only on this form', thisForm));}
    document.body.appendChild(panel);
  }

  // ── Remember an answer typed on the form ──────────────────────────────────
  // When the candidate answers a "needs you" question that comes up on every form (a saved
  // fact like sponsorship, or a short question they may see word for word again), a small
  // button next to the field offers to use that answer on every form. Nothing is saved
  // unless they click it.

  const YES_RE = /^\s*(yes|true|i am|i do|i will|i have)\b|^\s*y\s*$/i;
  const NO_RE = /^\s*(no|false|i am not|i do not|i don'?t|i will not|i won'?t)\b|^\s*n\s*$/i;
  const YES_NO_KEYS = new Set(['workAuthorizedUS', 'needsSponsorship', 'usCitizen', 'over18', 'willingToRelocate', 'driversLicense', 'backgroundCheck']);
  const TEXT_MAX = { noticePeriod: 60, desiredSalary: 60, languages: 120 };
  const CLEARANCES = [['ts_sci', /ts\s*\/?\s*sci/i], ['top_secret', /top secret/i], ['secret', /\bsecret\b/i], ['public_trust', /public trust/i], ['none', /^\s*(none|no|n\/a)\b/i]];

  /** What the candidate picked or typed in a field, as shown. */
  function answerIn(el) {
    if (!el) return '';
    if (el.tagName === 'SELECT') return el.selectedOptions?.[0]?.textContent?.trim() || '';
    const box = el.closest('.select__container, .select-shell, [class*="select__control"], [role="radiogroup"], fieldset');
    const single = box?.querySelector('[class*="single-value"], [class*="singleValue"]');
    if (single?.textContent?.trim()) return single.textContent.trim();
    const radio = box?.querySelector('input[type="radio"]:checked');
    if (radio) return (radio.closest('label')?.textContent || document.querySelector(`label[for="${CSS.escape(radio.id)}"]`)?.textContent || radio.value || '').trim();
    return (el.value || '').trim();
  }

  /** The answer as it's saved: yes/no for yes/no facts, a clearance level, or the words. */
  function toSaved(n, raw) {
    if (!raw) return null;
    if (n.saveAs) {
      if (YES_NO_KEYS.has(n.saveAs)) return YES_RE.test(raw) ? { [n.saveAs]: 'yes' } : NO_RE.test(raw) ? { [n.saveAs]: 'no' } : null;
      if (n.saveAs === 'securityClearance') {
        const hit = CLEARANCES.find(([, re]) => re.test(raw));
        return hit ? { securityClearance: hit[0] } : null;
      }
      return raw.length <= (TEXT_MAX[n.saveAs] || 60) ? { [n.saveAs]: raw } : null;
    }
    if (n.saveKey && raw.length <= 200) return { custom: { [n.saveKey]: raw } };
    return null;
  }

  function offerToRemember(n) {
    if (!n.saveAs && !n.saveKey) return;
    const el = findElement(n.fieldId);
    if (!el) return;
    const anchor = el.closest('.select__container, .select-shell, [class*="select__control"], [role="radiogroup"], fieldset') || el;
    let button = null;
    const check = () => setTimeout(() => {
      const changes = toSaved(n, answerIn(el));
      if (!changes) { button?.remove(); button = null; return; }
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'recrutas-remember';
        anchor.insertAdjacentElement('afterend', button);
        button.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const now = toSaved(n, answerIn(el));
          if (!now) return;
          button.disabled = true;
          button.textContent = 'Saving…';
          try {
            const res = await sendMessage({ type: 'SAVE_ANSWER', changes: now });
            if (!res?.success) throw new Error(res?.error || 'Save failed');
            button.textContent = 'Saved for every form ✓';
          } catch (err) {
            button.disabled = false;
            button.textContent = "Couldn't save. Try again";
          }
        });
      }
      if (!button.disabled) button.textContent = 'Use this answer on every form';
    }, 150);
    // Typed, picked from a native select, chosen in a custom dropdown or a radio group.
    for (const ev of ['change', 'focusout', 'click', 'keyup']) anchor.addEventListener(ev, check, true);
  }

  // ── Main fill trigger ──────────────────────────────────────────────────────

  // Re-entry guard: the button is wired via BOTH a direct listener and a
  // document-level delegated listener (see injectButton / the capture-phase
  // handler below), so a single click can reach triggerFill twice. This flag
  // collapses that to one run.
  let isFilling = false;
  window.__recruitasFill = () => triggerFill();

  async function triggerFill() {
    if (isFilling) return;
    isFilling = true;
    const btn = document.getElementById('recrutas-fill-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Analyzing form…';
    }

    try {
      const fields = scrapeFields();
      // Test hook: the real-browser bench sets data-recrutas-debug on <html> to read exactly
      // what the fill sends (question text, required, options). Never set by real pages.
      if (document.documentElement.getAttribute('data-recrutas-debug') === '1') {
        document.documentElement.setAttribute('data-recrutas-fields', JSON.stringify(fields.map(f => ({ id: f.id, type: f.type, label: f.label, required: f.required, options: f.options }))));
      }

      if (fields.length === 0) {
        showBanner('No form fields found on this page', 'warning');
        return;
      }

      if (btn) btn.textContent = 'Reading the form…';
      await readDropdownOptions(fields);
      if (document.documentElement.getAttribute('data-recrutas-debug') === '1') {
        document.documentElement.setAttribute('data-recrutas-fields', JSON.stringify(fields.map(f => ({ id: f.id, type: f.type, label: f.label, required: f.required, options: f.options }))));
      }

      const jobContext = extractJobContext();

      if (btn) btn.textContent = 'AI filling…';

      // The server takes at most 50 fields per request. Long applications
      // (60-70 fields on some Greenhouse forms) were rejected outright and got
      // nothing filled, so send them in batches and merge the answers.
      const BATCH = 45;
      const actions = [];
      let resumeUrl;
      let resumeMissing = false;
      const needsYou = [];
      let answersUrl;
      for (let start = 0; start < fields.length; start += BATCH) {
        if (btn && fields.length > BATCH) {
          btn.textContent = `AI filling… (${Math.min(start + BATCH, fields.length)}/${fields.length} fields)`;
        }
        // Guard against a lost response (e.g. the MV3 service worker being
        // terminated mid-request): without this the button stays on "AI filling…"
        // forever. Slightly longer than the background fetch's own 60s abort so
        // that, when it's the network stalling, the background's clearer error wins.
        const response = await withTimeout(
          sendMessage({
            type: 'FILL_FORM_AI',
            fields: fields.slice(start, start + BATCH),
            jobContext: jobContext.text,
          }),
          65000,
          'Form fill timed out. Please try again.'
        );

        if (!response) {
          // Defensive: a dropped/undefined background reply must not surface as a
          // cryptic "undefined has no properties" — give an actionable message.
          throw new Error('No response from the extension. Please reload the page and try again.');
        }

        if (!response.success) {
          throw new Error(response.error || 'AI fill failed');
        }

        actions.push(...(response.actions || []));
        resumeUrl = resumeUrl || response.resumeUrl;
        resumeMissing = resumeMissing || !!response.resumeMissing;
        needsYou.push(...(response.needsYou || []));
        answersUrl = answersUrl || response.answersUrl;
      }

      if (!actions || actions.length === 0) {
        addUnansweredRequired(fields, needsYou);
        showNeedsYou(needsYou, answersUrl);
        showBanner('AI could not determine how to fill this form', 'warning');
        return;
      }

      if (btn) btn.textContent = `Filling ${actions.length} fields…`;

      let { filled, failed } = await executeActions(actions, resumeUrl);

      // Answers can reveal more questions: Lever's disability answer shows a signature Name and
      // Date, and "If yes, explain" boxes appear on a Yes. They weren't on the page when it was
      // read, so read it once more and fill what's new (2026-10-15, Hermeus).
      await new Promise(r => setTimeout(r, 400));
      const firstIds = new Set(fields.map(f => f.id));
      const revealed = scrapeFields().filter(f => !firstIds.has(f.id));
      if (revealed.length) {
        await readDropdownOptions(revealed);
        const more = await withTimeout(
          sendMessage({ type: 'FILL_FORM_AI', fields: revealed.slice(0, BATCH), jobContext: jobContext.text }),
          65000, 'Form fill timed out. Please try again.'
        ).catch(() => null);
        if (more?.success) {
          const second = await executeActions(more.actions || [], resumeUrl || more.resumeUrl);
          filled += second.filled;
          failed = failed.concat(second.failed);
          actions.push(...(more.actions || []));
          needsYou.push(...(more.needsYou || []));
        }
        fields.push(...revealed);
      }

      if (filled > 0) markApplyContextFilled();
      tagSources(actions, failed);
      addUnansweredRequired(fields, needsYou);
      showNeedsYou(needsYou, answersUrl);

      // Report stats + telemetry to background
      sendMessage({
        type: 'FILL_COMPLETE',
        fieldsFilled: filled,
        failedFields: failed,
        atsType: jobContext.atsType,
        success: filled > 0,
      }).catch(() => {});

      const wantsResume = actions.some(a => a.action === 'upload_resume');
      if (wantsResume && resumeMissing) {
        showBanner('Your resume file is missing. Upload it again in Recrutas, then attach it here.', 'warning');
      } else if (filled === 0) {
        showBanner('Could not fill any fields. Try a different page.', 'warning');
      } else if (failed.length > 0) {
        showBanner(`Filled ${filled} field${filled !== 1 ? 's' : ''} · ${failed.length} skipped. Review before submitting.`, 'success');
      } else {
        showBanner(`Filled ${filled} field${filled !== 1 ? 's' : ''}. Review before submitting.`, 'success');
      }
    } catch (err) {
      // Report failed fill for telemetry
      const jobContext = extractJobContext();
      sendMessage({
        type: 'FILL_COMPLETE',
        fieldsFilled: 0,
        failedFields: [],
        atsType: jobContext.atsType,
        success: false,
        error: err.message,
      }).catch(() => {});
      
      if (err.message?.includes('Not authenticated') || err.message?.includes('Session expired')) {
        showBanner('Sign in to Recrutas extension first', 'error');
      } else {
        showBanner(err.message || 'Extension error. Try reloading the page.', 'error');
      }
    } finally {
      isFilling = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
          Fill with Recrutas
        `;
      }
    }
  }

  // ── Floating button ────────────────────────────────────────────────────────

  function injectButton() {
    if (document.getElementById('recrutas-fill-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'recrutas-fill-btn';
    btn.className = 'recrutas-fill-btn';
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg>
      Fill with Recrutas
    `;

    // Direct listener (fast path). A document-level capture-phase delegate
    // (set up once, below) is the reliable fallback: on Firefox the direct
    // node listener intermittently fails to fire for a programmatic/synthetic
    // click, leaving the button dead. Delegation on `document` does not.
    btn.addEventListener('click', triggerFill);
    document.body.appendChild(btn);
  }

  // Robust click wiring: a single capture-phase listener on `document` catches
  // clicks on the injected button even when the per-node listener doesn't fire.
  // Attached once per frame; the isFilling guard prevents a double-run when both
  // this and the direct listener fire.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && typeof t.closest === 'function' && t.closest('#recrutas-fill-btn')) {
      triggerFill();
    }
  }, true);

  // ── Application tracking ───────────────────────────────────────────────────
  // When an application form appears we remember the posting for this tab
  // (sessionStorage is per tab and per site, which covers every step of one
  // application flow). When the same tab later shows the application system's
  // own confirmation, we report the submission once. Nothing typed into the
  // form is read or sent: only the posting's URL, title and company.

  const APPLY_CTX_KEY = 'recrutas_apply_ctx';
  const APPLY_CTX_MAX_AGE_MS = 2 * 60 * 60 * 1000;
  const CONFIRM_TEXT_RE = /thank(?:s| you) for (?:your )?appl(?:ying|ication)|(?:your )?application (?:has been |was |is )?(?:successfully )?(?:submitted|received|sent|complete)|we(?:'ve| have) received your application|successfully (?:submitted|applied)/i;
  const CONFIRM_PATH_RE = /\/(?:thanks|thank-you|confirmation|submitted|success)(?:\/|$)/i;
  const onRecrutasSite = /(^|\.)recrutas\.ai$/i.test(location.hostname);

  function readApplyContext() {
    try { return JSON.parse(sessionStorage.getItem(APPLY_CTX_KEY) || 'null'); } catch { return null; }
  }
  function writeApplyContext(ctx) {
    try { sessionStorage.setItem(APPLY_CTX_KEY, JSON.stringify(ctx)); } catch { /* storage blocked */ }
  }

  // Company from the board URL when the page doesn't name it
  // (jobs.lever.co/acme/…, jobs.ashbyhq.com/acme/…, acme.breezy.hr/…).
  function companyFromUrl() {
    const host = location.hostname;
    const first = location.pathname.split('/').filter(Boolean)[0] || '';
    if (/(^|\.)(lever\.co|ashbyhq\.com|greenhouse\.io|smartrecruiters\.com)$/i.test(host)) return first.replace(/[-_]+/g, ' ');
    const sub = host.split('.')[0];
    return /^(www|jobs|careers|apply|boards|job-boards)$/i.test(sub) ? '' : sub.replace(/[-_]+/g, ' ');
  }

  // The posting a page belongs to: its URL without query, fragment and the
  // form/confirmation step (mirrors canonicalPostingUrl on the server).
  function postingKey(href) {
    try {
      const u = new URL(href);
      return (u.origin + u.pathname.replace(/\/+$/, '').replace(/\/(apply|application|thanks|thank-you|confirmation|submitted|success)(\/.*)?$/i, '')).toLowerCase();
    } catch { return href; }
  }

  function rememberApplyContext() {
    if (onRecrutasSite) return;
    const existing = readApplyContext();
    // Keep an unreported context only while it's for this same posting; a form
    // for a different job in the same tab replaces it.
    if (existing && !existing.reported && Date.now() - existing.ts < APPLY_CTX_MAX_AGE_MS
        && postingKey(existing.postingUrl) === postingKey(location.href)) return;
    const h1 = document.querySelector('h1')?.textContent?.trim() || '';
    writeApplyContext({
      postingUrl: location.href,
      title: (h1 || document.title || '').slice(0, 200),
      company: (document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || companyFromUrl() || '').slice(0, 200),
      ts: Date.now(),
      autoFilled: false,
      reported: false,
    });
  }

  function markApplyContextFilled() {
    const ctx = readApplyContext();
    if (ctx) writeApplyContext({ ...ctx, autoFilled: true });
  }

  function visibleFormFieldCount() {
    return deepQueryAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select')
      .filter(el => !el.closest('#recrutas-fill-btn, #recrutas-banner') && (el.offsetParent !== null || el.getClientRects().length > 0))
      .length;
  }

  function looksLikeConfirmation() {
    const text = (document.body?.innerText || '').slice(0, 8000);
    if (!CONFIRM_TEXT_RE.test(text)) return false;
    return CONFIRM_PATH_RE.test(location.pathname) || visibleFormFieldCount() < 2;
  }

  let reporting = false;
  async function checkSubmission() {
    if (onRecrutasSite || reporting) return;
    const ctx = readApplyContext();
    if (!ctx || ctx.reported || Date.now() - ctx.ts > APPLY_CTX_MAX_AGE_MS) return;
    if (!looksLikeConfirmation()) return;
    reporting = true;
    writeApplyContext({ ...ctx, reported: true });
    try {
      const res = await sendMessage({
        type: 'APPLICATION_SUBMITTED',
        postingUrl: ctx.postingUrl,
        title: ctx.title,
        company: ctx.company,
        autoFilled: ctx.autoFilled,
      });
      if (res?.success && !res.duplicate) {
        showBanner(res.tracked
          ? 'Application saved to Recrutas. We’ll tell you if this job is taken down.'
          : 'Application saved to your Recrutas applications.', 'success');
      }
    } catch {
      // Not signed in or offline: allow a retry on the next check.
      writeApplyContext({ ...ctx, reported: false });
    } finally {
      reporting = false;
    }
  }

  // Before applying: warn if this posting is already in the candidate's applications.
  let statusChecked = false;
  async function checkAlreadyApplied() {
    if (onRecrutasSite || statusChecked) return;
    statusChecked = true;
    try {
      const res = await sendMessage({ type: 'APPLICATION_STATUS', url: location.href });
      if (res?.success && res.applied) {
        const when = res.appliedAt ? new Date(res.appliedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'before';
        showBanner(`You already applied to this job on ${when}.`, 'warning');
      }
    } catch { /* not signed in: stay quiet */ }
  }

  // ── SPA-aware injection ────────────────────────────────────────────────────

  function maybeInject() {
    // With all_frames the script runs in every matching frame. In a sub-frame,
    // only float the button if the frame is big enough to host a real
    // application form — keeps a stray fixed button out of tiny tracking /
    // reCAPTCHA iframes that happen to contain an input. (Manual fill via the
    // popup/shortcut still works in any frame; this only gates the button.)
    if (window !== window.top && (window.innerWidth < 320 || window.innerHeight < 320)) {
      return;
    }
    const hasForm = deepQuery('input:not([type="hidden"]), textarea, select');
    if (hasForm) {
      injectButton();
      if (visibleFormFieldCount() >= 2) {
        rememberApplyContext();
        checkAlreadyApplied();
      }
    }
  }

  function debounce(fn, ms) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), ms);
    };
  }

  const debouncedInject = debounce(maybeInject, 300);
  const debouncedSubmissionCheck = debounce(checkSubmission, 800);

  maybeInject();
  checkSubmission();

  const observer = new MutationObserver(() => { debouncedInject(); debouncedSubmissionCheck(); });
  observer.observe(document.body, { childList: true, subtree: true });

  // A form rendered inside a shadow root doesn't trigger the observer above,
  // so keep checking for a little while after load until the button is up.
  let retries = 0;
  const retryInject = setInterval(() => {
    if (document.getElementById('recrutas-fill-btn') || ++retries > 20) { clearInterval(retryInject); return; }
    maybeInject();
  }, 1500);

  window.addEventListener('popstate', () => setTimeout(maybeInject, 500));
  window.addEventListener('hashchange', () => setTimeout(maybeInject, 500));
})();
