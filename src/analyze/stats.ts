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
  const entries = [...dist.entries()].sort((a, b) => a[0] - b[0]);

  if (entries.length === 0) {
    return {
      min: 0, max: 0, mean: 0, median: 0, mode: 0,
      stddev: 0, percentiles: {}, entropy: 0,
    };
  }

  const min = entries[0][0];
  const max = entries[entries.length - 1][0];

  // Mean
  let mean = 0;
  for (const [v, p] of entries) {
    mean += v * p;
  }

  // Mode (highest probability value)
  let mode = entries[0][0];
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

  // Percentiles via cumulative distribution
  const percentileKeys = [10, 25, 50, 75, 90, 95];
  const percentiles: Record<number, number> = {};
  let cumulative = 0;
  let percentileIndex = 0;

  for (const [v, p] of entries) {
    cumulative += p;
    while (
      percentileIndex < percentileKeys.length &&
      cumulative >= percentileKeys[percentileIndex] / 100
    ) {
      percentiles[percentileKeys[percentileIndex]] = v;
      percentileIndex++;
    }
  }

  // Median is the 50th percentile
  const median = percentiles[50] ?? mode;

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
