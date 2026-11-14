//! Exact probability distribution analyzer, order-statistic DP, and Monte Carlo fallback (`Roll 3.0 §5`).
//!
//! `"Exact"` in Roll 3.0 means exact for the bounded `roll-core` engine pipeline as built
//! (`crates/roll-core/src/eval.rs`), including its per-die `MAX_REROLLS = 100` and
//! `MAX_EXPLOSIONS = 100` loop caps, and is never an unlabelled approximation.

use alloc::collections::BTreeMap;
use alloc::collections::btree_map::Entry;
use alloc::format;
use alloc::vec;
use alloc::vec::Vec;
use core::num::NonZeroU64;
use rand_chacha::ChaCha12Rng;
use rand_core::{Rng, SeedableRng};

use crate::ast::{
    BinaryOp, ClampBounds, CompareOp, ComparePoint, DiceSides, DiceSpec, ExplosionRule,
    ExplosionVariant, Expr, KeepDropOp, MAX_EXPLOSIONS, MAX_REROLLS, MAX_TOTAL_DRAWS, ResultMode,
};
use crate::error::{ReceiptVerifyError, RollError};
use crate::eval::{
    EvalScratch, checked_div_floor, evaluate_total_with_source, evaluate_with_source,
    pool_die_delta,
};
use crate::math::{canon_f64, log2_f64, powi_u32, sqrt_f64};
use crate::rng::DrawSource;

/// Maximum sum of base dice counts across an AST accepted by [`analyze`] and [`compare`] (`§5.3`).
pub const MAX_ANALYZE_DICE: u32 = 1_000;

/// AST-wide exact transition budget across all nodes in a single [`analyze`] main pass (`§5.2`, `§5.3`),
/// per-divisor transition cap in the `§5.4` divisor pre-pass, and per-pair support-product / margin cap
/// `|A| * |B| <= MAX_EXACT_STATES` in general binary convolutions and [`compare`].
///
/// ### Exact-budget rule (`MAX_EXACT_STATES = 10_000_000`, `MAX_EXACT_LIVE_STATES = 3_000_000`)
/// A single `ExactBudget` is threaded through `try_exact` across the entire AST and checked
/// **before** every allocation and inner loop:
/// 1. **Cumulative transitions (`<= MAX_EXACT_STATES = 10_000_000`):** monotonically sums
///    executed transitions across every node in the AST (`1` unit per `Accum::Dense` / DP step;
///    `1` unit per `FLAT_CONTIGUOUS_PAIRS_PER_STATE = 16` flat contiguous FMA pairs;
///    `SPARSE_TRANSITION_WEIGHT = 10` units per `BTreeMap` lookup/insert). Unexecuted steps
///    that fail the pre-check do not advance the counter, preserving unspent budget for
///    sibling error-isolation checks (`§5.4` item 3).
/// 2. **Live retained state slots (`<= MAX_EXACT_LIVE_STATES = 3_000_000 <= MAX_EXACT_STATES`):**
///    tracks simultaneously live state slots across all active stack frames, operand
///    distributions, `convolve_n` power tables, `order_statistic_dp` buckets, and active
///    accumulators (`1` slot per `16`-byte `Vec`/dense entry; `SPARSE_STATE_SLOTS = 4` slots
///    per `BTreeMap` entry; `explosion_chain_sum_pmf` additionally caps `finished.len()` at
///    `MAX_EXPLOSION_FINISHED_STATES = 250_000`). Aborted subtrees restore the caller's
///    live-state baseline when their temporaries drop.
/// 3. **Reserved divisor pre-pass (`§5.4` items 1–2, [`MAX_DIVISOR_PREPASS_STATES`]):** before
///    the main `try_exact` pass begins, `precheck_divisors` analyzes every `BinaryOp::DivFloor`
///    divisor subtree under a separate reserved budget so sibling order or main-budget exhaustion
///    can never hide a reachable zero in an exact divisor.
pub const MAX_EXACT_STATES: usize = 10_000_000;

/// Reserved cumulative transition budget for the `§5.4` `DivFloor` divisor pre-pass (`20_000_000`),
/// strictly separate from the main pass's [`MAX_EXACT_STATES`] budget.
///
/// ### Divisor pre-pass rule, oversized-divisor rule, and total pre-pass bound (`§5.4` items 1–5)
/// 1. **Reserved budget & per-divisor cap:** `precheck_divisors` maintains its own cumulative
///    transition counter capped at `MAX_DIVISOR_PREPASS_STATES = 20_000_000` across all
///    `BinaryOp::DivFloor` divisor subtrees in the AST. Each individual divisor is analyzed with
///    `max_transitions = min(MAX_EXACT_STATES, MAX_DIVISOR_PREPASS_STATES - prepass_spent)` and
///    live-slot cap [`MAX_EXACT_LIVE_STATES`] (`3_000_000` slots, `< 48 MiB`), releasing its
///    distribution back to `0` live slots before the next divisor or the main pass runs.
/// 2. **Cheapest-first ordering (`§5.4` item 1):** Divisors are ordered ascending by
///    `(divisor_static_cost_bound(divisor), inorder_div_index)`, where `divisor_static_cost_bound`
///    is a static upper bound on exact transition cost computed from parsed dice counts, sides,
///    and stage modifiers, and `inorder_div_index` breaks ties by source byte offset (in Roll 3.0's
///    infix grammar, every `/` token and its immediate `right` divisor subtree appear in strict
///    left-to-right in-order AST sequence, so `inorder_div_index` is strictly order-isomorphic to
///    source byte offset on every parsed expression).
/// 3. **Zero-divisor error precedence (`§5.4` items 1, 2, 5):** Every divisor that is exact under
///    the reserved budget (`Ok` with `expr_max_die_rolls(divisor) <= MAX_EXACT_DIE_ROLLS`) and has
///    `is_reachable(0)` returns `Err(RollError::DivisionByZero)` immediately. Any non-`DivisionByZero`
///    exact error raised inside a divisor (such as `RollError::ArithmeticOverflow`) is held until
///    every remaining divisor within the reserved budget has been checked for a reachable `0`.
/// 4. **Rule for a divisor too large for the reserved budget (`§5.4` item 4):** If a divisor
///    exceeds its transition or live-slot cap (`ExactAbort::TooLarge`), uses an unsupported exact
///    combination (`ExactAbort::Unsupported`, e.g. `4d6!kh3`), exceeds [`MAX_EXACT_DIE_ROLLS`], or
///    is reached after `prepass_spent == MAX_DIVISOR_PREPASS_STATES`, the pre-pass skips it cleanly
///    (with `0` retained slots) and defers it to the main pass / [`monte_carlo_distribution`]
///    fallback, which reports `AnalysisMethod::MonteCarlo { samples }` (never `Exact`) unless a
///    sampled trial hits `0` and propagates `Err(RollError::DivisionByZero)`.
pub const MAX_DIVISOR_PREPASS_STATES: usize = 20_000_000;

/// Maximum simultaneously retained state slots across all active stack frames and buffers
/// during an exact [`analyze`] pass (`3_000_000 <= MAX_EXACT_STATES`, `< 48 MiB` peak heap).
pub const MAX_EXACT_LIVE_STATES: usize = 3_000_000;

/// Raw `u64` draw headroom reserved below [`MAX_TOTAL_DRAWS`] (`2,100,000`) for 64-bit Lemire
/// multiplication-rejection retries before [`analyze`] may certify a distribution as
/// [`AnalysisMethod::Exact`] (`80,000` raw draws, matching `crates/roll-core/src/ast.rs:38-52`).
///
/// At `expr_max_die_rolls(expr) == MAX_TOTAL_DRAWS`, even a single Lemire rejection retry (`2^64 mod s != 0`)
/// pushes `eval.rs` over `MAX_TOTAL_DRAWS` into `Err(RollError::DrawBudgetExceeded)` — an outcome not
/// modelled by independent per-die convolution. Requiring `expr_max_die_rolls(expr) <= MAX_EXACT_DIE_ROLLS`
/// (`2_020_000`) guarantees at least `80_000` retry draws of headroom (for `s <= 1,000,000`, per-roll
/// retry probability is `(2^64 mod s) / 2^64 < 5.5e-14`, so `P(> 80,000 retries)` is `< 10^-1_000_000`).
pub const EXACT_DRAW_RETRY_MARGIN: u64 = 80_000;

/// Maximum worst-case `roll_single_die` invocations (`2,020_000 = MAX_TOTAL_DRAWS - EXACT_DRAW_RETRY_MARGIN`)
/// permitted for [`analyze`] to label a distribution [`AnalysisMethod::Exact`].
pub const MAX_EXACT_DIE_ROLLS: u64 = (MAX_TOTAL_DRAWS as u64) - EXACT_DRAW_RETRY_MARGIN;

/// Live-state slot weight of one `BTreeMap<i64, f64>` entry (`~40–48` bytes vs `16`-byte `Vec` slot).
const SPARSE_STATE_SLOTS: usize = 4;

/// Transition weight of one `BTreeMap<i64, f64>` probe (`O(log N)` tree walk vs `O(1)` slice index).
const SPARSE_TRANSITION_WEIGHT: u128 = 10;

/// Flat contiguous slice FMA pairs (`dest[j] += pa * pb`) per transition unit in `convolve_contiguous`
/// and `subtract_contiguous` (`~20–35×` faster per pair than `Accum::Dense` / `BTreeMap` transitions).
const FLAT_CONTIGUOUS_PAIRS_PER_STATE: u128 = 16;

/// Maximum distinct finished totals retained by `explosion_chain_sum_pmf` before aborting to Monte Carlo.
const MAX_EXPLOSION_FINISHED_STATES: usize = 250_000;

/// Deterministic cumulative work ceiling (`28,000,000`) for [`analyze`]'s internal Monte Carlo
/// fallback before stopping at a sample boundary (`1 <= samples <= 100_000`, `§5.3`).
///
/// After `completed` samples, cumulative work is:
/// `work = source.draws + completed * estimate_mc_work_per_sample(expr)`.
/// Because Stage 1 already records `>= count` initial RNG draws per sample in `source.draws`,
/// adding `count * (|r| + |ro| + |cs| + |cf|)` in `estimate_mc_work_per_sample` charges at least
/// `count * (|r| + |ro| + |cs| + |cf| + 1)` units per sample for every dice group (plus actual
/// reroll/explosion RNG draws and Stage 5 keep/drop sort + chained-collection work).
const MAX_MC_WORK: u64 = 28_000_000;

/// Default trial count for [`AnalysisMethod::MonteCarlo`] (`§5.3`).
pub const DEFAULT_MONTE_CARLO_SAMPLES: u32 = 100_000;

/// Fixed 32-byte `ChaCha12Rng` key used by the deterministic Monte Carlo fallback (`§5.3`).
pub const MONTE_CARLO_DEFAULT_SEED: &[u8; 32] = b"roll.v3.montecarlo.default.seed!";

/// Threshold on `(max_key - min_key + 1)` below which flat dense array accumulation is used
/// instead of `BTreeMap` (`1_048_576 = 2^20` entries = `16 MiB`; both produce bit-for-bit
/// identical sorted `(i64, f64)` entries, covering `1d1000 * 1d1000` at span `1_000_000`).
const MAX_DENSE_SPAN: u128 = 1_048_576;

#[inline]
fn neumaier_add(sum: &mut f64, comp: &mut f64, val: f64) {
    let t = *sum + val;
    if sum.abs() >= val.abs() {
        *comp += (*sum - t) + val;
    } else {
        *comp += (val - t) + *sum;
    }
    *sum = t;
}

#[inline]
fn neumaier_sum_entries(slice: &[(i64, f64)]) -> f64 {
    let mut sum = 0.0_f64;
    let mut comp = 0.0_f64;
    for &(_, p) in slice {
        neumaier_add(&mut sum, &mut comp, p);
    }
    (sum + comp).max(0.0)
}

#[inline]
fn normalize_if_singleton(entries: &mut [(i64, f64)]) {
    if entries.len() == 1 {
        entries[0].1 = 1.0;
    }
}

/// Discrete integer probability distribution (`Roll 3.0 §1.2`, `§5.4`).
///
/// Entries are strictly ascending by `i64` outcome value. An integer is present in
/// `entries` iff at least one valid execution path reaches it with positive rational
/// probability, even when its IEEE-754 `f64` probability underflows to `0.0`.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Distribution {
    entries: Vec<(i64, f64)>,
}

/// Engine loop caps exercised by an [`AnalysisMethod::Exact`] distribution (`§5.3`).
///
/// Only caps actually reachable on the analyzed expression are populated (`Some(100)`).
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ModelledCaps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_explosions: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_rerolls: Option<u32>,
}

impl ModelledCaps {
    fn merge_from(&mut self, other: Self) {
        if other.max_explosions.is_some() {
            self.max_explosions = other.max_explosions;
        }
        if other.max_rerolls.is_some() {
            self.max_rerolls = other.max_rerolls;
        }
    }

    const fn into_option(self) -> Option<Self> {
        if self.max_explosions.is_some() || self.max_rerolls.is_some() {
            Some(self)
        } else {
            None
        }
    }
}

/// Provenance tag reporting whether a distribution is closed-form exact or sampled (`§5.3`).
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AnalysisMethod {
    Exact {
        #[serde(skip_serializing_if = "Option::is_none")]
        caps: Option<ModelledCaps>,
    },
    MonteCarlo {
        samples: u32,
    },
}

/// Summary statistics over a [`Distribution`] (`§1.2`).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DistributionStats {
    #[serde(with = "crate::codec::i64_str")]
    pub min: i64,
    #[serde(with = "crate::codec::i64_str")]
    pub max: i64,
    pub mean: f64,
    #[serde(with = "crate::codec::i64_str")]
    pub median: i64,
    #[serde(with = "crate::codec::i64_str")]
    pub mode: i64,
    pub stddev: f64,
    pub percentiles: BTreeMap<u8, i64>,
    pub entropy: f64,
}

/// Direction for [`Distribution::target_for_probability`] (`§1.2`).
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetDirection {
    AtLeast,
    AtMost,
}

/// Complete output of [`analyze`] (`§1.2`).
#[derive(Clone, Debug, PartialEq)]
pub struct AnalysisReport {
    pub distribution: Distribution,
    pub stats: DistributionStats,
    pub method: AnalysisMethod,
}

/// Head-to-head comparison report produced by [`compare`] (`§1.2`, `§5.3`).
#[derive(Clone, Debug, PartialEq)]
pub struct ComparisonReport {
    pub left: AnalysisReport,
    pub right: AnalysisReport,
    pub p_left_greater: f64,
    pub p_equal: f64,
    pub p_right_greater: f64,
    pub mean_margin: f64,
    pub margin: Option<Distribution>,
    pub method: AnalysisMethod,
}

/// Result of exact prefix-tape brute-force enumeration over `eval.rs` (`§9.3`).
#[derive(Clone, Debug, PartialEq)]
pub struct PrefixOracleResult {
    pub distribution: Distribution,
    pub tail_mass: f64,
    pub leaves: usize,
}

impl Distribution {
    /// Constructs a point-mass distribution `{(value, 1.0)}`.
    pub fn point(value: i64) -> Self {
        Self {
            entries: vec![(value, 1.0)],
        }
    }

    /// Borrows the ascending `(outcome, probability)` entries slice.
    pub fn entries(&self) -> &[(i64, f64)] {
        &self.entries
    }

    /// Number of reachable integer outcomes in the support.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Returns `true` if the distribution has no entries.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Returns `true` iff `target` is a reachable outcome of the distribution (`§5.4`),
    /// even when its `f64` probability underflowed to `0.0`.
    pub fn is_reachable(&self, target: i64) -> bool {
        self.entries
            .binary_search_by_key(&target, |&(v, _)| v)
            .is_ok()
    }

    /// Computes $P(X \ge \text{target})$.
    pub fn prob_at_least(&self, target: i64) -> f64 {
        let start = self.entries.partition_point(|&(v, _)| v < target);
        canon_f64(neumaier_sum_entries(&self.entries[start..]))
    }

    /// Computes $P(X \le \text{target})$.
    pub fn prob_at_most(&self, target: i64) -> f64 {
        let end = self.entries.partition_point(|&(v, _)| v <= target);
        canon_f64(neumaier_sum_entries(&self.entries[..end]))
    }

