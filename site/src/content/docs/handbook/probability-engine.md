---
title: Probability Engine
description: How @mcptoolshop/roll computes exact probability distributions, the algorithms behind each dice type, and the CLI analysis modes.
sidebar:
  order: 3
---

Roll includes a probability engine that computes exact distributions for dice expressions. Unlike simulators that run thousands of random trials and report approximate frequencies, Roll calculates the mathematically precise probability of every possible outcome. This page explains the algorithms used, when Monte Carlo fallback kicks in, and how to use the analysis modes from the CLI.

## How distributions are computed

The engine picks the most efficient algorithm based on the structure of the dice expression. There are seven strategies, tried in order of preference.

### Polynomial convolution (basic NdM)

For plain dice without modifiers (no keep, drop, or explode), Roll uses iterative convolution. The distribution of a single die is uniform: each face has probability 1/M. To get the distribution of N dice summed together, Roll convolves the single-die distribution with itself N times.

For example, the distribution of 1d6 is:

```
{1: 1/6, 2: 1/6, 3: 1/6, 4: 1/6, 5: 1/6, 6: 1/6}
```

To compute 2d6, Roll convolves this with itself. The result of 7 can occur as 1+6, 2+5, 3+4, 4+3, 5+2, or 6+1, giving it probability 6/36 = 16.67%.

This approach is fast and exact. The work scales with the number of possible sums (N*M values at most), not the total number of dice permutations.

### Full enumeration (keep/drop)

When the expression includes kh, kl, dh, or dl modifiers, Roll enumerates every possible combination of dice outcomes, applies the keep/drop rules, and tallies the resulting sums.

For `4d6dl1`, there are 6^4 = 1,296 possible outcomes. Roll walks through all 1,296, sorts each set of 4 dice, drops the lowest, sums the remaining 3, and records the probability.

This produces exact results but the cost grows exponentially with the number of dice. Roll caps the enumeration at **10 million states**. For `4d6` through about `7d6`, exact enumeration is feasible. Beyond that, Roll falls back to Monte Carlo.

### Analytical reroll

When the expression uses `r` (unlimited reroll) or `ro` (reroll once) without keep/drop or explosion, Roll computes the modified per-die distribution analytically.

For unlimited reroll (`r<3` on a d6), faces 1 and 2 have zero probability. Their mass redistributes uniformly to the remaining faces: each of faces 3-6 gets probability 1/4 instead of 1/6. The result is then convolved N times.

