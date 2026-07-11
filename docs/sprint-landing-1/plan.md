# Sprint Landing-1 — File SQL Landing Page

**Sprint goal:** Ship a professional, editor-themed landing page for File SQL to GitHub Pages at `https://arunkumar1997.github.io/vscode-sql-files/`.

**Duration:** Single sprint, one PR.
**Producer:** Remy
**Assigned team:** Nova (Frontend) + Milo (Art) — dev team chat
**Sign-off:** Ivy (QA) — QA chat

---

## 1. Context

File SQL launched on Product Hunt on 2026-07-11. The landing page is needed to:

- Convert PH traffic into VS Code Marketplace installs
- Provide a shareable, brandable URL for social posts, DMs, and future launches
- Establish visual identity for the project beyond the Marketplace listing

Concept was approved by CEO after the team consilium. See the consilium notes in this chat's history for full context. Key decisions summarised in Section 3 below.

---

## 2. CEO-approved decisions

| Question | Decision |
|---|---|
| Custom domain | ❌ No — ship on `arunkumar1997.github.io/vscode-sql-files` |
| Demo video | 📼 Placeholder for v1 — CEO will record and swap in later |
| Analytics | ❌ None — matches the extension's "no telemetry" ethos |

---

## 3. Concept summary (locked)

**One-liner:** A dark, mono-typography, VS Code-flavored landing page that a developer trusts in 3 seconds and installs in 10.

### Sections (top → bottom)

| # | Section | Purpose |
|---|---|---|
| 1 | Hero: headline, subhead, fake VS Code window mockup, Install + GitHub CTAs | Convert in 8 seconds |
| 2 | Demo video placeholder (aspect-ratio 16:9, styled empty state) | Reserved for CEO's recording |
| 3 | "Query any file" — grid of format cards (CSV, JSON, Parquet, TSV, S3) | Show breadth |
| 4 | Three killer features — folder→table, S3-native, 100% local | Differentiate |
| 5 | How it works — 3 steps with tiny code snippets | Reduce install anxiety |
| 6 | Install CTA — big Marketplace button + copyable `ext install` command | Convert fence-sitters |
| 7 | Footer — GitHub · Marketplace · PH badge · MIT · maker credit · "Powered by DuckDB" pill | Trust signals |

### Visual system

- **Background:** `#0d1117` (GitHub dark)
- **Surface:** `#161b22`
- **Text:** `#e6edf3` primary, `#7d8590` muted
- **Accent (owned by File SQL):** amber pulled from the extension icon at `media/icon.png` — Milo to sample the exact hex
- **DuckDB yellow (`#FFF000`):** **only** in the "Powered by DuckDB" credit pill in the footer — never in headlines or CTAs
- **Fonts:** JetBrains Mono (headlines + code) via CDN, Inter (body) via CDN
- **Motion:** hero typewriter effect, subtle hover lift on format cards, nothing else

### Tech constraints

