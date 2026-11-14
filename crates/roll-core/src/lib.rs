//! Deterministic Roll 3.0 core library (`no_std` + `alloc`).
//!
//! `roll-core` is the single normative source of truth for Roll 3.0 addressing,
//! `ChaCha12Rng` key derivation, 64-bit Lemire range mapping, canonical JSON
//! receipts, dice expression parsing/evaluation, and exact probability distribution
//! analysis. The `@mcptoolshop/roll` npm package is shipped as a pure TypeScript
//! port verified against `roll-core`-generated conformance fixtures for zero
//! install friction and synchronous use everywhere.

#![forbid(unsafe_code)]
#![no_std]

extern crate alloc;

pub mod analyze;
pub mod ast;
pub mod canonical_json;
pub mod codec;
pub mod conformance;
pub mod error;
pub mod eval;
pub mod math;
pub mod parser;
pub mod receipt;
pub mod rng;

pub use analyze::{
    AnalysisMethod, AnalysisReport, ComparisonReport, DEFAULT_MONTE_CARLO_SAMPLES, Distribution,
    DistributionStats, MAX_ANALYZE_DICE, MAX_EXACT_STATES, MONTE_CARLO_DEFAULT_SEED, ModelledCaps,
    PrefixOracleResult, TargetDirection, analyze, compare, compute_stats, lemire_witness_word,
    monte_carlo_distribution, reduce_keep_drop_interval, run_prefix_tape_oracle,
};
pub use ast::{
    BinaryOp, ClampBounds, CompareOp, ComparePoint, DiceSides, DiceSpec, ExplosionRule,
    ExplosionVariant, Expr, KeepDropOp, MAX_DICE_PER_GROUP, MAX_DIE_SIDES, MAX_EXPLOSIONS,
    MAX_EXPRESSION_BYTES, MAX_REROLLS, MAX_TOTAL_DICE_PER_EXPR, MAX_TOTAL_DRAWS, ResultMode,
    SortOrder,
};
pub use canonical_json::{cmp_utf16_code_units, to_canonical_json};
pub use error::{ReceiptVerifyError, RollError};
pub use eval::{
    CritKind, DieTrace, ExpressionOutcome, GroupOutcome, checked_div_floor, evaluate_with_rng,
    evaluate_with_tape,
};
pub use parser::parse;
pub use receipt::{
    ENGINE_VERSION, RECEIPT_SCHEMA_VERSION, ReceiptResult, ReceiptSpec, RollReceipt,
    compute_receipt_sha256, evaluate_addressed, to_canonical_receipt_json, verify_receipt,
    verify_receipt_json,
};
pub use rng::{
    DEFAULT_RULES_VERSION, KDF_PROTOCOL_TAG, MAX_DOMAIN_BYTES, MAX_ENTITY_ID_BYTES,
    MAX_RULES_VERSION_BYTES, RollAddress, RollRng, SeedMaterial, derive_roll_key,
    lemire_sample_from_tape,
};
