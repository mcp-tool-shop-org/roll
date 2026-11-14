#![forbid(unsafe_code)]

use core::num::NonZeroU64;
use rand_chacha::ChaCha12Rng;
use rand_core::{Rng, SeedableRng};
use roll_core::{
    RECEIPT_SCHEMA_VERSION, ReceiptSpec, ReceiptVerifyError, RollAddress, RollError, RollReceipt,
    SeedMaterial, cmp_utf16_code_units, compute_receipt_sha256, derive_roll_key,
    evaluate_addressed, parse, to_canonical_json, to_canonical_receipt_json, verify_receipt,
    verify_receipt_json,
};
use serde_json::json;

fn sample_receipt(expr_str: &str) -> RollReceipt {
    let expr = parse(expr_str).expect("valid expression");
    let addr = RollAddress::new(
        SeedMaterial::Int64(-42),
        4,
        "road_event",
        "caravan:north-04",
        0,
    );
    let (_outcome, receipt) = evaluate_addressed(&expr, &addr).expect("evaluation succeeds");
    receipt
}

#[test]
fn receipt_round_trips_and_reverifies_from_canonical_and_pretty_json() {
    let receipt = sample_receipt("4d6r=1min2kh3+5");
    assert_eq!(receipt.schema_version, RECEIPT_SCHEMA_VERSION);
    assert_eq!(receipt.rules_version, "roll.v3");
    assert!(receipt.eligible_weight_total.is_none());
    verify_receipt(&receipt).expect("fresh receipt verifies");

    let canonical = to_canonical_receipt_json(&receipt);
    let parsed = verify_receipt_json(&canonical).expect("canonical JSON verifies");
    assert_eq!(parsed, receipt);
    assert_eq!(to_canonical_receipt_json(&parsed), canonical);

    // Pretty-printed JSON with whitespace still parses and verifies against the canonical digest.
    let pretty = serde_json::to_string_pretty(&receipt).expect("pretty serialize");
    assert_ne!(pretty, canonical);
    let parsed_pretty = verify_receipt_json(&pretty).expect("pretty JSON verifies");
    assert_eq!(parsed_pretty, receipt);
}

#[test]
fn canonical_json_sorts_keys_by_utf16_code_units_and_rejects_floats() {
    // Spec §10.2: U+1F3B2 ("🎲", UTF-16 [0xD83C, 0xDFB2]) vs U+E000 (UTF-16 [0xE000]).
    // UTF-8 byte order puts U+E000 ([0xEE, 0x80, 0x80]) BEFORE U+1F3B2 ([0xF0, 0x9F, 0x8E, 0xB2]),
    // whereas RFC 8785 JCS / UTF-16 code unit order puts "🎲" (0xD83C) BEFORE "\u{E000}" (0xE000).
    let die_emoji = "🎲";
    let pua_char = "\u{E000}";
    assert!(
        pua_char < die_emoji,
        "Rust UTF-8 str::Ord sorts U+E000 first"
    );
    assert_eq!(
        cmp_utf16_code_units(die_emoji, pua_char),
        core::cmp::Ordering::Less
    );

    let val = json!({
        pua_char: "pua",
        die_emoji: "dice",
        "ascii": "first\x00\t\n"
    });
    let canonical = to_canonical_json(&val).expect("canonicalizes");
    let expected = format!(
        "{{\"ascii\":\"first\\u0000\\t\\n\",\"{die_emoji}\":\"dice\",\"{pua_char}\":\"pua\"}}"
    );
    assert_eq!(canonical, expected);

    // Floating-point numbers are forbidden in canonical receipt JSON.
    let bad_float = json!({ "prob": 0.5 });
    assert_eq!(
        to_canonical_json(&bad_float),
        Err(RollError::CanonicalJsonFloatUnsupported)
    );
}