    /// Returns $P(X = \text{target})$, or `0.0` if `target` is outside the support.
    pub fn prob_exactly(&self, target: i64) -> f64 {
        match self.entries.binary_search_by_key(&target, |&(v, _)| v) {
            Ok(idx) => canon_f64(self.entries[idx].1),
            Err(_) => 0.0,
        }
    }

    /// Computes $P(\text{lo} \le X \le \text{hi})$. Returns `0.0` when `lo > hi`.
    pub fn prob_in_range(&self, lo: i64, hi: i64) -> f64 {
        if lo > hi {
            return 0.0;
        }
        let start = self.entries.partition_point(|&(v, _)| v < lo);
        let end = self.entries.partition_point(|&(v, _)| v <= hi);
        canon_f64(neumaier_sum_entries(&self.entries[start..end]))
    }

    /// Cumulative distribution function $v \mapsto P(X \le v)$ in ascending support order.
    pub fn cdf(&self) -> Vec<(i64, f64)> {
        let mut out = Vec::with_capacity(self.entries.len());
        let mut cumulative = 0.0_f64;
        let mut comp = 0.0_f64;
        for &(v, p) in &self.entries {
            neumaier_add(&mut cumulative, &mut comp, p);
            out.push((v, canon_f64((cumulative + comp).max(0.0))));
        }
        out
    }

    /// Survival (complementary CDF) function $v \mapsto P(X \ge v)$ in ascending support order.
    pub fn survival(&self) -> Vec<(i64, f64)> {
        let total = neumaier_sum_entries(&self.entries);
        let mut out = Vec::with_capacity(self.entries.len());
        let mut below = 0.0_f64;
        let mut below_comp = 0.0_f64;
        for &(v, p) in &self.entries {
            let surv = (total - (below + below_comp)).max(0.0);
            out.push((v, canon_f64(surv)));
            neumaier_add(&mut below, &mut below_comp, p);
        }
        out
    }

    /// Break-even target solver (`§1.2`, `§9.2`):
    /// - `TargetDirection::AtLeast`: largest reachable `T` satisfying $P(X \ge T) \ge p$.
    /// - `TargetDirection::AtMost`: smallest reachable `T` satisfying $P(X \le T) \ge p$.
    ///
    /// Requires finite `p` in `(0.0, 1.0]`; returns [`RollError::InvalidProbability`] otherwise.
    pub fn target_for_probability(&self, p: f64, dir: TargetDirection) -> Result<i64, RollError> {
        if !p.is_finite() || p <= 0.0 || p > 1.0 {
            return Err(RollError::InvalidProbability {
                given: format!("{p}"),
            });
        }
        if self.entries.is_empty() {
            return Ok(0);
        }

        // Every outcome in `self.entries` has strictly positive rational probability (`§5.4`),
        // so `P(X <= T) >= 1` iff `T` is the true maximum and `P(X >= T) >= 1` iff `T` is the true minimum.
        if p == 1.0 {
            return Ok(match dir {
                TargetDirection::AtMost => self.entries[self.entries.len() - 1].0,
                TargetDirection::AtLeast => self.entries[0].0,
            });
        }

        // Guard against floating-point sum ~`1.0 - 1e-16` while remaining strictly > 0.0
        // even for tiny positive `p < 1e-12` so underflowed `0.0` tail entries never false-match.
        let threshold = (p - 1e-12).max(p * 0.5);

        match dir {
            TargetDirection::AtMost => {
                let mut cumulative = 0.0_f64;
                let mut comp = 0.0_f64;
                for &(v, prob) in &self.entries {
                    neumaier_add(&mut cumulative, &mut comp, prob);
                    if cumulative + comp >= threshold {
                        return Ok(v);
                    }
                }
                let fallback = self
                    .entries
                    .iter()
                    .rev()
                    .find(|&&(_, prob)| prob > 0.0)
                    .unwrap_or_else(|| self.entries.last().expect("non-empty"))
                    .0;
                Ok(fallback)
            }
            TargetDirection::AtLeast => {
                let mut answer = self.entries[0].0;
                let total = neumaier_sum_entries(&self.entries);
                let mut below = 0.0_f64;
                let mut below_comp = 0.0_f64;
                for &(v, prob) in &self.entries {
                    let survival = total - (below + below_comp);
                    if survival >= threshold {
                        answer = v;
                    }
                    neumaier_add(&mut below, &mut below_comp, prob);
                }
                Ok(answer)
            }
        }
    }

    /// Computes [`DistributionStats`] over this distribution.
    pub fn stats(&self) -> DistributionStats {
        compute_stats(self)
    }
}

/// Computes summary statistics (`min`, `max`, `mean`, `median`, `mode`, `stddev`, `percentiles`, `entropy`).
pub fn compute_stats(dist: &Distribution) -> DistributionStats {
    if dist.entries.is_empty() {
        return DistributionStats {
            min: 0,
            max: 0,
            mean: 0.0,
            median: 0,
            mode: 0,
            stddev: 0.0,
            percentiles: BTreeMap::new(),
            entropy: 0.0,
        };
    }

    let mass_sum = neumaier_sum_entries(&dist.entries);
    let needs_norm = (mass_sum - 1.0).abs() > 1e-12 && mass_sum > 0.0;
    let inv_norm = if needs_norm { 1.0 / mass_sum } else { 1.0 };

    let min = dist.entries[0].0;
    let max = dist.entries[dist.entries.len() - 1].0;

    let mut mean_sum = 0.0_f64;
    let mut mean_comp = 0.0_f64;
    let mut mode = min;
    let mut mode_prob = -1.0_f64;

    for &(v, raw_p) in &dist.entries {
        let p = if needs_norm { raw_p * inv_norm } else { raw_p };
        neumaier_add(&mut mean_sum, &mut mean_comp, (v as f64) * p);
        if p > mode_prob {
            mode_prob = p;
            mode = v;
        }
    }
    let mean = canon_f64(mean_sum + mean_comp);

    let mut var_sum = 0.0_f64;
    let mut var_comp = 0.0_f64;
    let mut ent_sum = 0.0_f64;
    let mut ent_comp = 0.0_f64;
    for &(v, raw_p) in &dist.entries {
        let p = if needs_norm { raw_p * inv_norm } else { raw_p };
        let diff = (v as f64) - mean;
        neumaier_add(&mut var_sum, &mut var_comp, p * (diff * diff));
        if p > 0.0 {
            neumaier_add(&mut ent_sum, &mut ent_comp, -(p * log2_f64(p)));
        }
    }
    let stddev = canon_f64(sqrt_f64((var_sum + var_comp).max(0.0)));
    let entropy = canon_f64((ent_sum + ent_comp).max(0.0));

    const PERCENTILE_KEYS: [u8; 6] = [10, 25, 50, 75, 90, 95];
    let mut percentiles = BTreeMap::new();
    let mut cumulative = 0.0_f64;
    let mut cum_comp = 0.0_f64;
    let mut pct_idx = 0usize;

    let last_positive_value = dist
        .entries
        .iter()
        .rev()
        .find(|&&(_, raw_p)| raw_p > 0.0)
        .map_or(max, |&(v, _)| v);

    for &(v, raw_p) in &dist.entries {
        let p = if needs_norm { raw_p * inv_norm } else { raw_p };
        neumaier_add(&mut cumulative, &mut cum_comp, p);
        let cur = cumulative + cum_comp;
        while pct_idx < PERCENTILE_KEYS.len() {
            let key = PERCENTILE_KEYS[pct_idx];
            let target = f64::from(key) / 100.0;
            if cur >= target - 1e-15 {
                percentiles.insert(key, v);
                pct_idx += 1;
            } else {
                break;
            }
        }
    }

    for key in PERCENTILE_KEYS {
        percentiles.entry(key).or_insert(last_positive_value);
    }

    let median = percentiles.get(&50).copied().unwrap_or(last_positive_value);

    DistributionStats {
        min,
        max,
        mean,
        median,
        mode,
        stddev,
        percentiles,
        entropy,
    }
}

/// Analyzes `expr` and returns its exact probability distribution (with any exercised engine caps)
/// or a deterministic Monte Carlo distribution (`Roll 3.0 §5`).
pub fn analyze(expr: &Expr) -> Result<AnalysisReport, RollError> {
    let total_dice = u64::from(expr.total_base_dice());
    if total_dice > u64::from(MAX_ANALYZE_DICE) {
        return Err(RollError::AnalysisBudgetExceeded {
            total_dice,
            max: u64::from(MAX_ANALYZE_DICE),
        });
    }

    // §5.4 items 1–2 & 5: check every `DivFloor` divisor subtree (cheapest first, ties by source
    // byte offset) under its own reserved budget before spending the main exact budget.
    precheck_divisors(expr)?;

    let mut budget = ExactBudget::new();
    match try_exact(expr, &mut budget) {
        Ok((distribution, caps)) if expr_max_die_rolls(expr) <= MAX_EXACT_DIE_ROLLS => {
            let stats = compute_stats(&distribution);
            Ok(AnalysisReport {
                distribution,
                stats,
                method: AnalysisMethod::Exact {
                    caps: caps.into_option(),
                },
            })
        }
        Err(ExactAbort::Error(err)) => Err(err),
        Ok(_) | Err(ExactAbort::TooLarge | ExactAbort::Unsupported) => {
            let (distribution, samples) = monte_carlo_fallback(expr, DEFAULT_MONTE_CARLO_SAMPLES)?;
            let stats = compute_stats(&distribution);
            Ok(AnalysisReport {
                distribution,
                stats,
                method: AnalysisMethod::MonteCarlo { samples },
            })
        }
    }
}

/// Compares two independent expressions `left` ($A$) and `right` ($B$) head-to-head (`§5.3`).
///
/// Computes exact `A - B` margin distribution when `|A| * |B|` and its accumulator stay within
/// the exact budget, and falls back to an $O(|A| + |B|)$ symmetric two-pointer linear scan
/// (`margin: None`) when `A - B` exceeds the budget (such as `compare("100d100", "100d100")`).
pub fn compare(left: &Expr, right: &Expr) -> Result<ComparisonReport, RollError> {
    let left_report = analyze(left)?;
    let right_report = analyze(right)?;

    let method = match (left_report.method, right_report.method) {
        (AnalysisMethod::Exact { caps: lc }, AnalysisMethod::Exact { caps: rc }) => {
            let mut merged = ModelledCaps::default();
            if let Some(c) = lc {
                merged.merge_from(c);
            }
            if let Some(c) = rc {
                merged.merge_from(c);
            }
            AnalysisMethod::Exact {
                caps: merged.into_option(),
            }
        }
        (
            AnalysisMethod::MonteCarlo { samples: sl },
            AnalysisMethod::MonteCarlo { samples: sr },
        ) => AnalysisMethod::MonteCarlo {
            samples: sl.min(sr),
        },
        (AnalysisMethod::MonteCarlo { samples }, _)
        | (_, AnalysisMethod::MonteCarlo { samples }) => AnalysisMethod::MonteCarlo { samples },
    };

    let a = &left_report.distribution;
    let b = &right_report.distribution;

    // Verify `A - B` cannot overflow `i64` on either the convolution or two-pointer path.
    if let (Some(&(a_min, _)), Some(&(a_max, _)), Some(&(b_min, _)), Some(&(b_max, _))) = (
        a.entries.first(),
        a.entries.last(),
        b.entries.first(),
        b.entries.last(),
    ) {
        a_min
            .checked_sub(b_max)
            .ok_or(RollError::ArithmeticOverflow)?;
        a_max
            .checked_sub(b_min)
            .ok_or(RollError::ArithmeticOverflow)?;
    }

    let mut margin_budget = ExactBudget::with_initial_live(a.len().saturating_add(b.len()));
    match subtract_distributions(a, b, &mut margin_budget) {
        Ok(margin_dist) => {
            let mut p_left_greater = 0.0_f64;
            let mut lg_comp = 0.0_f64;
            let mut p_equal = 0.0_f64;
            let mut eq_comp = 0.0_f64;
            let mut p_right_greater = 0.0_f64;
            let mut rg_comp = 0.0_f64;
            for &(v, p) in &margin_dist.entries {
                if v > 0 {
                    neumaier_add(&mut p_left_greater, &mut lg_comp, p);
                } else if v < 0 {
                    neumaier_add(&mut p_right_greater, &mut rg_comp, p);
                } else {
                    neumaier_add(&mut p_equal, &mut eq_comp, p);
                }
            }
            let mean_margin = canon_f64(left_report.stats.mean - right_report.stats.mean);
            Ok(ComparisonReport {
                left: left_report,
                right: right_report,
                p_left_greater: canon_f64((p_left_greater + lg_comp).max(0.0)),
                p_equal: canon_f64((p_equal + eq_comp).max(0.0)),
                p_right_greater: canon_f64((p_right_greater + rg_comp).max(0.0)),
                mean_margin,
                margin: Some(margin_dist),
                method,
            })
        }
        Err(ExactAbort::Error(err)) => Err(err),
        Err(ExactAbort::TooLarge | ExactAbort::Unsupported) => {
            let (p_left_greater, p_equal, p_right_greater) = two_pointer_compare(a, b);
            let mean_margin = canon_f64(left_report.stats.mean - right_report.stats.mean);
            Ok(ComparisonReport {
                left: left_report,
                right: right_report,
                p_left_greater,
                p_equal,
                p_right_greater,
                mean_margin,
                margin: None,
                method,
            })
        }
    }
}

fn two_pointer_compare(a: &Distribution, b: &Distribution) -> (f64, f64, f64) {
    let a_slice = &a.entries;
    let b_slice = &b.entries;

    let mut p_left_greater = 0.0_f64;
    let mut lg_comp = 0.0_f64;
    let mut p_equal = 0.0_f64;
    let mut eq_comp = 0.0_f64;
    let mut j = 0usize;
    let mut b_less_mass = 0.0_f64;
    let mut b_less_comp = 0.0_f64;
    for &(va, pa) in a_slice {
        while j < b_slice.len() && b_slice[j].0 < va {
            neumaier_add(&mut b_less_mass, &mut b_less_comp, b_slice[j].1);
            j += 1;
        }
        neumaier_add(
            &mut p_left_greater,
            &mut lg_comp,
            pa * (b_less_mass + b_less_comp).max(0.0),
        );
        if j < b_slice.len() && b_slice[j].0 == va {
            neumaier_add(&mut p_equal, &mut eq_comp, pa * b_slice[j].1);
        }
    }

    // Symmetric scan of `B` against `A` so `compare(X, X)` yields bit-identical win probabilities.
    let mut p_right_greater = 0.0_f64;
    let mut rg_comp = 0.0_f64;
    let mut i = 0usize;
    let mut a_less_mass = 0.0_f64;
    let mut a_less_comp = 0.0_f64;
    for &(vb, pb) in b_slice {
        while i < a_slice.len() && a_slice[i].0 < vb {
            neumaier_add(&mut a_less_mass, &mut a_less_comp, a_slice[i].1);
            i += 1;
        }
        neumaier_add(
            &mut p_right_greater,
            &mut rg_comp,
            pb * (a_less_mass + a_less_comp).max(0.0),
        );
    }

    (
        canon_f64((p_left_greater + lg_comp).max(0.0)),
        canon_f64((p_equal + eq_comp).max(0.0)),
        canon_f64((p_right_greater + rg_comp).max(0.0)),
    )
}

// ─── Internal AST-wide exact budget & accumulators ───────────────────────────

#[derive(Debug)]
enum ExactAbort {
    TooLarge,
    Unsupported,
    Error(RollError),
}

/// AST-wide cumulative transition and live-state budget threaded through `try_exact`.
struct ExactBudget {
    transitions: usize,
    max_transitions: usize,
    live_states: usize,
}

impl ExactBudget {
    const fn new() -> Self {
        Self {
            transitions: 0,
            max_transitions: MAX_EXACT_STATES,
            live_states: 0,
        }
    }

    const fn with_cap(max_transitions: usize) -> Self {
        Self {
            transitions: 0,
            max_transitions,
            live_states: 0,
        }
    }

