## Quality & Risk

Before calling significant work done: tests pass, lint clean, docs updated, and the change weighed for security, performance, data integrity, and deployment/rollback risk.

---

## Language Choice

Python is a last resort, not the easy default — Craig has been bitten repeatedly by Python-shaped instincts (scalar loops, unbatched hot paths) leaking into every language. Design data flow batch-first — a per-item call in a hot path is a defect. Prefer ecosystems whose norms pull toward quality: Rust for performance-critical or parallel work; TypeScript on bun (Craig's usual) or Go for services and tooling. If Python is unavoidable, write it like a systems language and surface it as debt to retire.

---

## Installed CLI Tools (beyond defaults)

jq, httpie, gh, bat, diff-so-fancy, hyperfine, tree, watch, ag, parallel, awscli, csvkit (csvcut/csvjoin/csvstat), imagemagick, optipng, webp, ffmpeg

---

Destructive git commands are blocked by a PreToolUse hook: `git checkout -- <path>`, `git restore` (except the pure `--staged` unstage form), `git reset --hard`, and `git clean` with a force flag (dry runs allowed); undo your own edits by editing.
