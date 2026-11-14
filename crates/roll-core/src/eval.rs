use alloc::string::String;
use alloc::vec::Vec;
use core::num::NonZeroU64;

use crate::ast::{
    BinaryOp, DiceSides, DiceSpec, ExplosionVariant, Expr, KeepDropOp, MAX_EXPLOSIONS, MAX_REROLLS,
    ResultMode,
};
use crate::error::RollError;
use crate::rng::{DrawSource, RollRng};

/// Natural / pool critical marker recorded on a kept die.
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CritKind {
    Success,
    Failure,
}

/// Complete non-destructive per-die execution history across all pipeline stages.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DieTrace {
    #[serde(with = "crate::codec::i64_str")]
    pub initial_face: i64,
    #[serde(with = "crate::codec::vec_i64_str")]
    pub rerolls: Vec<i64>,
    #[serde(with = "crate::codec::opt_i64_str")]
    pub clamped_to: Option<i64>,
    #[serde(with = "crate::codec::vec_i64_str")]
    pub explosions: Vec<i64>,
    #[serde(with = "crate::codec::i64_str")]
    pub final_value: i64,
    pub kept: bool,
    pub exploded_child: bool,
    pub critical: Option<CritKind>,
    pub pool_delta: Option<i8>,
}

/// Evaluated outcome for one `DiceSpec` node in an expression.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GroupOutcome {
    pub canonical_spec: String,
    pub dice: Vec<DieTrace>,
    #[serde(with = "crate::codec::i64_str")]
    pub total: i64,
    pub is_pool: bool,
}

/// Complete evaluated outcome for an [`Expr`].
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExpressionOutcome {
    pub canonical_expression: String,
    #[serde(with = "crate::codec::i64_str")]
    pub total: i64,
    pub groups: Vec<GroupOutcome>,
}

/// Checked mathematical integer floor division $\lfloor a / b \rfloor$ toward $-\infty$ (Roll 3.0 §4.3).
pub fn checked_div_floor(a: i64, b: i64) -> Result<i64, RollError> {
    if b == 0 {
        return Err(RollError::DivisionByZero);
    }
    let q = a.checked_div(b).ok_or(RollError::ArithmeticOverflow)?;
    let r = a % b;
    if r != 0 && (r < 0) != (b < 0) {
        q.checked_sub(1).ok_or(RollError::ArithmeticOverflow)
    } else {
        Ok(q)
    }
}

/// Evaluates `expr` against a mutable [`RollRng`], recording all `u64` draws in `rng`.
pub fn evaluate_with_rng(expr: &Expr, rng: &mut RollRng) -> Result<ExpressionOutcome, RollError> {
    evaluate_with_source(expr, rng)
}

pub(crate) fn evaluate_with_source<S: DrawSource>(
    expr: &Expr,
    source: &mut S,
) -> Result<ExpressionOutcome, RollError> {
    let mut groups = Vec::new();
    let total = walk_expr(expr, source, &mut groups)?;
    Ok(ExpressionOutcome {
        canonical_expression: expr.to_canonical_string(),
        total,
        groups,
    })
}

fn walk_expr<S: DrawSource>(
    expr: &Expr,
    source: &mut S,
    groups: &mut Vec<GroupOutcome>,
) -> Result<i64, RollError> {
    match expr {
        Expr::Number(v) => Ok(*v),
        Expr::Dice(spec) => {
            let group = roll_dice_group(spec, source)?;
            let total = group.total;
            groups.push(group);
            Ok(total)
        }
        Expr::UnaryNeg(operand) => {
            let val = walk_expr(operand, source, groups)?;
            val.checked_neg().ok_or(RollError::ArithmeticOverflow)
        }
        Expr::Binary { op, left, right } => {
            let lhs = walk_expr(left, source, groups)?;
            let rhs = walk_expr(right, source, groups)?;
            match op {
                BinaryOp::Add => lhs.checked_add(rhs).ok_or(RollError::ArithmeticOverflow),
                BinaryOp::Sub => lhs.checked_sub(rhs).ok_or(RollError::ArithmeticOverflow),
                BinaryOp::Mul => lhs.checked_mul(rhs).ok_or(RollError::ArithmeticOverflow),
                BinaryOp::DivFloor => checked_div_floor(lhs, rhs),
            }
        }
    }
}

