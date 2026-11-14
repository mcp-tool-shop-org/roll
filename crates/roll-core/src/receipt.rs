use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use core::num::NonZeroU64;
use rand_chacha::ChaCha12Rng;
use rand_core::{Rng, SeedableRng};
use sha2::{Digest, Sha256};

use crate::ast::{Expr, MAX_TOTAL_DRAWS};
use crate::canonical_json::to_canonical_json;
use crate::codec::{encode_hex_lower, encode_u64_hex};
use crate::error::{ReceiptVerifyError, RollError};
use crate::eval::{ExpressionOutcome, evaluate_with_rng, evaluate_with_source};
use crate::parser::parse;
use crate::rng::{DEFAULT_RULES_VERSION, RollAddress, RollRng, TapeSource, derive_roll_key};

/// Normative receipt schema version identifier (`Roll 3.0 §3.1`).
pub const RECEIPT_SCHEMA_VERSION: &str = "roll.receipt.v1";

/// Informational producer engine identifier embedded in receipts produced by `roll-core`.
pub const ENGINE_VERSION: &str = concat!("roll-core/", env!("CARGO_PKG_VERSION"));

/// Normative roll specification committed inside [`RollReceipt`].
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReceiptSpec {
    Expression { canonical_expression: String },
}

/// Normative roll outcome committed inside [`RollReceipt`].
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReceiptResult {
    Expression {
        expression_outcome: ExpressionOutcome,
    },
}

/// Self-contained, statelessly verifiable Roll 3.0 cryptographic audit receipt (`§3.1`).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RollReceipt {
    pub address: RollAddress,
    #[serde(with = "crate::codec::opt_nonzero_u64_str")]
    pub eligible_weight_total: Option<NonZeroU64>,
    pub engine_version: String,
    #[serde(with = "crate::codec::vec_u64_hex")]
    pub raw_draws: Vec<u64>,
    #[serde(with = "crate::codec::bytes32_hex")]
    pub receipt_sha256: [u8; 32],
    pub result: ReceiptResult,
    pub rules_version: String,
    pub schema_version: String,
    pub spec: ReceiptSpec,
}

/// Helper matching `RollReceipt` minus `receipt_sha256` for computing the self-digest (`§3.2`).
#[derive(serde::Serialize)]
struct UnsignedReceipt<'a> {
    address: &'a RollAddress,
    #[serde(with = "crate::codec::opt_nonzero_u64_str")]
    eligible_weight_total: &'a Option<NonZeroU64>,
    engine_version: &'a str,
    #[serde(with = "crate::codec::vec_u64_hex")]
    raw_draws: &'a [u64],
    result: &'a ReceiptResult,
    rules_version: &'a str,
    schema_version: &'a str,
    spec: &'a ReceiptSpec,
}

/// Computes `SHA-256` over the RFC 8785 canonical JSON of `receipt` with `"receipt_sha256"` omitted.
pub fn compute_receipt_sha256(receipt: &RollReceipt) -> Result<[u8; 32], RollError> {
    let unsigned = UnsignedReceipt {
        address: &receipt.address,
        eligible_weight_total: &receipt.eligible_weight_total,
        engine_version: &receipt.engine_version,
        raw_draws: &receipt.raw_draws,
        result: &receipt.result,
        rules_version: &receipt.rules_version,
        schema_version: &receipt.schema_version,
        spec: &receipt.spec,
    };
    let val = serde_json::to_value(&unsigned).map_err(|e| {
        RollError::ReceiptInvalid(ReceiptVerifyError::MalformedJson {
            message: alloc::string::ToString::to_string(&e),
        })
    })?;
    let canonical = to_canonical_json(&val)?;
    Ok(Sha256::digest(canonical.as_bytes()).into())
}

/// Serializes `receipt` to deterministic RFC 8785 (JCS) canonical JSON (`§3.2`).
pub fn to_canonical_receipt_json(receipt: &RollReceipt) -> String {
    let val =
        serde_json::to_value(receipt).expect("RollReceipt contains only valid JSON primitives");
    to_canonical_json(&val).expect("RollReceipt never contains floats")
}

/// Evaluates `expr` at `addr` and returns both the [`ExpressionOutcome`] and signed [`RollReceipt`].
pub fn evaluate_addressed(
    expr: &Expr,
    addr: &RollAddress,
) -> Result<(ExpressionOutcome, RollReceipt), RollError> {
    if addr.rules_version != DEFAULT_RULES_VERSION {
        return Err(RollError::InvalidAddress {
            field: "rules_version",
            reason: "rules_version must equal 'roll.v3'",
        });
    }
    let mut rng = RollRng::from_address(addr)?;
    let outcome = evaluate_with_rng(expr, &mut rng)?;
    let raw_draws = rng.into_draws();

    let mut receipt = RollReceipt {
        address: addr.clone(),
        eligible_weight_total: None,
        engine_version: String::from(ENGINE_VERSION),
        raw_draws,
        receipt_sha256: [0u8; 32],
        result: ReceiptResult::Expression {
            expression_outcome: outcome.clone(),
        },
        rules_version: addr.rules_version.clone(),
        schema_version: String::from(RECEIPT_SCHEMA_VERSION),
        spec: ReceiptSpec::Expression {
            canonical_expression: outcome.canonical_expression.clone(),
        },
    };
    receipt.receipt_sha256 = compute_receipt_sha256(&receipt)?;

    Ok((outcome, receipt))
}

