use alloc::string::String;
use core::fmt;

/// Structured verification failure for [`crate::RollReceipt`].
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ReceiptVerifyError {
    /// Receipt JSON could not be parsed or violated field encoding constraints.
    MalformedJson { message: String },
    /// `schema_version` was not `"roll.receipt.v1"`.
    UnsupportedSchemaVersion { found: String },
    /// Top-level `rules_version` disagreed with `address.rules_version`.
    RulesVersionMismatch {
        receipt_rules_version: String,
        address_rules_version: String,
    },
    /// `rules_version` was not `"roll.v3"`.
    UnsupportedRulesVersion { found: String },
    /// `address` failed Roll 3.0 namespace/length/character validation.
    InvalidAddress { field: String, reason: String },
    /// `receipt_sha256` did not match the canonical JSON SHA-256 of the unsigned envelope.
    DigestMismatch { expected: String, computed: String },
    /// `spec.kind` or `result.kind` is unsupported or mismatched.
    UnsupportedKind { kind: String },
    /// `eligible_weight_total` was non-null on an expression roll.
    UnexpectedEligibleWeightTotal,
    /// `spec.canonical_expression` failed to parse.
    InvalidSpecExpression { message: String },
    /// `spec.canonical_expression` parsed, but was not in canonical form.
    NonCanonicalExpression { given: String, canonical: String },
    /// `raw_draws.len()` exceeded [`crate::MAX_TOTAL_DRAWS`].
    DrawBudgetExceeded { total: usize, limit: u32 },
    /// `raw_draws[draw_index]` disagreed with `ChaCha12Rng` keyed from `address`.
    PrngStreamMismatch {
        draw_index: usize,
        expected: String,
        found: String,
    },
    /// Deterministic replay requested another draw after exhausting `raw_draws`.
    DrawTapeUnderflow { needed_at_index: usize },
    /// Deterministic replay finished with unconsumed trailing draws in `raw_draws`.
    UnconsumedDraws { consumed: usize, total: usize },
    /// Deterministic replay failed during expression evaluation (e.g. division by zero).
    ExecutionError { message: String },
    /// Recomputed `ExpressionOutcome` did not match `receipt.result`.
    ResultMismatch,
}

impl fmt::Display for ReceiptVerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MalformedJson { message } => {
                write!(f, "malformed receipt JSON: {message}")
            }
            Self::UnsupportedSchemaVersion { found } => {
                write!(
                    f,
                    "unsupported receipt schema_version '{found}' (expected 'roll.receipt.v1')"
                )
            }
            Self::RulesVersionMismatch {
                receipt_rules_version,
                address_rules_version,
            } => write!(
                f,
                "receipt rules_version '{receipt_rules_version}' does not match address.rules_version '{address_rules_version}'"
            ),
            Self::UnsupportedRulesVersion { found } => {
                write!(
                    f,
                    "unsupported rules_version '{found}' (expected 'roll.v3')"
                )
            }
            Self::InvalidAddress { field, reason } => {
                write!(f, "invalid address field '{field}': {reason}")
            }
            Self::DigestMismatch { expected, computed } => write!(
                f,
                "receipt_sha256 mismatch: receipt has {expected}, computed {computed}"
            ),
            Self::UnsupportedKind { kind } => {
                write!(f, "unsupported or mismatched receipt kind '{kind}'")
            }
            Self::UnexpectedEligibleWeightTotal => write!(
                f,
                "eligible_weight_total must be null for expression receipts"
            ),
            Self::InvalidSpecExpression { message } => {
                write!(f, "invalid spec canonical_expression: {message}")
            }
            Self::NonCanonicalExpression { given, canonical } => write!(
                f,
                "spec expression '{given}' is not canonical (expected '{canonical}')"
            ),
            Self::DrawBudgetExceeded { total, limit } => write!(
                f,
                "raw_draws length {total} exceeds maximum draw budget of {limit}"
            ),
            Self::PrngStreamMismatch {
                draw_index,
                expected,
                found,
            } => write!(
                f,
                "PRNG stream mismatch at raw_draws[{draw_index}]: expected {expected}, found {found}"
            ),
            Self::DrawTapeUnderflow { needed_at_index } => write!(
                f,
                "raw_draws underflow: replay needed another draw at index {needed_at_index}"
            ),
            Self::UnconsumedDraws { consumed, total } => write!(
                f,
                "raw_draws contains unconsumed trailing words: consumed {consumed} of {total}"
            ),
            Self::ExecutionError { message } => {
                write!(f, "replay execution failed: {message}")
            }
            Self::ResultMismatch => {
                write!(f, "replayed outcome does not match receipt result")
            }
        }
    }
}

