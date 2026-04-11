# Changelog

## 1.0.0 (2026-04-10)

Initial release.

### Features

- **Dice expression parser** — full recursive descent parser supporting `NdM`, arithmetic (`+`, `-`, `*`, `/`), parentheses, keep highest/lowest (`kh`, `kl`), drop highest/lowest (`dh`, `dl`), exploding dice (`!`, `!>N`), percentile (`d%`), and Fate dice (`dF`)
- **Probability analyzer** — exact distributions via convolution and enumeration, Monte Carlo fallback for complex expressions
- **Statistics** — mean, median, mode, standard deviation, percentiles (10/25/50/75/90/95), Shannon entropy
- **Terminal histograms** — colored bar charts with mode/median markers
- **Loot table roller** — weighted selection, nested table references, integrated dice expressions for quantity and value
- **Comparison mode** — side-by-side distribution analysis of two expressions
- **At-least mode** — P(result >= target) with visual probability bar
- **Zero runtime dependencies** — Node 22+ builtins only
- **Dual-use** — CLI via `npx @mcptoolshop/roll` and importable as a library
