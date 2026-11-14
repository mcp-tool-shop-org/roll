use alloc::boxed::Box;
use alloc::fmt::Write as _;
use alloc::string::String;
use alloc::vec::Vec;
use core::num::NonZeroU32;

/// Maximum byte length accepted by [`crate::parse`].
pub const MAX_EXPRESSION_BYTES: usize = 1_000;
/// Maximum recursive factor nesting depth (`(` parentheses and prefix unary `-`) accepted by [`crate::parse`] (`§4.2`).
///
/// Sized at `64` so unoptimized debug builds on constrained stacks (`1–2 MiB` Windows/CI/Wasm threads)
/// never approach stack overflow during parsing, evaluation, analysis, formatting, or recursive `Drop`.
pub const MAX_NESTING_DEPTH: usize = 64;
/// Maximum dice count in a single `NdM` dice group.
pub const MAX_DICE_PER_GROUP: u32 = 10_000;
/// Maximum sum of base dice counts across an entire expression AST.
pub const MAX_TOTAL_DICE_PER_EXPR: u32 = 10_000;
/// Maximum number of faces on a standard `NdM` die.
pub const MAX_DIE_SIDES: u32 = 1_000_000;
/// Maximum explosion iterations per initial die in Stage 4.
pub const MAX_EXPLOSIONS: u32 = 100;
/// Maximum iterations per unlimited reroll modifier per die in Stage 2a.
pub const MAX_REROLLS: u32 = 100;
/// Maximum raw `u64` RNG draws permitted across one complete expression evaluation (`2,100,000`).
///
/// ### Derivation from `eval::roll_single_die` call sites
/// Across all groups in a parsed expression, `sum(count) <= MAX_TOTAL_DICE_PER_EXPR = 10,000`.
/// For an expression carrying **at most one modifier of each kind** per group, each base die can
/// invoke `roll_single_die` at most:
/// - **Stage 1** (initial roll): `1` draw
/// - **Stage 2a** (one unlimited reroll `r`, capped at `MAX_REROLLS = 100`): `100` draws
/// - **Stage 2b** (one reroll-once `ro`): `1` draw
/// - **Stage 3** (`min` / `max` clamp): `0` draws
/// - **Stage 4** (one explosion `!` / `!!` / `!p`, singleton enforced by the parser and capped at
///   `MAX_EXPLOSIONS = 100` per initial die; exploded children are added after Stages 2a/2b): `100` draws
/// - **Stages 5–8** (`keep` / `drop`, `sort`, critical / pool total): `0` draws
///
/// That gives at most `1 + 100 + 1 + 100 = 202` die rolls per base die, or
/// `10,000 * 202 = 2,020,000` die rolls across an entire evaluation (whether in one group or split
/// across multiple groups). Setting `MAX_TOTAL_DRAWS = 2,100,000` leaves `80,000` raw `u64` draws
/// of headroom (covering any 64-bit Lemire rejection-sampling retries, whose per-draw retry
/// probability for `s <= MAX_DIE_SIDES = 1,000,000` is `(2^64 mod s) / 2^64 < 5.5e-14`) while
/// aborting stacked-reroll expressions (such as `10000d1` + `r=1` × 330) in milliseconds.
pub const MAX_TOTAL_DRAWS: u32 = 2_100_000;

const _: () = {
    let worst_case_single_mod_per_die = 1 + MAX_REROLLS + 1 + MAX_EXPLOSIONS;
    assert!(worst_case_single_mod_per_die == 202);
    let worst_case_expr_draws = MAX_TOTAL_DICE_PER_EXPR * worst_case_single_mod_per_die;
    assert!(worst_case_expr_draws == 2_020_000);
    assert!(MAX_TOTAL_DRAWS > worst_case_expr_draws);
};

/// Comparison operator for dice modifiers (`r`, `ro`, `!`, `!!`, `!p`, `cs`, `cf`).
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompareOp {
    Eq,
    Gt,
    Gte,
    Lt,
    Lte,
}

impl CompareOp {
    /// Canonical syntax token for this comparison operator.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Eq => "=",
            Self::Gt => ">",
            Self::Gte => ">=",
            Self::Lt => "<",
            Self::Lte => "<=",
        }
    }
}

