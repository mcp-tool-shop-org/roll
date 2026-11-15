//! Support-only reachability pass for the `§5.4` divisor check.
//!
//! Computes, for a subexpression, which integers it can produce **without an error**, as sets of
//! intervals and with no probabilities. Each value set is held twice:
//! - `must`: every value in it is reachable (a subset of the true success set);
//! - `may`: every reachable value is in it (a superset of the true success set).
//!
//! When a set would hold more than [`MAX_INTERVALS`] intervals, a `may` set merges its smallest gaps
//! (it stays a superset) and a `must` set drops the intervals farthest from zero, keeping its lowest
//! and highest (it stays a subset), so the
//! pass costs `O(nodes * MAX_INTERVALS^2 * log(count))` work at most, whatever the probabilities.
//!
//! The walk follows the engine's evaluation order (`eval.rs`: left operand, right operand, then
//! the operator), so a division's zero is only counted as reachable when everything the engine
//! evaluates before it can succeed on the same execution.

use alloc::vec::Vec;

use crate::ast::{
    BinaryOp, ClampBounds, CompareOp, ComparePoint, DiceSpec, ExplosionVariant, Expr, KeepDropOp,
    MAX_EXPLOSIONS, MAX_REROLLS, MAX_TOTAL_DRAWS, ResultMode,
};

/// Maximum intervals kept per set before it is coarsened.
const MAX_INTERVALS: usize = 128;

/// Maximum points enumerated for one interval product before falling back to corners or the hull.
const MAX_ENUMERATED_PRODUCT: u128 = 256;

/// Maximum points enumerated across one set product.
const MAX_ENUMERATED_POINTS: u128 = 4_096;

/// Intervals each operand of a set product is coarsened to first (`32^2` interval pairs at most).
const MAX_MUL_OPERAND_INTERVALS: usize = 32;

/// Three-valued answer of the support pass.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub(crate) enum Tri {
    No,
    Maybe,
    Yes,
}

#[derive(Copy, Clone, PartialEq, Eq)]
enum Kind {
    Must,
    May,
}

/// Sorted, disjoint, non-adjacent closed `i64` intervals.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct IvSet {
    iv: Vec<(i64, i64)>,
}

fn clip(lo: i128, hi: i128) -> Option<(i64, i64)> {
    let lo = lo.max(i128::from(i64::MIN));
    let hi = hi.min(i128::from(i64::MAX));
    (lo <= hi).then_some((lo as i64, hi as i64))
}

fn ceil_div(a: i128, b: i128) -> i128 {
    -floor_div(-a, b)
}

fn floor_div(a: i128, b: i128) -> i128 {
    let q = a / b;
    if a % b != 0 && ((a < 0) != (b < 0)) {
        q - 1
    } else {
        q
    }
}

impl IvSet {
    const fn empty() -> Self {
        Self { iv: Vec::new() }
    }

    fn point(v: i64) -> Self {
        Self {
            iv: alloc::vec![(v, v)],
        }
    }

    fn range(lo: i64, hi: i64) -> Self {
        if lo > hi {
            Self::empty()
        } else {
            Self {
                iv: alloc::vec![(lo, hi)],
            }
        }
    }

    /// Builds a normalized set from `i128` pieces; parts outside `i64` are overflow paths and dropped.
    fn from_pieces(mut pieces: Vec<(i128, i128)>, kind: Kind) -> Self {
        pieces.sort_unstable();
        let mut iv: Vec<(i64, i64)> = Vec::with_capacity(pieces.len());
        for (lo, hi) in pieces {
            let Some((lo, hi)) = clip(lo, hi) else {
                continue;
            };
            if let Some(last) = iv.last_mut()
                && i128::from(lo) <= i128::from(last.1) + 1
            {
                last.1 = last.1.max(hi);
                continue;
            }
            iv.push((lo, hi));
        }
        let mut out = Self { iv };
        out.cap(kind);
        out
    }

    fn cap(&mut self, kind: Kind) {
        self.cap_to(MAX_INTERVALS, kind);
    }

