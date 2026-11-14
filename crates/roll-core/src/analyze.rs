//! Exact probability distribution analyzer, order-statistic DP, and Monte Carlo fallback (`Roll 3.0 §5`).
//!
//! `"Exact"` in Roll 3.0 means exact for the bounded `roll-core` engine pipeline as built
//! (`crates/roll-core/src/eval.rs`), including its per-die `MAX_REROLLS = 100` and
//! `MAX_EXPLOSIONS = 100` loop caps, and is never an unlabelled approximation.

use alloc::collections::BTreeMap;
use alloc::format;
use alloc::vec;
use alloc::vec::Vec;
use core::num::NonZeroU64;
use rand_chacha::ChaCha12Rng;
use rand_core::{Rng, SeedableRng};

use crate::ast::{
    BinaryOp, ComparePoint, DiceSides, DiceSpec, ExplosionRule, ExplosionVariant, Expr, KeepDropOp,
    MAX_EXPLOSIONS, MAX_REROLLS, ResultMode,
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

/// Maximum state count or inner-loop transition budget per exact pass before falling back to Monte Carlo (`§5.2`, `§5.3`).
pub const MAX_EXACT_STATES: usize = 10_000_000;

/// Default trial count for [`AnalysisMethod::MonteCarlo`] (`§5.3`).
pub const DEFAULT_MONTE_CARLO_SAMPLES: u32 = 100_000;

/// Fixed 32-byte `ChaCha12Rng` key used by the deterministic Monte Carlo fallback (`§5.3`).
pub const MONTE_CARLO_DEFAULT_SEED: &[u8; 32] = b"roll.v3.montecarlo.default.seed!";

/// Threshold on `(max_key - min_key + 1)` below which flat dense array accumulation is used
/// instead of `BTreeMap` (both produce bit-for-bit identical sorted `(i64, f64)` entries).
const MAX_DENSE_SPAN: u128 = 524_288;

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
        let mut prob = 0.0_f64;
        for &(_, p) in &self.entries[start..] {
            prob += p;
        }
        canon_f64(prob)
    }

    /// Computes $P(X \le \text{target})$.
    pub fn prob_at_most(&self, target: i64) -> f64 {
        let end = self.entries.partition_point(|&(v, _)| v <= target);
        let mut prob = 0.0_f64;
        for &(_, p) in &self.entries[..end] {
            prob += p;
        }
        canon_f64(prob)
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
        let mut prob = 0.0_f64;
        for &(_, p) in &self.entries[start..end] {
            prob += p;
        }
        canon_f64(prob)
    }

    /// Cumulative distribution function $v \mapsto P(X \le v)$ in ascending support order.
    pub fn cdf(&self) -> Vec<(i64, f64)> {
        let mut out = Vec::with_capacity(self.entries.len());
        let mut cumulative = 0.0_f64;
        for &(v, p) in &self.entries {
            cumulative += p;
            out.push((v, canon_f64(cumulative)));
        }
        out
    }

    /// Survival (complementary CDF) function $v \mapsto P(X \ge v)$ in ascending support order.
    pub fn survival(&self) -> Vec<(i64, f64)> {
        let mut total = 0.0_f64;
        for &(_, p) in &self.entries {
            total += p;
        }
        let mut out = Vec::with_capacity(self.entries.len());
        let mut below = 0.0_f64;
        for &(v, p) in &self.entries {
            let surv = (total - below).max(0.0);
            out.push((v, canon_f64(surv)));
            below += p;
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

        // Guard against floating-point sum ~`1.0 - 1e-16` while remaining strictly > 0.0
        // even for tiny positive `p < 1e-12` so underflowed `0.0` tail entries never false-match.
        let threshold = (p - 1e-12).max(p * 0.5);

        match dir {
            TargetDirection::AtMost => {
                let mut cumulative = 0.0_f64;
                for &(v, prob) in &self.entries {
                    cumulative += prob;
                    if cumulative >= threshold {
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
                let mut total = 0.0_f64;
                for &(_, prob) in &self.entries {
                    total += prob;
                }
                let mut below = 0.0_f64;
                for &(v, prob) in &self.entries {
                    let survival = total - below;
                    if survival >= threshold {
                        answer = v;
                    }
                    below += prob;
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

    let mut mass_sum = 0.0_f64;
    for &(_, p) in &dist.entries {
        mass_sum += p;
    }
    let needs_norm = (mass_sum - 1.0).abs() > 1e-12 && mass_sum > 0.0;
    let inv_norm = if needs_norm { 1.0 / mass_sum } else { 1.0 };

    let min = dist.entries[0].0;
    let max = dist.entries[dist.entries.len() - 1].0;

    let mut mean = 0.0_f64;
    let mut mode = min;
    let mut mode_prob = -1.0_f64;

    for &(v, raw_p) in &dist.entries {
        let p = if needs_norm { raw_p * inv_norm } else { raw_p };
        mean += (v as f64) * p;
        if p > mode_prob {
            mode_prob = p;
            mode = v;
        }
    }
    mean = canon_f64(mean);

    let mut variance = 0.0_f64;
    let mut entropy = 0.0_f64;
    for &(v, raw_p) in &dist.entries {
        let p = if needs_norm { raw_p * inv_norm } else { raw_p };
        let diff = (v as f64) - mean;
        variance += p * (diff * diff);
        if p > 0.0 {
            entropy -= p * log2_f64(p);
        }
    }
    let stddev = canon_f64(sqrt_f64(variance.max(0.0)));
    entropy = canon_f64(entropy.max(0.0));

    const PERCENTILE_KEYS: [u8; 6] = [10, 25, 50, 75, 90, 95];
    let mut percentiles = BTreeMap::new();
    let mut cumulative = 0.0_f64;
    let mut pct_idx = 0usize;

    let last_positive_value = dist
        .entries
        .iter()
        .rev()
        .find(|&&(_, raw_p)| raw_p > 0.0)
        .map_or(max, |&(v, _)| v);

    for &(v, raw_p) in &dist.entries {
        let p = if needs_norm { raw_p * inv_norm } else { raw_p };
        cumulative += p;
        while pct_idx < PERCENTILE_KEYS.len() {
            let key = PERCENTILE_KEYS[pct_idx];
            let target = f64::from(key) / 100.0;
            if cumulative >= target - 1e-15 {
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
/// or a deterministic `100,000`-sample Monte Carlo distribution (`Roll 3.0 §5`).
pub fn analyze(expr: &Expr) -> Result<AnalysisReport, RollError> {
    let total_dice = u64::from(expr.total_base_dice());
    if total_dice > u64::from(MAX_ANALYZE_DICE) {
        return Err(RollError::AnalysisBudgetExceeded {
            total_dice,
            max: u64::from(MAX_ANALYZE_DICE),
        });
    }

    match try_exact(expr) {
        Ok((distribution, caps)) => {
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
        Err(ExactAbort::TooLarge | ExactAbort::Unsupported) => {
            let samples = DEFAULT_MONTE_CARLO_SAMPLES;
            let distribution = monte_carlo_distribution(expr, samples)?;
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
/// Computes exact `A - B` margin distribution when `|A| * |B| <= MAX_EXACT_STATES`, and falls back
/// to an $O(|A| + |B|)$ symmetric two-pointer linear scan (`margin: None`) when `|A| * |B|` exceeds
/// `MAX_EXACT_STATES` (such as `compare("100d100", "100d100")`).
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

    match subtract_distributions(a, b) {
        Ok(margin_dist) => {
            let mut p_left_greater = 0.0_f64;
            let mut p_equal = 0.0_f64;
            let mut p_right_greater = 0.0_f64;
            for &(v, p) in &margin_dist.entries {
                if v > 0 {
                    p_left_greater += p;
                } else if v < 0 {
                    p_right_greater += p;
                } else {
                    p_equal += p;
                }
            }
            let mean_margin = canon_f64(left_report.stats.mean - right_report.stats.mean);
            Ok(ComparisonReport {
                left: left_report,
                right: right_report,
                p_left_greater: canon_f64(p_left_greater),
                p_equal: canon_f64(p_equal),
                p_right_greater: canon_f64(p_right_greater),
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
    let mut p_equal = 0.0_f64;
    let mut j = 0usize;
    let mut b_less_mass = 0.0_f64;
    for &(va, pa) in a_slice {
        while j < b_slice.len() && b_slice[j].0 < va {
            b_less_mass += b_slice[j].1;
            j += 1;
        }
        p_left_greater += pa * b_less_mass;
        if j < b_slice.len() && b_slice[j].0 == va {
            p_equal += pa * b_slice[j].1;
        }
    }

    // Symmetric scan of `B` against `A` so `compare(X, X)` yields bit-identical win probabilities.
    let mut p_right_greater = 0.0_f64;
    let mut i = 0usize;
    let mut a_less_mass = 0.0_f64;
    for &(vb, pb) in b_slice {
        while i < a_slice.len() && a_slice[i].0 < vb {
            a_less_mass += a_slice[i].1;
            i += 1;
        }
        p_right_greater += pb * a_less_mass;
    }

    (
        canon_f64(p_left_greater),
        canon_f64(p_equal),
        canon_f64(p_right_greater),
    )
}

// ─── Internal exact engine & accumulators ────────────────────────────────────

#[derive(Debug)]
enum ExactAbort {
    TooLarge,
    Unsupported,
    Error(RollError),
}

enum Accum {
    Dense {
        min_key: i64,
        slots: Vec<(bool, f64)>,
    },
    Sparse(BTreeMap<i64, f64>),
}

impl Accum {
    fn with_bounds(min_key: i64, max_key: i64) -> Self {
        if min_key <= max_key {
            let span = (i128::from(max_key) - i128::from(min_key) + 1) as u128;
            if span <= MAX_DENSE_SPAN {
                return Self::Dense {
                    min_key,
                    slots: vec![(false, 0.0_f64); span as usize],
                };
            }
        }
        Self::Sparse(BTreeMap::new())
    }

    fn sparse() -> Self {
        Self::Sparse(BTreeMap::new())
    }

    #[inline]
    fn add(&mut self, key: i64, prob: f64) {
        match self {
            Self::Dense { min_key, slots } => {
                let idx = (i128::from(key) - i128::from(*min_key)) as usize;
                let slot = &mut slots[idx];
                slot.0 = true;
                slot.1 += prob;
            }
            Self::Sparse(map) => {
                *map.entry(key).or_insert(0.0) += prob;
            }
        }
    }

    fn into_entries(self) -> Vec<(i64, f64)> {
        match self {
            Self::Dense { min_key, slots } => {
                let mut out = Vec::new();
                for (idx, (reached, p)) in slots.into_iter().enumerate() {
                    if reached {
                        let key = (i128::from(min_key) + (idx as i128)) as i64;
                        out.push((key, canon_f64(p)));
                    }
                }
                out
            }
            Self::Sparse(map) => map.into_iter().map(|(k, p)| (k, canon_f64(p))).collect(),
        }
    }

    fn into_distribution(self) -> Distribution {
        Distribution {
            entries: self.into_entries(),
        }
    }
}

fn try_exact(expr: &Expr) -> Result<(Distribution, ModelledCaps), ExactAbort> {
    match expr {
        Expr::Number(v) => Ok((Distribution::point(*v), ModelledCaps::default())),
        Expr::Dice(spec) => try_exact_dice(spec),
        Expr::UnaryNeg(operand) => {
            let (inner, caps) = try_exact(operand)?;
            let negated = negate_distribution(&inner)?;
            Ok((negated, caps))
        }
        Expr::Binary { op, left, right } => {
            // §5.4 Divide-by-zero contract:
            // 1. Evaluate `try_exact(right)` BEFORE `try_exact(left)`.
            // 2. If `right` is exact and `right.is_reachable(0)` on `/`, immediately return
            //    `Err(RollError::DivisionByZero)` even if `left` exceeds `MAX_EXACT_STATES`.
            // 3. Isolate `TooLarge` / `Unsupported` on `right` and `left` separately so any
            //    deterministic `DivisionByZero` or `ArithmeticOverflow` inside `left` still
            //    propagates when `right` is `TooLarge` or `Unsupported`.
            let right_res = match try_exact(right) {
                Ok((r_dist, r_caps)) => {
                    if *op == BinaryOp::DivFloor && r_dist.is_reachable(0) {
                        return Err(ExactAbort::Error(RollError::DivisionByZero));
                    }
                    Ok((r_dist, r_caps))
                }
                Err(ExactAbort::Error(err)) => return Err(ExactAbort::Error(err)),
                Err(non_fatal) => Err(non_fatal),
            };

            let left_res = match try_exact(left) {
                Ok(ok) => Ok(ok),
                Err(ExactAbort::Error(err)) => return Err(ExactAbort::Error(err)),
                Err(non_fatal) => Err(non_fatal),
            };

            let (left_dist, left_caps) = left_res?;
            let (right_dist, right_caps) = right_res?;

            let out = eval_binary_distributions(*op, &left_dist, &right_dist)?;
            let mut caps = left_caps;
            caps.merge_from(right_caps);
            Ok((out, caps))
        }
    }
}

fn eval_binary_distributions(
    op: BinaryOp,
    left: &Distribution,
    right: &Distribution,
) -> Result<Distribution, ExactAbort> {
    if right.len() == 1 {
        let rv = right.entries[0].0;
        let r_mass = right.entries[0].1;
        let out = match op {
            BinaryOp::Add => shift_distribution_weighted(left, rv, r_mass)?,
            BinaryOp::Sub => {
                // `va - rv` directly so `rv == i64::MIN` works whenever `va < 0`!
                subtract_scalar_weighted(left, rv, r_mass)?
            }
            BinaryOp::Mul => scale_distribution_weighted(left, rv, r_mass)?,
            BinaryOp::DivFloor => divide_distribution_weighted(left, rv, r_mass)?,
        };
        return Ok(out);
    }

    if left.len() == 1 {
        let lv = left.entries[0].0;
        let l_mass = left.entries[0].1;
        let out = match op {
            BinaryOp::Add => shift_distribution_weighted(right, lv, l_mass)?,
            BinaryOp::Sub => subtract_from_scalar_weighted(lv, l_mass, right)?,
            BinaryOp::Mul => scale_distribution_weighted(right, lv, l_mass)?,
            BinaryOp::DivFloor => divide_distributions(left, right)?,
        };
        return Ok(out);
    }

    match op {
        BinaryOp::Add => convolve(left, right),
        BinaryOp::Sub => subtract_distributions(left, right),
        BinaryOp::Mul => multiply_distributions(left, right),
        BinaryOp::DivFloor => divide_distributions(left, right),
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

/// Composes Stage 1 (base uniform die) -> Stage 2 (`reroll_unlimited` with `MAX_REROLLS = 100`
/// residual + `reroll_once`) -> Stage 3 (`min`/`max` clamp).
fn single_die_pre_explode(
    spec: &DiceSpec,
    caps: &mut ModelledCaps,
) -> Result<Distribution, ExactAbort> {
    let s = side_count(spec.sides);
    if s > MAX_EXACT_STATES {
        return Err(ExactAbort::TooLarge);
    }

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
        let mut p_match = 0.0_f64;
        for &(face, p) in &base_entries {
            if cp.matches(face) {
                match_count += 1;
                p_match += p;
            }
        }
        if match_count == 0 {
            continue;
        }

        // Because every base face is reachable entering each Stage 2a modifier and `match_count > 0`,
        // rolling matching faces `MAX_REROLLS` times in a row is reachable in `eval.rs`.
        caps.max_rerolls = Some(MAX_REROLLS);

        if match_count == s {
            // Every face matches (e.g. `1d6r>=1`): all 100 rerolls match and the 100th fresh
            // uniform draw stands across all `s` faces.
            let total_mass = base_entries.iter().map(|&(_, p)| p).sum::<f64>();
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
        let mut p_match = 0.0_f64;
        for &(face, p) in &base_entries {
            if cp.matches(face) {
                match_count += 1;
                p_match += p;
            }
        }
        if match_count == 0 {
            continue;
        }

        let reroll_share = p_match / (s as f64);
        for entry in &mut base_entries {
            let base_kept = if cp.matches(entry.0) { 0.0 } else { entry.1 };
            entry.1 = canon_f64(base_kept + reroll_share);
        }
    }

    // Stage 3: Clamp (`min <= max` guaranteed on parsed specs; checked defensively here too).
    if let Some(clamp) = spec.clamp {
        if let (Some(lo), Some(hi)) = (clamp.min, clamp.max)
            && lo > hi
        {
            return Err(ExactAbort::Error(RollError::InvalidClampBounds {
                min: lo,
                max: hi,
                byte_offset: 0,
            }));
        }
        let mut clamped_map = Accum::sparse();
        for (mut v, p) in base_entries {
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
            clamped_map.add(v, p);
        }
        Ok(clamped_map.into_distribution())
    } else {
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
) -> Result<Distribution, ExactAbort> {
    let is_penetrate = rule.variant == ExplosionVariant::Penetrate;
    let p_raw = 1.0 / (s as f64);
    let raw_faces: Vec<(i64, f64)> = (1..=s).map(|f| (f as i64, p_raw)).collect();

    let mut finished = BTreeMap::<i64, f64>::new();
    let mut accumulated: Vec<(i64, f64)> = vec![(0, 1.0)];
    let mut total_work: u128 = 0;

    for depth in 0..=MAX_EXPLOSIONS {
        let step_faces: &[(i64, f64)] = if depth == 0 {
            &initial_dist.entries
        } else {
            &raw_faces
        };

        let step_work = (accumulated.len() as u128) * (step_faces.len() as u128);
        total_work = total_work.saturating_add(step_work);
        if total_work > (MAX_EXACT_STATES as u128)
            || finished
                .len()
                .saturating_add(accumulated.len())
                .saturating_add(step_faces.len())
                > MAX_EXACT_STATES
        {
            return Err(ExactAbort::TooLarge);
        }

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

        let mut next_acc = Accum::with_bounds(min_next, max_next);

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
                    *finished.entry(total).or_insert(0.0) += prod;
                } else {
                    next_acc.add(total, prod);
                }
            }
        }

        accumulated = next_acc.into_entries();
        if accumulated.is_empty() {
            break;
        }
    }

    Ok(Distribution {
        entries: finished
            .into_iter()
            .map(|(k, p)| (k, canon_f64(p)))
            .collect(),
    })
}

/// Stage 4 single-chain net-success expansion for exploding pools (`Standard` / `Penetrate` with empty `keep_drop`).
fn explosion_chain_pool_pmf(
    initial_dist: &Distribution,
    s: usize,
    rule: ExplosionRule,
    cs: &[ComparePoint],
    cf: &[ComparePoint],
    caps: &mut ModelledCaps,
) -> Result<Distribution, ExactAbort> {
    let is_penetrate = rule.variant == ExplosionVariant::Penetrate;
    let p_raw = 1.0 / (s as f64);
    let raw_faces: Vec<(i64, f64)> = (1..=s).map(|f| (f as i64, p_raw)).collect();

    let bound = i64::from(MAX_EXPLOSIONS) + 1;
    let mut finished = Accum::with_bounds(-bound, bound);
    let mut accumulated: Vec<(i64, f64)> = vec![(0, 1.0)];
    let mut total_work: u128 = 0;

    for depth in 0..=MAX_EXPLOSIONS {
        let step_faces: &[(i64, f64)] = if depth == 0 {
            &initial_dist.entries
        } else {
            &raw_faces
        };

        let step_work = (accumulated.len() as u128) * (step_faces.len() as u128);
        total_work = total_work.saturating_add(step_work);
        if total_work > (MAX_EXACT_STATES as u128) {
            return Err(ExactAbort::TooLarge);
        }

        let depth_bound = i64::from(depth) + 1;
        let mut next_acc = Accum::with_bounds(-depth_bound, depth_bound);

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
                    finished.add(next_net, prod);
                } else {
                    next_acc.add(next_net, prod);
                }
            }
        }

        accumulated = next_acc.into_entries();
        if accumulated.is_empty() {
            break;
        }
    }

    Ok(finished.into_distribution())
}

fn try_exact_dice(spec: &DiceSpec) -> Result<(Distribution, ModelledCaps), ExactAbort> {
    let count = spec.count.get() as usize;
    let mut node_caps = ModelledCaps::default();
    let pre_explode = single_die_pre_explode(spec, &mut node_caps)?;

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
                    // Compound (`!!`) sums bonus rolls into the same die (`eval.rs:250-268`),
                    // leaving exactly `count` i.i.d. dice drawn from `D_compound` before keep/drop and sum/pool!
                    explosion_chain_sum_pmf(&pre_explode, s, rule, &mut node_caps)?
                }
                ExplosionVariant::Standard | ExplosionVariant::Penetrate => {
                    if !spec.keep_drop.is_empty() {
                        // Variable-size multiset of dice before keep/drop (`4d6!kh3`): fall back to MC (`§5.1`).
                        return Err(ExactAbort::Unsupported);
                    }
                    let chain_pmf = match &spec.mode {
                        ResultMode::Sum { .. } => {
                            explosion_chain_sum_pmf(&pre_explode, s, rule, &mut node_caps)?
                        }
                        ResultMode::Pool { cs, cf } => {
                            explosion_chain_pool_pmf(&pre_explode, s, rule, cs, cf, &mut node_caps)?
                        }
                    };
                    let total_dist = convolve_n(&chain_pmf, count)?;
                    return Ok((total_dist, node_caps));
                }
            }
        }
    };

    // Stage 5 (Keep / Drop) + Stage 8 (Sum / Pool) over `count` i.i.d. dice drawn from `single_die_for_group`.
    if !spec.keep_drop.is_empty() {
        let (l, r) = reduce_keep_drop_interval(count, &spec.keep_drop);
        if l == r {
            return Ok((Distribution::point(0), node_caps));
        }
        if l > 0 || r < count {
            let dp_dist = order_statistic_dp(&single_die_for_group, count, l, r, &spec.mode)?;
            return Ok((dp_dist, node_caps));
        }
        // `l == 0 && r == count`: all `count` dice are kept; fall through to fast `convolve_n`.
    }

    let per_die_contribution = match &spec.mode {
        ResultMode::Sum { .. } => single_die_for_group,
        ResultMode::Pool { cs, cf } => {
            let mut pool_acc = Accum::with_bounds(-1, 1);
            for &(v, p) in &single_die_for_group.entries {
                let delta = i64::from(pool_die_delta(v, cs, cf));
                pool_acc.add(delta, p);
            }
            pool_acc.into_distribution()
        }
    };

    let group_dist = convolve_n(&per_die_contribution, count)?;
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
) -> Result<Distribution, ExactAbort> {
    if l == r {
        return Ok(Distribution::point(0));
    }

    let faces = &single.entries;
    let m = faces.len();
    debug_assert!(m >= 1);

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

    let mut dp: Vec<Vec<(i64, f64)>> = vec![Vec::new(); n + 1];
    dp[0].push((0, 1.0));

    let mut accumulated_work: u128 = 0;

    for (face_idx, &(_v_i, p_i)) in faces.iter().enumerate() {
        // §5.2 Cost guard: accumulate inner transitions `sum_{j=0}^N |dp[j]| * (N - j + 1)` before step `i`.
        let mut step_transitions: u128 = 0;
        for (j, bucket) in dp.iter().enumerate() {
            if !bucket.is_empty() {
                step_transitions =
                    step_transitions.saturating_add((bucket.len() as u128) * ((n - j + 1) as u128));
            }
        }
        accumulated_work = accumulated_work.saturating_add(step_transitions);
        if accumulated_work > (MAX_EXACT_STATES as u128) {
            return Err(ExactAbort::TooLarge);
        }

        let val_i = vals[face_idx];
        let is_last_face = face_idx + 1 == m;

        if is_last_face {
            // On the final face `m - 1`, all remaining `c = n - j` dice must land on `v_{m-1}` to reach `dp[n]`.
            let mut final_acc = Accum::with_bounds(global_min_sum, global_max_sum);
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
                    final_acc.add(next_sum, prob * w);
                }
            }
            return Ok(final_acc.into_distribution());
        }

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

                let target_acc = next_acc[next_j].get_or_insert_with(|| {
                    let kept_so_far = next_j.min(r).saturating_sub(l) as i64;
                    let lo_a = kept_so_far.saturating_mul(min_val);
                    let hi_a = kept_so_far.saturating_mul(max_val);
                    Accum::with_bounds(lo_a.min(hi_a).min(0), lo_a.max(hi_a).max(0))
                });

                for &(s, prob) in bucket {
                    let next_sum = s
                        .checked_add(delta_sum)
                        .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
                    target_acc.add(next_sum, prob * w);
                }
            }
        }

        let mut total_states = 0usize;
        let mut next_dp = Vec::with_capacity(n + 1);
        for slot in next_acc {
            let entries = slot.map_or_else(Vec::new, Accum::into_entries);
            total_states = total_states.saturating_add(entries.len());
            if total_states > MAX_EXACT_STATES {
                return Err(ExactAbort::TooLarge);
            }
            next_dp.push(entries);
        }
        dp = next_dp;
    }

    Ok(Distribution {
        entries: dp.pop().unwrap_or_default(),
    })
}

// ─── §5.3 Distribution algebra & Monte Carlo fallback ────────────────────────

fn negate_distribution(dist: &Distribution) -> Result<Distribution, ExactAbort> {
    let mut out = Vec::with_capacity(dist.entries.len());
    for &(v, p) in dist.entries.iter().rev() {
        let neg_v = v
            .checked_neg()
            .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
        out.push((neg_v, p));
    }
    Ok(Distribution { entries: out })
}

fn shift_distribution_weighted(
    dist: &Distribution,
    offset: i64,
    weight: f64,
) -> Result<Distribution, ExactAbort> {
    let mut out = Vec::with_capacity(dist.entries.len());
    for &(v, p) in &dist.entries {
        let shifted = v
            .checked_add(offset)
            .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
        out.push((shifted, canon_f64(p * weight)));
    }
    Ok(Distribution { entries: out })
}

fn subtract_scalar_weighted(
    dist: &Distribution,
    subtrahend: i64,
    weight: f64,
) -> Result<Distribution, ExactAbort> {
    let mut out = Vec::with_capacity(dist.entries.len());
    for &(v, p) in &dist.entries {
        let diff = v
            .checked_sub(subtrahend)
            .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
        out.push((diff, canon_f64(p * weight)));
    }
    Ok(Distribution { entries: out })
}

fn subtract_from_scalar_weighted(
    minuend: i64,
    weight: f64,
    right: &Distribution,
) -> Result<Distribution, ExactAbort> {
    let mut out = Vec::with_capacity(right.entries.len());
    for &(rv, rp) in right.entries.iter().rev() {
        let diff = minuend
            .checked_sub(rv)
            .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
        out.push((diff, canon_f64(weight * rp)));
    }
    Ok(Distribution { entries: out })
}

fn scale_distribution_weighted(
    dist: &Distribution,
    factor: i64,
    weight: f64,
) -> Result<Distribution, ExactAbort> {
    if factor == 0 {
        let total_p: f64 = dist.entries.iter().map(|&(_, p)| p * weight).sum();
        return Ok(Distribution {
            entries: vec![(0, canon_f64(total_p))],
        });
    }
    let mut out = Vec::with_capacity(dist.entries.len());
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
    Ok(Distribution { entries: out })
}

fn divide_distribution_weighted(
    dist: &Distribution,
    divisor: i64,
    weight: f64,
) -> Result<Distribution, ExactAbort> {
    if divisor == 0 {
        return Err(ExactAbort::Error(RollError::DivisionByZero));
    }
    let first_q = checked_div_floor(dist.entries[0].0, divisor).map_err(ExactAbort::Error)?;
    let last_q = checked_div_floor(dist.entries[dist.entries.len() - 1].0, divisor)
        .map_err(ExactAbort::Error)?;
    let mut acc = Accum::with_bounds(first_q.min(last_q), first_q.max(last_q));
    for &(v, p) in &dist.entries {
        let q = checked_div_floor(v, divisor).map_err(ExactAbort::Error)?;
        acc.add(q, p * weight);
    }
    Ok(acc.into_distribution())
}

fn convolve(a: &Distribution, b: &Distribution) -> Result<Distribution, ExactAbort> {
    let a_len = a.len() as u128;
    let b_len = b.len() as u128;
    if a_len + b_len - 1 > (MAX_EXACT_STATES as u128) || a_len * b_len > (MAX_EXACT_STATES as u128)
    {
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

    let mut acc = Accum::with_bounds(min_sum, max_sum);
    for &(va, pa) in &a.entries {
        for &(vb, pb) in &b.entries {
            acc.add(va + vb, pa * pb);
        }
    }
    Ok(acc.into_distribution())
}

fn subtract_distributions(a: &Distribution, b: &Distribution) -> Result<Distribution, ExactAbort> {
    let a_len = a.len() as u128;
    let b_len = b.len() as u128;
    if a_len + b_len - 1 > (MAX_EXACT_STATES as u128) || a_len * b_len > (MAX_EXACT_STATES as u128)
    {
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

    let mut acc = Accum::with_bounds(min_diff, max_diff);
    for &(va, pa) in &a.entries {
        for &(vb, pb) in &b.entries {
            acc.add(va - vb, pa * pb);
        }
    }
    Ok(acc.into_distribution())
}

/// Convolves `single` `count` times using bounded binary exponentiation (`§5.3`).
///
/// Builds power-of-two doublings `2^k * single` while squaring fits within `MAX_EXACT_STATES`,
/// and steps greedily by the largest chunk `2^k * single` whose product `|acc| * |chunk|` stays
/// within `MAX_EXACT_STATES`. This runs in $O(\log N)$ convolutions on moderate supports and
/// preserves exactness on wide cases like `100d100` where `32d100 * 32d100` (`3169^2 = 10.04M`)
/// would narrowly exceed `10,000,000` while `48d100 * 16d100` (`4753 * 1585 = 7.53M`) stays under!
fn convolve_n(single: &Distribution, count: usize) -> Result<Distribution, ExactAbort> {
    if count == 0 {
        return Ok(Distribution::point(0));
    }
    if count == 1 || single.len() == 1 {
        if single.len() == 1 {
            let v = single.entries[0]
                .0
                .checked_mul(count as i64)
                .ok_or(ExactAbort::Error(RollError::ArithmeticOverflow))?;
            let p = powi_u32(single.entries[0].1, count as u32);
            return Ok(Distribution {
                entries: vec![(v, canon_f64(p))],
            });
        }
        return Ok(single.clone());
    }

    let mut powers: Vec<(usize, Distribution)> = vec![(1, single.clone())];
    loop {
        let &(step_n, ref last_dist) = powers.last().expect("non-empty");
        let Some(next_n) = step_n.checked_mul(2) else {
            break;
        };
        if next_n > count {
            break;
        }
        let len_u128 = last_dist.len() as u128;
        if len_u128 * len_u128 > (MAX_EXACT_STATES as u128)
            || 2 * len_u128 - 1 > (MAX_EXACT_STATES as u128)
        {
            break;
        }
        let squared = convolve(last_dist, last_dist)?;
        powers.push((next_n, squared));
    }

    let (top_n, top_dist) = powers.last().expect("non-empty").clone();
    let mut acc = top_dist;
    let mut remaining = count - top_n;

    while remaining > 0 {
        let mut chosen_idx: Option<usize> = None;
        for (idx, &(chunk_n, ref chunk_dist)) in powers.iter().enumerate().rev() {
            if chunk_n <= remaining {
                let prod = (acc.len() as u128) * (chunk_dist.len() as u128);
                let sum_support = (acc.len() as u128) + (chunk_dist.len() as u128) - 1;
                if prod <= (MAX_EXACT_STATES as u128) && sum_support <= (MAX_EXACT_STATES as u128) {
                    chosen_idx = Some(idx);
                    break;
                }
            }
        }

        let Some(idx) = chosen_idx else {
            return Err(ExactAbort::TooLarge);
        };
        acc = convolve(&acc, &powers[idx].1)?;
        remaining -= powers[idx].0;
    }

    Ok(acc)
}

fn multiply_distributions(a: &Distribution, b: &Distribution) -> Result<Distribution, ExactAbort> {
    if (a.len() as u128) * (b.len() as u128) > (MAX_EXACT_STATES as u128) {
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

    let mut acc = Accum::with_bounds(min_prod, max_prod);
    for &(va, pa) in &a.entries {
        for &(vb, pb) in &b.entries {
            acc.add(va * vb, pa * pb);
        }
    }
    Ok(acc.into_distribution())
}

fn divide_distributions(a: &Distribution, b: &Distribution) -> Result<Distribution, ExactAbort> {
    if b.is_reachable(0) {
        return Err(ExactAbort::Error(RollError::DivisionByZero));
    }
    if (a.len() as u128) * (b.len() as u128) > (MAX_EXACT_STATES as u128) {
        return Err(ExactAbort::TooLarge);
    }

    let mut acc = Accum::sparse();
    for &(va, pa) in &a.entries {
        for &(vb, pb) in &b.entries {
            let q = checked_div_floor(va, vb).map_err(ExactAbort::Error)?;
            acc.add(q, pa * pb);
        }
    }
    Ok(acc.into_distribution())
}

struct StreamDrawSource {
    rng: ChaCha12Rng,
}

impl DrawSource for StreamDrawSource {
    #[inline]
    fn next_u64_word(&mut self) -> Result<u64, RollError> {
        Ok(self.rng.next_u64())
    }
}

/// Estimates the distribution of `expr` via `samples` trials on the continuous
/// `ChaCha12Rng::from_seed(*MONTE_CARLO_DEFAULT_SEED)` stream (`§5.3`).
pub fn monte_carlo_distribution(expr: &Expr, samples: u32) -> Result<Distribution, RollError> {
    let mut source = StreamDrawSource {
        rng: ChaCha12Rng::from_seed(*MONTE_CARLO_DEFAULT_SEED),
    };
    let mut scratch = EvalScratch::new();
    let mut counts = BTreeMap::<i64, u32>::new();

    for _ in 0..samples {
        let total = evaluate_total_with_source(expr, &mut source, &mut scratch)?;
        *counts.entry(total).or_insert(0) += 1;
    }

    let inv_samples = 1.0 / f64::from(samples);
    let entries = counts
        .into_iter()
        .map(|(v, c)| (v, canon_f64(f64::from(c) * inv_samples)))
        .collect();
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
    exhausted_span: Option<NonZeroU64>,
}

impl DrawSource for OracleTapeSource<'_> {
    fn next_u64_word(&mut self) -> Result<u64, RollError> {
        if let Some(&word) = self.words.get(self.cursor) {
            self.cursor += 1;
            Ok(word)
        } else {
            Err(RollError::ReceiptInvalid(
                ReceiptVerifyError::DrawTapeUnderflow {
                    needed_at_index: self.cursor,
                },
            ))
        }
    }

    fn sample_lemire_u64(&mut self, span: NonZeroU64) -> Result<u64, RollError> {
        if self.cursor >= self.words.len() {
            self.exhausted_span = Some(span);
            return Err(RollError::ReceiptInvalid(
                ReceiptVerifyError::DrawTapeUnderflow {
                    needed_at_index: self.cursor,
                },
            ));
        }
        // Execute the exact `DrawSource::sample_lemire_u64` integer multiplication-rejection math.
        let s = span.get();
        let x = self.next_u64_word()?;
        let mut m = u128::from(x) * u128::from(s);
        let mut low = m as u64;
        if low < s {
            let threshold = s.wrapping_neg() % s;
            while low < threshold {
                let x_retry = self.next_u64_word()?;
                m = u128::from(x_retry) * u128::from(s);
                low = m as u64;
            }
        }
        Ok((m >> 64) as u64)
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