    const fn with_initial_live(live_states: usize) -> Self {
        Self {
            transitions: 0,
            max_transitions: MAX_EXACT_STATES,
            live_states,
        }
    }

    /// Charges `work` elementary transitions before executing a loop or initialization.
    /// Leaves `self.transitions` unchanged if `self.transitions + work > self.max_transitions`.
    #[inline]
    fn charge_transitions(&mut self, work: u128) -> Result<(), ExactAbort> {
        let rem = self.max_transitions.saturating_sub(self.transitions) as u128;
        if work > rem {
            return Err(ExactAbort::TooLarge);
        }
        self.transitions += work as usize;
        Ok(())
    }

    /// Reserves `slots` live state slots before allocating heap storage.
    #[inline]
    fn reserve_live(&mut self, slots: usize) -> Result<(), ExactAbort> {
        if slots > MAX_EXACT_LIVE_STATES.saturating_sub(self.live_states) {
            return Err(ExactAbort::TooLarge);
        }
        self.live_states += slots;
        Ok(())
    }

    /// Releases `slots` previously reserved live state slots after dropping storage.
    #[inline]
    fn release_live(&mut self, slots: usize) {
        debug_assert!(
            self.live_states >= slots,
            "released {slots} slots with only {} live",
            self.live_states
        );
        self.live_states = self.live_states.saturating_sub(slots);
    }
}

/// Static `(upper_cost_bound, upper_support_bound)` computed from parsed dice counts, sides,
/// and stage modifiers (`§5.4` item 1) so the divisor pre-pass orders divisors cheapest first
/// without executing `try_exact`.
fn divisor_static_cost_bound(expr: &Expr) -> (u128, u128) {
    match expr {
        Expr::Number(_) => (1, 1),
        Expr::UnaryNeg(inner) => {
            let (c, sup) = divisor_static_cost_bound(inner);
            (c.saturating_add(sup), sup)
        }
        Expr::Dice(spec) => {
            let n_usize = spec.count.get() as usize;
            let n = n_usize as u128;
            let s = side_count(spec.sides) as u128;
            let reroll_passes = 1_u128
                .saturating_add(spec.reroll_unlimited.len() as u128)
                .saturating_add(spec.reroll_once.len() as u128)
                .saturating_add(u128::from(spec.clamp.is_some()));
            let pre_cost = reroll_passes.saturating_mul(s);

            let max_steps = u128::from(MAX_EXPLOSIONS) + 1;
            let (die_sup, exp_cost) = match spec.explode {
                None => (s, 0),
                Some(rule) => match (&spec.mode, rule.variant, spec.keep_drop.is_empty()) {
                    (
                        ResultMode::Pool { .. },
                        ExplosionVariant::Standard | ExplosionVariant::Penetrate,
                        true,
                    ) => {
                        let pool_chain_sup = 2 * u128::from(MAX_EXPLOSIONS) + 3;
                        let cost = max_steps.saturating_mul(pool_chain_sup).saturating_mul(s);
                        (pool_chain_sup, cost)
                    }
                    _ => {
                        let chain_sup = max_steps.saturating_mul(s);
                        let cost = max_steps
                            .saturating_mul(chain_sup)
                            .saturating_mul(s)
                            .saturating_mul(SPARSE_TRANSITION_WEIGHT);
                        (chain_sup, cost)
                    }
                },
            };

            if !spec.keep_drop.is_empty() {
                let (l, r) = reduce_keep_drop_interval(n_usize, &spec.keep_drop);
                if l == r {
                    return (pre_cost.saturating_add(exp_cost).saturating_add(1), 1);
                }
                if l > 0 || r < n_usize {
                    let dp_sup = match &spec.mode {
                        ResultMode::Pool { .. } => 2 * n + 1,
                        ResultMode::Sum { .. } => n.saturating_mul(die_sup),
                    };
                    let dp_cost = die_sup
                        .saturating_mul(n + 1)
                        .saturating_mul(n + 1)
                        .saturating_mul(dp_sup)
                        .saturating_mul(SPARSE_TRANSITION_WEIGHT);
                    return (
                        pre_cost.saturating_add(exp_cost).saturating_add(dp_cost),
                        dp_sup,
                    );
                }
            }

            let contrib_sup = match &spec.mode {
                ResultMode::Pool { .. } if spec.explode.is_none() => 3,
                ResultMode::Pool { .. } => 2 * u128::from(MAX_EXPLOSIONS) + 3,
                ResultMode::Sum { .. } => die_sup,
            };
            let group_sup = n.saturating_mul(contrib_sup);
            let conv_cost = if n <= 1 {
                contrib_sup
            } else {
                n.saturating_mul(n)
                    .saturating_mul(contrib_sup)
                    .saturating_mul(contrib_sup)
            };
            (
                pre_cost.saturating_add(exp_cost).saturating_add(conv_cost),
                group_sup.max(1),
            )
        }
        Expr::Binary { op, left, right } => {
            let (lc, lsup) = divisor_static_cost_bound(left);
            let (rc, rsup) = divisor_static_cost_bound(right);
            let (step_cost, out_sup) = if lsup == 1 && rsup == 1 {
                (1, 1)
            } else if rsup == 1 {
                (lsup.saturating_mul(SPARSE_TRANSITION_WEIGHT), lsup)
            } else if lsup == 1 && *op != BinaryOp::DivFloor {
                (rsup, rsup)
            } else {
                let pairs = lsup.saturating_mul(rsup);
                let out_s = match op {
                    BinaryOp::Add | BinaryOp::Sub => lsup.saturating_add(rsup).saturating_sub(1),
                    BinaryOp::Mul | BinaryOp::DivFloor => pairs,
                };
                (pairs.saturating_mul(SPARSE_TRANSITION_WEIGHT), out_s.max(1))
            };
            (
                lc.saturating_add(rc).saturating_add(step_cost),
                out_sup.max(1),
            )
        }
    }
}

/// Collects every `BinaryOp::DivFloor` divisor subtree in left-to-right in-order AST sequence.
///
/// In Roll 3.0's infix binary / prefix unary grammar, every `/` token appears strictly after all
/// tokens in its `left` child and strictly before all tokens in its `right` divisor subtree, and
/// each divisor begins immediately after its `/` token. Consequently, for any two `DivFloor` nodes
/// in a parsed AST, `inorder_idx` is strictly order-isomorphic to source byte offset.
fn collect_divisors_inorder<'a>(expr: &'a Expr, out: &mut Vec<(u128, usize, &'a Expr)>) {
    match expr {
        Expr::Number(_) | Expr::Dice(_) => {}
        Expr::UnaryNeg(inner) => collect_divisors_inorder(inner, out),
        Expr::Binary { op, left, right } => {
            collect_divisors_inorder(left, out);
            if *op == BinaryOp::DivFloor {
                let idx = out.len();
                let (cost_bound, _) = divisor_static_cost_bound(right);
                out.push((cost_bound, idx, right));
            }
            collect_divisors_inorder(right, out);
        }
    }
}

/// Runs the `§5.4` divisor pre-pass under [`MAX_DIVISOR_PREPASS_STATES`] before the main pass.
fn precheck_divisors(expr: &Expr) -> Result<(), RollError> {
    let mut divisors = Vec::new();
    collect_divisors_inorder(expr, &mut divisors);
    if divisors.is_empty() {
        return Ok(());
    }

    divisors.sort_by_key(|&(cost_bound, inorder_idx, _)| (cost_bound, inorder_idx));

    let mut prepass_spent: usize = 0;
    let mut deferred_error: Option<RollError> = None;

    for (_, _, divisor) in divisors {
        if expr_max_die_rolls(divisor) > MAX_EXACT_DIE_ROLLS {
            continue;
        }
        let rem = MAX_DIVISOR_PREPASS_STATES.saturating_sub(prepass_spent);
        if rem == 0 {
            break;
        }
        let mut div_budget = ExactBudget::with_cap(rem.min(MAX_EXACT_STATES));
        let res = try_exact(divisor, &mut div_budget);
        prepass_spent = prepass_spent.saturating_add(div_budget.transitions);

        match res {
            Ok((dist, _)) => {
                let zero_reachable = dist.is_reachable(0);
                let dist_len = dist.len();
                drop(dist);
                div_budget.release_live(dist_len);
                if zero_reachable {
                    return Err(RollError::DivisionByZero);
                }
            }
            Err(ExactAbort::Error(RollError::DivisionByZero)) => {
                return Err(RollError::DivisionByZero);
            }
            Err(ExactAbort::Error(other_err)) => {
                // §5.4 items 1 & 5: check every remaining exact divisor for a reachable `0`
                // before returning any non-`DivisionByZero` error from the pre-pass.
                if deferred_error.is_none() {
                    deferred_error = Some(other_err);
                }
            }
            Err(ExactAbort::TooLarge | ExactAbort::Unsupported) => {}
        }
    }

    if let Some(err) = deferred_error {
        return Err(err);
    }
    Ok(())
}

enum Accum {
    Dense {
        min_key: i64,
        slots: Vec<(bool, f64)>,
    },
    Sparse(BTreeMap<i64, f64>),
}

impl Accum {
    fn with_bounds(
        min_key: i64,
        max_key: i64,
        budget: &mut ExactBudget,
    ) -> Result<Self, ExactAbort> {
        if min_key <= max_key {
            let span = (i128::from(max_key) - i128::from(min_key) + 1) as u128;
            if span <= MAX_DENSE_SPAN {
                let len = span as usize;
                budget.charge_transitions(span)?;
                budget.reserve_live(len)?;
                return Ok(Self::Dense {
                    min_key,
                    slots: vec![(false, 0.0_f64); len],
                });
            }
        }
        Ok(Self::Sparse(BTreeMap::new()))
    }

    const fn is_sparse(&self) -> bool {
        matches!(self, Self::Sparse(_))
    }

    #[inline]
    fn add(&mut self, key: i64, prob: f64, budget: &mut ExactBudget) -> Result<(), ExactAbort> {
        self.add_capped(key, prob, usize::MAX, budget)
    }

    #[inline]
    fn add_capped(
        &mut self,
        key: i64,
        prob: f64,
        max_sparse_len: usize,
        budget: &mut ExactBudget,
    ) -> Result<(), ExactAbort> {
        match self {
            Self::Dense { min_key, slots } => {
                let idx = (i128::from(key) - i128::from(*min_key)) as usize;
                let slot = &mut slots[idx];
                slot.0 = true;
                slot.1 += prob;
                Ok(())
            }
            Self::Sparse(map) => {
                let cur_len = map.len();
                match map.entry(key) {
                    Entry::Occupied(mut occ) => {
                        *occ.get_mut() += prob;
                        Ok(())
                    }
                    Entry::Vacant(vac) => {
                        if cur_len >= max_sparse_len {
                            return Err(ExactAbort::TooLarge);
                        }
                        budget.reserve_live(SPARSE_STATE_SLOTS)?;
                        vac.insert(prob);
                        Ok(())
                    }
                }
            }
        }
    }

    /// Converts an intermediate partial-probability accumulator into sorted `(value, prob)` entries
    /// without normalizing singletons (`order_statistic_dp` and explosion chains hold partial mass `< 1.0`).
    fn into_entries(self, budget: &mut ExactBudget) -> Result<Vec<(i64, f64)>, ExactAbort> {
        match self {
            Self::Dense { min_key, slots } => {
                let slots_len = slots.len();
                let reached_count = slots.iter().filter(|&&(reached, _)| reached).count();
                budget.reserve_live(reached_count)?;
                let mut vec_out = Vec::with_capacity(reached_count);
                for (idx, (reached, p)) in slots.into_iter().enumerate() {
                    if reached {
                        let key = (i128::from(min_key) + (idx as i128)) as i64;
                        vec_out.push((key, canon_f64(p)));
                    }
                }
                budget.release_live(slots_len);
                Ok(vec_out)
            }
            Self::Sparse(map) => {
                let map_len = map.len();
                budget.reserve_live(map_len)?;
                let mut vec_out = Vec::with_capacity(map_len);
                for (k, p) in map {
                    vec_out.push((k, canon_f64(p)));
                }
                budget.release_live(map_len * SPARSE_STATE_SLOTS);
                Ok(vec_out)
            }
        }
    }

    fn into_distribution(self, budget: &mut ExactBudget) -> Result<Distribution, ExactAbort> {
        let mut entries = self.into_entries(budget)?;
        normalize_if_singleton(&mut entries);
        Ok(Distribution { entries })
    }
}

fn expr_contains_div(mut expr: &Expr) -> bool {
    loop {
        match expr {
            Expr::Number(_) | Expr::Dice(_) => return false,
            Expr::UnaryNeg(inner) => expr = inner,
            Expr::Binary { op, left, right } => {
                if *op == BinaryOp::DivFloor || expr_contains_div(right) {
                    return true;
                }
                expr = left;
            }
        }
    }
}

type ExactNodeResult = Result<(Distribution, ModelledCaps), ExactAbort>;

enum ExactCont<'a> {
    FinishNeg {
        live_base: usize,
    },
    BinaryAfterFirst {
        op: BinaryOp,
        right_first: bool,
        second: &'a Expr,
        live_base: usize,
    },
    BinaryAfterSecond {
        op: BinaryOp,
        right_first: bool,
        first_res: ExactNodeResult,
        live_base: usize,
    },
}

#[inline]
fn finish_node_frame(
    res: ExactNodeResult,
    live_base: usize,
    budget: &mut ExactBudget,
) -> ExactNodeResult {
    match res {
        Ok((dist, caps)) => {
            debug_assert_eq!(
                budget.live_states,
                live_base + dist.len(),
                "live-state accounting mismatch on Ok"
            );
            Ok((dist, caps))
        }
        Err(abort) => {
            budget.live_states = live_base;
            Err(abort)
        }
    }
}

fn combine_binary_exact(
    op: BinaryOp,
    right_first: bool,
    first_res: ExactNodeResult,
    second_res: ExactNodeResult,
    budget: &mut ExactBudget,
) -> ExactNodeResult {
    if let Err(ExactAbort::Error(err)) = second_res {
        drop(first_res);
        return Err(ExactAbort::Error(err));
    }
    let (left_res, right_res) = if right_first {
        (second_res, first_res)
    } else {
        (first_res, second_res)
    };
    let (left_dist, left_caps) = match left_res {
        Ok(ok) => ok,
        Err(abort) => {
            drop(right_res);
            return Err(abort);
        }
    };
    let (right_dist, right_caps) = match right_res {
        Ok(ok) => ok,
        Err(abort) => {
            drop(left_dist);
            return Err(abort);
        }
    };

    let out_res = eval_binary_distributions(op, &left_dist, &right_dist, budget);
    let l_len = left_dist.len();
    let r_len = right_dist.len();
    drop(left_dist);
    drop(right_dist);
    budget.release_live(l_len + r_len);

    let out = out_res?;
    let mut caps = left_caps;
    caps.merge_from(right_caps);
    Ok((out, caps))
}

