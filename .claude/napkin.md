# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Shell & Command Reliability (Highest Priority)
1. **[2026-06-09] Bash tool ≠ PowerShell: no `@'...'@` here-strings**
   This env has both shells. PowerShell here-string syntax passed to the Bash
   tool injects a literal `@` (mangled a commit subject into `@\n<subject>`).
   Do instead: in the Bash tool, write multi-line text (commit messages, etc.)
   with a POSIX heredoc to a temp file then `git commit -F /tmp/msg.txt`. Use
   `@'...'@` only in the PowerShell tool.
2. **[2026-06-09] Verify commit subject after multi-line `-m`**
   Do instead: after committing, run `git log -1 --format=%B | head -3` and fix
   with `git commit --amend -F file` if the subject is wrong.

## Workflow / Multi-Agent Orchestration
1. **[2026-06-09] `args` can arrive as a JSON string, not an array**
   A Workflow launched with an array `args` failed with
   `pipeline() expects an array`. Do instead: guard at the top of the script —
   `if (typeof args==='string') { try { args=JSON.parse(args) } catch {...} }`
   then `if (!Array.isArray(args)) args=[]`.
2. **[2026-06-09] Don't trust a synthesis agent's aggregate counts**
   The index agent miscounted totals (said 47 files/322 findings; real 55/359)
   and dropped a row. Do instead: treat per-file structured outputs as source
   of truth; recompute aggregates with a script (sum the table columns; diff
   `find docs -name '*.md'` vs the links in the index) and fix the header.

## Project Facts
1. **[2026-06-09] NestJS: runtime-driven providers are intentionally not exported**
   `CheckoutWorker` (self-registers via `onModuleInit`) and `ReconcileScheduler`
   (`@Interval` via ScheduleModule) live in `providers` but not `exports` — they
   are triggered by the runtime, not injected. Do instead: don't "clean up" as
   dead code; they are entry points. Comment is in `application.module.ts`.
2. **[2026-06-09] Build/verify command**
   Do instead: `npm run build` (tsc); full gate also runs `npm test` + `npx biome check --write src`.

## User Directives
1. **[2026-06-09] Code-review deliverables go to `docs/code-review/`**
   Do instead: one review doc per file, mirroring `src/` structure, plus an
   index README. User wants expert-level, per-file fan-out (sub-agents).
2. **[2026-06-09] Commit messages in English; atomic commits per concern**
   Do instead: separate unrelated work (e.g. code-review docs vs design docs)
   into distinct commits. User interacts in PT-BR but wants English commits/code comments.
