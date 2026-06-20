import type { Distribution } from "./distribution.js";

export interface DistributionStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  mode: number;
  stddev: number;
  percentiles: Record<number, number>; // 10, 25, 50, 75, 90, 95
  entropy: number;
}

/** Compute statistics from a probability distribution. */
export function computeStats(dist: Distribution): DistributionStats {
  // Sort by value
  const rawEntries = [...dist.entries()].sort((a, b) => a[0] - b[0]);

  if (rawEntries.length === 0) {
    return {
      min: 0, max: 0, mean: 0, median: 0, mode: 0,
      stddev: 0, percentiles: {}, entropy: 0,
    };
  }

  // F-AT-006: normalize so probabilities sum to 1 before computing percentiles.
  // Truncated exploding-dice distributions sum to slightly under 1; without
  // normalization the forward cumulative pass can fail to reach high percentile
  // keys, leaving them unset and silently dropping the median to the mode (a
  // wrong central value). Normalizing makes the cumulative pass reach 1.0.
  let massSum = 0;
  for (const [, p] of rawEntries) massSum += p;
  const norm = massSum > 0 ? massSum : 1;
  const entries: [number, number][] =
    Math.abs(massSum - 1) > 1e-12
      ? rawEntries.map(([v, p]) => [v, p / norm])
      : rawEntries;

  // entries is non-empty (rawEntries.length === 0 returned early above), so the
  // first and last elements are always defined.
  const min = entries[0]![0];
  const max = entries[entries.length - 1]![0];

  // Mean
  let mean = 0;
  for (const [v, p] of entries) {
    mean += v * p;
  }

  // Mode (highest probability value)
  let mode = entries[0]![0];
  let modeProbability = 0;
  for (const [v, p] of entries) {
    if (p > modeProbability) {
      modeProbability = p;
      mode = v;
    }
  }

  // Standard deviation
  let variance = 0;
  for (const [v, p] of entries) {
    variance += p * (v - mean) ** 2;
  }
  const stddev = Math.sqrt(variance);

  // Percentiles via cumulative distribution (on normalized mass).
  const percentileKeys = [10, 25, 50, 75, 90, 95];
  const percentiles: Record<number, number> = {};
  let cumulative = 0;
  let percentileIndex = 0;
  const lastValue = entries[entries.length - 1]![0]; // max value carrying mass

  for (const [v, p] of entries) {
    cumulative += p;
    while (
      percentileIndex < percentileKeys.length &&
      // percentileIndex < percentileKeys.length here, so the key is defined.
      cumulative >= percentileKeys[percentileIndex]! / 100
    ) {
      percentiles[percentileKeys[percentileIndex]!] = v;
      percentileIndex++;
    }
  }

  // Any percentile keys still unset (only possible from floating-point mass just
  // under 1.0 after normalization) default to the last value reached — the max
  // value that carries probability mass.
  for (const key of percentileKeys) {
    if (percentiles[key] === undefined) percentiles[key] = lastValue;
  }

  // F-AT-006: the median is the 50th percentile. The fallback must be the last
  // value reached (max with mass), NOT the mode — falling back to the mode
  // silently reports a wrong central value for right-skewed/truncated dice.
  const median = percentiles[50] ?? lastValue;

  // Shannon entropy
  let entropy = 0;
  for (const [, p] of entries) {
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  return { min, max, mean, median, mode, stddev, percentiles, entropy };
}

/** Compute P(result >= target). */
export function probabilityAtLeast(dist: Distribution, target: number): number {
  let prob = 0;
  for (const [v, p] of dist) {
    if (v >= target) prob += p;
  }
  return prob;
}

// ─── Point / range queries (FT-ANA-003) ──────────────────────────────────────
// Mirror probabilityAtLeast: each is a small linear sum over the distribution
// Map. They make no normalization assumption — a truncated exploding-dice
// distribution that sums to slightly under 1 returns slightly-under-1 mass,
// matching the raw probabilities the caller holds (the same convention
// probabilityAtLeast already uses).

/** Compute P(result <= x). */
export function probabilityAtMost(dist: Distribution, x: number): number {
  let prob = 0;
  for (const [v, p] of dist) {
    if (v <= x) prob += p;
  }
  return prob;
}

/** Compute P(result === x). Zero when x is outside the support. */
export function probabilityExactly(dist: Distribution, x: number): number {
  return dist.get(x) ?? 0;
}

/** Compute P(lo <= result <= hi), inclusive on both ends. */
export function probabilityInRange(dist: Distribution, lo: number, hi: number): number {
  let prob = 0;
  for (const [v, p] of dist) {
    if (v >= lo && v <= hi) prob += p;
  }
  return prob;
}

// ─── Cumulative / survival distributions (FT-ANA-004) ─────────────────────────

/** Cumulative distribution function: for each value v carrying mass (sorted
 *  ascending), map v → P(X <= v) as a running sum. The last entry equals the
 *  total mass (~1 for a normalized distribution). */
export function cumulativeDistribution(dist: Distribution): Map<number, number> {
  const sorted = [...dist.entries()].sort((a, b) => a[0] - b[0]);
  const cdf = new Map<number, number>();
  let cumulative = 0;
  for (const [v, p] of sorted) {
    cumulative += p;
    cdf.set(v, cumulative);
  }
  return cdf;
}

/** Survival (complementary CDF): for each value v carrying mass (sorted
 *  ascending), map v → P(X >= v). The first entry equals the total mass. */
export function survivalDistribution(dist: Distribution): Map<number, number> {
  const sorted = [...dist.entries()].sort((a, b) => a[0] - b[0]);
  let total = 0;
  for (const [, p] of sorted) total += p;
  const surv = new Map<number, number>();
  let below = 0; // mass strictly below the current value
  for (const [v, p] of sorted) {
    surv.set(v, total - below);
    below += p;
  }
  return surv;
}

// ─── Break-even / target solver (FT-ANA-005) ──────────────────────────────────

/**
 * Find the smallest target T (a value carrying mass) such that:
 *   - direction "atLeast": P(X >= T) >= p, or
 *   - direction "atMost":  P(X <= T) >= p.
 *
 * "Break-even" / "what number do I need" solver. Walks the support in sorted
 * order computing the running (C)CDF, returning the first value that clears the
 * threshold p.
 *
 * For "atLeast" the survival mass DECREASES as T rises, so the smallest
 * qualifying T is the LARGEST value still meeting the bar — we walk ascending
 * and keep the highest value whose survival mass is still >= p. For "atMost" the
 * cumulative mass INCREASES as T rises, so we return the first value whose CDF
 * reaches p. Empty distributions return 0.
 */
export function targetForProbability(
  dist: Distribution,
  p: number,
  direction: "atLeast" | "atMost" = "atLeast",
): number {
  const sorted = [...dist.entries()].sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) return 0;

  if (direction === "atMost") {
    // Smallest T with P(X <= T) >= p: first value whose cumulative mass clears p.
    let cumulative = 0;
    for (const [v, prob] of sorted) {
      cumulative += prob;
      if (cumulative >= p - 1e-12) return v;
    }
    // Floating-point shortfall under p (e.g. truncated mass): the max value is
    // the best achievable target.
    return sorted[sorted.length - 1]![0];
  }

  // direction === "atLeast": the break-even target. Survival mass P(X >= v) is
  // monotonically non-increasing as v rises, so the constraint P(X >= T) >= p is
  // easiest for small T (the minimum value trivially maximizes survival). The
  // useful "what number do I need" answer is the LARGEST T still meeting the
  // bar — the highest value you can require and still clear it with probability
  // >= p. Walk ascending, keep the highest value whose survival clears p.
  let answer = sorted[0]![0]; // minimum value: trivially satisfies any p<=total
  let total = 0;
  for (const [, prob] of sorted) total += prob;
  let cumulative = 0;
  for (const [v, prob] of sorted) {
    const survival = total - cumulative; // P(X >= v)
    if (survival >= p - 1e-12) answer = v;
    cumulative += prob;
  }
  return answer;
}
