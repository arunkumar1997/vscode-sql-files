/* File SQL landing — behaviour
 *
 * Everything here is progressive-enhancement.
 * If JS is disabled or fails:
 *   - the mockup SQL renders statically (server-rendered spans)
 *   - the copy field falls back to a selectable <input readonly>
 *   - the header still works, just without the on-scroll shadow
 */
(function () {
  'use strict';

  var prefersReducedMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------------
   * 1. Sticky-header shadow on scroll
   * ------------------------------------------------------------------ */
  (function stickyHeader() {
    var header = document.querySelector('.site-header');
    if (!header) return;

    var ticking = false;
    function update() {
      ticking = false;
      if (window.scrollY > 4) {
        header.classList.add('is-stuck');
      } else {
        header.classList.remove('is-stuck');
      }
    }
    function onScroll() {
      if (!ticking) {
        window.requestAnimationFrame(update);
        ticking = true;
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    update();
  })();

  /* ------------------------------------------------------------------
   * 2. Hero mockup — typewriter effect
   *
   * The <code id="typewriter"> element is server-rendered with the
   * full syntax-highlighted SQL. We snapshot the highlighted HTML,
   * temporarily blank the element, and re-type it character by
   * character while preserving span boundaries.
   *
   * If prefers-reduced-motion is set, we skip the animation entirely
   * and leave the pre-rendered content in place.
   * ------------------------------------------------------------------ */
  (function typewriter() {
    var el = document.getElementById('typewriter');
    if (!el) return;
    if (prefersReducedMotion) return;

    // Grab the fully-highlighted HTML, then convert it to a linear
    // "instruction stream" of tokens so we can re-emit char-by-char.
    var html = el.innerHTML;
    // Split into runs of tag / text so we can walk them.
    var parts = html.match(/(<[^>]+>)|([^<]+)/g) || [];

    // Total plain-text length to schedule the animation.
    var totalChars = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i][0] !== '<') totalChars += parts[i].length;
    }
    if (totalChars === 0) return;

    // Target duration ≈ 2.4s regardless of length.
    var perChar = Math.max(10, Math.min(45, Math.round(2400 / totalChars)));

    el.innerHTML = '';
    var codeEl = el.parentElement; // the <pre class="code">
    if (codeEl) codeEl.classList.add('typewriter-active');

    var idx = 0;      // index into parts
    var charIdx = 0;  // index into the current text run
    var buffer = '';  // accumulated HTML so far

    function tick() {
      if (idx >= parts.length) {
        if (codeEl) codeEl.classList.remove('typewriter-active');
        return;
      }
      var part = parts[idx];
      if (part[0] === '<') {
        // Emit tags whole.
        buffer += part;
        idx++;
        el.innerHTML = buffer;
        // Schedule next microtick immediately for tags.
        window.setTimeout(tick, 0);
        return;
      }
      // Text run — emit one character.
      buffer += part.charAt(charIdx);
      charIdx++;
      el.innerHTML = buffer;
      if (charIdx >= part.length) {
        idx++;
        charIdx = 0;
      }
      window.setTimeout(tick, perChar);
    }

    // Kick off after a short beat so users see the "before" state.
    window.setTimeout(tick, 350);
  })();

  /* ------------------------------------------------------------------
   * 3. Copy-to-clipboard for the install command
   * ------------------------------------------------------------------ */
  (function copyButton() {
    var container = document.querySelector('[data-copy]');
    if (!container) return;
    var input = container.querySelector('.copy-input');
    var btn = container.querySelector('[data-copy-btn]');
    var status = container.querySelector('[data-copy-status]');
    if (!input || !btn) return;

    var resetTimer = null;

    function announce(msg) {
      if (status) status.textContent = msg;
    }

    function reset() {
      btn.classList.remove('is-copied');
      var label = btn.querySelector('.copy-label-text');
      if (label) label.textContent = 'Copy';
      announce('');
    }

    function markCopied() {
      btn.classList.add('is-copied');
      var label = btn.querySelector('.copy-label-text');
      if (label) label.textContent = 'Copied';
      announce('Copied to clipboard.');
      if (resetTimer) window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(reset, 2200);
    }

    function fallbackCopy() {
      try {
        input.focus();
        input.select();
        input.setSelectionRange(0, input.value.length);
        var ok = document.execCommand && document.execCommand('copy');
        if (ok) markCopied();
        else announce('Press Ctrl/Cmd+C to copy.');
      } catch (err) {
        announce('Press Ctrl/Cmd+C to copy.');
      }
    }

    btn.addEventListener('click', function () {
      var text = input.value;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(markCopied, fallbackCopy);
      } else {
        fallbackCopy();
      }
    });
  })();
})();
