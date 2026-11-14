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
    MAX_EXPLOSIONS, ResultMode,
};

/// Maximum intervals kept per set before it is coarsened.
const MAX_INTERVALS: usize = 128;

/// Maximum points enumerated for one interval product before falling back to corners or the hull.
const MAX_ENUMERATED_PRODUCT: i128 = 256;

/// Maximum points enumerated across one set product.
const MAX_ENUMERATED_POINTS: i128 = 4_096;

/// Intervals each operand of a set product is coarsened to first (`32^2` interval pairs at most).
const MAX_MUL_OPERAND_INTERVALS: usize = 32;

/// Three-valued answer of the support pass.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub(crate) enum Tri {
    No,
    Maybe,
    Yes,
}

impl Tri {
    pub(crate) const fn and(self, other: Self) -> Self {
        match (self, other) {
            (Self::No, _) | (_, Self::No) => Self::No,
            (Self::Yes, Self::Yes) => Self::Yes,
            _ => Self::Maybe,
        }
    }
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
                let points = (b - a + 1) * (d - c + 1);
                let enumerate = points <= MAX_ENUMERATED_PRODUCT && points <= enumerable;
                if enumerate {
                    enumerable -= points;
                }
                match scalar {
                    // `{-1, 0, 1} * interval` is an interval.
                    Some(k) if (-1..=1).contains(&k) => pieces.push((lo, hi)),
                    Some(k) if enumerate => {
                        for v in span.0..=span.1 {
                            pieces.push((k * v, k * v));
                        }
                    }
                    None if enumerate => {
                        for x in a..=b {
                            for y in c..=d {
                                pieces.push((x * y, x * y));
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
                        // so it covers a whole interval. Use the divisor closest to zero.
                        let k = if c > 0 { c } else { d };
                        let (x, y) = (floor_div(a, k), floor_div(b, k));
                        pieces.push((x.min(y), x.max(y)));
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

    let variable_pool = matches!(
        spec.explode,
        Some(r) if r.variant != ExplosionVariant::Compound
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
                if calm.is_empty() {
                    IvSet::empty()
                } else {
                    contributions(&calm).nfold(kept_count(n, &spec.keep_drop), kind)
                }
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
                let k_lo = i128::from(kept_count(n, &spec.keep_drop) as i64);
                let k_hi = i128::from(
                    kept_count(n * (MAX_EXPLOSIONS as usize + 1), &spec.keep_drop) as i64,
                );
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
    /// The divisor subtree (`right` operand).
    pub(crate) divisor: &'a Expr,
    /// Whether the engine reaches the division with its dividend and divisor both evaluated
    /// successfully: everything evaluated before it can succeed, and the dividend can succeed.
    pub(crate) reached: Tri,
    /// Whether the divisor can evaluate to `0` without an error.
    pub(crate) zero: Tri,
}

/// Walks `expr` in engine order, returning its success set and appending one record per division.
///
/// `reach` is whether evaluation reaches `expr` with everything before it successful. Left spines
/// are walked iteratively; recursion follows right operands and unary operands only, whose depth
/// the parser caps at `MAX_NESTING_DEPTH`.
pub(crate) fn walk<'a>(expr: &'a Expr, reach: Tri, out: &mut Vec<DivisorRecord<'a>>) -> Abs {
    let mut spine: Vec<(BinaryOp, &'a Expr)> = Vec::new();
    let mut leftmost = expr;
    while let Expr::Binary { op, left, right } = leftmost {
        spine.push((*op, right));
        leftmost = left;
    }
    let mut acc = match leftmost {
        Expr::Number(v) => Abs::exact(IvSet::point(*v)),
        Expr::Dice(spec) => dice_abs(spec),
        Expr::UnaryNeg(inner) => {
            let a = walk(inner, reach, out);
            let must = a.must.neg(Kind::Must);
            let may = a.may.neg(Kind::May).union(&must, Kind::May);
            Abs { must, may }
        }
        Expr::Binary { .. } => unreachable!("spine walk stops at a non-binary node"),
    };
    for &(op, right) in spine.iter().rev() {
        let left_ok = acc.can_succeed();
        let r = walk(right, reach.and(left_ok), out);
        if op == BinaryOp::DivFloor {
            out.push(DivisorRecord {
                divisor: right,
                reached: reach.and(left_ok),
                zero: r.reaches(0),
            });
        }
        acc = binary_abs(op, &acc, &r);
    }
    acc
}

/// Whether `expr` can be evaluated without an error (`Tri::Yes` only when a witness value is known).
pub(crate) fn can_succeed(expr: &Expr) -> Tri {
    let mut sink = Vec::new();
    walk(expr, Tri::Yes, &mut sink).can_succeed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse;

    fn records(src: &str) -> Vec<(Tri, Tri)> {
        let e = parse(src).unwrap();
        let mut out = Vec::new();
        walk(&e, Tri::Yes, &mut out);
        out.iter().map(|r| (r.reached, r.zero)).collect()
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
            let abs = walk(&expr, Tri::Yes, &mut recs);
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