#[test]
fn tampered_versions_fields_and_draws_fail_with_named_errors() {
    // 1. Tampered schema_version -> UnsupportedSchemaVersion
    let mut bad_schema = sample_receipt("2d6+3");
    bad_schema.schema_version = String::from("roll.receipt.v99");
    assert!(matches!(
        verify_receipt(&bad_schema),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::UnsupportedSchemaVersion { ref found }
        )) if found == "roll.receipt.v99"
    ));

    // 2. Mismatched rules_version vs address.rules_version -> RulesVersionMismatch
    let mut mismatch_rules = sample_receipt("2d6+3");
    mismatch_rules.rules_version = String::from("roll.v2");
    assert!(matches!(
        verify_receipt(&mismatch_rules),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::RulesVersionMismatch { .. }
        ))
    ));

    // 3. Unsupported rules_version (both set to "roll.v2") -> UnsupportedRulesVersion
    let mut bad_rules = sample_receipt("2d6+3");
    bad_rules.rules_version = String::from("roll.v2");
    bad_rules.address.rules_version = String::from("roll.v2");
    assert!(matches!(
        verify_receipt(&bad_rules),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::UnsupportedRulesVersion { ref found }
        )) if found == "roll.v2"
    ));

    // 4. Un-rehashed field mutation -> DigestMismatch
    let mut unhashed_tamper = sample_receipt("2d6+3");
    unhashed_tamper.address.turn = 999;
    assert!(matches!(
        verify_receipt(&unhashed_tamper),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::DigestMismatch { .. }
        ))
    ));

    // 5. Re-hashed mutated raw_draws[0] -> PrngStreamMismatch
    let mut bad_draw = sample_receipt("2d6+3");
    bad_draw.raw_draws[0] ^= 1;
    bad_draw.receipt_sha256 = compute_receipt_sha256(&bad_draw).unwrap();
    assert!(matches!(
        verify_receipt(&bad_draw),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::PrngStreamMismatch { draw_index: 0, .. }
        ))
    ));

    // 6. Re-hashed truncated raw_draws -> DrawTapeUnderflow
    let mut truncated_draws = sample_receipt("2d6+3");
    truncated_draws.raw_draws.pop();
    truncated_draws.receipt_sha256 = compute_receipt_sha256(&truncated_draws).unwrap();
    assert!(matches!(
        verify_receipt(&truncated_draws),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::DrawTapeUnderflow { needed_at_index: 1 }
        ))
    ));

    // 7. Re-hashed appended genuine ChaCha12 draw word -> UnconsumedDraws
    let mut extra_draws = sample_receipt("2d6+3");
    let key = derive_roll_key(&extra_draws.address).unwrap();
    let mut stream = ChaCha12Rng::from_seed(key);
    for _ in 0..extra_draws.raw_draws.len() {
        let _ = stream.next_u64();
    }
    extra_draws.raw_draws.push(stream.next_u64());
    extra_draws.receipt_sha256 = compute_receipt_sha256(&extra_draws).unwrap();
    assert!(matches!(
        verify_receipt(&extra_draws),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::UnconsumedDraws {
                consumed: 2,
                total: 3
            }
        ))
    ));

    // 8. Re-hashed tampered result total -> ResultMismatch
    let mut bad_result = sample_receipt("2d6+3");
    let roll_core::ReceiptResult::Expression {
        ref mut expression_outcome,
    } = bad_result.result;
    expression_outcome.total += 1;
    bad_result.receipt_sha256 = compute_receipt_sha256(&bad_result).unwrap();
    assert!(matches!(
        verify_receipt(&bad_result),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::ResultMismatch
        ))
    ));

    // 9. Re-hashed non-canonical spec ("d20" instead of "1d20") -> NonCanonicalExpression
    let mut non_canonical = sample_receipt("1d20");
    non_canonical.spec = ReceiptSpec::Expression {
        canonical_expression: String::from("d20"),
    };
    non_canonical.receipt_sha256 = compute_receipt_sha256(&non_canonical).unwrap();
    assert!(matches!(
        verify_receipt(&non_canonical),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::NonCanonicalExpression { .. }
        ))
    ));

    // 10. Re-hashed invalid spec ("0d6") -> InvalidSpecExpression
    let mut invalid_spec = sample_receipt("1d6");
    invalid_spec.spec = ReceiptSpec::Expression {
        canonical_expression: String::from("0d6"),
    };
    invalid_spec.receipt_sha256 = compute_receipt_sha256(&invalid_spec).unwrap();
    assert!(matches!(
        verify_receipt(&invalid_spec),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::InvalidSpecExpression { .. }
        ))
    ));

    // 11. Re-hashed non-null eligible_weight_total on expression roll -> UnexpectedEligibleWeightTotal
    let mut unexpected_weight = sample_receipt("1d6");
    unexpected_weight.eligible_weight_total = NonZeroU64::new(100);
    unexpected_weight.receipt_sha256 = compute_receipt_sha256(&unexpected_weight).unwrap();
    assert!(matches!(
        verify_receipt(&unexpected_weight),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::UnexpectedEligibleWeightTotal
        ))
    ));

    // 12. Re-hashed invalid address domain -> InvalidAddress
    let mut invalid_addr = sample_receipt("1d6");
    invalid_addr.address.domain = String::from("bad domain");
    invalid_addr.receipt_sha256 = compute_receipt_sha256(&invalid_addr).unwrap();
    assert!(matches!(
        verify_receipt(&invalid_addr),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::InvalidAddress { ref field, .. }
        )) if field == "domain"
    ));

    // 13. Non-canonical JSON encodings (uppercase hex, leading zero integer, unknown field) -> MalformedJson
    let valid_json = to_canonical_receipt_json(&sample_receipt("1d6"));
    let upper_hex = valid_json.replace(
        &valid_json[valid_json.find("\"receipt_sha256\":\"").unwrap() + 18..][..64],
        &"A".repeat(64),
    );
    assert!(matches!(
        verify_receipt_json(&upper_hex),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::MalformedJson { .. }
        ))
    ));

    let leading_zero_turn = valid_json.replace("\"turn\":\"4\"", "\"turn\":\"04\"");
    assert!(matches!(
        verify_receipt_json(&leading_zero_turn),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::MalformedJson { .. }
        ))
    ));
}