/// Evaluates `expr` iteratively using an explicit heap continuation stack so neither nested
/// factors (`MAX_NESTING_DEPTH = 64`) nor 499-operator left-associative chains can grow the
/// native call stack in unoptimized debug builds.
fn try_exact(expr: &Expr, budget: &mut ExactBudget) -> ExactNodeResult {
    let mut stack: Vec<ExactCont<'_>> = Vec::new();
    let mut cur_expr: Option<&Expr> = Some(expr);
    let mut last_res: Option<ExactNodeResult> = None;

    loop {
        if let Some(node) = cur_expr.take() {
            let live_base = budget.live_states;
            match node {
                Expr::Number(v) => {
                    let res = budget
                        .charge_transitions(1)
                        .and_then(|()| budget.reserve_live(1))
                        .map(|()| (Distribution::point(*v), ModelledCaps::default()));
                    last_res = Some(finish_node_frame(res, live_base, budget));
                }
                Expr::Dice(spec) => {
                    let res = try_exact_dice(spec, budget);
                    last_res = Some(finish_node_frame(res, live_base, budget));
                }
                Expr::UnaryNeg(operand) => {
                    stack.push(ExactCont::FinishNeg { live_base });
                    cur_expr = Some(operand);
                }
                Expr::Binary { op, left, right } => {
                    // §5.4 Divide-by-zero & AST-wide budget interaction:
                    // - Evaluate `right` BEFORE `left` whenever `*op == BinaryOp::DivFloor`
                    //   (giving the divisor first claim on the budget and failing immediately on
                    //   `is_reachable(0)`), or on `+`/`-`/`*` when `right` contains a division and
                    //   `left` does not.
                    // - On division-free left-associative spines (`52 × (3163*d3162+d3162)`),
                    //   evaluate `left` before `right` so right-hand leaves are not stacked.
                    // - Isolate `TooLarge` / `Unsupported` across siblings so deterministic errors
                    //   in the other child still propagate when budget remains.
                    let right_first = *op == BinaryOp::DivFloor
                        || (expr_contains_div(right) && !expr_contains_div(left));
                    let (first, second) = if right_first {
                        (right.as_ref(), left.as_ref())
                    } else {
                        (left.as_ref(), right.as_ref())
                    };
                    stack.push(ExactCont::BinaryAfterFirst {
                        op: *op,
                        right_first,
                        second,
                        live_base,
                    });
                    cur_expr = Some(first);
                }
            }
        } else {
            let child_res = last_res.take().expect("ascending requires child result");
            match stack.pop() {
                None => return child_res,
                Some(ExactCont::FinishNeg { live_base }) => {
                    let res = match child_res {
                        Ok((inner, caps)) => {
                            let neg_res = negate_distribution(&inner, budget);
                            let inner_len = inner.len();
                            drop(inner);
                            budget.release_live(inner_len);
                            neg_res.map(|negated| (negated, caps))
                        }
                        Err(abort) => Err(abort),
                    };
                    last_res = Some(finish_node_frame(res, live_base, budget));
                }
                Some(ExactCont::BinaryAfterFirst {
                    op,
                    right_first,
                    second,
                    live_base,
                }) => match child_res {
                    Err(ExactAbort::Error(err)) => {
                        last_res = Some(finish_node_frame(
                            Err(ExactAbort::Error(err)),
                            live_base,
                            budget,
                        ));
                    }
                    Ok((r_dist, _))
                        if right_first && op == BinaryOp::DivFloor && r_dist.is_reachable(0) =>
                    {
                        drop(r_dist);
                        last_res = Some(finish_node_frame(
                            Err(ExactAbort::Error(RollError::DivisionByZero)),
                            live_base,
                            budget,
                        ));
                    }
                    first_res => {
                        stack.push(ExactCont::BinaryAfterSecond {
                            op,
                            right_first,
                            first_res,
                            live_base,
                        });
                        cur_expr = Some(second);
                    }
                },
                Some(ExactCont::BinaryAfterSecond {
                    op,
                    right_first,
                    first_res,
                    live_base,
                }) => {
                    let res = combine_binary_exact(op, right_first, first_res, child_res, budget);
                    last_res = Some(finish_node_frame(res, live_base, budget));
                }
            }
        }
    }
}

fn eval_binary_distributions(
    op: BinaryOp,
    left: &Distribution,
    right: &Distribution,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    if right.len() == 1 {
        let rv = right.entries[0].0;
        let r_mass = right.entries[0].1;
        let out = match op {
            BinaryOp::Add => shift_distribution_weighted(left, rv, r_mass, budget)?,
            BinaryOp::Sub => {
                // `va - rv` directly so `rv == i64::MIN` works whenever `va < 0`!
                subtract_scalar_weighted(left, rv, r_mass, budget)?
            }
            BinaryOp::Mul => scale_distribution_weighted(left, rv, r_mass, budget)?,
            BinaryOp::DivFloor => divide_distribution_weighted(left, rv, r_mass, budget)?,
        };
        return Ok(out);
    }

    if left.len() == 1 {
        let lv = left.entries[0].0;
        let l_mass = left.entries[0].1;
        let out = match op {
            BinaryOp::Add => shift_distribution_weighted(right, lv, l_mass, budget)?,
            BinaryOp::Sub => subtract_from_scalar_weighted(lv, l_mass, right, budget)?,
            BinaryOp::Mul => scale_distribution_weighted(right, lv, l_mass, budget)?,
            BinaryOp::DivFloor => divide_distributions(left, right, budget)?,
        };
        return Ok(out);
    }

    match op {
        BinaryOp::Add => convolve(left, right, budget),
        BinaryOp::Sub => subtract_distributions(left, right, budget),
        BinaryOp::Mul => multiply_distributions(left, right, budget),
        BinaryOp::DivFloor => divide_distributions(left, right, budget),
    }
}

// ─── §5.1 Single-die PMF composition in pipeline stage order ─────────────────

const fn side_count(sides: DiceSides) -> usize {
    match sides {
        DiceSides::Standard(n) => n.get() as usize,
        DiceSides::Percentile => 100,
        DiceSides::Fate => 3,
    }
}

#[inline]
const fn apply_clamp_value(mut v: i64, clamp: ClampBounds) -> i64 {
    if let Some(lo) = clamp.min
        && v < lo
    {
        v = lo;
    }
    if let Some(hi) = clamp.max
        && v > hi
    {
        v = hi;
    }
    v
}

/// Composes Stage 1 (base uniform die) -> Stage 2 (`reroll_unlimited` with `MAX_REROLLS = 100`
/// residual + `reroll_once`) -> Stage 3 (`min`/`max` clamp).
fn single_die_pre_explode(
    spec: &DiceSpec,
    caps: &mut ModelledCaps,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    if let Some(clamp) = spec.clamp
        && let (Some(lo), Some(hi)) = (clamp.min, clamp.max)
        && lo > hi
    {
        return Err(ExactAbort::Error(RollError::InvalidClampBounds {
            min: lo,
            max: hi,
            byte_offset: 0,
        }));
    }

    let s = side_count(spec.sides);
    if s > MAX_EXACT_STATES {
        return Err(ExactAbort::TooLarge);
    }

    // Exact integer face-counting fast path for clamped dice without Stage 2 rerolls:
    // avoids summing `1.0 / s` `O(s)` times in `f64` and runs in `O(post-clamp support)`.
    if spec.reroll_unlimited.is_empty()
        && spec.reroll_once.is_empty()
        && let Some(clamp) = spec.clamp
    {
        let raw_min = spec.sides.min_face();
        let raw_max = spec.sides.max_face();
        let v_min = apply_clamp_value(raw_min, clamp);
        let v_max = apply_clamp_value(raw_max, clamp);
        if v_min == v_max {
            budget.charge_transitions(1)?;
            budget.reserve_live(1)?;
            return Ok(Distribution::point(v_min));
        }

        let out_len = (v_max - v_min + 1) as usize;
        budget.charge_transitions(out_len as u128)?;
        budget.reserve_live(out_len)?;

        let s_f64 = s as f64;
        let low_count = (v_min - raw_min + 1) as u64;
        let high_count = (raw_max - v_max + 1) as u64;
        let p_one = canon_f64(1.0 / s_f64);

        let mut out = Vec::with_capacity(out_len);
        out.push((v_min, canon_f64((low_count as f64) / s_f64)));
        for v in (v_min + 1)..v_max {
            out.push((v, p_one));
        }
        out.push((v_max, canon_f64((high_count as f64) / s_f64)));
        return Ok(Distribution { entries: out });
    }

    let reroll_passes = 1_u128
        .saturating_add(spec.reroll_unlimited.len() as u128)
        .saturating_add(spec.reroll_once.len() as u128)
        .saturating_add(u128::from(spec.clamp.is_some()));
    budget.charge_transitions(reroll_passes.saturating_mul(s as u128))?;
    budget.reserve_live(s)?;

    // Stage 1: Uniform base faces in ascending order. Every base face stays reachable
    // throughout Stage 2a and Stage 2b (even when a residual probability underflows `f64`).
    let mut base_entries: Vec<(i64, f64)> = match spec.sides {
        DiceSides::Fate => {
            let p = 1.0 / 3.0;
            vec![(-1, p), (0, p), (1, p)]
        }
        DiceSides::Standard(_) | DiceSides::Percentile => {
            let p = 1.0 / (s as f64);
            (1..=s).map(|f| (f as i64, p)).collect()
        }
    };

    // Stage 2a: Unlimited rerolls (`MAX_REROLLS = 100` per modifier per die).
    for &cp in &spec.reroll_unlimited {
        let mut match_count = 0usize;
        let mut p_match_sum = 0.0_f64;
        let mut p_match_comp = 0.0_f64;
        for &(face, p) in &base_entries {
            if cp.matches(face) {
                match_count += 1;
                neumaier_add(&mut p_match_sum, &mut p_match_comp, p);
            }
        }
        if match_count == 0 {
            continue;
        }
        let p_match = (p_match_sum + p_match_comp).max(0.0);

        // Because every base face is reachable entering each Stage 2a modifier and `match_count > 0`,
        // rolling matching faces `MAX_REROLLS` times in a row is reachable in `eval.rs`.
        caps.max_rerolls = Some(MAX_REROLLS);

        if match_count == s {
            // Every face matches (e.g. `1d6r>=1`): all 100 rerolls match and the 100th fresh
            // uniform draw stands across all `s` faces.
            let total_mass = neumaier_sum_entries(&base_entries);
            let uniform = total_mass / (s as f64);
            for entry in &mut base_entries {
                entry.1 = canon_f64(uniform);
            }
        } else {
            let keep_count = s - match_count;
            let q = (match_count as f64) / (s as f64);
            let q_cap = powi_u32(q, MAX_REROLLS);
            let share_keep = (p_match * (1.0 - q_cap)) / (keep_count as f64);
            let residual_match = canon_f64((p_match * q_cap) / (match_count as f64));

            for entry in &mut base_entries {
                if cp.matches(entry.0) {
                    // Reachable residual outcome stays in the support even if `residual_match == 0.0`.
                    entry.1 = residual_match;
                } else {
                    entry.1 = canon_f64(entry.1 + share_keep);
                }
            }
        }
    }

    // Stage 2b: Reroll once.
    for &cp in &spec.reroll_once {
        let mut match_count = 0usize;
        let mut p_match_sum = 0.0_f64;
        let mut p_match_comp = 0.0_f64;
        for &(face, p) in &base_entries {
            if cp.matches(face) {
                match_count += 1;
                neumaier_add(&mut p_match_sum, &mut p_match_comp, p);
            }
        }
        if match_count == 0 {
            continue;
        }
        let p_match = (p_match_sum + p_match_comp).max(0.0);

        let reroll_share = p_match / (s as f64);
        for entry in &mut base_entries {
            let base_kept = if cp.matches(entry.0) { 0.0 } else { entry.1 };
            entry.1 = canon_f64(base_kept + reroll_share);
        }
    }

    // Stage 3: Clamp over already-sorted `base_entries` using Neumaier compensated run-length summation.
    if let Some(clamp) = spec.clamp {
        let first_v = apply_clamp_value(base_entries[0].0, clamp);
        let last_v = apply_clamp_value(base_entries[base_entries.len() - 1].0, clamp);
        if first_v == last_v {
            drop(base_entries);
            budget.release_live(s);
            budget.reserve_live(1)?;
            return Ok(Distribution::point(first_v));
        }

        // Count distinct clamped values in sorted `base_entries` before allocating `clamped`.
        let mut distinct = 1usize;
        let mut prev_clamped = first_v;
        for &(raw_v, _) in &base_entries[1..] {
            let cv = apply_clamp_value(raw_v, clamp);
            if cv != prev_clamped {
                distinct += 1;
                prev_clamped = cv;
            }
        }

        budget.reserve_live(distinct)?;
        let mut clamped = Vec::with_capacity(distinct);
        let mut cur_v = first_v;
        let mut cur_sum = 0.0_f64;
        let mut cur_comp = 0.0_f64;
        for (raw_v, p) in base_entries {
            let cv = apply_clamp_value(raw_v, clamp);
            if cv == cur_v {
                neumaier_add(&mut cur_sum, &mut cur_comp, p);
            } else {
                clamped.push((cur_v, canon_f64((cur_sum + cur_comp).max(0.0))));
                cur_v = cv;
                cur_sum = p;
                cur_comp = 0.0;
            }
        }
        clamped.push((cur_v, canon_f64((cur_sum + cur_comp).max(0.0))));
        budget.release_live(s);
        normalize_if_singleton(&mut clamped);
        Ok(Distribution { entries: clamped })
    } else {
        normalize_if_singleton(&mut base_entries);
        Ok(Distribution {
            entries: base_entries,
        })
    }
}

/// Stage 4 single-chain sum expansion (`Standard`, `Compound`, `Penetrate`) up to `MAX_EXPLOSIONS = 100`.
fn explosion_chain_sum_pmf(
    initial_dist: &Distribution,
    s: usize,
    rule: ExplosionRule,
    caps: &mut ModelledCaps,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let live_base = budget.live_states;
    let res = explosion_chain_sum_pmf_inner(initial_dist, s, rule, caps, budget);
    if res.is_err() {
        budget.live_states = live_base;
    }
    res
}

fn explosion_chain_sum_pmf_inner(
    initial_dist: &Distribution,
    s: usize,
    rule: ExplosionRule,
    caps: &mut ModelledCaps,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let is_penetrate = rule.variant == ExplosionVariant::Penetrate;
    budget.charge_transitions(s as u128)?;

    // Tight `i128` span bound for `finished` so small/medium exploding dice (`1d6!`, `5d9!!>2kl2`)
    // use dense `O(1)` storage while huge dice (`1d1000000!`) fall back to capped sparse storage.
    let min_0 = i128::from(initial_dist.entries[0].0);
    let max_0 = i128::from(initial_dist.entries[initial_dist.len() - 1].0);
    let init_explodes = initial_dist
        .entries
        .iter()
        .any(|&(raw_face, _)| rule.threshold.matches(raw_face));
    let raw_explodes = (1..=s).any(|f| rule.threshold.matches(f as i64));
    let max_bonus = if is_penetrate {
        (s as i128 - 1).max(1)
    } else {
        s as i128
    };
    let max_chain = if !init_explodes {
        max_0
    } else if !raw_explodes {
        max_0 + max_bonus
    } else {
        max_0 + i128::from(MAX_EXPLOSIONS) * max_bonus
    };

    let mut finished = if max_chain >= min_0
        && ((max_chain - min_0 + 1) as u128) <= MAX_DENSE_SPAN
        && let (Ok(lo_i64), Ok(hi_i64)) = (i64::try_from(min_0), i64::try_from(max_chain))
    {
        Accum::with_bounds(lo_i64, hi_i64, budget)?
    } else {
        Accum::Sparse(BTreeMap::new())
    };

    budget.reserve_live(s + 1)?;
    let p_raw = 1.0 / (s as f64);
    let raw_faces: Vec<(i64, f64)> = (1..=s).map(|f| (f as i64, p_raw)).collect();
    let mut accumulated: Vec<(i64, f64)> = vec![(0, 1.0)];

    for depth in 0..=MAX_EXPLOSIONS {
        let step_faces: &[(i64, f64)] = if depth == 0 {
            &initial_dist.entries
        } else {
            &raw_faces
        };

        let min_eff = if is_penetrate && depth > 0 {
            (step_faces[0].0 - 1).max(1)
        } else {
            step_faces[0].0
        };
        let max_eff = if is_penetrate && depth > 0 {
            (step_faces[step_faces.len() - 1].0 - 1).max(1)
        } else {
            step_faces[step_faces.len() - 1].0
        };
        let min_next = accumulated[0]
            .0
            .checked_add(min_eff)
            .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
        let max_next = accumulated[accumulated.len() - 1]
            .0
            .checked_add(max_eff)
            .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;

        let exploding_faces = if depth == MAX_EXPLOSIONS {
            0usize
        } else {
            step_faces
                .iter()
                .filter(|&&(raw_face, _)| rule.threshold.matches(raw_face))
                .count()
        };
        let finishing_faces = step_faces.len() - exploding_faces;

        // Pre-allocation bound check: at `depth == 0`, `accumulated == [(0, 1.0)]` and `step_faces`
        // has strictly distinct keys, so `finishing_faces` distinct keys would be inserted.
        if depth == 0 && finished.is_sparse() && finishing_faces > MAX_EXPLOSION_FINISHED_STATES {
            return Err(ExactAbort::TooLarge);
        }

        let mut next_acc = if exploding_faces > 0 {
            Some(Accum::with_bounds(min_next, max_next, budget)?)
        } else {
            None
        };

        let acc_len = accumulated.len() as u128;
        let finish_weight = if finished.is_sparse() {
            SPARSE_TRANSITION_WEIGHT
        } else {
            1
        };
        let finish_cost = acc_len
            .saturating_mul(finishing_faces as u128)
            .saturating_mul(finish_weight);
        let next_weight = if next_acc.as_ref().is_some_and(Accum::is_sparse) {
            SPARSE_TRANSITION_WEIGHT
        } else {
            1
        };
        let next_cost = acc_len
            .saturating_mul(exploding_faces as u128)
            .saturating_mul(next_weight);
        budget.charge_transitions(finish_cost.saturating_add(next_cost))?;

        for &(acc_sum, acc_prob) in &accumulated {
            for &(raw_face, p_face) in step_faces {
                let effective = if is_penetrate && depth > 0 {
                    (raw_face - 1).max(1)
                } else {
                    raw_face
                };
                let total = acc_sum
                    .checked_add(effective)
                    .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
                let prod = acc_prob * p_face;

                // Threshold comparison uses the unadjusted raw face (`eval.rs:277,293`).
                let explodes = rule.threshold.matches(raw_face);
                if !explodes || depth == MAX_EXPLOSIONS {
                    if explodes {
                        caps.max_explosions = Some(MAX_EXPLOSIONS);
                    }
                    finished.add_capped(total, prod, MAX_EXPLOSION_FINISHED_STATES, budget)?;
                } else if let Some(ref mut acc) = next_acc {
                    acc.add(total, prod, budget)?;
                }
            }
        }

        let old_acc_len = accumulated.len();
        drop(accumulated);
        budget.release_live(old_acc_len);

        match next_acc {
            Some(acc) => {
                accumulated = acc.into_entries(budget)?;
                if accumulated.is_empty() {
                    break;
                }
            }
            None => {
                accumulated = Vec::new();
                break;
            }
        }
    }

    let rem_acc_len = accumulated.len();
    drop(accumulated);
    drop(raw_faces);
    budget.release_live(s + rem_acc_len);

    finished.into_distribution(budget)
}