- Plain `index.html` + `styles.css` + `main.js`
- **No build step, no npm, no framework**
- Total page weight ≤ 30 KB gzipped (fonts loaded from CDN don't count)
- Fully functional with JavaScript disabled (typewriter degrades to static text; copy button falls back to selectable `<input>`)
- Zero cookies, zero analytics, zero third-party trackers

### Explicit non-goals (do not build)

- ❌ Blog, docs site, or pricing page
- ❌ In-browser SQL playground (parked as future sprint)
- ❌ Email signup, contact form, or newsletter
- ❌ Cookie banner (nothing to consent to)
- ❌ Dark/light mode toggle (dark only for v1)

---

## 4. File layout

```
/site/                          ← Landing page source (deployed to GH Pages)
  index.html
  styles.css
  main.js
  assets/
    icon.svg                    ← File SQL logo (copy or re-export from media/icon.png)
    og-image.png                ← Open Graph preview (1200×630)
    favicon.ico
    favicon.svg

/.github/workflows/
  deploy-landing.yml            ← Deploys /site to GitHub Pages on push to main

/docs/                          ← Internal planning docs (already exists, DO NOT publish)
  feedback/
  sprint-landing-1/
    plan.md                     ← This file
    progress.md                 ← Dev team updates this during the sprint
    done.md                     ← Written at sprint end
```

---

## 5. Task breakdown

Priority order — do them top-down. Each has a definition of done.

### T1 — Repo scaffolding & GitHub Pages setup

- [ ] Create `/site/` folder with empty `index.html`, `styles.css`, `main.js`
- [ ] Create `.github/workflows/deploy-landing.yml` — deploys `/site` to Pages on push to `main` when files under `/site/**` change
- [ ] In repo Settings → Pages, set source to "GitHub Actions"
- [ ] Verify a "Hello File SQL" placeholder deploys successfully to `arunkumar1997.github.io/vscode-sql-files/`
- **Owner:** Nova

### T2 — Design tokens & base styles

- [ ] Extract the exact accent amber hex from `media/icon.png` (Milo)
- [ ] Define CSS custom properties in `:root` — colors, spacing scale, font sizes, radii
- [ ] Import JetBrains Mono + Inter from a reliable CDN (Google Fonts or bunny.net) with `preconnect` hints
- [ ] Global reset, `body` typography, focus-ring style, subtle graph-paper background pattern (CSS gradient — no image)
- **Owner:** Milo (tokens) + Nova (CSS implementation)

### T3 — Hero section

- [ ] Headline: 6–8 words, mono font, large. Suggested: **"SQL for your files. Inside VS Code."**
- [ ] Subhead: 1 sentence, muted color. Suggested: **"Right-click a CSV, JSON, Parquet, or S3 file — get a queryable SQL table. Powered by DuckDB."**
- [ ] Two CTAs: primary "Install for VS Code" (Marketplace deep-link) + secondary "View on GitHub"
- [ ] Fake VS Code window mockup — pure CSS/HTML, not an image. Traffic-light buttons, tab labeled "sales.parquet", editor showing a short SQL query, results grid below with 3–4 rows of sample data
- [ ] Typewriter effect on the SQL inside the mockup (JS, degrades gracefully to static)
- **Owner:** Nova (structure + JS) + Milo (visual polish)

### T4 — Demo video placeholder

- [ ] 16:9 aspect-ratio container, styled as an empty state with a "▶ Demo video coming soon" message
- [ ] Marked in a code comment as `<!-- REPLACE: swap for <video src="assets/demo.mp4"> when CEO delivers the recording -->`
- **Owner:** Nova

### T5 — "Query any file" format grid

- [ ] Responsive grid (3 columns desktop, 2 tablet, 1 mobile)
- [ ] One card per format: CSV, JSON, Parquet, TSV, JSONL, S3
- [ ] Each card: format icon (inline SVG), format name, one-line description
- [ ] Subtle hover lift (transform + box-shadow), 150ms transition
- **Owner:** Milo (icons + copy) + Nova (grid)

### T6 — Three killer features section

- [ ] Three-column layout (stacks on mobile)
- [ ] Features:
  1. **Folder = Table.** Point at a folder or S3 prefix. Each subfolder becomes its own table automatically.
  2. **S3-native.** Auto-detected regions, AWS profile support, streams files to a local temp dir. Never leaves your control.
  3. **100% local.** No accounts, no cloud, no telemetry. Your data stays on your machine.
- [ ] Each feature: icon, heading, 2-line description
- **Owner:** Milo (copy + icons) + Nova (layout)

### T7 — How it works (3 steps)

- [ ] Three numbered steps, each with a tiny code snippet or UI hint:
  1. **Install** — `code --install-extension file-sql`
  2. **Load a file** — right-click any file in Explorer → "Open with File SQL"
  3. **Query** — write SQL, press `Ctrl+Enter`
- [ ] Code snippets in mono font, dark surface, subtle border
- **Owner:** Nova

### T8 — Install CTA section

- [ ] Large centered "Install File SQL" button linking to the Marketplace
- [ ] Below: copyable `ext install file-sql` command with a copy-to-clipboard icon button (JS)
- [ ] Fallback for JS-disabled: `<input readonly value="ext install file-sql">` that users can select manually
- **Owner:** Nova

### T9 — Footer

- [ ] Links: GitHub · VS Code Marketplace · Product Hunt page · License (MIT)
- [ ] Maker credit: "Built by @arunkumar1997"
- [ ] "Powered by DuckDB" pill (only place DuckDB yellow appears)
- [ ] Copyright line: `© 2026 File SQL`
- **Owner:** Milo (copy) + Nova (layout)

### T10 — Meta tags & social sharing

- [ ] `<title>`: "File SQL — Query files with SQL, inside VS Code"
- [ ] `<meta name="description">`: single sentence, ≤160 chars
- [ ] Open Graph tags: `og:title`, `og:description`, `og:image` (1200×630), `og:url`, `og:type=website`
- [ ] Twitter card: `twitter:card=summary_large_image`, `twitter:title`, `twitter:description`, `twitter:image`
- [ ] Favicon: SVG + ICO
- [ ] `og-image.png` — Milo to design (1200×630, matches page visual system)
- **Owner:** Milo (og image) + Nova (meta tags)

### T11 — Responsive & accessibility pass

- [ ] Works down to 320px width — no horizontal scroll
- [ ] All interactive elements keyboard-navigable with visible focus ring
- [ ] All images have `alt` attributes; icon-only buttons have `aria-label`
- [ ] Color contrast ≥ 4.5:1 on all text (verify with a contrast checker)
- [ ] `prefers-reduced-motion` respected — disables typewriter and hover animations
- **Owner:** Nova + Ivy (QA verification)

---

## 6. Success criteria

Sprint is done when **all of these are true**:

- [ ] Page is live at `https://arunkumar1997.github.io/vscode-sql-files/`
- [ ] Lighthouse mobile scores: Performance ≥ 95, Accessibility = 100, Best Practices = 100, SEO = 100
- [ ] Page renders correctly with JavaScript disabled (test in Firefox with JS off)
- [ ] Page works and looks correct at 320px, 768px, 1024px, and 1440px widths
- [ ] Works in latest Chrome, Firefox, and Safari
- [ ] All CTAs go to correct URLs (Marketplace + GitHub)
- [ ] Sharing the URL on Twitter/LinkedIn/Slack shows a proper OG preview
- [ ] Total page weight ≤ 30 KB gzipped (excluding CDN fonts)
- [ ] Zero console errors or 404s
- [ ] QA sign-off from Ivy — see `docs/sprint-landing-1/qa-signoff.md`
- [ ] README updated with a "🌐 Landing page" link near the top

---

## 7. Out of scope (do NOT build)

Reject if requested during the sprint. File as a follow-up if valuable:

- Playground / in-browser SQL editor
- Dark/light mode toggle
- Multi-language / i18n
- Blog, changelog, or docs pages
- Testimonials or case studies (nothing to quote yet)
- Sign-up form, email capture, contact form
- Cookie banner
- Custom domain / DNS setup
- Analytics of any kind
- A/B testing framework

---

## 8. Handoff to QA (Ivy)

When dev team pushes their PR, Ivy runs the checklist in Section 6. If any fail, Ivy files GitHub Issues with the `landing-page` + `bug` labels and blocks the merge. If all pass, Ivy writes `docs/sprint-landing-1/qa-signoff.md` and comments "QA ✅" on the PR.

---

## 9. Post-merge tasks (Remy)

- [ ] Merge PR to `main` (regular merge, never squash/rebase)
- [ ] Verify GH Pages deploy succeeded
- [ ] Post the landing page URL on the Product Hunt thread as an update comment
- [ ] Add the URL to LinkedIn profile featured section
- [ ] Update `README.md` header with a live link
- [ ] Write `docs/sprint-landing-1/done.md`
- [ ] Update `PROJECT_BRIEF.md` sections 7+8 (when brief exists)

---

## 10. Agent prompt for the dev team chat

Copy-paste this into a fresh `@ai-team-dev` chat:

> Read `docs/sprint-landing-1/plan.md`. You are the File SQL landing page dev team.
>
> **Nova (Frontend):** you own structure, JS, responsive behaviour, accessibility, and the GH Pages workflow.
> **Milo (Art):** you own the visual system, colors, typography, icons, copy polish, and the OG image.
>
> Start with: `git pull origin main && git checkout -b feature/landing-1`
>
> Work through the tasks in Section 5 in order. Update `docs/sprint-landing-1/progress.md` after each completed task. Take your time — do it right, not fast. This is the public face of the product.
>
> Every commit message should reference the task number, e.g. `feat(landing): T3 hero section with typewriter mockup`.
>
> Constraints (non-negotiable): plain HTML/CSS/JS only, no build step, no framework, no npm dependencies added to the extension's package.json. If you need JetBrains Mono or Inter, load from CDN.
>
> When all tasks in Section 5 are done and all success criteria in Section 6 are met, push and create the PR: `git push origin feature/landing-1`. Tag it `landing-page` and request review from Remy. Do not merge yourself.
