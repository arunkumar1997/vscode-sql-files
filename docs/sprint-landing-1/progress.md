# Sprint Landing-1 — Progress Log

The dev team updates this file after each completed task. Enables recovery if the chat overflows.

**Status:** 🟡 In progress
**Branch:** `feature/landing-1`
**PR:** _(link when open)_

---

## Task tracker

| # | Task | Owner | Status | Notes |
|---|------|-------|--------|-------|
| T1 | Repo scaffolding & GitHub Pages setup | Nova | ✅ Done | `site/` scaffolded, `deploy-landing.yml` workflow added. Manual step required: Settings → Pages → Source = "GitHub Actions" (Remy). |
| T2 | Design tokens & base styles | Milo + Nova | ⬜ Not started | |
| T3 | Hero section | Nova + Milo | ⬜ Not started | |
| T4 | Demo video placeholder | Nova | ⬜ Not started | |
| T5 | "Query any file" format grid | Milo + Nova | ⬜ Not started | |
| T6 | Three killer features section | Milo + Nova | ⬜ Not started | |
| T7 | How it works (3 steps) | Nova | ⬜ Not started | |
| T8 | Install CTA section | Nova | ⬜ Not started | |
| T9 | Footer | Milo + Nova | ⬜ Not started | |
| T10 | Meta tags & social sharing | Milo + Nova | ⬜ Not started | |
| T11 | Responsive & accessibility pass | Nova + Ivy | ⬜ Not started | |

Status legend: ⬜ Not started · 🟡 In progress · ✅ Done · 🚧 Blocked

---

## Log

_(append newest-first — timestamp + who + what)_

- **2026-07-11, Nova:** T1 complete. Created `site/{index.html,styles.css,main.js,assets/}` with a "Hello, File SQL" placeholder. Added `.github/workflows/deploy-landing.yml` that deploys `site/` to GitHub Pages on push to `main` when files under `site/**` (or the workflow itself) change. Uses `actions/configure-pages@v5`, `actions/upload-pages-artifact@v3`, `actions/deploy-pages@v4`. Manual step for Remy: repo Settings → Pages → Source = "GitHub Actions". Verified locally: workflow YAML valid, placeholder loads.
- **2026-07-11, Milo:** Sampled `media/file-sql-icon.png` (note: plan referenced `media/icon.png` — actual file is `file-sql-icon.png`). The icon's dominant accent is a bright yellow SQL pill (visually near-DuckDB-yellow). Since the plan explicitly reserves `#FFF000` for the footer credit pill only, I picked a warm amber `#FFB454` as the File-SQL-owned accent — clearly distinct from DuckDB yellow, warm/orange-leaning, and lands at ~9.3:1 contrast on the `#0d1117` background. Locked in as `--accent`.
- **2026-07-11, Remy:** Sprint plan written and committed. Awaiting dev team pickup.

---

## Blockers

_(list anything preventing progress — Remy resolves)_

- None yet.

---

## Decisions made during the sprint

_(record any judgement calls the dev team makes that aren't in the plan)_

- **Amber accent:** `#FFB454` (Milo). Plan called for sampling amber from the icon, but the icon's yellow is essentially DuckDB yellow, which the plan reserves for the footer pill only. `#FFB454` is a warm amber that reads distinctly from `#FFF000` while staying within the icon's warm palette.
- **Icon filename:** plan referenced `media/icon.png`; actual file is `media/file-sql-icon.png`. Used the actual path.
- **Pages source:** workflow uses the modern `actions/deploy-pages@v4` flow (requires "GitHub Actions" as the Pages source in repo settings). Flagged for Remy to set once.