/// Stage 4 single-chain net-success expansion for exploding pools (`Standard` / `Penetrate` with empty `keep_drop`).
fn explosion_chain_pool_pmf(
    initial_dist: &Distribution,
    s: usize,
    rule: ExplosionRule,
    cs: &[ComparePoint],
    cf: &[ComparePoint],
    caps: &mut ModelledCaps,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let live_base = budget.live_states;
    let res = explosion_chain_pool_pmf_inner(initial_dist, s, rule, cs, cf, caps, budget);
    if res.is_err() {
        budget.live_states = live_base;
    }
    res
}

fn explosion_chain_pool_pmf_inner(
    initial_dist: &Distribution,
    s: usize,
    rule: ExplosionRule,
    cs: &[ComparePoint],
    cf: &[ComparePoint],
    caps: &mut ModelledCaps,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let is_penetrate = rule.variant == ExplosionVariant::Penetrate;
    budget.charge_transitions(s as u128)?;
    budget.reserve_live(s + 1)?;

    let p_raw = 1.0 / (s as f64);
    let raw_faces: Vec<(i64, f64)> = (1..=s).map(|f| (f as i64, p_raw)).collect();

    let bound = i64::from(MAX_EXPLOSIONS) + 1;
    let mut finished = Accum::with_bounds(-bound, bound, budget)?;
    let mut accumulated: Vec<(i64, f64)> = vec![(0, 1.0)];

    for depth in 0..=MAX_EXPLOSIONS {
        let step_faces: &[(i64, f64)] = if depth == 0 {
            &initial_dist.entries
        } else {
            &raw_faces
        };

        let step_work = (accumulated.len() as u128) * (step_faces.len() as u128);
        budget.charge_transitions(step_work)?;

        let depth_bound = i64::from(depth) + 1;
        let mut next_acc = Accum::with_bounds(-depth_bound, depth_bound, budget)?;

        for &(acc_net, acc_prob) in &accumulated {
            for &(raw_face, p_face) in step_faces {
                let effective = if is_penetrate && depth > 0 {
                    (raw_face - 1).max(1)
                } else {
                    raw_face
                };
                let delta = i64::from(pool_die_delta(effective, cs, cf));
                let next_net = acc_net + delta;
                let prod = acc_prob * p_face;

                let explodes = rule.threshold.matches(raw_face);
                if !explodes || depth == MAX_EXPLOSIONS {
                    if explodes {
                        caps.max_explosions = Some(MAX_EXPLOSIONS);
                    }
                    finished.add(next_net, prod, budget)?;
                } else {
                    next_acc.add(next_net, prod, budget)?;
                }
            }
        }

        let old_acc_len = accumulated.len();
        drop(accumulated);
        budget.release_live(old_acc_len);

        accumulated = next_acc.into_entries(budget)?;
        if accumulated.is_empty() {
            break;
        }
    }

    let rem_acc_len = accumulated.len();
    drop(accumulated);
    drop(raw_faces);
    budget.release_live(s + rem_acc_len);

    finished.into_distribution(budget)
}

fn try_exact_dice(
    spec: &DiceSpec,
    budget: &mut ExactBudget,
) -> Result<(Distribution, ModelledCaps), ExactAbort> {
    let count = spec.count.get() as usize;
    let mut node_caps = ModelledCaps::default();
    let pre_explode = single_die_pre_explode(spec, &mut node_caps, budget)?;

    // Determine effective single-die distribution after Stage 4, or handle multi-die explosion chains.
    let single_die_for_group = match spec.explode {
        None => pre_explode,
        Some(rule) => {
            if spec.sides == DiceSides::Fate {
                return Err(ExactAbort::Unsupported);
            }
            let s = side_count(spec.sides);
            match rule.variant {
                ExplosionVariant::Compound => {
                    // Compound (`!!`) sums bonus rolls into the same die (`eval.rs:302-320`),
                    // leaving exactly `count` i.i.d. dice drawn from `D_compound` before keep/drop and sum/pool!
                    let comp =
                        explosion_chain_sum_pmf(&pre_explode, s, rule, &mut node_caps, budget)?;
                    let pre_len = pre_explode.len();
                    drop(pre_explode);
                    budget.release_live(pre_len);
                    comp
                }
                ExplosionVariant::Standard | ExplosionVariant::Penetrate => {
                    if !spec.keep_drop.is_empty() {
                        // Variable-size multiset of dice before keep/drop (`4d6!kh3`): fall back to MC (`§5.1`).
                        return Err(ExactAbort::Unsupported);
                    }
                    let chain_pmf = match &spec.mode {
                        ResultMode::Sum { .. } => {
                            explosion_chain_sum_pmf(&pre_explode, s, rule, &mut node_caps, budget)?
                        }
                        ResultMode::Pool { cs, cf } => explosion_chain_pool_pmf(
                            &pre_explode,
                            s,
                            rule,
                            cs,
                            cf,
                            &mut node_caps,
                            budget,
                        )?,
                    };
                    let pre_len = pre_explode.len();
                    drop(pre_explode);
                    budget.release_live(pre_len);

                    let total_dist = convolve_n(&chain_pmf, count, budget)?;
                    let chain_len = chain_pmf.len();
                    drop(chain_pmf);
                    budget.release_live(chain_len);
                    return Ok((total_dist, node_caps));
                }
            }
        }
    };

    // Stage 5 (Keep / Drop) + Stage 8 (Sum / Pool) over `count` i.i.d. dice drawn from `single_die_for_group`.
    if !spec.keep_drop.is_empty() {
        let (l, r) = reduce_keep_drop_interval(count, &spec.keep_drop);
        if l == r {
            let single_len = single_die_for_group.len();
            drop(single_die_for_group);
            budget.release_live(single_len);
            budget.reserve_live(1)?;
            return Ok((Distribution::point(0), node_caps));
        }
        if l > 0 || r < count {
            let dp_dist =
                order_statistic_dp(&single_die_for_group, count, l, r, &spec.mode, budget)?;
            let single_len = single_die_for_group.len();
            drop(single_die_for_group);
            budget.release_live(single_len);
            return Ok((dp_dist, node_caps));
        }
        // `l == 0 && r == count`: all `count` dice are kept; fall through to fast `convolve_n`.
    }

    let per_die_contribution = match &spec.mode {
        ResultMode::Sum { .. } => single_die_for_group,
        ResultMode::Pool { cs, cf } => {
            budget.charge_transitions(single_die_for_group.len() as u128)?;
            let mut pool_acc = Accum::with_bounds(-1, 1, budget)?;
            for &(v, p) in &single_die_for_group.entries {
                let delta = i64::from(pool_die_delta(v, cs, cf));
                pool_acc.add(delta, p, budget)?;
            }
            let pool_dist = pool_acc.into_distribution(budget)?;
            let single_len = single_die_for_group.len();
            drop(single_die_for_group);
            budget.release_live(single_len);
            pool_dist
        }
    };

    let group_dist = convolve_n(&per_die_contribution, count, budget)?;
    let contrib_len = per_die_contribution.len();
    drop(per_die_contribution);
    budget.release_live(contrib_len);
    Ok((group_dist, node_caps))
}

// ─── §5.2 Order-statistic dynamic programming for keep/drop ──────────────────

/// Reduces any sequence of `KeepDropOp` modifiers on `count` sorted dice $X_{(0)} \le \dots \le X_{(N-1)}$
/// to a single half-open rank interval `[l, r)` (`0 <= l <= r <= count`, `§5.2`).
pub fn reduce_keep_drop_interval(count: usize, ops: &[KeepDropOp]) -> (usize, usize) {
    let mut l = 0usize;
    let mut r = count;
    for &op in ops {
        let len = r - l;
        match op {
            KeepDropOp::KeepHighest(k) => {
                let keep = (k as usize).min(len);
                l = r - keep;
            }
            KeepDropOp::KeepLowest(k) => {
                let keep = (k as usize).min(len);
                r = l + keep;
            }
            KeepDropOp::DropHighest(k) => {
                let drop = (k as usize).min(len);
                r -= drop;
            }
            KeepDropOp::DropLowest(k) => {
                let drop = (k as usize).min(len);
                l += drop;
            }
        }
    }
    (l, r)
}

/// Division-free multinomial order-statistic DP (`§5.2`) over `[l, r)` of `n` i.i.d. dice.
fn order_statistic_dp(
    single: &Distribution,
    n: usize,
    l: usize,
    r: usize,
    mode: &ResultMode,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let live_base = budget.live_states;
    let res = order_statistic_dp_inner(single, n, l, r, mode, budget);
    if res.is_err() {
        budget.live_states = live_base;
    }
    res
}

fn order_statistic_dp_inner(
    single: &Distribution,
    n: usize,
    l: usize,
    r: usize,
    mode: &ResultMode,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    if l == r {
        budget.charge_transitions(1)?;
        budget.reserve_live(1)?;
        return Ok(Distribution::point(0));
    }

    let faces = &single.entries;
    let m = faces.len();
    debug_assert!(m >= 1);

    let vals_slots = m.div_ceil(2);
    budget.charge_transitions(m as u128)?;
    budget.reserve_live(vals_slots)?;
    let vals: Vec<i64> = match mode {
        ResultMode::Sum { .. } => faces.iter().map(|&(v, _)| v).collect(),
        ResultMode::Pool { cs, cf } => faces
            .iter()
            .map(|&(v, _)| i64::from(pool_die_delta(v, cs, cf)))
            .collect(),
    };

    let min_val = vals.iter().copied().min().unwrap_or(0);
    let max_val = vals.iter().copied().max().unwrap_or(0);
    let kept_total = (r - l) as i64;
    let bound_a = kept_total
        .checked_mul(min_val)
        .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
    let bound_b = kept_total
        .checked_mul(max_val)
        .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
    let global_min_sum = bound_a.min(bound_b);
    let global_max_sum = bound_a.max(bound_b);

    let dp_header_slots = n + 1;
    budget.charge_transitions(dp_header_slots as u128)?;
    budget.reserve_live(dp_header_slots + 1)?;
    let mut dp: Vec<Vec<(i64, f64)>> = vec![Vec::new(); n + 1];
    dp[0].push((0, 1.0));
    let mut dp_states = 1usize;

    let mut min_seen = vals[0];
    let mut max_seen = vals[0];

    for (face_idx, &(_v_i, p_i)) in faces.iter().enumerate() {
        let val_i = vals[face_idx];
        min_seen = min_seen.min(val_i);
        max_seen = max_seen.max(val_i);
        let is_last_face = face_idx + 1 == m;

        if is_last_face {
            // On the final face `m - 1`, all remaining `c = n - j` dice must land on `v_{m-1}` to reach `dp[n]`.
            let mut last_work: u128 = 0;
            for (j, bucket) in dp.iter().enumerate() {
                if !bucket.is_empty() {
                    last_work = last_work
                        .saturating_add(bucket.len() as u128)
                        .saturating_add((n - j) as u128);
                }
            }
            let mut final_acc = Accum::with_bounds(global_min_sum, global_max_sum, budget)?;
            let weight = if final_acc.is_sparse() {
                SPARSE_TRANSITION_WEIGHT
            } else {
                1
            };
            budget.charge_transitions(last_work.saturating_mul(weight))?;

            for (j, bucket) in dp.iter().enumerate() {
                if bucket.is_empty() {
                    continue;
                }
                let c = n - j;
                let mut w = 1.0_f64;
                for step_c in 1..=c {
                    w *= ((j + step_c) as f64) * p_i / (step_c as f64);
                }
                let overlap_lo = j.max(l);
                let overlap_hi = n.min(r);
                let k_kept = overlap_hi.saturating_sub(overlap_lo) as i64;
                let delta_sum = k_kept
                    .checked_mul(val_i)
                    .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;

                for &(s, prob) in bucket {
                    let next_sum = s
                        .checked_add(delta_sum)
                        .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
                    final_acc.add(next_sum, prob * w, budget)?;
                }
            }

            drop(dp);
            drop(vals);
            budget.release_live(dp_states + dp_header_slots + vals_slots);
            return final_acc.into_distribution(budget);
        }

        // §5.2 Cost guard: charge inner transitions `sum_{j=0}^N |dp[j]| * (N - j + 1)` BEFORE step `i`.
        let mut step_transitions: u128 = 0;
        for (j, bucket) in dp.iter().enumerate() {
            if !bucket.is_empty() {
                step_transitions =
                    step_transitions.saturating_add((bucket.len() as u128) * ((n - j + 1) as u128));
            }
        }
        budget.charge_transitions(step_transitions)?;

        budget.reserve_live(dp_header_slots)?;
        let mut next_acc: Vec<Option<Accum>> = (0..=n).map(|_| None).collect();

        for (j, bucket) in dp.iter().enumerate() {
            if bucket.is_empty() {
                continue;
            }
            let max_c = n - j;
            let mut w = 1.0_f64;

            for c in 0..=max_c {
                if c > 0 {
                    // Telescoping multinomial factor `binom(j + c, c) * p_i^c`:
                    // divides only by the exact small integer `c` (never by a tail probability sum!).
                    w *= ((j + c) as f64) * p_i / (c as f64);
                }
                let next_j = j + c;
                let overlap_lo = j.max(l);
                let overlap_hi = next_j.min(r);
                let k_kept = overlap_hi.saturating_sub(overlap_lo) as i64;
                let delta_sum = k_kept
                    .checked_mul(val_i)
                    .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;

                if next_acc[next_j].is_none() {
                    let kept_so_far = next_j.min(r).saturating_sub(l) as i64;
                    let lo_a = kept_so_far.saturating_mul(min_seen);
                    let hi_a = kept_so_far.saturating_mul(max_seen);
                    next_acc[next_j] = Some(Accum::with_bounds(
                        lo_a.min(hi_a).min(0),
                        lo_a.max(hi_a).max(0),
                        budget,
                    )?);
                }
                let target_acc = next_acc[next_j].as_mut().expect("initialized");
                if target_acc.is_sparse() {
                    budget.charge_transitions(
                        (bucket.len() as u128) * (SPARSE_TRANSITION_WEIGHT - 1),
                    )?;
                }

                for &(s, prob) in bucket {
                    let next_sum = s
                        .checked_add(delta_sum)
                        .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
                    target_acc.add(next_sum, prob * w, budget)?;
                }
            }
        }

        drop(dp);
        budget.release_live(dp_states);

        let mut next_dp_states = 0usize;
        let mut next_dp = Vec::with_capacity(n + 1);
        for slot in next_acc {
            let entries = match slot {
                Some(acc) => acc.into_entries(budget)?,
                None => Vec::new(),
            };
            next_dp_states = next_dp_states.saturating_add(entries.len());
            next_dp.push(entries);
        }
        budget.release_live(dp_header_slots);

        dp = next_dp;
        dp_states = next_dp_states;
    }

    let mut entries = dp.pop().unwrap_or_default();
    let returned_len = entries.len();
    drop(dp);
    drop(vals);
    budget.release_live(dp_states.saturating_sub(returned_len) + dp_header_slots + vals_slots);
    normalize_if_singleton(&mut entries);
    Ok(Distribution { entries })
}

