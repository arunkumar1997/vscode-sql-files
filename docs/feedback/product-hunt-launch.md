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

### FB-002 — Query large Parquet files on S3 without downloading the whole thing

- **Status:** 🆕 New
- **Captured:** 2026-07-11
- **Source:** Product Hunt launch comment
- **Reporter:** _(PH username — fill in)_
- **Type:** Architecture / Performance
- **Priority:** High (blocks File SQL from being usable on large S3 datasets)

**What they said**

> How does this handle really large parquet files on S3 without downloading the whole thing first?

**Current behaviour**

File SQL uses a **download-first** architecture: S3 files are streamed to a local temp directory, then read by DuckDB. For a large Parquet file (say 10 GB), the user pays the full download cost before the first row is returned. This defeats one of Parquet's core value propositions — being cheap to query selectively.

**The underlying need**

Users querying large S3 Parquet datasets need Parquet's native benefits:
- **Projection pushdown** — only the columns in `SELECT` are read
- **Predicate pushdown** — only the row groups matching `WHERE` are read
- **Range reads over HTTPS** — no full download, no local temp copy

**Rough solution shape**

- Adopt DuckDB's `httpfs` extension for S3 access instead of the current pre-download flow
- Configure `httpfs` to use the same AWS credentials + region resolution we already have
- Query S3 URIs directly: `read_parquet('s3://bucket/file.parquet')` becomes a range-read
- Fall back to download-first for formats where streaming doesn't help (small CSV, JSON that must be fully parsed)

**Open questions to resolve before scoping**

- Which formats benefit from `httpfs` streaming (Parquet: big win; CSV/JSON: mixed)
- How to keep AWS credential resolution consistent between `httpfs` and our current profile-based flow
- Caching strategy — do we still cache anything locally, or fully stateless?
- How to handle intermittent network errors mid-query (retry vs abort)
- Impact on the "temp file cleanup on deactivate" logic currently in `s3Handler.ts`
- Does `httpfs` respect `s3:GetBucketLocation` for auto region detection, or do we lose that?

**Public reply posted on PH**

> Honest answer — right now it downloads the file first, then queries locally. So for a big Parquet on S3, you'd pay the full download cost. Moving to DuckDB's httpfs extension (range-reads + column/predicate pushdown, no full download) is definitely the next step. Adding it to the roadmap.

**Next actions**

- [ ] File as GitHub Issue with `enhancement`, `roadmap`, `architecture` labels
- [ ] Link the Issue back to this entry
- [ ] Post the Issue link as a follow-up reply on the PH comment thread
- [ ] Prioritise for Sprint 2 or Sprint 3 — likely higher priority than FB-001 because it affects real-world usability on large datasets
- [ ] Consider updating README to clarify current S3 behaviour so users aren't surprised (transparency > silent limitation)

---