    fn cap_to(&mut self, limit: usize, kind: Kind) {
        let n = self.iv.len();
        if n <= limit {
            return;
        }
        match kind {
            Kind::May => {
                // Merge the `n - MAX_INTERVALS` smallest gaps, the ones farthest from zero first among
                // equal gaps (small offsets from zero are what divisors test): still a superset.
                let mut gaps: Vec<(i128, core::cmp::Reverse<i128>, usize)> = (1..n)
                    .map(|i| {
                        let (lo, hi) = (i128::from(self.iv[i - 1].1), i128::from(self.iv[i].0));
                        (hi - lo, core::cmp::Reverse(lo.abs().min(hi.abs())), i)
                    })
                    .collect();
                gaps.sort_unstable();
                let mut merge = alloc::vec![false; n];
                for &(_, _, i) in gaps.iter().take(n - limit) {
                    merge[i] = true;
                }
                let mut iv: Vec<(i64, i64)> = Vec::with_capacity(limit);
                for (i, &(lo, hi)) in self.iv.iter().enumerate() {
                    if merge[i] {
                        let last = iv.last_mut().expect("gap index >= 1");
                        last.1 = hi;
                    } else {
                        iv.push((lo, hi));
                    }
                }
                self.iv = iv;
            }
            Kind::Must => {
                // Keep the lowest and highest intervals (overflow witnesses) and the ones closest
                // to zero (what divisors test): still a subset.
                let dist = |&(lo, hi): &(i64, i64)| -> i128 {
                    if lo <= 0 && hi >= 0 {
                        0
                    } else {
                        i128::from(lo).abs().min(i128::from(hi).abs())
                    }
                };
                let mut order: Vec<usize> = (1..n - 1).collect();
                order.sort_by_key(|&i| (dist(&self.iv[i]), i));
                let mut keep = alloc::vec![false; n];
                keep[0] = true;
                keep[n - 1] = true;
                for &i in order.iter().take(limit - 2) {
                    keep[i] = true;
                }
                let mut i = 0;
                self.iv.retain(|_| {
                    let k = keep[i];
                    i += 1;
                    k
                });
            }
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.iv.is_empty()
    }

    pub(crate) fn contains(&self, v: i64) -> bool {
        let idx = self.iv.partition_point(|&(_, hi)| hi < v);
        idx < self.iv.len() && self.iv[idx].0 <= v
    }

    fn hull(&self) -> Option<(i64, i64)> {
        Some((self.iv.first()?.0, self.iv.last()?.1))
    }

    fn union(&self, other: &Self, kind: Kind) -> Self {
        let pieces = self
            .iv
            .iter()
            .chain(other.iv.iter())
            .map(|&(lo, hi)| (i128::from(lo), i128::from(hi)))
            .collect();
        Self::from_pieces(pieces, kind)
    }

    fn add(&self, other: &Self, kind: Kind) -> Self {
        let mut pieces = Vec::with_capacity(self.iv.len() * other.iv.len());
        for &(a, b) in &self.iv {
            for &(c, d) in &other.iv {
                pieces.push((i128::from(a) + i128::from(c), i128::from(b) + i128::from(d)));
            }
        }
        Self::from_pieces(pieces, kind)
    }

    fn neg(&self, kind: Kind) -> Self {
        let pieces = self
            .iv
            .iter()
            .map(|&(lo, hi)| (-i128::from(hi), -i128::from(lo)))
            .collect();
        Self::from_pieces(pieces, kind)
    }

    fn sub(&self, other: &Self, kind: Kind) -> Self {
        // `-MIN` is not an `i64`, so negate in `i128` pieces rather than through `neg`.
        let mut pieces = Vec::with_capacity(self.iv.len() * other.iv.len());
        for &(a, b) in &self.iv {
            for &(c, d) in &other.iv {
                pieces.push((i128::from(a) - i128::from(d), i128::from(b) - i128::from(c)));
            }
        }
        Self::from_pieces(pieces, kind)
    }

    fn mul(&self, other: &Self, kind: Kind) -> Self {
        // Bound the work: at most `MAX_MUL_OPERAND_INTERVALS^2` interval pairs, and at most
        // `MAX_ENUMERATED_POINTS` points enumerated per product; past that, corners or the hull.
        let mut lhs = self.clone();
        lhs.cap_to(MAX_MUL_OPERAND_INTERVALS, kind);
        let mut rhs = other.clone();
        rhs.cap_to(MAX_MUL_OPERAND_INTERVALS, kind);
        let mut enumerable = MAX_ENUMERATED_POINTS;
        let mut pieces: Vec<(i128, i128)> = Vec::new();
        for &(a, b) in &lhs.iv {
            for &(c, d) in &rhs.iv {
                let (a, b, c, d) = (i128::from(a), i128::from(b), i128::from(c), i128::from(d));
                let corners = [a * c, a * d, b * c, b * d];
                let lo = *corners.iter().min().expect("4 corners");
                let hi = *corners.iter().max().expect("4 corners");
                let (scalar, span) = if a == b {
                    (Some(a), (c, d))
                } else if c == d {
                    (Some(c), (a, b))
                } else {
                    (None, (0, 0))
                };
                // Widths in `u128` (each at most 2^64): their product can overflow, and an overflow
                // means "too many points", never "enumerate".
                let width = |lo: i128, hi: i128| (hi - lo) as u128 + 1;
                let points = width(a, b).checked_mul(width(c, d));
                let enumerate =
                    points.is_some_and(|p| p <= MAX_ENUMERATED_PRODUCT && p <= enumerable);
                if enumerate {
                    enumerable -= points.unwrap_or(0);
                }
                match scalar {
                    // `{-1, 0, 1} * interval` is an interval.
                    Some(k) if (-1..=1).contains(&k) => pieces.push((lo, hi)),
                    Some(k) if enumerate => {
                        // Hard cap independent of the precomputed count (defence in depth).
                        let mut steps: u128 = 0;
                        for v in span.0..=span.1 {
                            steps += 1;
                            if steps > MAX_ENUMERATED_PRODUCT {
                                pieces.push((lo, hi));
                                break;
                            }
                            pieces.push((k * v, k * v));
                        }
                    }
                    None if enumerate => {
                        let mut steps: u128 = 0;
                        'outer: for x in a..=b {
                            for y in c..=d {
                                steps += 1;
                                if steps > MAX_ENUMERATED_PRODUCT {
                                    pieces.push((lo, hi));
                                    break 'outer;
                                }
                                pieces.push((x * y, x * y));
                            }
                        }
                    }
                    // `k * [lo, hi]` with too many points: keep only the factors whose product
                    // fits `i64` (the others overflow), so a partial overflow does not widen the
                    // hull to all of `i64`, and its ends are real values for `must`.
                    Some(k) => {
                        let (fmin, fmax) = if k > 0 {
                            (
                                ceil_div(i128::from(i64::MIN), k),
                                floor_div(i128::from(i64::MAX), k),
                            )
                        } else {
                            (
                                ceil_div(i128::from(i64::MAX), k),
                                floor_div(i128::from(i64::MIN), k),
                            )
                        };
                        let (vlo, vhi) = (span.0.max(fmin), span.1.min(fmax));
                        if vlo <= vhi {
                            let (x, y) = (k * vlo, k * vhi);
                            match kind {
                                Kind::May => pieces.push((x.min(y), x.max(y))),
                                Kind::Must => {
                                    pieces.push((x, x));
                                    pieces.push((y, y));
                                    if vlo <= 0 && vhi >= 0 {
                                        pieces.push((0, 0));
                                    }
                                }
                            }
                        }
                    }
                    _ => match kind {
                        Kind::May => pieces.push((lo, hi)),
                        Kind::Must => {
                            pieces.extend(corners.iter().map(|&v| (v, v)));
                            // `0 * y == 0` for any `y`, so a factor interval holding `0` witnesses it.
                            if (a <= 0 && b >= 0) || (c <= 0 && d >= 0) {
                                pieces.push((0, 0));
                            }
                        }
                    },
                }
            }
        }
        Self::from_pieces(pieces, kind)
    }

    /// `floor(a / b)` over the non-zero part of `other` (a zero divisor is an error path).
    fn div_floor(&self, other: &Self, kind: Kind) -> Self {
        let mut divisors: Vec<(i128, i128)> = Vec::new();
        for &(c, d) in &other.iv {
            let (c, d) = (i128::from(c), i128::from(d));
            if c <= -1 {
                divisors.push((c, d.min(-1)));
            }
            if d >= 1 {
                divisors.push((c.max(1), d));
            }
        }
        let mut pieces: Vec<(i128, i128)> = Vec::new();
        for &(a, b) in &self.iv {
            let (a, b) = (i128::from(a), i128::from(b));
            for &(c, d) in &divisors {
                match kind {
                    Kind::May => {
                        let q = [
                            floor_div(a, c),
                            floor_div(a, d),
                            floor_div(b, c),
                            floor_div(b, d),
                        ];
                        let lo = *q.iter().min().expect("4 corners");
                        let hi = *q.iter().max().expect("4 corners");
                        pieces.push((lo, hi));
                    }
                    Kind::Must => {
                        // For one fixed divisor `k`, `a -> floor(a / k)` moves by at most 1 per step,
                        // so it covers a whole interval. Use both ends of the divisor interval: the
                        // one closest to zero and the one farthest from it (which reaches the small
                        // quotients, `0` among them).
                        for k in [c, d] {
                            let (x, y) = (floor_div(a, k), floor_div(b, k));
                            pieces.push((x.min(y), x.max(y)));
                        }
                    }
                }
            }
        }
        Self::from_pieces(pieces, kind)
    }

    /// `n`-fold sumset (`n` i.i.d. values summed), by binary exponentiation.
    fn nfold(&self, n: u64, kind: Kind) -> Self {
        if n == 0 {
            return Self::point(0);
        }
        if self.iv.len() == 1 {
            let (lo, hi) = self.iv[0];
            let n = i128::from(n);
            return Self::from_pieces(alloc::vec![(i128::from(lo) * n, i128::from(hi) * n)], kind);
        }
        let mut result = Self::point(0);
        let mut base = self.clone();
        let mut n = n;
        loop {
            if n & 1 == 1 {
                result = result.add(&base, kind);
            }
            n >>= 1;
            if n == 0 {
                break;
            }
            base = base.add(&base, kind);
        }
        result
    }