// ─── §5.3 Distribution algebra & Monte Carlo fallback ────────────────────────

fn negate_distribution(
    dist: &Distribution,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let len = dist.entries.len();
    budget.charge_transitions(len as u128)?;
    budget.reserve_live(len)?;
    let mut out = Vec::with_capacity(len);
    for &(v, p) in dist.entries.iter().rev() {
        let neg_v = v
            .checked_neg()
            .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
        out.push((neg_v, p));
    }
    normalize_if_singleton(&mut out);
    Ok(Distribution { entries: out })
}

fn shift_distribution_weighted(
    dist: &Distribution,
    offset: i64,
    weight: f64,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let len = dist.entries.len();
    budget.charge_transitions(len as u128)?;
    budget.reserve_live(len)?;
    let mut out = Vec::with_capacity(len);
    for &(v, p) in &dist.entries {
        let shifted = v
            .checked_add(offset)
            .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
        out.push((shifted, canon_f64(p * weight)));
    }
    normalize_if_singleton(&mut out);
    Ok(Distribution { entries: out })
}

fn subtract_scalar_weighted(
    dist: &Distribution,
    subtrahend: i64,
    weight: f64,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let len = dist.entries.len();
    budget.charge_transitions(len as u128)?;
    budget.reserve_live(len)?;
    let mut out = Vec::with_capacity(len);
    for &(v, p) in &dist.entries {
        let diff = v
            .checked_sub(subtrahend)
            .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
        out.push((diff, canon_f64(p * weight)));
    }
    normalize_if_singleton(&mut out);
    Ok(Distribution { entries: out })
}

fn subtract_from_scalar_weighted(
    minuend: i64,
    weight: f64,
    right: &Distribution,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let len = right.entries.len();
    budget.charge_transitions(len as u128)?;
    budget.reserve_live(len)?;
    let mut out = Vec::with_capacity(len);
    for &(rv, rp) in right.entries.iter().rev() {
        let diff = minuend
            .checked_sub(rv)
            .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
        out.push((diff, canon_f64(weight * rp)));
    }
    normalize_if_singleton(&mut out);
    Ok(Distribution { entries: out })
}

fn scale_distribution_weighted(
    dist: &Distribution,
    factor: i64,
    weight: f64,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    if factor == 0 {
        budget.charge_transitions(1)?;
        budget.reserve_live(1)?;
        return Ok(Distribution::point(0));
    }
    let len = dist.entries.len();
    budget.charge_transitions(len as u128)?;
    budget.reserve_live(len)?;
    let mut out = Vec::with_capacity(len);
    if factor > 0 {
        for &(v, p) in &dist.entries {
            let scaled = v
                .checked_mul(factor)
                .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
            out.push((scaled, canon_f64(p * weight)));
        }
    } else {
        for &(v, p) in dist.entries.iter().rev() {
            let scaled = v
                .checked_mul(factor)
                .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
            out.push((scaled, canon_f64(p * weight)));
        }
    }
    normalize_if_singleton(&mut out);
    Ok(Distribution { entries: out })
}

fn divide_distribution_weighted(
    dist: &Distribution,
    divisor: i64,
    weight: f64,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    if divisor == 0 {
        return Err(ExactAbort::Error(RollError::DivisionByZero));
    }
    let first_q = checked_div_floor(dist.entries[0].0, divisor).map_err(ExactAbort::Error)?;
    let last_q = checked_div_floor(dist.entries[dist.entries.len() - 1].0, divisor)
        .map_err(ExactAbort::Error)?;
    let mut acc = Accum::with_bounds(first_q.min(last_q), first_q.max(last_q), budget)?;
    let cost = (dist.entries.len() as u128)
        * if acc.is_sparse() {
            SPARSE_TRANSITION_WEIGHT
        } else {
            1
        };
    budget.charge_transitions(cost)?;
    for &(v, p) in &dist.entries {
        let q = checked_div_floor(v, divisor).map_err(ExactAbort::Error)?;
        acc.add(q, p * weight, budget)?;
    }
    acc.into_distribution(budget)
}

#[inline]
fn is_contiguous(dist: &Distribution) -> bool {
    let len = dist.len();
    if len == 0 {
        return false;
    }
    let first = i128::from(dist.entries[0].0);
    let last = i128::from(dist.entries[len - 1].0);
    last - first == (len - 1) as i128
}

/// Flat contiguous convolution for gap-free distributions (`100%` slot density across `min_sum..=max_sum`,
/// charging `ceil(pairs / FLAT_CONTIGUOUS_PAIRS_PER_STATE) + out_len` and accumulating in the exact
/// same `(i = 0..a.len(), j = 0..b.len())` order as `Accum::Dense` for bit-identical IEEE-754 sums).
fn convolve_contiguous(
    a: &Distribution,
    b: &Distribution,
    min_sum: i64,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let a_len = a.len();
    let b_len = b.len();
    let out_len = a_len + b_len - 1;
    let pairs = (a_len as u128) * (b_len as u128);
    let work = pairs
        .div_ceil(FLAT_CONTIGUOUS_PAIRS_PER_STATE)
        .saturating_add(out_len as u128);
    budget.charge_transitions(work)?;

    let b_slots = b_len.div_ceil(2);
    let out_slots = out_len.div_ceil(2);
    let peak_slots = out_slots
        .checked_add(b_slots.max(out_len))
        .ok_or(ExactAbort::TooLarge)?;
    budget.reserve_live(peak_slots)?;

    let b_probs: Vec<f64> = b.entries.iter().map(|&(_, p)| p).collect();
    let mut out_probs: Vec<f64> = vec![0.0_f64; out_len];

    for (i, &(_, pa)) in a.entries.iter().enumerate() {
        let dest = &mut out_probs[i..i + b_len];
        for (slot, &pb) in dest.iter_mut().zip(b_probs.iter()) {
            *slot += pa * pb;
        }
    }
    drop(b_probs);

    let mut entries = Vec::with_capacity(out_len);
    for (idx, p) in out_probs.into_iter().enumerate() {
        let key = (i128::from(min_sum) + (idx as i128)) as i64;
        entries.push((key, canon_f64(p)));
    }
    budget.release_live(peak_slots - out_len);
    normalize_if_singleton(&mut entries);
    Ok(Distribution { entries })
}

fn subtract_contiguous(
    a: &Distribution,
    b: &Distribution,
    min_diff: i64,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let a_len = a.len();
    let b_len = b.len();
    let out_len = a_len + b_len - 1;
    let pairs = (a_len as u128) * (b_len as u128);
    let work = pairs
        .div_ceil(FLAT_CONTIGUOUS_PAIRS_PER_STATE)
        .saturating_add(out_len as u128);
    budget.charge_transitions(work)?;

    let b_slots = b_len.div_ceil(2);
    let out_slots = out_len.div_ceil(2);
    let peak_slots = out_slots
        .checked_add(b_slots.max(out_len))
        .ok_or(ExactAbort::TooLarge)?;
    budget.reserve_live(peak_slots)?;

    let b_rev_probs: Vec<f64> = b.entries.iter().rev().map(|&(_, p)| p).collect();
    let mut out_probs: Vec<f64> = vec![0.0_f64; out_len];

    for (i, &(_, pa)) in a.entries.iter().enumerate() {
        let dest = &mut out_probs[i..i + b_len];
        for (slot, &pb) in dest.iter_mut().zip(b_rev_probs.iter()) {
            *slot += pa * pb;
        }
    }
    drop(b_rev_probs);

    let mut entries = Vec::with_capacity(out_len);
    for (idx, p) in out_probs.into_iter().enumerate() {
        let key = (i128::from(min_diff) + (idx as i128)) as i64;
        entries.push((key, canon_f64(p)));
    }
    budget.release_live(peak_slots - out_len);
    normalize_if_singleton(&mut entries);
    Ok(Distribution { entries })
}

fn convolve(
    a: &Distribution,
    b: &Distribution,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let a_len = a.len() as u128;
    let b_len = b.len() as u128;
    let pairs = a_len * b_len;
    let both_contiguous = is_contiguous(a) && is_contiguous(b);
    let max_pairs = if both_contiguous {
        (MAX_EXACT_STATES as u128) * FLAT_CONTIGUOUS_PAIRS_PER_STATE
    } else {
        MAX_EXACT_STATES as u128
    };
    if a_len + b_len - 1 > (MAX_EXACT_STATES as u128) || pairs > max_pairs {
        return Err(ExactAbort::TooLarge);
    }

    let min_sum = a.entries[0]
        .0
        .checked_add(b.entries[0].0)
        .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
    let max_sum = a.entries[a.len() - 1]
        .0
        .checked_add(b.entries[b.len() - 1].0)
        .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;

    if both_contiguous {
        return convolve_contiguous(a, b, min_sum, budget);
    }

    let mut acc = Accum::with_bounds(min_sum, max_sum, budget)?;
    let cost = if acc.is_sparse() {
        pairs.saturating_mul(SPARSE_TRANSITION_WEIGHT)
    } else {
        pairs
    };
    budget.charge_transitions(cost)?;

    for &(va, pa) in &a.entries {
        for &(vb, pb) in &b.entries {
            acc.add(va + vb, pa * pb, budget)?;
        }
    }
    acc.into_distribution(budget)
}

fn subtract_distributions(
    a: &Distribution,
    b: &Distribution,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let a_len = a.len() as u128;
    let b_len = b.len() as u128;
    let pairs = a_len * b_len;
    if a_len + b_len - 1 > (MAX_EXACT_STATES as u128) || pairs > (MAX_EXACT_STATES as u128) {
        return Err(ExactAbort::TooLarge);
    }

    let min_diff = a.entries[0]
        .0
        .checked_sub(b.entries[b.len() - 1].0)
        .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
    let max_diff = a.entries[a.len() - 1]
        .0
        .checked_sub(b.entries[0].0)
        .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;

    if is_contiguous(a) && is_contiguous(b) {
        return subtract_contiguous(a, b, min_diff, budget);
    }

    let mut acc = Accum::with_bounds(min_diff, max_diff, budget)?;
    let cost = if acc.is_sparse() {
        pairs.saturating_mul(SPARSE_TRANSITION_WEIGHT)
    } else {
        pairs
    };
    budget.charge_transitions(cost)?;

    for &(va, pa) in &a.entries {
        for &(vb, pb) in &b.entries {
            acc.add(va - vb, pa * pb, budget)?;
        }
    }
    acc.into_distribution(budget)
}

fn is_uniform_contiguous(single: &Distribution) -> bool {
    let s = single.len();
    if s < 2 {
        return false;
    }
    let first_v = single.entries[0].0;
    let last_v = single.entries[s - 1].0;
    if i128::from(last_v) - i128::from(first_v) != (s - 1) as i128 {
        return false;
    }
    let p_bits = single.entries[0].1.to_bits();
    if single.entries[0].1 <= 0.0 {
        return false;
    }
    single.entries[1..]
        .iter()
        .all(|&(_, p)| p.to_bits() == p_bits)
}

/// Subtraction-free block `suffix + prefix` windowed convolution for `count` i.i.d. uniform
/// contiguous dice (`O(count^2 * s)` total transitions vs `O(count^2 * s^2)` pairwise convolution,
/// with zero floating-point subtractions so extreme tails never suffer cancellation).
fn convolve_n_uniform_contiguous(
    single: &Distribution,
    count: usize,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let s = single.len();
    let count_i64 = count as i64;
    let min_total = single.entries[0]
        .0
        .checked_mul(count_i64)
        .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
    let _max_total = single.entries[s - 1]
        .0
        .checked_mul(count_i64)
        .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;

    let s_minus_1 = (s - 1) as u128;
    let count_u128 = count as u128;
    // Preserve §5.3 pairwise support-product guard (`|D_{count-1}| * |D_1| <= MAX_EXACT_STATES`,
    // e.g. `12d1000` has `10,990 * 1,000 = 10,990,000 > MAX_EXACT_STATES` -> Monte Carlo).
    let prev_len_u128 = (count_u128 - 1) * s_minus_1 + 1;
    if prev_len_u128 * (s as u128) > (MAX_EXACT_STATES as u128) {
        return Err(ExactAbort::TooLarge);
    }
    let final_len_u128 = count_u128 * s_minus_1 + 1;
    if final_len_u128 > (MAX_EXACT_LIVE_STATES as u128) {
        return Err(ExactAbort::TooLarge);
    }
    let final_len = final_len_u128 as usize;

    // Exact transition count across steps `2..=count`: `sum_{k=2}^count (k * (s - 1) + 1)`.
    let steps = count_u128 - 1;
    let total_transitions = s_minus_1 * ((count_u128 + 2) * steps / 2) + steps;
    budget.charge_transitions(total_transitions)?;

    // Peak storage holds `curr`, `prefix`, `suffix`, and `next` (`4 * final_len` `f64`s = `2 * final_len` slots),
    // and then `curr` (`final_len / 2` slots) + `entries` (`final_len` slots) <= `2 * final_len` slots.
    let peak_slots = final_len.checked_mul(2).ok_or(ExactAbort::TooLarge)?;
    budget.reserve_live(peak_slots)?;

    let s_f64 = s as f64;
    let p_init = canon_f64(1.0 / s_f64);
    let mut curr: Vec<f64> = Vec::with_capacity(final_len);
    curr.resize(s, p_init);
    let mut prefix: Vec<f64> = vec![0.0; final_len];
    let mut suffix: Vec<f64> = vec![0.0; final_len];
    let mut next: Vec<f64> = Vec::with_capacity(final_len);

    for _ in 2..=count {
        let l = curr.len();
        let out_len = l + s - 1;

        let mut block_start = 0usize;
        while block_start < l {
            let block_end = (block_start + s).min(l);
            let mut acc = 0.0_f64;
            for i in block_start..block_end {
                acc += curr[i];
                prefix[i] = acc;
            }
            let mut rev_acc = 0.0_f64;
            for i in (block_start..block_end).rev() {
                rev_acc += curr[i];
                suffix[i] = rev_acc;
            }
            block_start = block_end;
        }

        next.clear();
        for out_idx in 0..out_len {
            let a = out_idx.saturating_sub(s - 1);
            let b = out_idx.min(l - 1);
            let sum_window = if a / s < b / s {
                suffix[a] + prefix[b]
            } else if a % s == 0 {
                prefix[b]
            } else {
                suffix[a]
            };
            // Divide by the exact integer `s_f64` instead of multiplying by `fl(1.0 / s_f64)`
            // so `1/3`-ULP rounding in `1.0 / 6.0` never compounds systematically across 500 steps.
            next.push(canon_f64(sum_window / s_f64));
        }

        core::mem::swap(&mut curr, &mut next);
    }

    drop(prefix);
    drop(suffix);
    drop(next);

    let mut entries = Vec::with_capacity(final_len);
    for (idx, prob) in curr.into_iter().enumerate() {
        entries.push((min_total + (idx as i64), prob));
    }
    budget.release_live(peak_slots - final_len);
    normalize_if_singleton(&mut entries);
    Ok(Distribution { entries })
}