/// Threshold predicate `<op><value>`.
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ComparePoint {
    pub op: CompareOp,
    pub value: i64,
}

impl ComparePoint {
    /// Evaluates whether `candidate` satisfies this comparison threshold.
    pub const fn matches(self, candidate: i64) -> bool {
        match self.op {
            CompareOp::Eq => candidate == self.value,
            CompareOp::Gt => candidate > self.value,
            CompareOp::Gte => candidate >= self.value,
            CompareOp::Lt => candidate < self.value,
            CompareOp::Lte => candidate <= self.value,
        }
    }

    fn write_canonical(self, out: &mut String) {
        out.push_str(self.op.as_str());
        let _ = write!(out, "{}", self.value);
    }
}

/// Die face specification (`NdM`, `Nd%`, or `NdF`).
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum DiceSides {
    /// Uniform integer die over `1..=n` (`1 <= n <= MAX_DIE_SIDES`).
    Standard(NonZeroU32),
    /// Percentile die (`d%`) over `1..=100`.
    Percentile,
    /// Fate/Fudge die (`dF`) over `-1..=1`.
    Fate,
}

impl DiceSides {
    /// Minimum face value producible by a single raw roll of this die.
    pub const fn min_face(self) -> i64 {
        match self {
            Self::Standard(_) | Self::Percentile => 1,
            Self::Fate => -1,
        }
    }

    /// Maximum face value producible by a single raw roll of this die.
    pub const fn max_face(self) -> i64 {
        match self {
            Self::Standard(n) => n.get() as i64,
            Self::Percentile => 100,
            Self::Fate => 1,
        }
    }
}

/// Stage 3 per-die value clamp bounds (`min <= max` when both `Some`).
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ClampBounds {
    pub min: Option<i64>,
    pub max: Option<i64>,
}

/// Stage 4 explosion family.
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExplosionVariant {
    Standard,
    Compound,
    Penetrate,
}

impl ExplosionVariant {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "!",
            Self::Compound => "!!",
            Self::Penetrate => "!p",
        }
    }
}

/// Stage 4 explosion rule with resolved threshold.
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ExplosionRule {
    pub variant: ExplosionVariant,
    pub threshold: ComparePoint,
}

/// Stage 5 keep/drop operation.
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "op", content = "count", rename_all = "snake_case")]
pub enum KeepDropOp {
    KeepHighest(u32),
    KeepLowest(u32),
    DropHighest(u32),
    DropLowest(u32),
}

/// Stage 6 presentation sort direction (`GroupOutcome.dice` always retains RNG draw order).
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortOrder {
    Asc,
    Desc,
}

/// Stage 7 & 8 evaluation mode (standard sum with optional natural crit marks vs success pool).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResultMode {
    Sum {
        crit_success_max: bool,
        crit_failure_min: bool,
    },
    Pool {
        cs: Vec<ComparePoint>,
        cf: Vec<ComparePoint>,
    },
}

/// Canonical validated dice group specification with typed pipeline stage slots.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DiceSpec {
    pub count: NonZeroU32,
    pub sides: DiceSides,
    pub reroll_unlimited: Vec<ComparePoint>,
    pub reroll_once: Vec<ComparePoint>,
    pub clamp: Option<ClampBounds>,
    pub explode: Option<ExplosionRule>,
    pub keep_drop: Vec<KeepDropOp>,
    pub mode: ResultMode,
    pub sort: Option<SortOrder>,
}

impl DiceSpec {
    /// Formats this dice group in canonical stage-ordered Roll 3.0 notation.
    pub fn to_canonical_string(&self) -> String {
        let mut out = String::new();
        self.write_canonical(&mut out);
        out
    }

