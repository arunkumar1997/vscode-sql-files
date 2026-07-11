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

    /* ------------------------------------------------------------------
     * 4. Demo video — click-to-play with cover + play button
     *
     * The <video> has no `autoplay`; instead we render a poster image
     * plus a big amber play button. Clicking anywhere on the overlay
     * plays the video and hides the button. Native controls take over
     * from there (the video element gets `controls` on first play).
     * ------------------------------------------------------------------ */
    (function videoPlay() {
        var frames = document.querySelectorAll('[data-video]');
        frames.forEach(function (frame) {
            var video = frame.querySelector('video');
            var btn = frame.querySelector('[data-video-play]');
            if (!video || !btn) return;

            function play() {
                // Show native controls once the user has opted in.
                video.setAttribute('controls', '');
                frame.classList.add('is-playing');
                var p = video.play();
                if (p && typeof p.catch === 'function') {
                    p.catch(function () {
                        // Playback was blocked — restore the overlay so the user
                        // can try again with the native controls visible.
                        frame.classList.remove('is-playing');
                    });
                }
            }

            btn.addEventListener('click', play);

            // If the video ends, bring the overlay back so users can replay
            // from the cover state.
            video.addEventListener('ended', function () {
                frame.classList.remove('is-playing');
                video.removeAttribute('controls');
                try { video.currentTime = 0; } catch (e) { /* noop */ }
            });
        });
    })();

    /* ------------------------------------------------------------------
     * 5. Theme toggle — dark / light
     *
     * The initial theme is set by an inline <script> in <head> to avoid
     * a flash of the wrong theme. This IIFE only handles user clicks
     * on the toggle button, persists the choice to localStorage, and
     * keeps the <meta name="theme-color"> browser-chrome hint in sync.
     * ------------------------------------------------------------------ */
    (function themeToggle() {
        var btn = document.querySelector('[data-theme-toggle]');
        if (!btn) return;

        var root = document.documentElement;
        var THEME_COLOR_DARK = '#0d1117';
        var THEME_COLOR_LIGHT = '#ffffff';

        function currentTheme() {
            return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
        }

        function syncButton(theme) {
            // The button shows the *destination* theme (i.e. what clicking
            // will switch to), which matches how most sites do it.
            var next = theme === 'dark' ? 'light' : 'dark';
            btn.setAttribute('aria-label', 'Switch to ' + next + ' theme');
            btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
            btn.setAttribute('title', 'Switch to ' + next + ' theme');
        }

        function syncMetaThemeColor(theme) {
            // Update the single unmediated theme-color tag so the browser
            // chrome (address bar on mobile, PWA title bar) follows.
            var metas = document.querySelectorAll('meta[name="theme-color"]');
            var wanted = theme === 'light' ? THEME_COLOR_LIGHT : THEME_COLOR_DARK;
            var updated = false;
            metas.forEach(function (m) {
                if (!m.getAttribute('media')) {
                    m.setAttribute('content', wanted);
                    updated = true;
                }
            });
            if (!updated) {
                var m = document.createElement('meta');
                m.setAttribute('name', 'theme-color');
                m.setAttribute('content', wanted);
                document.head.appendChild(m);
            }
        }

        function apply(theme, persist) {
            root.setAttribute('data-theme', theme);
            syncButton(theme);
            syncMetaThemeColor(theme);
            if (persist) {
                try { localStorage.setItem('fs-theme', theme); }
                catch (e) { /* private mode / disabled storage — silently ignore */ }
            }
        }

        // Initial sync — the head script already set data-theme; align UI to it.
        syncButton(currentTheme());
        syncMetaThemeColor(currentTheme());

        btn.addEventListener('click', function () {
            var next = currentTheme() === 'dark' ? 'light' : 'dark';
            apply(next, true);
        });

        // Follow the OS preference live — but ONLY while the user hasn't
        // made an explicit choice via the toggle. Once they click, their
        // choice is remembered in localStorage and this listener bails.
        if (window.matchMedia) {
            var mql = window.matchMedia('(prefers-color-scheme: light)');
            var handler = function (e) {
                var saved = null;
                try { saved = localStorage.getItem('fs-theme'); }
                catch (err) { /* storage disabled — treat as no choice */ }
                if (saved === 'light' || saved === 'dark') return;
                apply(e.matches ? 'light' : 'dark', false);
            };
            if (typeof mql.addEventListener === 'function') {
                mql.addEventListener('change', handler);
            } else if (typeof mql.addListener === 'function') {
                mql.addListener(handler);
            }
        }
    })();
})();