/// Verifies a [`RollReceipt`] in isolation (`Roll 3.0 §3.3`).
pub fn verify_receipt(receipt: &RollReceipt) -> Result<(), RollError> {
    // 1. Schema & version check.
    if receipt.schema_version != RECEIPT_SCHEMA_VERSION {
        return Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::UnsupportedSchemaVersion {
                found: receipt.schema_version.clone(),
            },
        ));
    }
    if receipt.rules_version != receipt.address.rules_version {
        return Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::RulesVersionMismatch {
                receipt_rules_version: receipt.rules_version.clone(),
                address_rules_version: receipt.address.rules_version.clone(),
            },
        ));
    }
    if receipt.rules_version != DEFAULT_RULES_VERSION {
        return Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::UnsupportedRulesVersion {
                found: receipt.rules_version.clone(),
            },
        ));
    }
    if receipt.raw_draws.len() > MAX_TOTAL_DRAWS as usize {
        return Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::DrawBudgetExceeded {
                total: receipt.raw_draws.len(),
                limit: MAX_TOTAL_DRAWS,
            },
        ));
    }

    // 2. Integrity digest check (`SHA-256` of canonical JSON without `receipt_sha256`).
    let computed_sha = compute_receipt_sha256(receipt)?;
    if computed_sha != receipt.receipt_sha256 {
        return Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::DigestMismatch {
                expected: encode_hex_lower(&receipt.receipt_sha256),
                computed: encode_hex_lower(&computed_sha),
            },
        ));
    }

    // 3. Spec canonicality check.
    let (
        ReceiptSpec::Expression {
            canonical_expression,
        },
        ReceiptResult::Expression { expression_outcome },
    ) = (&receipt.spec, &receipt.result);

    if receipt.eligible_weight_total.is_some() {
        return Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::UnexpectedEligibleWeightTotal,
        ));
    }

    let expr = parse(canonical_expression).map_err(|err| {
        RollError::ReceiptInvalid(ReceiptVerifyError::InvalidSpecExpression {
            message: format!("{err}"),
        })
    })?;
    let expected_canonical = expr.to_canonical_string();
    if &expected_canonical != canonical_expression {
        return Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::NonCanonicalExpression {
                given: canonical_expression.clone(),
                canonical: expected_canonical,
            },
        ));
    }

    // 4. PRNG stream authenticity check (`RollAddress` KDF + `ChaCha12Rng`).
    let key = derive_roll_key(&receipt.address).map_err(|err| match err {
        RollError::InvalidAddress { field, reason } => {
            RollError::ReceiptInvalid(ReceiptVerifyError::InvalidAddress {
                field: String::from(field),
                reason: String::from(reason),
            })
        }
        other => other,
    })?;
    let mut chacha = ChaCha12Rng::from_seed(key);
    for (idx, &recorded_word) in receipt.raw_draws.iter().enumerate() {
        let stream_word = chacha.next_u64();
        if stream_word != recorded_word {
            return Err(RollError::ReceiptInvalid(
                ReceiptVerifyError::PrngStreamMismatch {
                    draw_index: idx,
                    expected: encode_u64_hex(stream_word),
                    found: encode_u64_hex(recorded_word),
                },
            ));
        }
    }

    // 5. Deterministic execution & exact draw exhaustion check.
    let mut tape = TapeSource::new(&receipt.raw_draws);
    let replayed = match evaluate_with_source(&expr, &mut tape) {
        Ok(outcome) => outcome,
        Err(RollError::ReceiptInvalid(err)) => return Err(RollError::ReceiptInvalid(err)),
        Err(exec_err) => {
            return Err(RollError::ReceiptInvalid(
                ReceiptVerifyError::ExecutionError {
                    message: format!("{exec_err}"),
                },
            ));
        }
    };

    if tape.cursor() != receipt.raw_draws.len() {
        return Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::UnconsumedDraws {
                consumed: tape.cursor(),
                total: receipt.raw_draws.len(),
            },
        ));
    }

    if &replayed != expression_outcome {
        return Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::ResultMismatch,
        ));
    }

    Ok(())
}

/// Parses a canonical or whitespace-formatted JSON receipt string and runs [`verify_receipt`].
pub fn verify_receipt_json(canonical_or_raw_json: &str) -> Result<RollReceipt, RollError> {
    let receipt: RollReceipt = serde_json::from_str(canonical_or_raw_json).map_err(|err| {
        RollError::ReceiptInvalid(ReceiptVerifyError::MalformedJson {
            message: format!("{err}"),
        })
    })?;
    verify_receipt(&receipt)?;
    Ok(receipt)
}
