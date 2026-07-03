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

  // Prevent double-injection on SPAs
  if (window.__recruitasInjected) {
    triggerFill();
    return;
  }
  window.__recruitasInjected = true;

  // ── Native value setter (React/Angular/Vue compatible) ─────────────────────

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT'
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── Label text resolver ────────────────────────────────────────────────────

  function getLabelText(el) {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent?.trim() || '';
    }
    // aria-labelledby → resolve the referenced element(s) and join their text.
    const labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledby) {
      const txt = labelledby.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim() || '')
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
    const elements = document.querySelectorAll('input, textarea, select');

    for (const el of elements) {
      const type = (el.type || el.tagName.toLowerCase()).toLowerCase();

      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
      if (el.readOnly || el.disabled) continue;
      // Radios are collected as grouped fields (one per name) further down, so
      // the model sees the question + all options instead of N disconnected inputs.
      if (type === 'radio') continue;

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

      const field = {
        id: fieldId,
        type: type,
        label: getLabelText(el) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
        name: el.getAttribute('name') || '',
        required: el.required || el.getAttribute('aria-required') === 'true',
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
    for (const r of document.querySelectorAll('input[type="radio"]')) {
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
      const groupLabel =
        (fieldset?.querySelector(':scope > legend')?.textContent?.trim()) ||
        first.getAttribute('aria-label') ||
        (first.getAttribute('aria-labelledby')
          ? document.getElementById(first.getAttribute('aria-labelledby'))?.textContent?.trim() || ''
          : '') ||
        getLabelText(first);
      fields.push({
        id: key,
        type: 'radio',
        label: groupLabel || '',
        name: group.name,
        required: group.radios.some(r => r.required || r.getAttribute('aria-required') === 'true'),
        options: options.length > 0 ? options : undefined,
      });
    }

    // Custom dropdown elements (Workday, iCIMS, Taleo use div[role="listbox"] instead of <select>)
    const customDropdowns = document.querySelectorAll(
      '[role="listbox"], [role="combobox"], [data-automation-id*="select"], [data-automation-id*="dropdown"]'
    );
    for (const el of customDropdowns) {
      // Skip if we already captured a child input from this container
      if (el.querySelector('input, select') &&
          Array.from(el.querySelectorAll('input, select')).some(child => seen.has(child.id || child.name))) {
        continue;
      }

      const fieldId = el.id || el.getAttribute('data-automation-id') || `recrutas_custom_${fields.length}`;
      if (seen.has(fieldId)) continue;
      seen.add(fieldId);

      const options = Array.from(el.querySelectorAll('[role="option"], li, [data-value]'))
        .map(opt => opt.textContent?.trim())
        .filter(Boolean);

      fields.push({
        id: fieldId,
        type: 'custom_select',
        label: getLabelText(el) || el.getAttribute('aria-label') || '',
        name: '',
        required: el.getAttribute('aria-required') === 'true',
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
      || document.querySelector(`[name="${CSS.escape(fieldId)}"]`)
      || document.querySelector(`[id="${CSS.escape(fieldId)}"]`);
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
    setNativeValue(el, value);
    el.blur();
    highlightFilled(el);
    return true;
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
      if (fuzzy) {
        setNativeValue(el, fuzzy.value);
        highlightFilled(el);
        return true;
      }
      return false;
    }

    setNativeValue(el, option.value);
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
    const nodes = document.querySelectorAll(
      '.select__menu .select__option, [class*="menu-list"] [class*="option"], [class*="select__menu"] [role="option"], [role="listbox"]:not([class*="iti__"]) [role="option"], [class*="MenuList"] [role="option"]'
    );
    return Array.from(nodes).filter(o =>
      !o.className?.toString().includes('iti__') &&
      !o.closest('[class*="iti__"], .iti, [class*="intl-tel"]') &&
      (o.offsetParent !== null || o.getClientRects().length > 0)
    );
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
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
  async function attemptDropdown(el, container, searchInput, wanted, isDecline, isAffirm) {
    const txt = o => (o.textContent || '').trim().toLowerCase();
    // When the desired value is a word (e.g. "United States"), never accept a bare
    // dial-code option ("+1") — that's the phone widget leaking in.
    const wantNumeric = isDialCode(wanted);
    const matchInMenu = () => {
      const opts = visibleOptionNodes().filter(o => wantNumeric || !isDialCode(txt(o)));
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
    const opt = await waitFor(matchInMenu, 1000, 120);
    if (opt) {
      clickOption(opt);
    } else {
      sendKey(searchInput, 'ArrowDown', 40);
      await sleep(100);
      sendKey(searchInput, 'Enter', 13);
    }
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
  async function selectDropdownOption(el, value) {
    const container = dropdownContainer(el);
    const wanted = value.trim().toLowerCase();
    const isDecline = DECLINE_RE.test(wanted);
    const isAffirm = !isDecline && AFFIRM_RE.test(wanted);
    const searchInput = container.querySelector('input[role="combobox"], input[type="text"], input:not([type])') || el;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(250);
      if (committedValue(container, el)) return true;
      if (await attemptDropdown(el, container, searchInput, wanted, isDecline, isAffirm)) return true;
    }
    return false;
  }

  // ACTION: click_then_type. A multi-select value is sent as a pipe-delimited list
  // ("New York | Remote") so we can select each option without colliding with the
  // commas inside "City, State" option labels.
  async function executeClickThenType(el, value) {
    const parts = value.includes('|')
      ? value.split('|').map(s => s.trim()).filter(Boolean)
      : [value];

    let anySuccess = false;
    try {
      for (const part of parts) {
        const ok = await withTimeout(
          selectDropdownOption(el, part),
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
      ? Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`))
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

        // Radio groups: whatever action the model emitted (select / radio /
        // click_then_type), selecting the matching option is the only sane fill.
        if (el.type === 'radio') {
          success = executeRadio(el, action.value || '');
          continue;
        }

        // Combobox/react-select: route to the dropdown driver regardless of the
        // model's action, honouring the same time budget as click_then_type.
        if (elIsCombobox) {
          if (Date.now() > dropdownDeadline) { success = false; break; }
          success = await executeClickThenType(el, action.value || '');
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
              success = await executeClickThenType(el, action.value || '');
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

    setTimeout(() => banner.remove(), 5000);
  }

  // ── Main fill trigger ──────────────────────────────────────────────────────

  // Re-entry guard: the button is wired via BOTH a direct listener and a
  // document-level delegated listener (see injectButton / the capture-phase
  // handler below), so a single click can reach triggerFill twice. This flag
  // collapses that to one run.
  let isFilling = false;

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

      if (fields.length === 0) {
        showBanner('No form fields found on this page', 'warning');
        return;
      }

      const jobContext = extractJobContext();

      if (btn) btn.textContent = 'AI filling…';

      // Guard against a lost response (e.g. the MV3 service worker being
      // terminated mid-request): without this the button stays on "AI filling…"
      // forever. Slightly longer than the background fetch's own 60s abort so
      // that, when it's the network stalling, the background's clearer error wins.
      const response = await withTimeout(
        sendMessage({
          type: 'FILL_FORM_AI',
          fields,
          jobContext: jobContext.text,
        }),
        65000,
        'Form fill timed out — please try again.'
      );

      if (!response) {
        // Defensive: a dropped/undefined background reply must not surface as a
        // cryptic "undefined has no properties" — give an actionable message.
        throw new Error('No response from the extension. Please reload the page and try again.');
      }

      if (!response.success) {
        throw new Error(response.error || 'AI fill failed');
      }

      const { actions, resumeUrl } = response;

      if (!actions || actions.length === 0) {
        showBanner('AI could not determine how to fill this form', 'warning');
        return;
      }

      if (btn) btn.textContent = `Filling ${actions.length} fields…`;

      const { filled, failed } = await executeActions(actions, resumeUrl);

      // Report stats + telemetry to background
      sendMessage({
        type: 'FILL_COMPLETE',
        fieldsFilled: filled,
        failedFields: failed,
        atsType: jobContext.atsType,
        success: filled > 0,
      }).catch(() => {});

      if (filled === 0) {
        showBanner('Could not fill any fields — try a different page', 'warning');
      } else if (failed.length > 0) {
        showBanner(`Filled ${filled} field${filled !== 1 ? 's' : ''} · ${failed.length} skipped — review before submitting`, 'success');
      } else {
        showBanner(`Filled ${filled} field${filled !== 1 ? 's' : ''} — review before submitting`, 'success');
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
        showBanner(err.message || 'Extension error — try reloading', 'error');
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
    const hasForm = document.querySelector('input:not([type="hidden"]), textarea, select');
    if (hasForm) {
      injectButton();
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

  maybeInject();

  const observer = new MutationObserver(() => debouncedInject());
  observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('popstate', () => setTimeout(maybeInject, 500));
  window.addEventListener('hashchange', () => setTimeout(maybeInject, 500));
})();