impl core::error::Error for ReceiptVerifyError {}

/// Top-level error returned across `roll-core` parsing, addressing, execution, and verification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RollError {
    ExpressionTooLong {
        len: usize,
        max: usize,
    },
    ExpressionTooDeep {
        depth: usize,
        max: usize,
        byte_offset: usize,
    },
    Lex {
        message: String,
        byte_offset: usize,
    },
    Parse {
        message: String,
        byte_offset: usize,
    },
    DiceBudgetExceeded {
        total_dice: u64,
        max: u64,
    },
    DrawBudgetExceeded {
        limit: u32,
    },
    InvalidClampBounds {
        min: i64,
        max: i64,
        byte_offset: usize,
    },
    ArithmeticOverflow,
    DivisionByZero,
    AnalysisBudgetExceeded {
        total_dice: u64,
        max: u64,
    },
    InvalidProbability {
        given: String,
    },
    InvalidAddress {
        field: &'static str,
        reason: &'static str,
    },
    CanonicalJsonFloatUnsupported,
    ReceiptInvalid(ReceiptVerifyError),
}

impl fmt::Display for RollError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ExpressionTooLong { len, max } => write!(
                f,
                "expression length {len} bytes exceeds maximum of {max} bytes"
            ),
            Self::ExpressionTooDeep {
                depth,
                max,
                byte_offset,
            } => write!(
                f,
                "expression nesting depth {depth} at byte {byte_offset} exceeds maximum depth of {max}"
            ),
            Self::Lex {
                message,
                byte_offset,
            } => write!(f, "lex error at byte {byte_offset}: {message}"),
            Self::Parse {
                message,
                byte_offset,
            } => write!(f, "parse error at byte {byte_offset}: {message}"),
            Self::DiceBudgetExceeded { total_dice, max } => write!(
                f,
                "total dice count {total_dice} exceeds expression budget of {max}"
            ),
            Self::DrawBudgetExceeded { limit } => write!(
                f,
                "evaluation exceeded maximum draw budget of {limit} RNG draws"
            ),
            Self::InvalidClampBounds {
                min,
                max,
                byte_offset,
            } => write!(
                f,
                "invalid clamp bounds at byte {byte_offset}: min ({min}) exceeds max ({max})"
            ),
            Self::ArithmeticOverflow => write!(f, "checked 64-bit integer arithmetic overflow"),
            Self::DivisionByZero => write!(f, "division by zero"),
            Self::AnalysisBudgetExceeded { total_dice, max } => write!(
                f,
                "expression too complex to analyze: {total_dice} dice exceeds analysis limit of {max}"
            ),
            Self::InvalidProbability { given } => write!(
                f,
                "invalid target probability '{given}' (expected finite probability in (0, 1])"
            ),
            Self::InvalidAddress { field, reason } => {
                write!(f, "invalid roll address field '{field}': {reason}")
            }
            Self::CanonicalJsonFloatUnsupported => {
                write!(
                    f,
                    "floating-point numbers are forbidden in canonical receipt JSON"
                )
            }
            Self::ReceiptInvalid(err) => write!(f, "receipt verification failed: {err}"),
        }
    }
}

impl core::error::Error for RollError {
    fn source(&self) -> Option<&(dyn core::error::Error + 'static)> {
        match self {
            Self::ReceiptInvalid(err) => Some(err),
            _ => None,
        }
    }
}