    /// Values of `self` that satisfy (`want == true`) or fail (`false`) `cp`.
    fn filter(&self, cp: ComparePoint, want: bool, kind: Kind) -> Self {
        let v = i128::from(cp.value);
        let (lo, hi) = match cp.op {
            CompareOp::Eq => (v, v),
            CompareOp::Gt => (v + 1, i128::from(i64::MAX)),
            CompareOp::Gte => (v, i128::from(i64::MAX)),
            CompareOp::Lt => (i128::from(i64::MIN), v - 1),
            CompareOp::Lte => (i128::from(i64::MIN), v),
        };
        let mut pieces = Vec::new();
        for &(a, b) in &self.iv {
            let (a, b) = (i128::from(a), i128::from(b));
            if want {
                pieces.push((a.max(lo), b.min(hi)));
            } else {
                pieces.push((a, b.min(lo - 1)));
                pieces.push((a.max(hi + 1), b));
            }
        }
        pieces.retain(|&(x, y)| x <= y);
        Self::from_pieces(pieces, kind)
    }

    /// Image under a non-decreasing map (`clamp`, penetrate's `max(r - 1, 1)`).
    fn map_monotone(&self, f: impl Fn(i64) -> i64, kind: Kind) -> Self {
        let pieces = self
            .iv
            .iter()
            .map(|&(lo, hi)| (i128::from(f(lo)), i128::from(f(hi))))
            .collect();
        Self::from_pieces(pieces, kind)
    }

    /// Set of pool contributions `[cs hit] - [cf hit]` (a subset of `{-1, 0, 1}`) over `self`.
    fn pool_contributions(&self, cs: &[ComparePoint], cf: &[ComparePoint], kind: Kind) -> Self {
        // The contribution is constant between consecutive compare-point values, so testing each
        // interval's ends and every compare value (and its neighbours) inside it is exhaustive.
        let mut seen = [false; 3];
        for &(lo, hi) in &self.iv {
            let mut probe = |v: i64| {
                if v >= lo && v <= hi {
                    let hit_cs = cs.iter().any(|cp| cp.matches(v));
                    let hit_cf = cf.iter().any(|cp| cp.matches(v));
                    seen[(i8::from(hit_cs) - i8::from(hit_cf) + 1) as usize] = true;
                }
            };
            probe(lo);
            probe(hi);
            for cp in cs.iter().chain(cf.iter()) {
                probe(cp.value.saturating_sub(1));
                probe(cp.value);
                probe(cp.value.saturating_add(1));
            }
        }
        let pieces = (-1_i128..=1)
            .filter(|&c| seen[(c + 1) as usize])
            .map(|c| (c, c))
            .collect();
        Self::from_pieces(pieces, kind)
    }
}

/// Success set of a subexpression: `must ⊆ true success set ⊆ may`.
#[derive(Clone, Debug)]
pub(crate) struct Abs {
    pub(crate) must: IvSet,
    pub(crate) may: IvSet,
}

impl Abs {
    /// A subexpression that always errors.
    const fn never() -> Self {
        Self {
            must: IvSet::empty(),
            may: IvSet::empty(),
        }
    }

    fn exact(set: IvSet) -> Self {
        Self {
            must: set.clone(),
            may: set,
        }
    }

    /// Whether the subexpression can succeed (produce any value without an error).
    pub(crate) fn can_succeed(&self) -> Tri {
        if !self.must.is_empty() {
            Tri::Yes
        } else if self.may.is_empty() {
            Tri::No
        } else {
            Tri::Maybe
        }
    }

    /// Whether `v` is a reachable success value.
    pub(crate) fn reaches(&self, v: i64) -> Tri {
        if self.must.contains(v) {
            Tri::Yes
        } else if self.may.contains(v) {
            Tri::Maybe
        } else {
            Tri::No
        }
    }
}

fn clamp_value(v: i64, clamp: Option<ClampBounds>) -> i64 {
    let Some(c) = clamp else { return v };
    let mut v = v;
    if let Some(lo) = c.min
        && v < lo
    {
        v = lo;
    }
    if let Some(hi) = c.max
        && v > hi
    {
        v = hi;
    }
    v
}

/// Explosion chain support for one die: the set of chain sums (`Sum` mode and compound) or of
/// chain contribution sums (`Pool` mode with `!`/`!p`), following `eval.rs` Stage 4 exactly:
/// the first test uses the post-clamp value, every later test the raw face, and the chain stops
/// after `MAX_EXPLOSIONS` draws whether or not the last face matched.
fn chain_set(
    spec: &DiceSpec,
    pre: &IvSet,
    contrib: Option<(&[ComparePoint], &[ComparePoint])>,
    kind: Kind,
) -> IvSet {
    let rule = spec.explode.expect("chain_set needs an explosion");
    let faces = IvSet::range(spec.sides.min_face(), spec.sides.max_face());
    let raw_match = faces.filter(rule.threshold, true, kind);
    let raw_stop = faces.filter(rule.threshold, false, kind);
    let child = |s: &IvSet| match rule.variant {
        ExplosionVariant::Penetrate => s.map_monotone(|r| (r - 1).max(1), kind),
        ExplosionVariant::Standard | ExplosionVariant::Compound => s.clone(),
    };
    let value = |s: IvSet| match contrib {
        Some((cs, cf)) => s.pool_contributions(cs, cf, kind),
        None => s,
    };
    let step_continue = value(child(&raw_match));
    let step_stop = value(child(&raw_stop));
    let step_any = value(child(&faces));

    let mut finished = value(pre.filter(rule.threshold, false, kind));
    let mut open = value(pre.filter(rule.threshold, true, kind));
    for depth in 1..=MAX_EXPLOSIONS {
        if open.is_empty() {
            break;
        }
        if depth == MAX_EXPLOSIONS {
            finished = finished.union(&open.add(&step_any, kind), kind);
        } else {
            finished = finished.union(&open.add(&step_stop, kind), kind);
            open = open.add(&step_continue, kind);
        }
    }
    finished
}