/// Convolves `single` `count` times (`§5.3`).
fn convolve_n(
    single: &Distribution,
    count: usize,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let live_base = budget.live_states;
    let res = convolve_n_inner(single, count, budget);
    if res.is_err() {
        budget.live_states = live_base;
    }
    res
}

fn convolve_n_inner(
    single: &Distribution,
    count: usize,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    if count == 0 {
        budget.charge_transitions(1)?;
        budget.reserve_live(1)?;
        return Ok(Distribution::point(0));
    }
    if single.len() == 1 {
        let v = single.entries[0]
            .0
            .checked_mul(count as i64)
            .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
        budget.charge_transitions(1)?;
        budget.reserve_live(1)?;
        return Ok(Distribution::point(v));
    }
    if count == 1 {
        budget.charge_transitions(single.len() as u128)?;
        budget.reserve_live(single.len())?;
        return Ok(single.clone());
    }

    if count > 2 && is_uniform_contiguous(single) {
        return convolve_n_uniform_contiguous(single, count, budget);
    }

    budget.charge_transitions(single.len() as u128)?;
    budget.reserve_live(single.len())?;
    let mut powers: Vec<(usize, Distribution)> = vec![(1, single.clone())];

    let single_contiguous = is_contiguous(single);
    let max_step_pairs = if single_contiguous {
        (MAX_EXACT_STATES as u128) * FLAT_CONTIGUOUS_PAIRS_PER_STATE
    } else {
        MAX_EXACT_STATES as u128
    };

    loop {
        let &(step_n, ref last_dist) = powers.last().expect("non-empty");
        let Some(next_n) = step_n.checked_mul(2) else {
            break;
        };
        if next_n > count {
            break;
        };
        let len_u128 = last_dist.len() as u128;
        if len_u128 * len_u128 > max_step_pairs || 2 * len_u128 - 1 > (MAX_EXACT_STATES as u128) {
            break;
        }
        let squared = convolve(last_dist, last_dist, budget)?;
        powers.push((next_n, squared));
    }

    let top_n = powers.last().expect("non-empty").0;
    if top_n == count {
        let (_, acc) = powers.pop().expect("non-empty");
        let rem_states: usize = powers.iter().map(|(_, d)| d.len()).sum();
        drop(powers);
        budget.release_live(rem_states);
        return Ok(acc);
    }

    let top_len = powers.last().expect("non-empty").1.len();
    budget.charge_transitions(top_len as u128)?;
    budget.reserve_live(top_len)?;
    let mut acc = powers.last().expect("non-empty").1.clone();
    let mut remaining = count - top_n;

    while remaining > 0 {
        let mut chosen_idx: Option<usize> = None;
        for (idx, &(chunk_n, ref chunk_dist)) in powers.iter().enumerate().rev() {
            if chunk_n <= remaining {
                let prod = (acc.len() as u128) * (chunk_dist.len() as u128);
                let sum_support = (acc.len() as u128) + (chunk_dist.len() as u128) - 1;
                if prod <= max_step_pairs && sum_support <= (MAX_EXACT_STATES as u128) {
                    chosen_idx = Some(idx);
                    break;
                }
            }
        }

        let Some(idx) = chosen_idx else {
            return Err(ExactAbort::TooLarge);
        };
        let next_acc = convolve(&acc, &powers[idx].1, budget)?;
        let old_len = acc.len();
        drop(acc);
        budget.release_live(old_len);
        acc = next_acc;
        remaining -= powers[idx].0;
    }

    let powers_states: usize = powers.iter().map(|(_, d)| d.len()).sum();
    drop(powers);
    budget.release_live(powers_states);

    Ok(acc)
}

fn multiply_distributions(
    a: &Distribution,
    b: &Distribution,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    let pairs = (a.len() as u128) * (b.len() as u128);
    if pairs > (MAX_EXACT_STATES as u128) {
        return Err(ExactAbort::TooLarge);
    }

    let a_first = a.entries[0].0;
    let a_last = a.entries[a.len() - 1].0;
    let b_first = b.entries[0].0;
    let b_last = b.entries[b.len() - 1].0;
    let corners = [
        a_first
            .checked_mul(b_first)
            .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?,
        a_first
            .checked_mul(b_last)
            .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?,
        a_last
            .checked_mul(b_first)
            .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?,
        a_last
            .checked_mul(b_last)
            .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?,
    ];
    let min_prod = corners.iter().copied().min().unwrap_or(0);
    let max_prod = corners.iter().copied().max().unwrap_or(0);

    let mut acc = Accum::with_bounds(min_prod, max_prod, budget)?;
    let cost = if acc.is_sparse() {
        pairs.saturating_mul(SPARSE_TRANSITION_WEIGHT)
    } else {
        pairs
    };
    budget.charge_transitions(cost)?;

    for &(va, pa) in &a.entries {
        for &(vb, pb) in &b.entries {
            acc.add(va * vb, pa * pb, budget)?;
        }
    }
    acc.into_distribution(budget)
}

fn divide_distributions(
    a: &Distribution,
    b: &Distribution,
    budget: &mut ExactBudget,
) -> Result<Distribution, ExactAbort> {
    if b.is_reachable(0) {
        return Err(ExactAbort::Error(RollError::DivisionByZero));
    }

    // Check extremal numerator/denominator corners so deterministic `i64::MIN / -1` overflow
    // surfaces and bounded quotients can use `Accum::Dense`.
    let a_extremes = [a.entries[0].0, a.entries[a.len() - 1].0];
    let neg_end = b.entries.partition_point(|&(vb, _)| vb < 0);
    let mut b_extremes = Vec::with_capacity(4);
    if neg_end > 0 {
        b_extremes.push(b.entries[0].0);
        if neg_end > 1 {
            b_extremes.push(b.entries[neg_end - 1].0);
        }
    }
    if neg_end < b.entries.len() {
        b_extremes.push(b.entries[neg_end].0);
        if neg_end + 1 < b.entries.len() {
            b_extremes.push(b.entries[b.entries.len() - 1].0);
        }
    }

    let mut min_q = i64::MAX;
    let mut max_q = i64::MIN;
    for &va in &a_extremes {
        for &vb in &b_extremes {
            let q = checked_div_floor(va, vb).map_err(ExactAbort::Error)?;
            min_q = min_q.min(q);
            max_q = max_q.max(q);
        }
    }

    let pairs = (a.len() as u128) * (b.len() as u128);
    if pairs > (MAX_EXACT_STATES as u128) {
        return Err(ExactAbort::TooLarge);
    }

    let mut acc = Accum::with_bounds(min_q, max_q, budget)?;
    let cost = if acc.is_sparse() {
        pairs.saturating_mul(SPARSE_TRANSITION_WEIGHT)
    } else {
        pairs
    };
    budget.charge_transitions(cost)?;

    for &(va, pa) in &a.entries {
        for &(vb, pb) in &b.entries {
            let q = checked_div_floor(va, vb).map_err(ExactAbort::Error)?;
            acc.add(q, pa * pb, budget)?;
        }
    }
    acc.into_distribution(budget)
}

struct StreamDrawSource {
    rng: ChaCha12Rng,
    draws: u64,
}

impl DrawSource for StreamDrawSource {
    #[inline]
    fn next_u64_word(&mut self) -> Result<u64, RollError> {
        self.draws += 1;
        Ok(self.rng.next_u64())
    }
}

fn count_matching_range(lo: i64, hi: i64, cp: ComparePoint) -> u64 {
    if lo > hi {
        return 0;
    }
    match cp.op {
        CompareOp::Eq => u64::from(cp.value >= lo && cp.value <= hi),
        CompareOp::Gt => {
            let start = cp.value.saturating_add(1).max(lo);
            if start <= hi {
                (hi - start + 1) as u64
            } else {
                0
            }
        }
        CompareOp::Gte => {
            let start = cp.value.max(lo);
            if start <= hi {
                (hi - start + 1) as u64
            } else {
                0
            }
        }
        CompareOp::Lt => {
            let end = cp.value.saturating_sub(1).min(hi);
            if lo <= end { (end - lo + 1) as u64 } else { 0 }
        }
        CompareOp::Lte => {
            let end = cp.value.min(hi);
            if lo <= end { (end - lo + 1) as u64 } else { 0 }
        }
    }
}

#[inline]
fn count_matching_faces(sides: DiceSides, cp: ComparePoint) -> u64 {
    count_matching_range(sides.min_face(), sides.max_face(), cp)
}

/// Exact maximum `roll_single_die` invocations reachable by `expr` in `eval.rs` (excluding
/// Lemire 64-bit rejection retries). If this exceeds `MAX_TOTAL_DRAWS`, `eval.rs` has a
/// reachable `DrawBudgetExceeded` path that independent per-die convolution does not model.
fn expr_max_die_rolls(expr: &Expr) -> u64 {
    match expr {
        Expr::Number(_) => 0,
        Expr::UnaryNeg(inner) => expr_max_die_rolls(inner),
        Expr::Binary { left, right, .. } => {
            expr_max_die_rolls(left).saturating_add(expr_max_die_rolls(right))
        }
        Expr::Dice(spec) => {
            let mut per_die: u64 = 1;
            for &cp in &spec.reroll_unlimited {
                if count_matching_faces(spec.sides, cp) > 0 {
                    per_die = per_die.saturating_add(u64::from(MAX_REROLLS));
                }
            }
            for &cp in &spec.reroll_once {
                if count_matching_faces(spec.sides, cp) > 0 {
                    per_die = per_die.saturating_add(1);
                }
            }
            if let Some(rule) = spec.explode {
                let raw_min = spec.sides.min_face();
                let raw_max = spec.sides.max_face();
                let (post_min, post_max) = match spec.clamp {
                    Some(clamp) => (
                        apply_clamp_value(raw_min, clamp),
                        apply_clamp_value(raw_max, clamp),
                    ),
                    None => (raw_min, raw_max),
                };
                if count_matching_range(post_min, post_max, rule.threshold) > 0 {
                    if count_matching_faces(spec.sides, rule.threshold) > 0 {
                        per_die = per_die.saturating_add(u64::from(MAX_EXPLOSIONS));
                    } else {
                        per_die = per_die.saturating_add(1);
                    }
                }
            }
            u64::from(spec.count.get()).saturating_mul(per_die)
        }
    }
}

/// Estimates per-sample deterministic CPU work outside `DrawSource::next_u64_word` (`§5.3`).
///
/// Combined with `source.draws` (which already counts `>= count` initial Stage 1 draws per sample
/// plus any triggered reroll/explosion draws), each `DiceSpec` group contributes at least:
/// `count * (|r| + |ro| + |cs| + |cf| + 1) + keep_drop_work` per sample.
fn estimate_mc_work_per_sample(expr: &Expr) -> u64 {
    match expr {
        Expr::Number(_) => 0,
        Expr::UnaryNeg(inner) => estimate_mc_work_per_sample(inner),
        Expr::Binary { left, right, .. } => {
            estimate_mc_work_per_sample(left).saturating_add(estimate_mc_work_per_sample(right))
        }
        Expr::Dice(spec) => {
            let base = u64::from(spec.count.get());
            let (cs_len, cf_len) = match &spec.mode {
                ResultMode::Pool { cs, cf } => (cs.len() as u64, cf.len() as u64),
                ResultMode::Sum { .. } => (0, 0),
            };
            let scan_passes = (spec.reroll_unlimited.len() as u64)
                .saturating_add(spec.reroll_once.len() as u64)
                .saturating_add(cs_len)
                .saturating_add(cf_len);
            let mut work = base.saturating_mul(scan_passes);

            if spec.keep_drop.is_empty() {
                return work;
            }

            let est_len = match spec.explode {
                Some(rule) if rule.variant != ExplosionVariant::Compound => {
                    let s = side_count(spec.sides) as u64;
                    let m = count_matching_faces(spec.sides, rule.threshold);
                    let max_len = base.saturating_mul(u64::from(MAX_EXPLOSIONS) + 1);
                    if m >= s {
                        max_len
                    } else if m > 0 {
                        base.saturating_add(base.saturating_mul(m) / (s - m))
                            .max(base.saturating_mul(2))
                            .min(max_len)
                    } else {
                        base.saturating_mul(2)
                    }
                }
                _ => base,
            };
            let mut cur_len = est_len;
            for (op_idx, &op) in spec.keep_drop.iter().enumerate() {
                let log_term = u64::from(cur_len.max(2).ilog2());
                let sort_work = (cur_len.saturating_mul(log_term)) / 20;
                let collect_work = if op_idx > 0 { est_len / 4 } else { 0 };
                work = work.saturating_add(sort_work).saturating_add(collect_work);
                cur_len = match op {
                    KeepDropOp::KeepHighest(k) | KeepDropOp::KeepLowest(k) => {
                        cur_len.min(u64::from(k)).max(1)
                    }
                    KeepDropOp::DropHighest(k) | KeepDropOp::DropLowest(k) => {
                        cur_len.saturating_sub(u64::from(k)).max(1)
                    }
                };
            }
            work
        }
    }
}

fn monte_carlo_fallback(
    expr: &Expr,
    target_samples: u32,
) -> Result<(Distribution, u32), RollError> {
    let mut source = StreamDrawSource {
        rng: ChaCha12Rng::from_seed(*MONTE_CARLO_DEFAULT_SEED),
        draws: 0,
    };
    let mut scratch = EvalScratch::new();
    let mut counts = BTreeMap::<i64, u32>::new();
    let static_work_per_sample = estimate_mc_work_per_sample(expr);
    let mut completed: u32 = 0;

    for _ in 0..target_samples {
        let total = evaluate_total_with_source(expr, &mut source, &mut scratch)?;
        *counts.entry(total).or_insert(0) += 1;
        completed += 1;

        let work = source
            .draws
            .saturating_add(u64::from(completed).saturating_mul(static_work_per_sample));
        if work >= MAX_MC_WORK {
            break;
        }
    }

    let denom = f64::from(completed.max(1));
    let mut entries: Vec<(i64, f64)> = counts
        .into_iter()
        .map(|(v, c)| (v, canon_f64(f64::from(c) / denom)))
        .collect();
    normalize_if_singleton(&mut entries);
    Ok((Distribution { entries }, completed))
}

/// Estimates the distribution of `expr` via `samples` trials on the continuous
/// `ChaCha12Rng::from_seed(*MONTE_CARLO_DEFAULT_SEED)` stream (`§5.3`).
///
/// Any evaluation error on a trial (including [`RollError::DrawBudgetExceeded`],
/// [`RollError::DivisionByZero`], or [`RollError::ArithmeticOverflow`]) aborts immediately
/// on that sample and is surfaced directly to the caller without retrying remaining samples.
pub fn monte_carlo_distribution(expr: &Expr, samples: u32) -> Result<Distribution, RollError> {
    let mut source = StreamDrawSource {
        rng: ChaCha12Rng::from_seed(*MONTE_CARLO_DEFAULT_SEED),
        draws: 0,
    };
    let mut scratch = EvalScratch::new();
    let mut counts = BTreeMap::<i64, u32>::new();

    for _ in 0..samples {
        let total = evaluate_total_with_source(expr, &mut source, &mut scratch)?;
        *counts.entry(total).or_insert(0) += 1;
    }

    let denom = f64::from(samples);
    let mut entries: Vec<(i64, f64)> = counts
        .into_iter()
        .map(|(v, c)| (v, canon_f64(f64::from(c) / denom)))
        .collect();
    normalize_if_singleton(&mut entries);
    Ok(Distribution { entries })
}

// ─── §9.3 Black-box prefix-tape brute-force oracle over `eval.rs` ────────────

/// Computes a deterministic 64-bit Lemire witness word `w` for `(span, k)` (`0 <= k < span.get()`)
/// such that `DrawSource::sample_lemire_u64(span)` returns `k` in a single word with zero retries.
pub fn lemire_witness_word(span: NonZeroU64, k: u64) -> u64 {
    assert!(k < span.get(), "offset k must be < span");
    let s = u128::from(span.get());
    let num = ((u128::from(k) + 1) << 64) - 1;
    (num / s) as u64
}

struct OracleTapeSource<'a> {
    words: &'a [u64],
    cursor: usize,
    last_span: Option<NonZeroU64>,
    exhausted_span: Option<NonZeroU64>,
}

