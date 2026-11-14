use alloc::boxed::Box;
use alloc::fmt::Write as _;
use alloc::string::String;
use alloc::vec::Vec;
use core::num::NonZeroU32;

/// Maximum byte length accepted by [`crate::parse`].
pub const MAX_EXPRESSION_BYTES: usize = 1_000;
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