/// The kept total of one concrete execution of an exploding keep/drop group in which every one of
/// the `n` initial dice shows `v0` (an exploding post-clamp value) and its chain ends on the lowest
/// stopping face, or, when every face matches, runs `MAX_EXPLOSIONS` children on the lowest face.
fn exploding_witness(
    spec: &DiceSpec,
    rule: crate::ast::ExplosionRule,
    v0: i64,
    pool: Option<(&[ComparePoint], &[ComparePoint])>,
) -> Option<i64> {
    let n = u128::from(spec.count.get());
    let (lo, hi) = (spec.sides.min_face(), spec.sides.max_face());
    let stop = IvSet::range(lo, hi)
        .filter(rule.threshold, false, Kind::May)
        .iv
        .first()
        .map(|i| i.0);
    let (raw, per_die) = match stop {
        Some(f) => (f, 1_u128),
        None => (lo, u128::from(MAX_EXPLOSIONS)),
    };
    let child = match rule.variant {
        ExplosionVariant::Penetrate => (raw - 1).max(1),
        ExplosionVariant::Standard | ExplosionVariant::Compound => raw,
    };
    let value = |v: i64| -> i128 {
        match pool {
            Some((cs, cf)) => i128::from(crate::eval::pool_die_delta(v, cs, cf)),
            None => i128::from(v),
        }
    };
    // The pool sorted by value: `n` copies of the smaller value, then the rest.
    let (small, small_n, large, large_n) = if v0 <= child {
        (v0, n, child, n * per_die)
    } else {
        (child, n * per_die, v0, n)
    };
    let len = usize::try_from(small_n + large_n).ok()?;
    let (l, r) = crate::analyze::reduce_keep_drop_interval(len, &spec.keep_drop);
    let (l, r) = (l as u128, r as u128);
    let from_small = r.min(small_n).saturating_sub(l.min(small_n));
    let from_large = (r - l) - from_small;
    let total = value(small) * from_small as i128 + value(large) * from_large as i128;
    i64::try_from(total).ok()
}

fn kept_count(pool: usize, ops: &[KeepDropOp]) -> u64 {
    let (l, r) = crate::analyze::reduce_keep_drop_interval(pool, ops);
    (r - l) as u64
}

fn dice_set(spec: &DiceSpec, kind: Kind) -> IvSet {
    let n = spec.count.get() as usize;
    let lo = spec.sides.min_face();
    let hi = spec.sides.max_face();
    // Stage 2 rerolls never remove a face (the `MAX_REROLLS` residual and a reroll-once can both
    // leave any face), and the Stage 3 clamp is non-decreasing, so the post-clamp set is an interval.
    let pre = IvSet::range(clamp_value(lo, spec.clamp), clamp_value(hi, spec.clamp));
    let pool = match &spec.mode {
        ResultMode::Pool { cs, cf } => Some((cs.as_slice(), cf.as_slice())),
        ResultMode::Sum { .. } => None,
    };
    let contributions = |s: &IvSet| match pool {
        Some((cs, cf)) => s.pool_contributions(cs, cf, kind),
        None => s.clone(),
    };

    // An explosion whose first test (on the post-clamp value) can never pass leaves a fixed pool.
    let variable_pool = matches!(
        spec.explode,
        Some(r) if r.variant != ExplosionVariant::Compound
            && !pre.filter(r.threshold, true, kind).is_empty()
    );
    if variable_pool {
        if spec.keep_drop.is_empty() {
            // Each initial die's chain (the die and its children) adds independently.
            return chain_set(spec, &pre, pool, kind).nfold(n as u64, kind);
        }
        let rule = spec.explode.expect("variable pool");
        return match kind {
            Kind::Must => {
                // Executions where no die explodes: `n` dice from the non-matching post-clamp values.
                let calm = pre.filter(rule.threshold, false, kind);
                let mut must = if calm.is_empty() {
                    IvSet::empty()
                } else {
                    contributions(&calm).nfold(kept_count(n, &spec.keep_drop), kind)
                };
                // Plus two concrete executions in which every die explodes, so `must` is never
                // empty: every initial die shows the lowest (or the highest) exploding post-clamp
                // value, and each chain ends on the lowest stopping face (or, when every face
                // matches, runs `MAX_EXPLOSIONS` children on the lowest face).
                let exploding = pre.filter(rule.threshold, true, kind);
                for v0 in [
                    exploding.iv.first().map(|i| i.0),
                    exploding.iv.last().map(|i| i.1),
                ]
                .into_iter()
                .flatten()
                {
                    if let Some(w) = exploding_witness(spec, rule, v0, pool) {
                        must = must.union(&IvSet::point(w), kind);
                    }
                }
                must
            }
            Kind::May => {
                // Every pool value is a post-clamp initial value or a child value; the kept count
                // is non-decreasing in the pool size, which lies in `[n, n * (MAX_EXPLOSIONS + 1)]`.
                let faces = IvSet::range(lo, hi);
                let child = match rule.variant {
                    ExplosionVariant::Penetrate => faces.map_monotone(|r| (r - 1).max(1), kind),
                    _ => faces,
                };
                let values = contributions(&pre.union(&child, kind));
                let Some((vlo, vhi)) = values.hull() else {
                    return IvSet::empty();
                };
                let k_lo = kept_count(n, &spec.keep_drop);
                let k_hi = kept_count(
                    n.saturating_mul(MAX_EXPLOSIONS as usize + 1),
                    &spec.keep_drop,
                );
                if k_lo == k_hi {
                    // A fixed kept count: the kept sum is a `k`-fold sum of pool values.
                    return values.nfold(k_lo, kind);
                }
                let (k_lo, k_hi) = (i128::from(k_lo), i128::from(k_hi));
                let (vlo, vhi) = (i128::from(vlo), i128::from(vhi));
                IvSet::from_pieces(
                    alloc::vec![((k_lo * vlo).min(k_hi * vlo), (k_lo * vhi).max(k_hi * vhi))],
                    kind,
                )
            }
        };
    }

    // Fixed pool of `n` i.i.d. dice (no explosion, or compound).
    let die = match spec.explode {
        Some(_) => chain_set(spec, &pre, None, kind),
        None => pre,
    };
    let per_die = contributions(&die);
    // Any multiset of `m` per-die values can be the kept ranks `[l, r)`: put the dropped low dice
    // at the minimum and the dropped high dice at the maximum.
    let kept = if spec.keep_drop.is_empty() {
        n as u64
    } else {
        kept_count(n, &spec.keep_drop)
    };
    per_die.nfold(kept, kind)
}

fn dice_abs(spec: &DiceSpec) -> Abs {
    let must = dice_set(spec, Kind::Must);
    let may = dice_set(spec, Kind::May);
    // Dice groups never error (`sum(count) * max |value|` fits in `i64`), and the `may` set is a
    // superset: keep the `must` witnesses inside it even if the two coarsened differently.
    let may = may.union(&must, Kind::May);
    Abs { must, may }
}

fn binary_abs(op: BinaryOp, l: &Abs, r: &Abs) -> Abs {
    let apply = |a: &IvSet, b: &IvSet, kind: Kind| -> IvSet {
        if a.is_empty() || b.is_empty() {
            return IvSet::empty();
        }
        match op {
            BinaryOp::Add => a.add(b, kind),
            BinaryOp::Sub => a.sub(b, kind),
            BinaryOp::Mul => a.mul(b, kind),
            BinaryOp::DivFloor => a.div_floor(b, kind),
        }
    };
    let must = apply(&l.must, &r.must, Kind::Must);
    let may = apply(&l.may, &r.may, Kind::May).union(&must, Kind::May);
    Abs { must, may }
}

