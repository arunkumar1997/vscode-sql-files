# Product Hunt Launch — Feedback Log

**Launch date:** 2026-07-11 (12:01 AM PDT / 12:31 PM IST)
**Source:** https://www.producthunt.com/products/file-sql

Feedback captured from the launch day and beyond. Each item should be triaged to a GitHub Issue with a link back here.

---

## Legend

| Status | Meaning |
|---|---|
| 🆕 New | Just captured, not yet triaged |
| 📋 Filed | GitHub Issue created |
| 🚧 In progress | Being worked on |
| ✅ Shipped | Released in a version |
| ❌ Won't do | Out of scope, with reason |

---

## Feedback

### FB-001 — Shareable per-project setup for teams

- **Status:** 🆕 New
- **Captured:** 2026-07-11
- **Source:** Product Hunt launch comment
- **Reporter:** _(PH username — fill in)_
- **Type:** Feature request
- **Priority:** High (validates a real team workflow gap)

**What they said**

> Love this, being able to right-click a Parquet file and query it right in VS Code saves so much context switching. One thing that would make it even better: add a way to persist and share connection configs and saved queries per project, so my whole team can run the same SQL against the same folder structure without each person setting it up from scratch.

**The underlying need**

Teams currently have to re-register the same tables/folders manually on every machine. There's no way to share table setups or saved queries across a team via git. This blocks File SQL from moving from a solo tool to a team-standard tool.

**Rough solution shape (for the eventual GitHub Issue)**

- Workspace-level config file at the repo root (format TBD — JSON / YAML / TOML)
- Lists tables: name, path/URI, format hints, optional AWS profile + region per table
- A `.filesql/queries/*.sql` folder for saved queries that ships with the repo
- On workspace open, extension auto-loads the tables and surfaces saved queries in the sidebar
- Fully checkable into git, reviewable in PRs, no per-person setup

**Open questions to resolve before scoping**

- Config file format: JSON vs YAML vs TOML
- AWS profile/region: per-workspace or per-table?
- Portability: how to handle relative vs absolute paths across machines
- Precedence when workspace config conflicts with user settings
- Should saved queries appear in the sidebar tree, or only in the query editor tab list?

**Public reply posted on PH**

> Thanks for the feedback! Yeah, this is a really good point. Team setup so everyone runs the same SQL on the same folders is definitely where this needs to go next. Adding it to the roadmap.

**Next actions**

- [ ] File as GitHub Issue with `enhancement` + `roadmap` labels
- [ ] Link the Issue back to this entry
- [ ] Post the Issue link as a follow-up reply on the PH comment thread
- [ ] Consider for Sprint 2 (post-landing-page sprint)

---