fn roll_single_die<S: DrawSource>(sides: DiceSides, source: &mut S) -> Result<i64, RollError> {
    match sides {
        DiceSides::Standard(n) => {
            let span = NonZeroU64::from(n);
            let offset = source.sample_lemire_u64(span)?;
            Ok(1 + (offset as i64))
        }
        DiceSides::Percentile => {
            let span = NonZeroU64::new(100).expect("100 != 0");
            let offset = source.sample_lemire_u64(span)?;
            Ok(1 + (offset as i64))
        }
        DiceSides::Fate => {
            let span = NonZeroU64::new(3).expect("3 != 0");
            let offset = source.sample_lemire_u64(span)?;
            Ok((offset as i64) - 1)
        }
    }
}

fn roll_dice_group<S: DrawSource>(
    spec: &DiceSpec,
    source: &mut S,
) -> Result<GroupOutcome, RollError> {
    let count = spec.count.get() as usize;

    // Stage 1: Initial uniform rolls.
    let mut dice: Vec<DieTrace> = Vec::with_capacity(count);
    for _ in 0..count {
        let face = roll_single_die(spec.sides, source)?;
        dice.push(DieTrace {
            initial_face: face,
            rerolls: Vec::new(),
            clamped_to: None,
            explosions: Vec::new(),
            final_value: face,
            kept: true,
            exploded_child: false,
            critical: None,
            pool_delta: None,
        });
    }

    // Stage 2a: Unlimited rerolls (capped at MAX_REROLLS per modifier per die).
    for &cp in &spec.reroll_unlimited {
        for die in &mut dice {
            if !die.kept {
                continue;
            }
            let mut iterations: u32 = 0;
            while cp.matches(die.final_value) && iterations < MAX_REROLLS {
                let new_face = roll_single_die(spec.sides, source)?;
                die.rerolls.push(new_face);
                die.final_value = new_face;
                iterations += 1;
            }
        }
    }

    // Stage 2b: Reroll once.
    for &cp in &spec.reroll_once {
        for die in &mut dice {
            if !die.kept {
                continue;
            }
            if cp.matches(die.final_value) {
                let new_face = roll_single_die(spec.sides, source)?;
                die.rerolls.push(new_face);
                die.final_value = new_face;
            }
        }
    }

    // Stage 3: Min/max clamping (`min <= max` enforced at parse time).
    if let Some(clamp) = spec.clamp {
        for die in &mut dice {
            if !die.kept {
                continue;
            }
            let mut v = die.final_value;
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
            if v != die.final_value {
                die.clamped_to = Some(v);
                die.final_value = v;
            }
        }
    }

    // Stage 4: Explode / Compound / Penetrate.
    if let Some(rule) = spec.explode {
        match rule.variant {
            ExplosionVariant::Standard => {
                let original_len = dice.len();
                for i in 0..original_len {
                    if !dice[i].kept {
                        continue;
                    }
                    let mut current = dice[i].final_value;
                    let mut chain_len: u32 = 0;
                    while rule.threshold.matches(current) && chain_len < MAX_EXPLOSIONS {
                        let raw_face = roll_single_die(spec.sides, source)?;
                        dice[i].explosions.push(raw_face);
                        dice.push(DieTrace {
                            initial_face: raw_face,
                            rerolls: Vec::new(),
                            clamped_to: None,
                            explosions: Vec::new(),
                            final_value: raw_face,
                            kept: true,
                            exploded_child: true,
                            critical: None,
                            pool_delta: None,
                        });
                        current = raw_face;
                        chain_len += 1;
                    }
                }
            }
            ExplosionVariant::Compound => {
                for die in &mut dice {
                    if !die.kept {
                        continue;
                    }
                    let mut current = die.final_value;
                    let mut chain_len: u32 = 0;
                    while rule.threshold.matches(current) && chain_len < MAX_EXPLOSIONS {
                        let raw_face = roll_single_die(spec.sides, source)?;
                        die.explosions.push(raw_face);
                        die.final_value = die
                            .final_value
                            .checked_add(raw_face)
                            .ok_or(RollError::ArithmeticOverflow)?;
                        current = raw_face;
                        chain_len += 1;
                    }
                }
            }
            ExplosionVariant::Penetrate => {
                let original_len = dice.len();
                for i in 0..original_len {
                    if !dice[i].kept {
                        continue;
                    }
                    let mut current = dice[i].final_value;
                    let mut chain_len: u32 = 0;
                    while rule.threshold.matches(current) && chain_len < MAX_EXPLOSIONS {
                        let raw_face = roll_single_die(spec.sides, source)?;
                        let pen_value = (raw_face - 1).max(1);
                        dice[i].explosions.push(raw_face);
                        dice.push(DieTrace {
                            initial_face: raw_face,
                            rerolls: Vec::new(),
                            clamped_to: None,
                            explosions: Vec::new(),
                            final_value: pen_value,
                            kept: true,
                            exploded_child: true,
                            critical: None,
                            pool_delta: None,
                        });
                        // Threshold comparison uses the unadjusted raw face.
                        current = raw_face;
                        chain_len += 1;
                    }
                }
            }
        }
    }

    // Stage 5: Keep / Drop (stable ascending value sort over currently kept indices).
    for &kd in &spec.keep_drop {
        let mut kept_indices: Vec<usize> = dice
            .iter()
            .enumerate()
            .filter_map(|(idx, d)| d.kept.then_some(idx))
            .collect();
        kept_indices.sort_by_key(|&idx| dice[idx].final_value);

        match kd {
            KeepDropOp::KeepHighest(n) => {
                let k = n as usize;
                let drop_count = kept_indices.len().saturating_sub(k);
                for &idx in &kept_indices[..drop_count] {
                    dice[idx].kept = false;
                }
            }
            KeepDropOp::KeepLowest(n) => {
                let k = (n as usize).min(kept_indices.len());
                for &idx in &kept_indices[k..] {
                    dice[idx].kept = false;
                }
            }
            KeepDropOp::DropHighest(n) => {
                let drop_count = (n as usize).min(kept_indices.len());
                let start = kept_indices.len() - drop_count;
                for &idx in &kept_indices[start..] {
                    dice[idx].kept = false;
                }
            }
            KeepDropOp::DropLowest(n) => {
                let drop_count = (n as usize).min(kept_indices.len());
                for &idx in &kept_indices[..drop_count] {
                    dice[idx].kept = false;
                }
            }
        }
    }

    // Stage 6 (`spec.sort`) is presentation-only; `dice` remains in exact RNG draw order.

    // Stage 7 & 8: Critical marking and group total.
    let mut total: i64 = 0;
    let is_pool = match &spec.mode {
        ResultMode::Sum {
            crit_success_max,
            crit_failure_min,
        } => {
            let max_face = spec.sides.max_face();
            let min_face = spec.sides.min_face();
            for die in &mut dice {
                if !die.kept {
                    continue;
                }
                if *crit_success_max && die.final_value == max_face {
                    die.critical = Some(CritKind::Success);
                }
                if *crit_failure_min && die.final_value == min_face {
                    die.critical = Some(CritKind::Failure);
                }
                total = total
                    .checked_add(die.final_value)
                    .ok_or(RollError::ArithmeticOverflow)?;
            }
            false
        }
        ResultMode::Pool { cs, cf } => {
            for die in &mut dice {
                if !die.kept {
                    continue;
                }
                let hit_cs = cs.iter().any(|cp| cp.matches(die.final_value));
                let hit_cf = cf.iter().any(|cp| cp.matches(die.final_value));
                if hit_cs {
                    die.critical = Some(CritKind::Success);
                }
                if hit_cf {
                    die.critical = Some(CritKind::Failure);
                }
                let delta: i8 = i8::from(hit_cs) - i8::from(hit_cf);
                die.pool_delta = Some(delta);
                total = total
                    .checked_add(i64::from(delta))
                    .ok_or(RollError::ArithmeticOverflow)?;
            }
            true
        }
    };

    Ok(GroupOutcome {
        canonical_spec: spec.to_canonical_string(),
        dice,
        total,
        is_pool,
    })
}