#[test]
fn receipt_execution_error_unsupported_rules_codec_and_error_trait_coverage() {
    use core::error::Error as _;
    use roll_core::codec::{
        decode_bytes32_hex, decode_u64_hex, parse_canonical_i64, parse_canonical_u64,
    };

    // 1. Re-hashed forged receipt with canonical `"1d6/0"` (consumes the valid 1-word ChaCha12 draw
    //    for `1d6`, then hits `DivisionByZero` during replay) -> `ReceiptVerifyError::ExecutionError`.
    let mut exec_err_receipt = sample_receipt("1d6");
    exec_err_receipt.spec = ReceiptSpec::Expression {
        canonical_expression: String::from("1d6/0"),
    };
    exec_err_receipt.receipt_sha256 = compute_receipt_sha256(&exec_err_receipt).unwrap();
    match verify_receipt(&exec_err_receipt) {
        Err(RollError::ReceiptInvalid(ReceiptVerifyError::ExecutionError { message })) => {
            assert!(
                message.contains("division by zero"),
                "unexpected message: {message}"
            );
        }
        other => panic!("expected ExecutionError, got {other:?}"),
    }

    // 2. `evaluate_addressed` rejects non-v3 `rules_version` on `RollAddress`.
    let mut bad_addr = RollAddress::new(SeedMaterial::Int64(1), 0, "cli", "", 0);
    bad_addr.rules_version = String::from("roll.v2");
    assert!(matches!(
        evaluate_addressed(&parse("1d6").unwrap(), &bad_addr),
        Err(RollError::InvalidAddress {
            field: "rules_version",
            ..
        })
    ));

    // 3. Direct codec rejection unit checks (`"-0"`, leading zeros, `+`, short/uppercase hex).
    assert_eq!(parse_canonical_i64("-9223372036854775808"), Ok(i64::MIN));
    assert!(parse_canonical_i64("-0").is_err());
    assert!(parse_canonical_i64("+5").is_err());
    assert!(parse_canonical_i64("00").is_err());
    assert!(parse_canonical_i64("").is_err());
    assert!(parse_canonical_i64("9223372036854775808").is_err());

    assert_eq!(parse_canonical_u64("18446744073709551615"), Ok(u64::MAX));
    assert!(parse_canonical_u64("-1").is_err());
    assert!(parse_canonical_u64("01").is_err());
    assert!(parse_canonical_u64("").is_err());

    assert!(decode_bytes32_hex("00").is_err());
    assert!(decode_bytes32_hex(&"A".repeat(64)).is_err());
    assert!(decode_u64_hex("00").is_err());
    assert!(decode_u64_hex("0123456789ABCDEF").is_err());

    // 4. `<RollError as core::error::Error>::source` and new analyzer error `Display` formatting.
    let budget_err = RollError::AnalysisBudgetExceeded {
        total_dice: 1_001,
        max: 1_000,
    };
    assert!(budget_err.source().is_none());
    assert!(budget_err.to_string().contains("1001 dice exceeds"));

    let prob_err = RollError::InvalidProbability {
        given: String::from("0"),
    };
    assert!(prob_err.source().is_none());
    assert!(prob_err.to_string().contains("(0, 1]"));
}