For reroll once (`ro=1` on a d6), each face gets a two-step probability: P(end on face) = P(roll face directly, face doesn't match) + P(roll a match, then reroll to face). This produces exact results with no simulation.

### Analytical min/max clamping

For `min` and `max` modifiers without keep/drop or explosion, Roll modifies the single-die distribution by truncating and piling mass.

For `1d6min3`: faces 1 and 2 have their probability mass (1/6 each) piled onto face 3. The result: P(3) = 3/6, P(4) = P(5) = P(6) = 1/6.

For `1d6max4`: faces 5 and 6 pile onto face 4. Same principle in reverse.

### Analytical success counting

For success counting pools (`cs>=N`, optionally with `cf<=M`) without keep/drop or explosion, Roll classifies each die face as +1 (success), -1 (failure), or 0 (neutral) based on the thresholds. This creates a 3-outcome single-die distribution that is convolved N times.

For `8d6cs>=5`: each die has P(+1) = 2/6 (faces 5,6), P(0) = 4/6 (faces 1-4). The resulting distribution over 0-8 successes is computed exactly via convolution.

When reroll and min/max modifiers are present, Roll first computes the modified per-die distribution (after reroll and clamping), then classifies the faces. This means `8d6r<2cs>=5` produces an exact distribution — not Monte Carlo.

### Truncated recursion (exploding / compounding / penetrating dice)

Exploding, compounding, and penetrating dice create variable-length chains. Roll handles all three variants with iterative depth expansion.

For each "chain depth" from 0 to 10, Roll tracks every possible accumulated sum and its probability. At each depth, it fans out into all M faces:

- If the face is below the explosion threshold (or the depth cap is reached), the chain terminates and the sum is recorded in the final distribution.
- If the face meets or exceeds the threshold, the chain continues: the sum is carried forward to the next depth.

The depth cap of 10 explosions means Roll truncates chains longer than 10 rerolls. For a standard d6 (explode on 6), the probability of reaching 10 explosions is (1/6)^10, which is about 0.000002%. The truncation error is negligible.

For **penetrating dice** (`!p`), each explosion depth subtracts 1 from the rolled face value (minimum 1), producing a distribution that skews lower than standard exploding. For **compounding dice** (`!!`), the distribution shape is mathematically identical to exploding — the difference is engine-side (one die vs. many), not probability-side.

After computing the distribution for a single exploding/compounding/penetrating die, Roll convolves it N times for NdX! expressions.

### Monte Carlo fallback

When none of the exact strategies apply (or when the state space exceeds 10 million), Roll falls back to Monte Carlo simulation. It runs **100,000 trials** using deterministic seeded PRNGs (one per trial) and records the frequency of each outcome.

Cases that trigger Monte Carlo:

- Multiplying or dividing two dice distributions (e.g., `2d6 * 1d4`)
- Extremely large keep/drop pools (e.g., `20d20kh10` with 20^20 states)
- Exploding dice combined with keep/drop modifiers

The Monte Carlo results are approximate but reliable at 100k samples. Standard error is typically under 0.5% for any single outcome probability.

## Arithmetic on distributions

When dice expressions are combined with arithmetic, Roll operates on the distributions directly:

| Operation | Method |
|-----------|--------|
| dice + constant | Shift every value by the constant |
| dice - constant | Shift every value by negative constant |
| dice * constant | Scale every value by the constant |
| dice / constant | Integer floor-divide every value |
| dice + dice | Convolve the two distributions (sum of independent variables) |
| dice - dice | Negate the second distribution, then convolve |
| dice * dice | Monte Carlo fallback |
| dice / dice | Monte Carlo fallback |

The shift and scale operations are O(n) in the number of distinct outcomes. Convolution of two distributions is O(n*m) where n and m are the number of distinct values in each.

## Available statistics

Once a distribution is computed, Roll derives these statistics:

### Mean

The expected value: the weighted average of all outcomes. For 2d6, the mean is 7.00.

### Median

The value at or below which 50% of outcomes fall. Computed from the cumulative distribution function. For 2d6, the median is 7.

### Mode

The most probable single outcome. When multiple values tie for highest probability, Roll reports the lowest. For 2d6, the mode is 7 (probability 16.67%).

### Standard deviation

The square root of the variance, measuring how spread out the outcomes are. A d20 (stddev 5.77) is much more variable than 3d6 (stddev 2.96) despite similar means.

### Range

The minimum and maximum possible outcomes.

### Percentiles

The values at which cumulative probability crosses key thresholds:

| Percentile | Meaning |
|-----------|---------|
| p10 | 10% of rolls fall at or below this value |
| p25 | First quartile |
| p50 | Median (same as the median stat) |
| p75 | Third quartile |
| p90 | 90% of rolls fall at or below |
| p95 | Only 5% of rolls exceed this value |

### Shannon entropy

Measured in bits, entropy quantifies the unpredictability of the roll. A d6 has entropy log2(6) = 2.58 bits. A d20 has 4.32 bits. A constant has 0 bits (completely predictable).

Entropy helps compare dice systems: `4d6dl1` (entropy 3.53 bits) is less unpredictable than `3d6` (entropy 3.67 bits) because the keep-highest mechanic compresses the distribution toward higher values.

## CLI analysis modes

### Full analysis: --analyze

```bash
roll 2d6+3 --analyze
```

Prints two sections:

1. **Histogram** -- a horizontal bar chart of every possible outcome. The mode is highlighted with `*>` and yellow bars. The median is marked with `~>`. If mode and median coincide, the marker is `M>`.

2. **Statistics box** -- all stats listed in a Unicode box: mean, median, mode, stddev, range, entropy, and percentiles.

### Threshold check: --at-least

```bash
roll d20+5 --at-least 15
```

Computes P(result >= target) and displays it as a visual probability bar with a plain-language assessment (from "Very unlikely" through "Almost certain").

This is useful for answering game-design questions like "can the fighter hit AC 18?" or "what are the odds of making this saving throw?"

### Distribution comparison: --compare

```bash
roll --compare "4d6dl1" "3d6"
```

Computes both distributions and prints:

1. **Comparison table** -- side-by-side stats (mean, median, mode, stddev, min, max, entropy) with a diff column showing the delta. Positive diffs are green; negative are red.

2. **Both histograms** -- rendered one after the other so you can visually compare the shapes.

This is invaluable for game design decisions: comparing advantage vs. flat bonuses, evaluating house rules, or tuning encounter difficulty.

### JSON output

All analysis modes support `--json` for machine-readable output:

```bash
roll 2d6 --analyze --json
```

Returns a JSON object with the expression, full stats, and the distribution as an array of `[value, probability]` pairs.

```bash
roll d20+5 --at-least 15 --json
```

Returns the expression, target, and probability as a decimal.

## Performance characteristics

| Expression | Strategy | States | Time |
|-----------|----------|--------|------|
| `2d6` | Convolution | 11 values | Instant |
| `8d6` | Convolution | 43 values | Instant |
| `4d6dl1` | Enumeration | 1,296 states | Instant |
| `6d6dl1` | Enumeration | 46,656 states | Fast |
| `1d6!` | Truncated recursion | ~60 values | Instant |
| `1d6!!` | Truncated recursion | ~60 values | Instant |
| `1d6!p` | Truncated recursion | ~60 values | Instant |
| `4d6!` | Recursion + convolution | ~240 values | Instant |
| `2d6r<2` | Analytical reroll | 5 values | Instant |
| `2d6min3` | Analytical clamp | 4 values | Instant |
| `8d6cs>=5` | Success counting | 9 values | Instant |
| `8d6r<2cs>=5` | Reroll + success counting | 9 values | Instant |
| `2d6*1d4` | Monte Carlo | 100k samples | ~50ms |
| `20d20kh10` | Monte Carlo | 100k samples | ~50ms |

The exact strategies run in microseconds for typical tabletop expressions. Monte Carlo runs in tens of milliseconds. All analysis is single-threaded and synchronous.
