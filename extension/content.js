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
    let node = el.parentElement;
    while (node && node.tagName !== 'FORM') {
      if (node.tagName === 'LABEL') return node.textContent?.trim() || '';
      node = node.parentElement;
    }
    const prev = el.previousElementSibling;
    if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'P')) {
      return prev.textContent?.trim() || '';
    }
    return '';
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

      // Allow visually-hidden inputs (React Select, comboboxes use opacity:0 / position:absolute)
      const isFileInput = el.type === 'file';
      const isReactSelect = el.getAttribute('role') === 'combobox' ||
        el.closest('[class*="select"], [class*="Select"], [class*="combobox"]');
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

      if (type === 'checkbox' || type === 'radio') {
        field.type = type;
      }

      fields.push(field);
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
        label: getLabelText(el) || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
          ? document.getElementById(el.getAttribute('aria-labelledby'))?.textContent?.trim() || '' : '',
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

  // ACTION: click_then_type
  async function executeClickThenType(el, value) {
    const timeoutMs = 5000;
    
    try {
      await withTimeout((async () => {
        el.focus();
        el.click();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        await sleep(350);

        const searchInput = el.closest('[class*="select"], [class*="dropdown"], [class*="combobox"], [role="combobox"], [role="listbox"]')
          ?.querySelector('input[type="text"], input:not([type])')
          || el;

        if (searchInput) {
          setNativeValue(searchInput, value);
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
        }

        await sleep(400);

        const valueLower = value.toLowerCase();
        const optionSelectors = [
          '[role="option"]',
          '[class*="option"]',
          '[class*="menu-item"]',
          '[class*="listbox"] li',
          '[class*="dropdown"] li',
          'li[data-value]',
          '.select__option',
          '.react-select__option',
        ];

        for (const selector of optionSelectors) {
          const options = document.querySelectorAll(selector);
          for (const opt of options) {
            const text = opt.textContent?.trim().toLowerCase() || '';
            if (text === valueLower || text.includes(valueLower) || valueLower.includes(text)) {
              opt.click();
              opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              opt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              highlightFilled(el);
              return true;
            }
          }
        }

        // Last resort: press Enter and hope the first suggestion was selected
        searchInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        await sleep(200);

        // Check if value actually changed — if not, this failed
        const currentValue = (searchInput || el).value || el.textContent?.trim() || '';
        if (currentValue && currentValue.toLowerCase().includes(valueLower.substring(0, 3))) {
          highlightFilled(el);
          return true;
        }

        highlightFailed(el);
        return false;
      })(), timeoutMs, 'Dropdown selection timed out');
    } catch (err) {
      console.debug('[Recrutas] click_then_type failed:', err.message);
      highlightFailed(el);
      return false;
    }
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

    for (const action of actions) {
      if (action.action === 'skip') continue;

      const el = findElement(action.fieldId);
      if (!el) {
        failed.push(action.fieldId);
        console.debug(`[Recrutas] Element not found: ${action.fieldId}`);
        continue;
      }

      let success = false;

      // Try up to 2 times
      for (let attempt = 0; attempt < 2 && !success; attempt++) {
        if (attempt > 0) await sleep(300);

        switch (action.action) {
          case 'type':
            success = executeType(el, action.value || '');
            break;
          case 'select':
            success = executeSelect(el, action.value || '');
            break;
          case 'click_then_type':
            success = await executeClickThenType(el, action.value || '');
            break;
          case 'check':
            success = executeCheck(el);
            break;
          case 'upload_resume':
            success = await executeUploadResume(el, resumeUrl);
            break;
          case 'click_option':
            // For custom dropdowns (role="listbox") — click the container, then click matching option
            success = await executeClickThenType(el, action.value || '');
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

  async function triggerFill() {
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

    btn.addEventListener('click', triggerFill);
    document.body.appendChild(btn);
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
