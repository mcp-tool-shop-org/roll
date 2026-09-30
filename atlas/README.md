# roll: how it works

Mapped at 2026-09-30 from commit ad9faaa by Atlas 1.24.0.

## What this is

5 parts, mostly TypeScript (58 files), CSS (2), Astro (1) and JavaScript (1). Work enters through 7 doors; CI and Release each reach 2 parts, and CI is followed because a pull request goes through it. It publishes to npm. It deploys a site to GitHub Pages. People run roll, roll-bridge and roll-mcp. People import @mcptoolshop/roll.

## What changed since 2026-09-24 (97f0f4f)

- CI's pull request trigger now also names `codecov.yml`.
- CI's push trigger now also names `codecov.yml`.
- 2 files added and 92 changed content, across 5 parts.

## What comes in

1. **CI.** On a pull request touching 11 paths; on a push touching 11 paths; or by hand. Runs src/bin.ts and tests/; builds src/.
2. **Release.** When a tag matching `v*` is pushed; or by hand. Runs tests/; builds src/.
3. **Deploy site to GitHub Pages.** On a push to main touching 2 paths; or by hand. Runs site/astro.config.mjs and site/src/.
4. **@mcptoolshop/roll** (the package people import). Loads src/index.ts, src/bridge/handler.ts and src/tables/engine.ts.
5. **roll** (a command people run). Runs src/bin.ts.
6. **roll-bridge** (a command people run). Runs src/bridge/server.ts.
7. **roll-mcp** (a command people run). Runs src/mcp/server.ts.

## What happens through CI

1. The workflow runs src/bin.ts in src and tests/ in tests; it builds src/ in src.
2. It uploads coverage to Codecov.

## Who reads the results

CI writes nothing this map can see.

## The other doors

**Release** runs tests/, builds src/, publishes to npm, and creates a GitHub release.

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

Window: 180 days; a pair counts from 3 shared commits, since 0 source files reach 10 revisions; the floor rises to 10 when 25 do.

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

.github/workflows/ci.yml → src/bin.ts → src/display/color.ts → src/display/box.ts → src/loot/table.ts

Read those in order to follow one pull request end to end.

## What this map cannot see

- 2 reads go to a path their caller passes, not to this repository.
- Statistics confidence is low: fewer than 25 source files reach 10 revisions in the window.

Regenerate with `npx --yes @dogfood-lab/atlas map`.
