# Skill routing

Before answering, check whether a skill matches the prompt and invoke it via the Skill tool. Pick by task, not by keyword. If several apply, use the first in the order below. Skip skills for trivial questions or chat.

## Process (new work)
- Vague or underspecified ask → `interview-me`, then `brainstorming`
- New feature or behavior, no spec yet → `brainstorming`, then `spec-driven-development`
- Spec exists, need tasks → `writing-plans` / `planning-and-task-breakdown`
- Executing a plan → `executing-plans` or `subagent-driven-development`; 2+ independent tasks → `dispatching-parallel-agents`
- Implementing → `test-driven-development` + `incremental-implementation`

## Bugs and failures
- Any bug, failing test, or unexpected error → `systematic-debugging` (or `debugging-and-error-recovery`); unclear cause → `investigate-first`
- Small targeted fix → `surgical-patch`

## Review and finish
- Review a diff or PR → `code-review-and-quality` or `requesting-code-review`; feedback received → `receiving-code-review`
- Before claiming done, committing, or opening a PR → `verification-before-completion`
- Branch wrap-up → `finishing-a-development-branch`; commits, branches, PR descriptions → `yt-studio-git` (then `git-workflow-and-versioning` for general rules)
- Deploying → `shipping-and-launch`, `ci-cd-and-automation`

## Code quality
- Any coding task → apply `karpathy-guidelines` and `ponytail` (smallest change that solves it)
- Refactor / simplify → `safe-refactor`, `code-simplification`
- Security-sensitive code → `security-and-hardening`
- Perf → `performance-optimization`; APIs → `api-and-interface-design`; migrations → `migration`

## UI / design
- Landing pages, marketing sites, "looks generic/AI-made" → `design-taste-frontend`
- App screens, components, accessibility, design systems → `ui-ux-pro-max`, `frontend-ui-engineering`
- Tailwind / shadcn → `ui-styling`
- Banners, logos, brand → `design` / `banner-design` / `brand`
- Slides → `slides` (HTML) or `pptx` (.pptx)

## Files and docs
- .docx → `docx`; .pdf → `pdf`; .xlsx/.csv → `xlsx`; docs/specs → `doc-coauthoring`

## Codebase questions
- Architecture, file relationships, "how does X work here" → `graphify` first (query `graphify-out/` if it exists)
- Broad search across many files → `caveman-explore` / `cavecrew`

## Opt-in only (do not auto-run)
- `caveman` (terse voice), `caveman-*` cloud/setup/optimize skills, `ponytail-audit`, `ponytail-gain`, `ponytail-debt`, `skill-creator`, `template-skill`. Use only when the user asks by name.