    pub(crate) fn write_canonical(&self, out: &mut String) {
        let _ = write!(out, "{}d", self.count.get());
        match self.sides {
            DiceSides::Standard(n) => {
                let _ = write!(out, "{}", n.get());
            }
            DiceSides::Percentile => out.push('%'),
            DiceSides::Fate => out.push('F'),
        }

        for &cp in &self.reroll_unlimited {
            out.push('r');
            cp.write_canonical(out);
        }

        for &cp in &self.reroll_once {
            out.push_str("ro");
            cp.write_canonical(out);
        }

        if let Some(clamp) = self.clamp {
            if let Some(lo) = clamp.min {
                let _ = write!(out, "min{lo}");
            }
            if let Some(hi) = clamp.max {
                let _ = write!(out, "max{hi}");
            }
        }

        if let Some(exp) = self.explode {
            out.push_str(exp.variant.as_str());
            exp.threshold.write_canonical(out);
        }

        for &kd in &self.keep_drop {
            match kd {
                KeepDropOp::KeepHighest(n) => {
                    let _ = write!(out, "kh{n}");
                }
                KeepDropOp::KeepLowest(n) => {
                    let _ = write!(out, "kl{n}");
                }
                KeepDropOp::DropHighest(n) => {
                    let _ = write!(out, "dh{n}");
                }
                KeepDropOp::DropLowest(n) => {
                    let _ = write!(out, "dl{n}");
                }
            }
        }

        match &self.mode {
            ResultMode::Sum {
                crit_success_max,
                crit_failure_min,
            } => {
                if *crit_success_max {
                    out.push_str("cs");
                }
                if *crit_failure_min {
                    out.push_str("cf");
                }
            }
            ResultMode::Pool { cs, cf } => {
                for &cp in cs {
                    out.push_str("cs");
                    cp.write_canonical(out);
                }
                for &cp in cf {
                    out.push_str("cf");
                    cp.write_canonical(out);
                }
            }
        }

        match self.sort {
            Some(SortOrder::Asc) => out.push_str("sa"),
            Some(SortOrder::Desc) => out.push_str("sd"),
            None => {}
        }
    }
}

/// Checked 64-bit integer binary arithmetic operators.
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    DivFloor,
}

impl BinaryOp {
    pub const fn as_char(self) -> char {
        match self {
            Self::Add => '+',
            Self::Sub => '-',
            Self::Mul => '*',
            Self::DivFloor => '/',
        }
    }

    const fn precedence(self) -> u8 {
        match self {
            Self::Add | Self::Sub => 1,
            Self::Mul | Self::DivFloor => 2,
        }
    }
}

/// Validated Roll 3.0 dice/arithmetic expression AST.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum Expr {
    Number(#[serde(with = "crate::codec::i64_str")] i64),
    Dice(DiceSpec),
    UnaryNeg(Box<Expr>),
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
}

impl Expr {
    const fn precedence(&self) -> u8 {
        match self {
            Self::Binary { op, .. } => op.precedence(),
            Self::UnaryNeg(_) => 3,
            Self::Number(value) if *value < 0 => 3,
            Self::Number(_) | Self::Dice(_) => 4,
        }
    }

    /// Formats this AST as its unique canonical, whitespace-free Roll 3.0 expression string.
    pub fn to_canonical_string(&self) -> String {
        let mut out = String::new();
        self.write_canonical(&mut out);
        out
    }

    fn write_canonical(&self, out: &mut String) {
        match self {
            Self::Number(value) => {
                let _ = write!(out, "{value}");
            }
            Self::Dice(spec) => spec.write_canonical(out),
            Self::UnaryNeg(operand) => {
                out.push('-');
                let need_parens =
                    operand.precedence() < 3 || matches!(operand.as_ref(), Self::Number(_));
                if need_parens {
                    out.push('(');
                    operand.write_canonical(out);
                    out.push(')');
                } else {
                    operand.write_canonical(out);
                }
            }
            Self::Binary { op, left, right } => {
                let prec = op.precedence();
                if left.precedence() < prec {
                    out.push('(');
                    left.write_canonical(out);
                    out.push(')');
                } else {
                    left.write_canonical(out);
                }
                out.push(op.as_char());
                // Left-associative grammar: right child with equal precedence requires parentheses.
                if right.precedence() <= prec {
                    out.push('(');
                    right.write_canonical(out);
                    out.push(')');
                } else {
                    right.write_canonical(out);
                }
            }
        }
    }

    /// Total base dice across all `DiceSpec` nodes in this AST (excluding runtime explosions).
    pub fn total_base_dice(&self) -> u32 {
        match self {
            Self::Number(_) => 0,
            Self::Dice(spec) => spec.count.get(),
            Self::UnaryNeg(operand) => operand.total_base_dice(),
            Self::Binary { left, right, .. } => left
                .total_base_dice()
                .saturating_add(right.total_base_dice()),
        }
    }
}
