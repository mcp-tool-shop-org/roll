# roll: how it works

Mapped at 2026-09-24 from commit 97f0f4f.

## What this is

5 parts, mostly TypeScript (57 files). Work enters through 7 doors; CI and Release each reach 2 parts, and CI is followed because a pull request goes through it. It publishes to npm. People run roll, roll-bridge and roll-mcp. People import @mcptoolshop/roll.

## What changed since the last map

This is the first map.

## What comes in

1. **CI.** On a pull request touching 10 paths; on a push touching 10 paths; or by hand. Runs src/bin.ts and tests/; checks src/.
2. **Release.** When a tag matching `v*` is pushed; or by hand. Runs tests/; checks src/.
3. **Deploy site to GitHub Pages.** On a push to main touching 2 paths; or by hand. Runs site/astro.config.mjs and site/src/.
4. **@mcptoolshop/roll** (the package people import). Loads src/index.ts, src/bridge/handler.ts and src/tables/engine.ts.
5. **roll** (a command people run). Runs src/bin.ts.
6. **roll-bridge** (a command people run). Runs src/bridge/server.ts.
7. **roll-mcp** (a command people run). Runs src/mcp/server.ts.

## What happens through CI

1. The workflow runs src/bin.ts in src and tests/ in tests; it checks src/ in src.

## Who reads the results

CI writes nothing this map can see.

## The other doors

**Release** runs tests/, checks src/, publishes to npm, and creates a GitHub release.

**Deploy site to GitHub Pages** runs site/astro.config.mjs and site/src/, and deploys the site.

**@mcptoolshop/roll** (the package people import) loads src/index.ts, src/bridge/handler.ts and src/tables/engine.ts.

**roll** (a command people run) runs src/bin.ts.

**roll-bridge** (a command people run) runs src/bridge/server.ts.

**roll-mcp** (a command people run) runs src/mcp/server.ts.

## What breaks what

- **src** is imported only from tests, by 1 part (tests), and sits on the path of 6 doors.
- **tests** is imported by no other part and sits on the path of 2 doors.

## What tends to change together

No two source files changed together often enough to name.

Window: 180 days; a pair counts from 3 shared commits, since the window holds fewer than 30 qualifying commits.

## What no test touches

Every code part is imported by at least one test.

## Written but never read

No place this map can see is written, so none goes unread.

## Helpers that look duplicated

No two parts export a helper that looks alike.

## Generated, never hand-edited

Nothing in this repository writes to a tracked place this map can see.

## Hand-authored

People write .github/, the repository root and site/. Nothing in this repository writes to them.

## Where to start

.github/workflows/ci.yml → src/bin.ts

Read those in order to follow one pull request end to end.

## What this map cannot see

- 3 reads go to the directory the command is run in, the home directory or a path its caller passes, not to this repository.
- Statistics confidence is low: fewer than 30 qualifying commits in the window, and fewer than 20 source files reach 10 revisions.

Regenerate with `npx --yes @dogfood-lab/atlas map`.
