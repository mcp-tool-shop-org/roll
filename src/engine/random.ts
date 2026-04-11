import { randomInt } from "node:crypto";

export type RngFn = (min: number, max: number) => number;

/** Cryptographically secure random integer in [min, max] (inclusive). */
export const cryptoRng: RngFn = (min: number, max: number): number => {
  return randomInt(min, max + 1); // crypto.randomInt upper bound is exclusive
};

/** Create a seeded PRNG for deterministic testing. Simple mulberry32. */
export function seededRng(seed: number): RngFn {
  let state = seed | 0;
  return (min: number, max: number): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const raw = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return min + Math.floor(raw * (max - min + 1));
  };
}
