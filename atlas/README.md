# roll: how it works

Mapped at 2026-11-14 from commit 35824c7 by Atlas 1.26.0.

## What this is

8 parts, mostly TypeScript (58 files), Rust (23), CSS (2), Astro (1) and JavaScript (1). Work enters through 8 doors; the busiest is CI, which reaches 4 parts. It publishes to npm. It deploys a site to GitHub Pages. People run roll, roll-bridge and roll-mcp. People import @mcptoolshop/roll. roll is a command built from crates/roll-cli (nothing ships it).

## What changed since 2026-11-14 (7984126)

Nothing structural changed since 2026-11-14; 1 file changed content.

## What comes in

1. **CI.** On a pull request; on a push touching 15 paths; or by hand. Runs crates/roll-cli/src/main.rs, src/bin.ts, crates/roll-cli/tests/ and 36 more; builds src/; checks crates/roll-cli/src/lib.rs and crates/roll-core/src/lib.rs.
2. **Release.** When a tag matching `v*` is pushed; or by hand. Runs tests/; builds src/.
3. **Deploy site to GitHub Pages.** On a push to main touching 2 paths; or by hand. Runs site/astro.config.mjs and site/src/.
4. **roll** (a command built from crates/roll-cli, which nothing ships, from crates/roll-cli/Cargo.toml). Runs crates/roll-cli/src/main.rs.
5. **@mcptoolshop/roll** (the package people import). Loads src/index.ts, src/bridge/handler.ts and src/tables/engine.ts.
6. **roll** (a command people run, from package.json). Runs src/bin.ts.
7. **roll-bridge** (a command people run). Runs src/bridge/server.ts.
8. **roll-mcp** (a command people run). Runs src/mcp/server.ts.

## What happens through CI

1. The workflow runs crates/roll-cli/src/main.rs and crates/roll-cli/tests/ in roll-cli, crates/roll-core/src/analyze.rs and crates/roll-core/tests/ in roll-core, src/bin.ts in src, and tests/ in tests; it builds src/ in src; it checks crates/roll-cli/src/lib.rs in roll-cli and crates/roll-core/src/lib.rs in roll-core.
2. It uploads coverage to Codecov.

## Who reads the results

CI writes nothing this map can see.

## The other doors

**Release** runs tests/, builds src/, publishes to npm, and creates a GitHub release.

**Deploy site to GitHub Pages** runs site/astro.config.mjs and site/src/, and deploys the site.

**roll** (a command built from crates/roll-cli, which nothing ships, from crates/roll-cli/Cargo.toml) runs crates/roll-cli/src/main.rs and reaches roll-core.

**@mcptoolshop/roll** (the package people import) loads src/index.ts, src/bridge/handler.ts and src/tables/engine.ts.

**roll** (a command people run, from package.json) runs src/bin.ts.

**roll-bridge** (a command people run) runs src/bridge/server.ts.

**roll-mcp** (a command people run) runs src/mcp/server.ts.

## What breaks what

- **roll-core** is imported by 1 part (roll-cli) and sits on the path of 2 doors.
- **src** is imported only from tests, by 1 part (tests), and sits on the path of 6 doors.
- **roll-cli** is imported by no other part and sits on the path of 2 doors.
- **tests** is imported by no other part and sits on the path of 2 doors.

## What tends to change together

- **src/bin.ts** and **src/mcp/server.ts** changed together in 7 of 8 commits, inside the src part.
- **src/bridge/handler.ts** and **src/mcp/server.ts** changed together in 6 of 7 commits, inside the src part.
- **src/bin.ts** and **src/bridge/handler.ts** changed together in 6 of 8 commits, inside the src part.
- **src/bin.ts** and **src/display/format.ts** changed together in 5 of 8 commits, inside the src part.
- **src/bridge/handler.ts** and **src/display/format.ts** changed together in 4 of 7 commits, inside the src part.

Confidence is low: fewer than 25 source files reach 10 revisions in the window.

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

People write .github/, fixtures/, the repository root and site/. Nothing in this repository writes to them.

## Where to start

.github/workflows/ci.yml → src/bin.ts → src/display/box.ts → src/display/color.ts

Read those in order to follow one pull request end to end.

Beside the path, src/bin.ts also calls src/loot/table.ts.

## What this map cannot see

- 3 writes and 2 reads go to a path their caller passes, not to this repository.
- 1 file belongs to no part: docs/spec/roll-3.0.md.
- Statistics confidence is low: fewer than 25 source files reach 10 revisions in the window.

Regenerate with `npx --yes @dogfood-lab/atlas map`.