/// What the support pass learned about one `DivFloor` node, in engine evaluation order.
pub(crate) struct DivisorRecord<'a> {
    /// The division node.
    pub(crate) node: &'a Expr,
    /// The divisor subtree (`right` operand).
    pub(crate) divisor: &'a Expr,
    /// Whether the engine reaches the division with its dividend and divisor both evaluated
    /// successfully: everything evaluated before it can succeed, and the dividend can succeed.
    /// `Maybe` exactly when `conds` is not empty.
    pub(crate) reached: Tri,
    /// The earlier operands whose success the support pass could not decide (`must` empty, `may`
    /// not): the division is reached when every one of them can succeed (with a non-zero value,
    /// when the flag is set). They are disjoint subtrees with independent dice, so their
    /// successes combine (the draw budget aside). See [`Cond`].
    pub(crate) conds: Vec<Cond<'a>>,
    /// Whether the divisor can evaluate to `0` without an error.
    pub(crate) zero: Tri,
}

/// An undecided earlier operand: the subtree, and whether it must succeed with a non-zero value
/// (the divisor of a division it sits under) rather than with any value.
///
/// A node whose own operator cannot raise an error for any pair of operand values in their `may`
/// sets succeeds exactly when its operands do (a division's divisor with a non-zero value), so an
/// undecided node like that is split into its undecided operands. For a sum of terms, the
/// conditions are then the undecided terms themselves, whatever order they are written in.
pub(crate) type Cond<'a> = (&'a Expr, bool);

/// Reachability of a subexpression: `None` when it is never reached, else the undecided earlier
/// operands it depends on (none: reached).
type Reach<'a> = Option<Vec<Cond<'a>>>;

/// What the walk learned about one node, for splitting conditions.
#[derive(Copy, Clone)]
struct NodeFact {
    /// Whether the node can succeed.
    succeed: Tri,
    /// Whether it can succeed with a non-zero value.
    nonzero: Tri,
    /// Whether its own operator cannot raise an error for operand values in their `may` sets.
    safe: bool,
}

type Facts = alloc::collections::BTreeMap<usize, NodeFact>;

fn addr(e: &Expr) -> usize {
    core::ptr::from_ref(e) as usize
}

fn record_fact(facts: &mut Facts, e: &Expr, abs: &Abs, safe: bool) {
    let nonzero = if abs.must.iv.iter().any(|&(lo, hi)| lo != 0 || hi != 0) {
        Tri::Yes
    } else if abs.may.iv.iter().all(|&(lo, hi)| lo == 0 && hi == 0) {
        Tri::No
    } else {
        Tri::Maybe
    };
    facts.insert(
        addr(e),
        NodeFact {
            succeed: abs.can_succeed(),
            nonzero,
            safe,
        },
    );
}

/// Whether `op` cannot raise an error for any `a` in `l` and `b` in `r` (a zero divisor aside,
/// which a division's split asks about separately).
fn op_safe(op: BinaryOp, l: &IvSet, r: &IvSet) -> bool {
    let (Some((a, b)), Some((c, d))) = (l.hull(), r.hull()) else {
        return true;
    };
    let (a, b, c, d) = (i128::from(a), i128::from(b), i128::from(c), i128::from(d));
    let fits = |lo: i128, hi: i128| lo >= i128::from(i64::MIN) && hi <= i128::from(i64::MAX);
    match op {
        BinaryOp::Add => fits(a + c, b + d),
        BinaryOp::Sub => fits(a - d, b - c),
        BinaryOp::Mul => {
            let k = [a * c, a * d, b * c, b * d];
            fits(
                k.iter().copied().min().unwrap_or(0),
                k.iter().copied().max().unwrap_or(0),
            )
        }
        BinaryOp::DivFloor => !(a == i128::from(i64::MIN) && c <= -1 && d >= -1),
    }
}

/// The undecided parts of `e`, which must succeed (with a non-zero value if `nonzero`).
fn split_cond<'a>(e: &'a Expr, nonzero: bool, facts: &Facts, out: &mut Vec<Cond<'a>>) {
    let Some(f) = facts.get(&addr(e)).copied() else {
        out.push((e, nonzero));
        return;
    };
    if (if nonzero { f.nonzero } else { f.succeed }) == Tri::Yes {
        return;
    }
    match e {
        Expr::Binary { op, left, right } if f.safe && !nonzero => {
            split_cond(left, false, facts, out);
            split_cond(right, *op == BinaryOp::DivFloor, facts, out);
        }
        Expr::UnaryNeg(inner) if f.safe && !nonzero => split_cond(inner, false, facts, out),
        _ => out.push((e, nonzero)),
    }
}

fn reach_tri(reach: &Reach<'_>) -> Tri {
    match reach {
        None => Tri::No,
        Some(c) if c.is_empty() => Tri::Yes,
        Some(_) => Tri::Maybe,
    }
}

/// Walks `expr` in engine order, returning its success set and appending one record per division.
///
/// Left spines are walked iteratively; recursion follows right operands and unary operands only,
/// whose depth the parser caps at `MAX_NESTING_DEPTH`.
pub(crate) fn walk<'a>(expr: &'a Expr, out: &mut Vec<DivisorRecord<'a>>) -> Abs {
    let mut facts = Facts::new();
    walk_inner(expr, &Some(Vec::new()), 0, out, &mut facts).0
}

/// Fewest `roll_single_die` calls one die of `spec` makes (the initial roll, its rerolls and its
/// explosion chain) on any execution. Every roll takes at least one RNG word, so `count` times
/// this is a lower bound on the group's draws.
///
/// It is a shortest path over the faces through the stages of `eval.rs`, held as the least cost
/// of each face, piecewise constant over intervals (each compare point splits at most two
/// pieces, so there are at most `2 * modifiers + 1`):
/// - `r` with matched set `M`: a face outside `M` keeps its cost or is reached after one reroll
///   from the cheapest face in `M`; a face in `M` is final only after `MAX_REROLLS` rerolls;
/// - `ro`: every face in `M` is rerolled once and lands anywhere;
/// - the clamp maps the faces, and an explosion whose first test passes rolls one child (or
///   `MAX_EXPLOSIONS` when every raw face matches).
///
/// It is tighter than `analyze`'s certain-draw rule (§5.3.1), which the Monte Carlo cost model
/// keeps: `1d4ro<=2ro>=3` always rolls twice, and that rule counts once.
pub(crate) fn min_rolls_per_die(spec: &DiceSpec) -> u64 {
    let (lo, hi) = (spec.sides.min_face(), spec.sides.max_face());
    // `(lo, hi, cost)` pieces covering `[lo, hi]` in order.
    let mut pieces: Vec<(i64, i64, u64)> = alloc::vec![(lo, hi, 1)];
    for (cp, once) in spec
        .reroll_unlimited
        .iter()
        .map(|&cp| (cp, false))
        .chain(spec.reroll_once.iter().map(|&cp| (cp, true)))
    {
        // Split every piece into its matched and unmatched parts.
        let mut tagged: Vec<(i64, i64, u64, bool)> = Vec::with_capacity(pieces.len() + 2);
        for &(a, b, c) in &pieces {
            let range = IvSet::range(a, b);
            for (part, hit) in [
                (range.filter(cp, true, Kind::May), true),
                (range.filter(cp, false, Kind::May), false),
            ] {
                tagged.extend(part.iv.iter().map(|&(x, y)| (x, y, c, hit)));
            }
        }
        tagged.sort_unstable_by_key(|p| p.0);
        let Some(min_m) = tagged.iter().filter(|p| p.3).map(|p| p.2).min() else {
            continue;
        };
        let landed = min_m.saturating_add(1);
        let stuck = if once {
            landed
        } else {
            min_m.saturating_add(u64::from(MAX_REROLLS))
        };
        pieces = tagged
            .into_iter()
            .map(|(a, b, c, hit)| (a, b, if hit { stuck } else { c.min(landed) }))
            .collect();
    }
    let Some(rule) = spec.explode else {
        return pieces.iter().map(|p| p.2).min().unwrap_or(1);
    };
    let child = if IvSet::range(lo, hi)
        .filter(rule.threshold, false, Kind::May)
        .is_empty()
    {
        u64::from(MAX_EXPLOSIONS)
    } else {
        1
    };
    // Stage 3 is non-decreasing, so each piece maps to an interval of post-clamp values.
    pieces
        .iter()
        .map(|&(a, b, c)| {
            let post = IvSet::range(clamp_value(a, spec.clamp), clamp_value(b, spec.clamp));
            if post.filter(rule.threshold, false, Kind::May).is_empty() {
                c.saturating_add(child)
            } else {
                c
            }
        })
        .min()
        .unwrap_or(1)
}