impl DrawSource for OracleTapeSource<'_> {
    #[inline]
    fn on_sample_span(&mut self, span: NonZeroU64) {
        self.last_span = Some(span);
    }

    fn next_u64_word(&mut self) -> Result<u64, RollError> {
        if let Some(&word) = self.words.get(self.cursor) {
            self.cursor += 1;
            Ok(word)
        } else {
            self.exhausted_span = self.last_span;
            Err(RollError::ReceiptInvalid(
                ReceiptVerifyError::DrawTapeUnderflow {
                    needed_at_index: self.cursor,
                },
            ))
        }
    }
}

/// Brute-force prefix-tape oracle (`§9.3`) driving the real `eval::evaluate_with_source`
/// over uniform face branches (`0..span`) via Lemire witness words, with zero knowledge
/// of modifier stages.
///
/// Branches terminate into `tail_mass` only when `tape.len() >= max_draws` or
/// `branch_prob < min_branch_prob` (`0.0` explores the entire finite/capped execution tree).
pub fn run_prefix_tape_oracle(
    expr: &Expr,
    max_draws: usize,
    min_branch_prob: f64,
) -> Result<PrefixOracleResult, RollError> {
    struct State {
        outcomes: BTreeMap<i64, f64>,
        tail_mass: f64,
        leaves: usize,
        tape: Vec<u64>,
    }

    fn walk(
        expr: &Expr,
        prob: f64,
        max_draws: usize,
        min_branch_prob: f64,
        st: &mut State,
    ) -> Result<(), RollError> {
        let requested_span = {
            let mut src = OracleTapeSource {
                words: &st.tape,
                cursor: 0,
                last_span: None,
                exhausted_span: None,
            };
            match evaluate_with_source(expr, &mut src) {
                Ok(outcome) => {
                    assert_eq!(
                        src.cursor,
                        st.tape.len(),
                        "prefix-tape leaf must consume exact prefix"
                    );
                    *st.outcomes.entry(outcome.total).or_insert(0.0) += prob;
                    st.leaves += 1;
                    return Ok(());
                }
                Err(RollError::ReceiptInvalid(ReceiptVerifyError::DrawTapeUnderflow {
                    ..
                })) => src.exhausted_span.expect("span recorded on underflow"),
                Err(real_err) => return Err(real_err),
            }
        };

        if st.tape.len() >= max_draws || (min_branch_prob > 0.0 && prob < min_branch_prob) {
            st.tail_mass += prob;
            return Ok(());
        }

        let s = requested_span.get();
        let step_prob = prob / (s as f64);
        for k in 0..s {
            let word = lemire_witness_word(requested_span, k);
            st.tape.push(word);
            walk(expr, step_prob, max_draws, min_branch_prob, st)?;
            st.tape.pop();
        }
        Ok(())
    }

    let mut st = State {
        outcomes: BTreeMap::new(),
        tail_mass: 0.0,
        leaves: 0,
        tape: Vec::new(),
    };
    walk(expr, 1.0, max_draws, min_branch_prob, &mut st)?;

    Ok(PrefixOracleResult {
        distribution: Distribution {
            entries: st
                .outcomes
                .into_iter()
                .map(|(k, p)| (k, canon_f64(p)))
                .collect(),
        },
        tail_mass: canon_f64(st.tail_mass),
        leaves: st.leaves,
    })
}

#[cfg(test)]
mod tests {
    use alloc::boxed::Box;
    use alloc::vec::Vec;
    use core::num::NonZeroU32;
    use rand_chacha::ChaCha12Rng;
    use rand_core::{Rng, SeedableRng};

    use crate::ast::{
        BinaryOp, ClampBounds, CompareOp, ComparePoint, DiceSides, DiceSpec, ExplosionRule,
        ExplosionVariant, Expr, KeepDropOp, ResultMode, SortOrder,
    };
    use crate::error::RollError;
    use crate::eval::{EvalScratch, evaluate_total_with_source, evaluate_with_source};
    use crate::parser::parse;
    use crate::rng::{DrawSource, RollRng};

    /// Recording `DrawSource` beginning with adversarial Lemire rejection-retry boundary words
    /// (`0`, `1`, `u64::MAX`, `u64::MAX - 1`, `0x8000_0000_0000_0000`, ...) followed by a
    /// deterministic `ChaCha12Rng` stream so every retry branch in `sample_lemire_u64` is exercised.
    struct AdversarialRetrySource {
        prefix: &'static [u64],
        cursor: usize,
        fallback: ChaCha12Rng,
        draws: Vec<u64>,
    }

    impl AdversarialRetrySource {
        fn new(prefix: &'static [u64], seed: [u8; 32]) -> Self {
            Self {
                prefix,
                cursor: 0,
                fallback: ChaCha12Rng::from_seed(seed),
                draws: Vec::new(),
            }
        }
    }

    impl DrawSource for AdversarialRetrySource {
        fn next_u64_word(&mut self) -> Result<u64, RollError> {
            let word = if let Some(&w) = self.prefix.get(self.cursor) {
                self.cursor += 1;
                w
            } else {
                self.fallback.next_u64()
            };
            self.draws.push(word);
            Ok(word)
        }
    }

    fn gen_random_compare_point(rng: &mut ChaCha12Rng, lo: i64, hi: i64) -> ComparePoint {
        let op = match rng.next_u32() % 5 {
            0 => CompareOp::Eq,
            1 => CompareOp::Gt,
            2 => CompareOp::Gte,
            3 => CompareOp::Lt,
            _ => CompareOp::Lte,
        };
        let span = (hi - lo + 1) as u64;
        let value = lo + ((rng.next_u64() % span) as i64);
        ComparePoint { op, value }
    }

    fn gen_random_dice_spec(rng: &mut ChaCha12Rng) -> DiceSpec {
        let count = NonZeroU32::new(1 + (rng.next_u32() % 6)).expect("non-zero");
        let sides = match rng.next_u32() % 5 {
            0 => DiceSides::Fate,
            1 => DiceSides::Percentile,
            _ => {
                let s = 1 + (rng.next_u32() % 20);
                DiceSides::Standard(NonZeroU32::new(s).expect("non-zero"))
            }
        };
        let (lo, hi) = (sides.min_face() - 1, sides.max_face() + 1);

        let r_len = (rng.next_u32() % 3) as usize;
        let reroll_unlimited = (0..r_len)
            .map(|_| gen_random_compare_point(rng, lo, hi))
            .collect();

        let ro_len = (rng.next_u32() % 3) as usize;
        let reroll_once = (0..ro_len)
            .map(|_| gen_random_compare_point(rng, lo, hi))
            .collect();

        let clamp = match rng.next_u32() % 4 {
            0 => None,
            1 => Some(ClampBounds {
                min: Some(lo + ((rng.next_u32() % 6) as i64)),
                max: None,
            }),
            2 => Some(ClampBounds {
                min: None,
                max: Some(hi - ((rng.next_u32() % 6) as i64)),
            }),
            _ => {
                let a = lo + ((rng.next_u32() % 6) as i64);
                let b = a + ((rng.next_u32() % 6) as i64);
                Some(ClampBounds {
                    min: Some(a),
                    max: Some(b),
                })
            }
        };

        let explode = if sides == DiceSides::Fate || (rng.next_u32() & 1) == 0 {
            None
        } else {
            let variant = match rng.next_u32() % 3 {
                0 => ExplosionVariant::Standard,
                1 => ExplosionVariant::Compound,
                _ => ExplosionVariant::Penetrate,
            };
            let threshold = gen_random_compare_point(rng, 1, sides.max_face() + 1);
            Some(ExplosionRule { variant, threshold })
        };

        let kd_len = (rng.next_u32() % 3) as usize;
        let keep_drop = (0..kd_len)
            .map(|_| {
                let k = rng.next_u32() % 8;
                match rng.next_u32() % 4 {
                    0 => KeepDropOp::KeepHighest(k),
                    1 => KeepDropOp::KeepLowest(k),
                    2 => KeepDropOp::DropHighest(k),
                    _ => KeepDropOp::DropLowest(k),
                }
            })
            .collect();

        let mode = if (rng.next_u32() & 1) == 0 {
            ResultMode::Sum {
                crit_success_max: (rng.next_u32() & 1) != 0,
                crit_failure_min: (rng.next_u32() & 2) != 0,
            }
        } else {
            let cs_len = 1 + (rng.next_u32() % 2) as usize;
            let cf_len = (rng.next_u32() % 2) as usize;
            ResultMode::Pool {
                cs: (0..cs_len)
                    .map(|_| gen_random_compare_point(rng, lo, hi))
                    .collect(),
                cf: (0..cf_len)
                    .map(|_| gen_random_compare_point(rng, lo, hi))
                    .collect(),
            }
        };

        let sort = match rng.next_u32() % 3 {
            0 => None,
            1 => Some(SortOrder::Asc),
            _ => Some(SortOrder::Desc),
        };

        DiceSpec {
            count,
            sides,
            reroll_unlimited,
            reroll_once,
            clamp,
            explode,
            keep_drop,
            mode,
            sort,
        }
    }

    fn gen_random_expr(rng: &mut ChaCha12Rng, depth: u32) -> Expr {
        if depth == 0 {
            return if (rng.next_u32() & 3) == 0 {
                let v = (rng.next_u64() % 41) as i64 - 20;
                Expr::Number(v)
            } else {
                Expr::Dice(gen_random_dice_spec(rng))
            };
        }
        match rng.next_u32() % 6 {
            0 => Expr::UnaryNeg(Box::new(gen_random_expr(rng, depth - 1))),
            1..=4 => {
                let op = match rng.next_u32() % 4 {
                    0 => BinaryOp::Add,
                    1 => BinaryOp::Sub,
                    2 => BinaryOp::Mul,
                    _ => BinaryOp::DivFloor,
                };
                Expr::Binary {
                    op,
                    left: Box::new(gen_random_expr(rng, depth - 1)),
                    right: Box::new(gen_random_expr(rng, depth - 1)),
                }
            }
            _ => Expr::Dice(gen_random_dice_spec(rng)),
        }
    }

    #[test]
    fn evaluate_total_with_source_matches_evaluate_with_source_on_totals_errors_and_draws() {
        const CURATED: &[&str] = &[
            "0",
            "42",
            "-9223372036854775808",
            "-(-9223372036854775808)",
            "1d1",
            "1d6",
            "3d20",
            "2d%",
            "4dF",
            "-(2d6-7)",
            "1d6r=7",
            "3d4r<2",
            "2d6r=1r=2",
            "1d6r>=1",
            "2dFr=-1",
            "2d6ro=1",
            "2d6ro<=2ro=3",
            "3dFro<0",
            "2d6min2",
            "2d6max5",
            "4d8min3max6",
            "2dFmin0max1",
            "1d4max3!",
            "1d4max3!>=3",
            "1d6min7!>=7",
            "2d6!",
            "2d6!!",
            "2d6!p",
            "1d6!>=1",
            "1d6!!>=1",
            "1d6!p>=1",
            "1d1!p=1",
            "2d6min6!p>=5",
            "4d6kh3",
            "4d6kl1",
            "4d6dh1",
            "4d6dl1",
            "5d6dl1dh1kh2",
            "4d6kh0",
            "6d2dl2kh2",
            "4d6!kh3",
            "4d6!!kh3",
            "4d6!pkh3",
            "4d6sa",
            "4d6kh3sd",
            "5d10cs>=8cf<=1",
            "5d10cs>=5cf<=6",
            "5d10cs>8cf<3",
            "4d6!cs>=5cf<=1",
            "4d6!pcs>=5cf<=1",
            "4d6!!kh2cs>=6cf<=2",
            "3d4r=1dh1cs>=3cf<=1",
            "2d20cscf",
            "3dFcscf",
            "(2d6-8)/3",
            "(2d6-8)/-3",
            "(2d3ro=1-4)*(1dF)+(5d2kh3)/2",
            // Short-circuiting runtime errors (verify `right` consumes zero draws when `left` fails):
            "1d6/0+3d6",
            "1d6/(1d2-1)+3d6",
            "(-9223372036854775808)/-1+2d6",
            "(1d2+9223372036854775806)+3d6",
            "(1d2+9223372036854775805)*2+3d6",
            "1d2!!>=1+9223372036854775800",
        ];

        const RETRY_PREFIX: &[u64] = &[
            0,
            1,
            u64::MAX,
            u64::MAX - 1,
            u64::MAX - 2,
            0x8000_0000_0000_0000,
            0xFFFF_FFFF_FFFF_FFFE,
            123_456_789,
            0,
            0,
            u64::MAX,
        ];

        // Reuse one `EvalScratch` across the entire differential suite to stress buffer clearing.
        let mut shared_scratch = EvalScratch::new();
        let mut total_runs = 0usize;
        let mut error_runs = 0usize;

        for (expr_idx, &expr_str) in CURATED.iter().enumerate() {
            let expr = parse(expr_str).expect("valid curated expression");

            for seed_idx in 0..128u64 {
                let mut seed = [0u8; 32];
                seed[..8].copy_from_slice(&(expr_idx as u64).to_le_bytes());
                seed[8..16].copy_from_slice(&seed_idx.to_le_bytes());

                let mut rng_full = RollRng::from_raw_seed(seed);
                let mut rng_total = RollRng::from_raw_seed(seed);

                let full_res = evaluate_with_source(&expr, &mut rng_full).map(|o| o.total);
                let total_res =
                    evaluate_total_with_source(&expr, &mut rng_total, &mut shared_scratch);

                assert_eq!(
                    total_res, full_res,
                    "result mismatch on '{expr_str}' seed={seed_idx}"
                );
                assert_eq!(
                    rng_total.draws(),
                    rng_full.draws(),
                    "draw sequence mismatch on '{expr_str}' seed={seed_idx}"
                );
                if total_res.is_err() {
                    error_runs += 1;
                }
                total_runs += 1;
            }

            // Adversarial Lemire rejection-retry tape check:
            let retry_seed = [expr_idx as u8; 32];
            let mut src_full = AdversarialRetrySource::new(RETRY_PREFIX, retry_seed);
            let mut src_total = AdversarialRetrySource::new(RETRY_PREFIX, retry_seed);
            let full_retry = evaluate_with_source(&expr, &mut src_full).map(|o| o.total);
            let total_retry =
                evaluate_total_with_source(&expr, &mut src_total, &mut shared_scratch);
            assert_eq!(
                total_retry, full_retry,
                "retry-tape result mismatch on '{expr_str}'"
            );
            assert_eq!(
                src_total.draws, src_full.draws,
                "retry-tape draws mismatch on '{expr_str}'"
            );
            if total_retry.is_err() {
                error_runs += 1;
            }
            total_runs += 1;
        }

        // Randomly generated multi-stage ASTs × deterministic seeds:
        let mut ast_gen = ChaCha12Rng::from_seed(*b"roll.v3.diff_test.ast_generator!");
        for ast_idx in 0..250u64 {
            let expr = gen_random_expr(&mut ast_gen, 2);
            for seed_idx in 0..64u64 {
                let mut seed = [0xA5u8; 32];
                seed[..8].copy_from_slice(&ast_idx.to_le_bytes());
                seed[8..16].copy_from_slice(&seed_idx.to_le_bytes());

                let mut rng_full = RollRng::from_raw_seed(seed);
                let mut rng_total = RollRng::from_raw_seed(seed);

                let full_res = evaluate_with_source(&expr, &mut rng_full).map(|o| o.total);
                let total_res =
                    evaluate_total_with_source(&expr, &mut rng_total, &mut shared_scratch);

                assert_eq!(
                    total_res,
                    full_res,
                    "random AST #{ast_idx} ({}) mismatch on seed {seed_idx}",
                    expr.to_canonical_string()
                );
                assert_eq!(
                    rng_total.draws(),
                    rng_full.draws(),
                    "random AST #{ast_idx} ({}) draw mismatch on seed {seed_idx}",
                    expr.to_canonical_string()
                );
                if total_res.is_err() {
                    error_runs += 1;
                }
                total_runs += 1;
            }
        }

        assert_eq!(total_runs, CURATED.len() * 129 + 250 * 64);
        assert!(
            error_runs > 500,
            "expected error paths exercised, got {error_runs}"
        );
    }
}
