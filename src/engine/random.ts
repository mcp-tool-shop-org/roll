import { randomInt } from "node:crypto";

export type RngFn = (min: number, max: number) => number;

/** Cryptographically secure random integer in [min, max] (inclusive). */
export const cryptoRng: RngFn = (min: number, max: number): number => {
  return randomInt(min, max + 1); // crypto.randomInt upper bound is exclusive
};

// Multiplicative inverse of mulberry32's Weyl step 0x6d2b79f5 modulo 2^32:
// Math.imul(0x6d2b79f5, 0xdc58aa5d) === 1, allowing exact O(1) draw-count
// recovery between checkpoints (< 2^32 draws) with zero per-draw instructions.
const WEYL_STEP = 0x6d2b79f5;
const WEYL_STEP_INV = 0xdc58aa5d;

/**
 * Create a deterministic mulberry32 PRNG paired with `takeDraws()`, which
 * returns the exact number of draws (`< 2^32`) elapsed since creation or the
 * previous `takeDraws()` call without adding per-draw closure or counter work.
 */
export function seededRngWithDraws(seed: number): {
  rng: RngFn;
  takeDraws: () => number;
} {
  let state = seed | 0;
  let checkpoint = state;
  const rng: RngFn = (min: number, max: number): number => {
    state = (state + WEYL_STEP) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const raw = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return min + Math.floor(raw * (max - min + 1));
  };
  const takeDraws = (): number => {
    const draws = Math.imul((state - checkpoint) | 0, WEYL_STEP_INV) >>> 0;
    checkpoint = state;
    return draws;
  };
  return { rng, takeDraws };
}

/** Create a seeded PRNG for deterministic testing. Simple mulberry32. */
export function seededRng(seed: number): RngFn {
  return seededRngWithDraws(seed).rng;
}