/// Fewest draws every evaluation of `spec` takes.
fn group_min_draws(spec: &DiceSpec) -> u64 {
    u64::from(spec.count.get()).saturating_mul(min_rolls_per_die(spec))
}

/// [`walk`], also carrying the fewest draws every evaluation takes before `expr` (`prefix`).
/// A subexpression whose fewest draws, with everything evaluated before it, exceed
/// `MAX_TOTAL_DRAWS` always raises `DrawBudgetExceeded`, so its success set is empty: nothing
/// after it is reached, which is what `precheck_divisors` and the main pass both rely on.
fn walk_inner<'a>(
    expr: &'a Expr,
    reach: &Reach<'a>,
    prefix: u64,
    out: &mut Vec<DivisorRecord<'a>>,
    facts: &mut Facts,
) -> (Abs, u64) {
    let over = |draws: u64| prefix.saturating_add(draws) > u64::from(MAX_TOTAL_DRAWS);
    // `(op, right, left, node)` per binary node of the left spine, outermost first.
    let mut spine: Vec<(BinaryOp, &'a Expr, &'a Expr, &'a Expr)> = Vec::new();
    let mut leftmost = expr;
    while let Expr::Binary { op, left, right } = leftmost {
        spine.push((*op, right, left, leftmost));
        leftmost = left;
    }
    let mut leftmost_safe = true;
    let (mut acc, mut draws) = match leftmost {
        Expr::Number(v) => (Abs::exact(IvSet::point(*v)), 0),
        Expr::Dice(spec) => (dice_abs(spec), group_min_draws(spec)),
        Expr::UnaryNeg(inner) => {
            let (a, d) = walk_inner(inner, reach, prefix, out, facts);
            leftmost_safe = !a.may.contains(i64::MIN);
            let must = a.must.neg(Kind::Must);
            let may = a.may.neg(Kind::May).union(&must, Kind::May);
            (Abs { must, may }, d)
        }
        Expr::Binary { .. } => unreachable!("spine walk stops at a non-binary node"),
    };
    if over(draws) {
        acc = Abs::never();
    }
    record_fact(facts, leftmost, &acc, leftmost_safe);
    for &(op, right, left, node) in spine.iter().rev() {
        // `acc` is the success set of `left`, the operand the engine evaluates just before `right`.
        let right_reach = match (reach, acc.can_succeed()) {
            (None, _) | (_, Tri::No) => None,
            (Some(c), Tri::Yes) => Some(c.clone()),
            (Some(c), Tri::Maybe) => {
                let mut c = c.clone();
                split_cond(left, false, facts, &mut c);
                Some(c)
            }
        };
        let (r, r_draws) = walk_inner(
            right,
            &right_reach,
            prefix.saturating_add(draws),
            out,
            facts,
        );
        if op == BinaryOp::DivFloor {
            out.push(DivisorRecord {
                node,
                divisor: right,
                reached: reach_tri(&right_reach),
                conds: right_reach.unwrap_or_default(),
                zero: r.reaches(0),
            });
        }
        draws = draws.saturating_add(r_draws);
        let safe = op_safe(op, &acc.may, &r.may);
        acc = if over(draws) {
            Abs::never()
        } else {
            binary_abs(op, &acc, &r)
        };
        record_fact(facts, node, &acc, safe);
    }
    (acc, draws)
}

/// Whether `expr` can be evaluated without an error (`Tri::Yes` only when a witness value is known).
pub(crate) fn can_succeed(expr: &Expr) -> Tri {
    let mut sink = Vec::new();
    walk(expr, &mut sink).can_succeed()
}

/// Draw facts about one node, for the main exact pass's error reporting.
#[derive(Copy, Clone, Debug)]
pub(crate) struct NodeDraws {
    /// Fewest and most die rolls of everything the engine evaluates before the node.
    before_min: u64,
    before_max: u64,
    /// Fewest and most die rolls of the node itself.
    own_min: u64,
    own_max: u64,
    /// Whether no dice group evaluated before the node whose draws vary between runs sits under
    /// a node that can raise an error (checked with interval hulls, so `false` may be
    /// pessimistic). Then the success of everything before does not depend on those groups, and
    /// they can take their cheapest runs.
    before_safe: bool,
}

impl NodeDraws {
    /// Whether an error the node raises itself, once its operands have succeeded, is one the
    /// engine can reach within the draw budget:
    /// - `No` when every evaluation has exceeded `MAX_TOTAL_DRAWS` by the end of the node;
    /// - `Yes` when every evaluation fits, or when `before_safe` holds and the cheapest run of
    ///   what comes before, followed by any run of the node, fits (every face sequence has an
    ///   execution with one word per roll, so rolls are draws there);
    /// - `Maybe` otherwise.
    pub(crate) fn error_reachable(&self) -> Tri {
        let max = u64::from(MAX_TOTAL_DRAWS);
        if self.before_min.saturating_add(self.own_min) > max {
            Tri::No
        } else if self.before_max.saturating_add(self.own_max) <= max
            || (self.before_safe && self.before_min.saturating_add(self.own_max) <= max)
        {
            Tri::Yes
        } else {
            Tri::Maybe
        }
    }
}

/// [`NodeDraws`] for every node of one expression, keyed by node address, from one engine-order
/// walk (`O(nodes)` entries).
pub(crate) struct DrawContext {
    nodes: alloc::collections::BTreeMap<usize, NodeDraws>,
}

struct DrawRun {
    min: u64,
    max: u64,
    safe: bool,
    nodes: alloc::collections::BTreeMap<usize, NodeDraws>,
}

fn widen((a, b): (i64, i64)) -> (i128, i128) {
    (i128::from(a), i128::from(b))
}

/// Records `e`'s facts and returns its success-value hull (`None`: it never succeeds) and whether
/// it holds a dice group whose draws vary between runs. Recursion follows the expression, as
/// `expr_max_die_rolls` does.
fn draw_visit(e: &Expr, run: &mut DrawRun) -> (Option<(i128, i128)>, bool) {
    let (bmin, bmax, bsafe) = (run.min, run.max, run.safe);
    let (hull, local_safe, varies) = match e {
        Expr::Number(v) => (Some((i128::from(*v), i128::from(*v))), true, false),
        Expr::Dice(spec) => {
            let (lo, hi) = (
                group_min_draws(spec),
                crate::analyze::group_max_die_rolls(spec),
            );
            run.min = run.min.saturating_add(lo);
            run.max = run.max.saturating_add(hi);
            (dice_abs(spec).may.hull().map(widen), true, lo != hi)
        }
        Expr::UnaryNeg(inner) => match draw_visit(inner, run) {
            (Some((a, b)), v) => (clip(-b, -a).map(widen), a > i128::from(i64::MIN), v),
            (None, v) => (None, true, v),
        },
        Expr::Binary { op, left, right } => {
            let (l, lv) = draw_visit(left, run);
            let (r, rv) = draw_visit(right, run);
            match (l, r) {
                (Some((a, b)), Some((c, d))) => {
                    let (lo, hi) = match op {
                        BinaryOp::Add => (a + c, b + d),
                        BinaryOp::Sub => (a - d, b - c),
                        BinaryOp::Mul => {
                            let k = [a * c, a * d, b * c, b * d];
                            (
                                k.iter().copied().min().unwrap_or(0),
                                k.iter().copied().max().unwrap_or(0),
                            )
                        }
                        BinaryOp::DivFloor => {
                            let m = a.abs().max(b.abs());
                            (-m, m)
                        }
                    };
                    let safe = match op {
                        BinaryOp::DivFloor => {
                            !(c <= 0 && d >= 0) && !(a == i128::from(i64::MIN) && c <= -1)
                        }
                        _ => lo >= i128::from(i64::MIN) && hi <= i128::from(i64::MAX),
                    };
                    // A constant factor: only the factors whose product fits succeed.
                    let hull = match (op, a == b, c == d) {
                        (BinaryOp::Mul, true, _) => scaled_hull(a, c, d),
                        (BinaryOp::Mul, _, true) => scaled_hull(c, a, b),
                        _ => clip(lo, hi).map(widen),
                    };
                    (hull, safe, lv || rv)
                }
                _ => (None, true, lv || rv),
            }
        }
    };
    // What comes after `e` may assume the cheapest run of everything before it only when no
    // group whose draws vary sits under a node that can fail (that run may not succeed).
    run.safe &= local_safe || !varies;
    run.nodes.insert(
        core::ptr::from_ref(e) as usize,
        NodeDraws {
            before_min: bmin,
            before_max: bmax,
            own_min: run.min - bmin,
            own_max: run.max - bmax,
            before_safe: bsafe,
        },
    );
    (hull, varies)
}

/// Hull of the values `k * v`, `v` in `[lo, hi]`, that fit `i64`.
fn scaled_hull(k: i128, lo: i128, hi: i128) -> Option<(i128, i128)> {
    if k == 0 {
        return Some((0, 0));
    }
    let (fmin, fmax) = if k > 0 {
        (
            ceil_div(i128::from(i64::MIN), k),
            floor_div(i128::from(i64::MAX), k),
        )
    } else {
        (
            ceil_div(i128::from(i64::MAX), k),
            floor_div(i128::from(i64::MIN), k),
        )
    };
    let (vlo, vhi) = (lo.max(fmin), hi.min(fmax));
    (vlo <= vhi).then(|| ((k * vlo).min(k * vhi), (k * vlo).max(k * vhi)))
}

impl DrawContext {
    pub(crate) fn new(expr: &Expr) -> Self {
        let mut run = DrawRun {
            min: 0,
            max: 0,
            safe: true,
            nodes: alloc::collections::BTreeMap::new(),
        };
        draw_visit(expr, &mut run);
        Self { nodes: run.nodes }
    }

    /// Facts for `e`, a node of the expression this context was built from.
    pub(crate) fn get(&self, e: &Expr) -> Option<NodeDraws> {
        self.nodes.get(&(core::ptr::from_ref(e) as usize)).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse;

    fn records(src: &str) -> Vec<(Tri, Tri)> {
        let e = parse(src).unwrap();
        let mut out = Vec::new();
        walk(&e, &mut out);
        out.iter().map(|r| (r.reached, r.zero)).collect()
    }

    /// `min_rolls_per_die` against the engine: the fewest words over every tape of up to five
    /// single-word faces (a `d2`..`d4` has no Lemire retry for the witness words), on generated
    /// one-die specs, and never below `analyze`'s certain-draw rule.
    #[test]
    fn min_rolls_per_die_matches_the_engine_on_small_dice() {
        use crate::analyze::{certain_draws_per_die, lemire_witness_word};
        use crate::eval::evaluate_with_tape;
        use alloc::format;
        use core::num::NonZeroU64;

        let one = |src: &str| match parse(src).unwrap() {
            Expr::Dice(s) => min_rolls_per_die(&s),
            _ => unreachable!("a dice group"),
        };
        assert_eq!(one("1d4ro<=2ro>=3"), 2);
        assert_eq!(one("1d6r>=1"), 101);
        assert_eq!(one("1d6ro>=1"), 2);
        assert_eq!(one("1d6r<=3ro>=4"), 2);
        assert_eq!(one("1d6!>=1"), 101);
        assert_eq!(one("1d6min6!"), 2);
        assert_eq!(one("1d6r<=5ro=6"), 2);

        struct Lcg(u64);
        impl Lcg {
            fn next(&mut self, n: u64) -> u64 {
                self.0 = self
                    .0
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                (self.0 >> 33) % n
            }
        }
        const OPS: [&str; 5] = ["=", ">", ">=", "<", "<="];
        let mut rng = Lcg(20_261_114);
        let mut checked = 0;
        for _ in 0..400 {
            let sides = 2 + rng.next(3);
            let mut src = format!("1d{sides}");
            for _ in 0..rng.next(4) {
                src.push_str(["r", "ro"][rng.next(2) as usize]);
                src.push_str(OPS[rng.next(5) as usize]);
                src.push_str(&format!("{}", 1 + rng.next(sides)));
            }
            match rng.next(4) {
                0 => src.push_str(&format!("min{}", 1 + rng.next(sides))),
                1 => src.push_str(&format!("max{}", 1 + rng.next(sides))),
                _ => {}
            }
            if rng.next(2) == 0 {
                // `!`, `!p` or `!!`; `>=1` explodes on every face, so the chain runs
                // `MAX_EXPLOSIONS` children (past the 5-face tapes).
                src.push_str(["!", "!p", "!!"][rng.next(3) as usize]);
                if rng.next(4) == 0 {
                    src.push_str(">=1");
                } else {
                    src.push_str(&format!(">{}", rng.next(sides + 1)));
                }
            }
            let Ok(expr) = parse(&src) else { continue };
            let Expr::Dice(spec) = &expr else {
                unreachable!("a dice group")
            };
            let span = NonZeroU64::new(sides).unwrap();
            // Fewest words over every tape of up to 5 faces (`None`: more than 5).
            let mut best: Option<u64> = None;
            'len: for len in 1..=5_u32 {
                for code in 0..sides.pow(len) {
                    let mut c = code;
                    let tape: Vec<u64> = (0..len)
                        .map(|_| {
                            let k = c % sides;
                            c /= sides;
                            lemire_witness_word(span, k)
                        })
                        .collect();
                    if let Ok((_, used)) = evaluate_with_tape(&expr, &tape) {
                        best = Some(used as u64);
                        break 'len;
                    }
                }
            }
            let got = min_rolls_per_die(spec);
            match best {
                Some(b) => assert_eq!(got, b, "{src}"),
                None => assert!(got > 5, "{src}: {got}"),
            }
            assert!(got >= certain_draws_per_die(spec), "{src}");
            checked += 1;
        }
        assert!(checked > 300, "{checked}");
    }

    #[test]
    fn support_pass_decides_zero_and_reach_in_engine_order() {
        // Sums of contiguous dice are exact intervals.
        assert_eq!(records("1d6/(1d3000+1d50000-2)"), [(Tri::Yes, Tri::Yes)]);
        assert_eq!(records("1d6/(1d3000+1d50000)"), [(Tri::Yes, Tri::No)]);
        assert_eq!(records("1d6/(200d6kh100-100)"), [(Tri::Yes, Tri::Yes)]);
        // A left operand that always overflows is evaluated first, so the zero is never reached.
        assert_eq!(
            records("1d6/(9223372036854775807+1d2)+1d6/(1d2-1)"),
            [(Tri::Yes, Tri::No), (Tri::No, Tri::Yes)]
        );
        // Keep over an exploding pool: the no-explosion executions witness `12`, and pool values
        // stay within one face, so `19` is out of reach.
        assert_eq!(records("1d6/(4d6!kh3-12)"), [(Tri::Yes, Tri::Yes)]);
        assert_eq!(records("1d6/(4d6!kh3-19)"), [(Tri::Yes, Tri::No)]);
        // Exploding chain sums of `d6!` skip every multiple of 6 below the cap.
        assert_eq!(records("1/(1d6!-12)"), [(Tri::Yes, Tri::No)]);
        assert_eq!(records("1/(1d6!-13)"), [(Tri::Yes, Tri::Yes)]);
        // Rerolls never remove a face; a clamp maps the face interval.
        assert_eq!(records("1/(1d20r=1-1)"), [(Tri::Yes, Tri::Yes)]);
        assert_eq!(records("1/(1d20min3-2)"), [(Tri::Yes, Tri::No)]);
        // A product with a factor that can be `0` can be `0`, however many factors follow.
        let product = alloc::vec!["(1d6!-3)"; 40].join("*");
        assert_eq!(
            records(&alloc::format!("1/({product})")),
            [(Tri::Yes, Tri::Yes)]
        );
        // Pool contributions.
        assert_eq!(records("1/(3d6cs>=5cf<=1+3)"), [(Tri::Yes, Tri::Yes)]);
        assert_eq!(records("1/(3d6cs>=5+1)"), [(Tri::Yes, Tri::No)]);
    }

    /// Differential check against the exact analyzer: on every generated expression that analyzes
    /// `Exact`, `must ⊆ support ⊆ may`, and no division is claimed reached with a zero.
    #[test]
    fn support_sets_bracket_the_exact_support_on_generated_expressions() {
        use crate::analyze::{AnalysisMethod, ExactPhase, exact_phase};
        use alloc::format;
        use alloc::string::String;

        struct Lcg(u64);
        impl Lcg {
            fn next(&mut self, n: u64) -> u64 {
                self.0 = self
                    .0
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1_442_695_040_888_963_407);
                (self.0 >> 33) % n
            }
        }
        const OPS: [&str; 5] = ["=", ">", ">=", "<", "<="];
        fn cp(r: &mut Lcg, sides: u64) -> String {
            format!("{}{}", OPS[r.next(5) as usize], r.next(sides + 2))
        }
        fn dice(r: &mut Lcg) -> String {
            let sides = [2_u64, 3, 4, 6, 10][r.next(5) as usize];
            let mut s = format!("{}d{}", 1 + r.next(4), sides);
            if r.next(4) == 0 {
                s.push('r');
                s.push_str(&cp(r, sides));
            }
            if r.next(4) == 0 {
                s.push_str("ro");
                s.push_str(&cp(r, sides));
            }
            if r.next(5) == 0 {
                s.push_str(&format!("min{}", 1 + r.next(sides)));
            }
            if r.next(3) == 0 {
                s.push_str(["!", "!!", "!p"][r.next(3) as usize]);
                // Thresholds that match every face would always reach `MAX_EXPLOSIONS`.
                s.push_str(&format!(">{}", 1 + r.next(sides)));
            }
            if r.next(3) == 0 {
                s.push_str(&format!(
                    "{}{}",
                    ["kh", "kl", "dh", "dl"][r.next(4) as usize],
                    r.next(4)
                ));
            }
            if r.next(6) == 0 {
                s.push_str("cs");
                s.push_str(&cp(r, sides));
                if r.next(2) == 0 {
                    s.push_str("cf");
                    s.push_str(&cp(r, sides));
                }
            }
            s
        }
        fn term(r: &mut Lcg, depth: u32) -> String {
            match r.next(if depth == 0 { 2 } else { 5 }) {
                0 => format!("{}", r.next(11) as i64 - 5),
                1 => dice(r),
                2 => format!("-({})", term(r, depth - 1)),
                _ => format!(
                    "({}{}{})",
                    term(r, depth - 1),
                    ["+", "-", "*", "/"][r.next(4) as usize],
                    term(r, depth - 1)
                ),
            }
        }

        let mut rng = Lcg(20_261_114);
        let (mut exact_cases, mut zero_cases) = (0, 0);
        for _ in 0..3_000 {
            let src = term(&mut rng, 3);
            let Ok(expr) = parse(&src) else { continue };
            let mut recs = Vec::new();
            let abs = walk(&expr, &mut recs);
            let claimed_zero = recs
                .iter()
                .any(|r| r.reached == Tri::Yes && r.zero == Tri::Yes);
            // The exact phase only: a sampled fallback has no exact support to compare with.
            match exact_phase(&expr) {
                Ok(ExactPhase::Done(rep)) => {
                    assert!(matches!(rep.method, AnalysisMethod::Exact { .. }));
                    exact_cases += 1;
                    assert!(!claimed_zero, "{src}: zero claimed on an exact success");
                    let support: Vec<i64> =
                        rep.distribution.entries().iter().map(|&(v, _)| v).collect();
                    for &(lo, hi) in &abs.must.iv {
                        for v in lo..=hi.min(lo.saturating_add(4_096)) {
                            assert!(support.binary_search(&v).is_ok(), "{src}: must {v}");
                        }
                    }
                    for &v in &support {
                        assert!(abs.may.contains(v), "{src}: may misses {v}");
                    }
                }
                Err(crate::error::RollError::DivisionByZero) => zero_cases += 1,
                _ => {}
            }
        }
        assert!(
            exact_cases > 1_000 && zero_cases > 50,
            "{exact_cases} {zero_cases}"
        );
    }
}
