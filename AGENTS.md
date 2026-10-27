<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project rules for any coding agent

Full handoff (current status, task list, owner rules) is in `docs/HANDOFF.md`. That folder is local and gitignored: read it, never commit it. Short version:

- Branch and PR only, squash merge. Never push to `develop`.
- Never commit `docs/` or `.taste-skill/`.
- No AI co-author or "generated with" lines in commits or PR bodies.
- CI quota is out: run typecheck, lint, unit and full integration locally first, and say so in the PR body.
- Unclear paid-call outcomes are never auto-retried.
- Max two agents at once, each in its own git worktree.
- Keep answers and reports short.
