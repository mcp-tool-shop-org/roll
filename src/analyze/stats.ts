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
