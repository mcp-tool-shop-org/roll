//! Deterministic cross-language conformance fixture builder (`Roll 3.0 §9.1`).
//!
//! Pure `no_std` + `alloc` implementation so both native targets and `wasm32-wasip1`
//! execute the exact same fixture generation and verify identical `MANIFEST.sha256` digests.

use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;
use core::num::NonZeroU64;
use rand_chacha::ChaCha12Rng;
use rand_core::{Rng, SeedableRng};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::analyze::{AnalysisMethod, DistributionStats, TargetDirection, analyze, compare};
use crate::ast::Expr;
use crate::canonical_json::{cmp_utf16_code_units, to_canonical_json};
use crate::codec::{encode_hex_lower, encode_u64_hex};
use crate::error::{ReceiptVerifyError, RollError};
use crate::eval::{checked_div_floor, evaluate_with_rng};
use crate::parser::parse;
use crate::receipt::{
    ReceiptResult, ReceiptSpec, RollReceipt, compute_receipt_sha256, evaluate_addressed,
    to_canonical_receipt_json, verify_receipt_json,
};
use crate::rng::{RollAddress, RollRng, SeedMaterial, derive_roll_key, lemire_sample_from_tape};

/// In-memory deterministic conformance fixture bundle (`01`..`04` + `MANIFEST.sha256`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConformanceBundle {
    /// Map from relative filename (`01_kdf_and_rng.json`, etc.) to exact UTF-8 file bytes.
    pub files: BTreeMap<String, String>,
    /// Exact UTF-8 contents of `MANIFEST.sha256` (`<sha256>  <filename>\n` per file).
    pub manifest: String,
    /// Lowercase hex SHA-256 of `manifest` itself.
    pub manifest_sha256: String,
}

#[derive(serde::Serialize)]
struct KdfAndRngFile {
    schema_version: &'static str,
    chacha12_zero_seed_words: Vec<String>,
    kdf_vectors: Vec<KdfVector>,
    invalid_addresses: Vec<InvalidAddressCase>,
    lemire_stream_vectors: Vec<LemireStreamVector>,
    lemire_tape_vectors: Vec<LemireTapeVector>,
}

#[derive(serde::Serialize)]
struct KdfVector {
    index: usize,
    description: String,
    address: RollAddress,
    derived_key_hex: String,
    first_words_hex: Vec<String>,
}

#[derive(serde::Serialize)]
struct InvalidAddressCase {
    description: &'static str,
    address: RollAddress,
    expected_field: &'static str,
}

#[derive(serde::Serialize)]
struct LemireStreamVector {
    span: String,
    seed_int64: String,
    sampled: String,
    raw_draws_hex: Vec<String>,
}

#[derive(serde::Serialize)]
struct LemireTapeVector {
    description: String,
    span: String,
    threshold: String,
    tape_hex: Vec<String>,
    expected_sampled: String,
    expected_consumed: usize,
}

#[derive(serde::Serialize)]
struct GrammarAndAstFile {
    schema_version: &'static str,
    accept_cases: Vec<GrammarAcceptCase>,
    reject_cases: Vec<GrammarRejectCase>,
    division_and_arithmetic_cases: Vec<DivisionArithmeticCase>,
}

#[derive(serde::Serialize)]
struct GrammarAcceptCase {
    input: String,
    canonical_expression: String,
    total_base_dice: u32,
    ast: Expr,
}

#[derive(serde::Serialize)]
struct GrammarRejectCase {
    description: String,
    input: String,
    expected_error_kind: &'static str,
    expected_byte_offset: Option<usize>,
}

#[derive(serde::Serialize)]
struct DivisionArithmeticCase {
    description: String,
    expression: String,
    expected_outcome: &'static str,
    expected_total: Option<String>,
}

#[derive(serde::Serialize)]
struct RollsAndReceiptsFile {
    schema_version: &'static str,
    canonical_json_cases: Vec<CanonicalJsonCase>,
    valid_receipts: Vec<ValidReceiptCase>,
    tampered_receipts: Vec<TamperedReceiptCase>,
    ten_thousand_receipts_sha256: String,
}

#[derive(serde::Serialize)]
struct CanonicalJsonCase {
    description: &'static str,
    input: Value,
    utf8_key_order: Vec<String>,
    utf16_key_order: Vec<String>,
    canonical_json: String,
    sha256_hex: String,
}

#[derive(serde::Serialize)]
struct ValidReceiptCase {
    index: usize,
    input_expression: String,
    canonical_receipt_json: String,
    receipt_sha256: String,
    total: String,
}

#[derive(serde::Serialize)]
struct TamperedReceiptCase {
    index: usize,
    description: String,
    tampered_receipt_json: String,
    expected_error_code: &'static str,
}

#[derive(serde::Serialize)]
struct ExactAnalysisFile {
    schema_version: &'static str,
    analyze_cases: Vec<AnalyzeFixtureCase>,
    compare_cases: Vec<CompareFixtureCase>,
    error_cases: Vec<AnalyzeErrorFixtureCase>,
}

#[derive(serde::Serialize)]
struct PmfEntryFixture {
    outcome: String,
    probability: f64,
}

#[derive(serde::Serialize)]
struct StatsFixture {
    min: String,
    max: String,
    mean: f64,
    median: String,
    mode: String,
    stddev: f64,
    percentiles: BTreeMap<String, String>,
    entropy: f64,
}

#[derive(serde::Serialize)]
struct TargetQueryFixture {
    probability: f64,
    at_least: String,
    at_most: String,
}

#[derive(serde::Serialize)]
struct AnalyzeFixtureCase {
    description: &'static str,
    expression: &'static str,
    canonical_expression: String,
    method: AnalysisMethod,
    support_len: usize,
    stats: StatsFixture,
    pmf: Vec<PmfEntryFixture>,
    cdf_samples: Vec<PmfEntryFixture>,
    survival_samples: Vec<PmfEntryFixture>,
    target_queries: Vec<TargetQueryFixture>,
}

#[derive(serde::Serialize)]
struct CompareFixtureCase {
    description: &'static str,
    left_expression: &'static str,
    right_expression: &'static str,
    method: AnalysisMethod,
    p_left_greater: f64,
    p_equal: f64,
    p_right_greater: f64,
    mean_margin: f64,
    has_exact_margin: bool,
    margin_support_len: Option<usize>,
}

#[derive(serde::Serialize)]
struct AnalyzeErrorFixtureCase {
    description: &'static str,
    expression: &'static str,
    expected_error_kind: &'static str,
}

/// Builds the complete deterministic conformance suite in memory (`01`..`04` + `MANIFEST.sha256`).
pub fn build_conformance_suite() -> ConformanceBundle {
    let mut files = BTreeMap::new();

    let file01 = build_01_kdf_and_rng();
    let json01 = serialize_fixture_json(&file01);
    files.insert(String::from("01_kdf_and_rng.json"), json01);

    let file02 = build_02_grammar_and_ast();
    let json02 = serialize_fixture_json(&file02);
    files.insert(String::from("02_grammar_and_ast.json"), json02);

    let file03 = build_03_rolls_and_receipts();
    let json03 = serialize_fixture_json(&file03);
    files.insert(String::from("03_rolls_and_receipts.json"), json03);

    let file04 = build_04_exact_analysis();
    let json04 = serialize_fixture_json(&file04);
    files.insert(String::from("04_exact_analysis.json"), json04);

    let mut manifest = String::new();
    for (name, contents) in &files {
        let digest = encode_hex_lower(&Sha256::digest(contents.as_bytes()));
        manifest.push_str(&digest);
        manifest.push_str("  ");
        manifest.push_str(name);
        manifest.push('\n');
    }

    let manifest_sha256 = encode_hex_lower(&Sha256::digest(manifest.as_bytes()));

    ConformanceBundle {
        files,
        manifest,
        manifest_sha256,
    }
}

/// Computes the Spec §2.4 running SHA-256 over the canonical JSON bytes of 10,000 generated `RollReceipt`s.
pub fn compute_10k_receipts_sha256() -> String {
    const EXPRS: &[&str] = &[
        "1d6",
        "2d6+3",
        "4d6r=1min2kh3+5",
        "1d20cscf",
        "4d6khsa",
        "2d6rsa",
        "1d6!",
        "1d6!!>4",
        "1d6!p>=5",
        "8d6cs>=5cf<=1",
        "4dF",
        "4dFr=-1",
        "d%",
        "(3d6-10)/2",
        "6d6dl1dh1*2-3",
        "2d4ro=1min2max4",
    ];
    const DOMAINS: &[&str] = &["road_event", "market_shock", "combat", "cli"];

    let mut hasher = Sha256::new();
    let parsed_exprs: Vec<Expr> = EXPRS
        .iter()
        .map(|s| parse(s).expect("valid fixture expression"))
        .collect();

    for i in 0..10_000u64 {
        let expr = &parsed_exprs[(i as usize) % parsed_exprs.len()];
        let domain = DOMAINS[(i as usize) % DOMAINS.len()];
        let seed = if i.is_multiple_of(5) {
            let tag = format!("roll.v3.repro.beacon.{i:08}");
            let bytes: [u8; 32] = Sha256::digest(tag.as_bytes()).into();
            SeedMaterial::Bytes32(bytes)
        } else {
            let signed = (i as i64)
                .wrapping_mul(-7_046_029_254_386_353_131)
                .wrapping_add(42);
            SeedMaterial::Int64(signed)
        };
        let entity = if i.is_multiple_of(7) {
            format!("caravan:🎲-{}", i % 97)
        } else {
            format!("entity:{}", i % 251)
        };
        let addr = RollAddress::new(seed, i / 4, domain, entity, i % 4);
        let (_outcome, receipt) =
            evaluate_addressed(expr, &addr).expect("10k reproducibility roll succeeds");
        let canonical = to_canonical_receipt_json(&receipt);
        hasher.update(canonical.as_bytes());
        hasher.update(b"\n");
    }

    encode_hex_lower(&hasher.finalize())
}

fn serialize_fixture_json<T: serde::Serialize>(val: &T) -> String {
    let mut s = serde_json::to_string_pretty(val).expect("fixture serializes cleanly");
    s.push('\n');
    s
}

fn build_01_kdf_and_rng() -> KdfAndRngFile {
    // 1. First 16 words (2 ChaCha12 blocks) from zero seed.
    let mut zero_rng = RollRng::from_raw_seed([0u8; 32]);
    let mut chacha12_zero_seed_words = Vec::with_capacity(16);
    for _ in 0..16 {
        chacha12_zero_seed_words.push(encode_u64_hex(zero_rng.next_u64_recorded()));
    }

    // 2. 250 KDF vectors covering boundary seeds, prefix-collision pairs, UTF-8 entity_ids, and lengths.
    let mut named_addresses: Vec<(String, RollAddress)> = vec![
        (
            String::from("int64_zero_cli"),
            RollAddress::new(SeedMaterial::Int64(0), 0, "cli", "", 0),
        ),
        (
            String::from("int64_minus_one"),
            RollAddress::new(SeedMaterial::Int64(-1), 0, "cli", "", 0),
        ),
        (
            String::from("int64_min"),
            RollAddress::new(SeedMaterial::Int64(i64::MIN), 0, "cli", "", 0),
        ),
        (
            String::from("int64_max"),
            RollAddress::new(SeedMaterial::Int64(i64::MAX), 0, "cli", "", 0),
        ),
        (
            String::from("int64_one_low32_anchor"),
            RollAddress::new(SeedMaterial::Int64(1), 0, "cli", "", 0),
        ),
        (
            String::from("int64_2pow32_plus_one_no_truncation"),
            RollAddress::new(SeedMaterial::Int64(4_294_967_297), 0, "cli", "", 0),
        ),
        (
            String::from("int64_js_max_safe_integer"),
            RollAddress::new(SeedMaterial::Int64(9_007_199_254_740_991), 0, "cli", "", 0),
        ),
        (
            String::from("int64_js_max_safe_plus_one"),
            RollAddress::new(SeedMaterial::Int64(9_007_199_254_740_992), 0, "cli", "", 0),
        ),
        (
            String::from("int64_js_max_safe_plus_two"),
            RollAddress::new(SeedMaterial::Int64(9_007_199_254_740_993), 0, "cli", "", 0),
        ),
        (
            String::from("bytes32_all_zero"),
            RollAddress::new(SeedMaterial::Bytes32([0u8; 32]), 0, "drand", "", 0),
        ),
        (
            String::from("bytes32_all_ff"),
            RollAddress::new(
                SeedMaterial::Bytes32([0xffu8; 32]),
                u64::MAX,
                "drand",
                "",
                u64::MAX,
            ),
        ),
        (
            String::from("prefix_collision_pair_a"),
            RollAddress::new(SeedMaterial::Int64(7), 1, "ab", "c", 0),
        ),
        (
            String::from("prefix_collision_pair_b"),
            RollAddress::new(SeedMaterial::Int64(7), 1, "a", "bc", 0),
        ),
        (
            String::from("domain_min_1_byte"),
            RollAddress::new(SeedMaterial::Int64(42), 1, "x", "", 0),
        ),
        (
            String::from("domain_max_128_bytes"),
            RollAddress::new(SeedMaterial::Int64(42), 1, "d".repeat(128), "", 0),
        ),
        (
            String::from("entity_max_256_bytes_ascii"),
            RollAddress::new(SeedMaterial::Int64(42), 1, "road", "e".repeat(256), 0),
        ),
        (
            String::from("entity_utf8_emoji_and_cjk"),
            RollAddress::new(
                SeedMaterial::Int64(42),
                4,
                "road_event",
                "caravan:🎲-北方商隊-04",
                2,
            ),
        ),
        (
            String::from("entity_max_256_bytes_utf8_4byte"),
            RollAddress::new(SeedMaterial::Int64(42), 1, "road", "🎲".repeat(64), 0),
        ),
        (
            String::from("rules_version_min_1_byte"),
            RollAddress {
                campaign_seed: SeedMaterial::Int64(42),
                turn: 0,
                domain: String::from("cli"),
                entity_id: String::new(),
                roll_index: 0,
                rules_version: String::from("3"),
            },
        ),
        (
            String::from("rules_version_max_64_bytes"),
            RollAddress {
                campaign_seed: SeedMaterial::Int64(42),
                turn: 0,
                domain: String::from("cli"),
                entity_id: String::new(),
                roll_index: 0,
                rules_version: "v".repeat(64),
            },
        ),
    ];

    while named_addresses.len() < 250 {
        let idx = named_addresses.len() as u64;
        let seed = if idx.is_multiple_of(3) {
            let digest: [u8; 32] = Sha256::digest(format!("drand.round.{idx}").as_bytes()).into();
            SeedMaterial::Bytes32(digest)
        } else {
            let val = (idx as i64)
                .wrapping_mul(-3_935_559_000_370_003_845)
                .wrapping_add(idx as i64);
            SeedMaterial::Int64(val)
        };
        let domain = match idx % 4 {
            0 => "road_event",
            1 => "market_shock",
            2 => "cli",
            _ => "encounter.tier_2",
        };
        let entity = if idx.is_multiple_of(5) {
            String::new()
        } else {
            format!("unit:{idx}:route-{}", idx % 17)
        };
        let turn = idx.wrapping_mul(1_000_003);
        let roll_index = idx % 19;
        named_addresses.push((
            format!("grid_vector_{idx:03}"),
            RollAddress::new(seed, turn, domain, entity, roll_index),
        ));
    }

    let mut kdf_vectors = Vec::with_capacity(250);
    for (index, (description, address)) in named_addresses.into_iter().enumerate() {
        let key = derive_roll_key(&address).expect("valid fixture KDF address");
        let mut rng = RollRng::from_raw_seed(key);
        let mut first_words_hex = Vec::with_capacity(4);
        for _ in 0..4 {
            first_words_hex.push(encode_u64_hex(rng.next_u64_recorded()));
        }
        kdf_vectors.push(KdfVector {
            index,
            description,
            address,
            derived_key_hex: encode_hex_lower(&key),
            first_words_hex,
        });
    }

    // 3. Invalid address cases.
    let invalid_addresses = vec![
        InvalidAddressCase {
            description: "empty domain rejected",
            address: RollAddress::new(SeedMaterial::Int64(1), 0, "", "", 0),
            expected_field: "domain",
        },
        InvalidAddressCase {
            description: "domain over 128 bytes rejected",
            address: RollAddress::new(SeedMaterial::Int64(1), 0, "a".repeat(129), "", 0),
            expected_field: "domain",
        },
        InvalidAddressCase {
            description: "domain containing ASCII space rejected",
            address: RollAddress::new(SeedMaterial::Int64(1), 0, "road event", "", 0),
            expected_field: "domain",
        },
        InvalidAddressCase {
            description: "entity_id containing ESC control byte rejected",
            address: RollAddress::new(SeedMaterial::Int64(1), 0, "road", "bad\x1bname", 0),
            expected_field: "entity_id",
        },
        InvalidAddressCase {
            description: "entity_id over 256 bytes rejected",
            address: RollAddress::new(SeedMaterial::Int64(1), 0, "road", "e".repeat(257), 0),
            expected_field: "entity_id",
        },
        InvalidAddressCase {
            description: "empty rules_version rejected",
            address: RollAddress {
                campaign_seed: SeedMaterial::Int64(1),
                turn: 0,
                domain: String::from("cli"),
                entity_id: String::new(),
                roll_index: 0,
                rules_version: String::new(),
            },
            expected_field: "rules_version",
        },
        InvalidAddressCase {
            description: "rules_version over 64 bytes rejected",
            address: RollAddress {
                campaign_seed: SeedMaterial::Int64(1),
                turn: 0,
                domain: String::from("cli"),
                entity_id: String::new(),
                roll_index: 0,
                rules_version: "r".repeat(65),
            },
            expected_field: "rules_version",
        },
    ];

    // 4. Live stream Lemire vectors across representative and boundary spans (§9.1).
    let spans: [u64; 10] = [
        1,
        2,
        3,
        6,
        20,
        100,
        1u64 << 32,
        (1u64 << 53) + 7,
        3u64 << 62,
        u64::MAX,
    ];
    let mut lemire_stream_vectors = Vec::new();
    for (idx, &s) in spans.iter().enumerate() {
        let span = NonZeroU64::new(s).expect("non-zero span");
        let seed_int64 = (idx as i64) * 1337 - 500;
        let addr = RollAddress::new(SeedMaterial::Int64(seed_int64), 0, "lemire", "", 0);
        let mut rng = RollRng::from_address(&addr).expect("valid address");
        let sampled = rng.sample_u64(span);
        let raw_draws_hex = rng.draws().iter().copied().map(encode_u64_hex).collect();
        lemire_stream_vectors.push(LemireStreamVector {
            span: s.to_string(),
            seed_int64: seed_int64.to_string(),
            sampled: sampled.to_string(),
            raw_draws_hex,
        });
    }

    // 5. Synthetic Lemire tape vectors exercising fast path, slow-check accept, and multi-retry slow path.
    let mut lemire_tape_vectors = Vec::new();
    let slow_spans: [u64; 8] = [
        3,
        6,
        20,
        100,
        (1u64 << 53) + 7,
        3u64 << 62,
        u64::MAX - 1,
        u64::MAX,
    ];

    for &s in &slow_spans {
        let span = NonZeroU64::new(s).expect("non-zero");
        let threshold = s.wrapping_neg() % s;
        // Find a non-zero word `x_rej` with `(x_rej * s) mod 2^64 < threshold` when threshold > 1:
        // Note `(floor(2^64 / s) + 1) * s = 2^64 + (s - (2^64 mod s))`? Let's compute exact modular witness:
        // For any `s` with `threshold > 0`, `x = 0` ALWAYS has `low = 0 < threshold`!
        // In addition, `q_ceil = (u64::MAX / s) + 1` has `(q_ceil * s) mod 2^64 = s - threshold`!
        // Whenever `s - threshold < threshold` (i.e. `threshold > s / 2`, such as s=3 (t=1? no, 2^64 mod 3 = 1),
        // s=6 (t=4, s-t=2 < 4!), s=20 (t=16, s-t=4 < 16!), s=100 (t=16? 2^64 mod 100 = 16)),
        // we can find non-zero rejected words by stepping multiples `k * q_ceil` reducing mod s!
        let mut non_zero_reject: Option<u64> = None;
        if threshold > 1 {
            let step = (u64::MAX / s).wrapping_add(1);
            let mut acc: u128 = 0;
            for _ in 1..256 {
                acc = acc.wrapping_add(u128::from(step));
                if acc <= u128::from(u64::MAX) {
                    let cand = acc as u64;
                    let low = (u128::from(cand) * u128::from(s)) as u64;
                    if low < threshold {
                        non_zero_reject = Some(cand);
                        break;
                    }
                } else {
                    break;
                }
            }
        }

        // Accept word: pick a deterministic high-entropy word that satisfies `low >= threshold`.
        let accept_word: u64 = if s == u64::MAX {
            42
        } else {
            let mut candidate = 0x53f9_5507_6a9a_f49bu64 ^ s;
            loop {
                let low = (u128::from(candidate) * u128::from(s)) as u64;
                if low >= threshold {
                    break candidate;
                }
                candidate = candidate.wrapping_add(1);
            }
        };

        let mut tape = vec![0u64];
        if let Some(nz) = non_zero_reject {
            tape.push(nz);
        }
        tape.push(accept_word);

        let (sampled, consumed) =
            lemire_sample_from_tape(span, &tape).expect("synthetic slow-path tape must terminate");
        assert_eq!(consumed, tape.len());

        lemire_tape_vectors.push(LemireTapeVector {
            description: format!("slow_path_rejection_span_{s}"),
            span: s.to_string(),
            threshold: threshold.to_string(),
            tape_hex: tape.iter().copied().map(encode_u64_hex).collect(),
            expected_sampled: sampled.to_string(),
            expected_consumed: consumed,
        });
    }

    // Explicit span = 6 boundary where `low == threshold` (4 < 6, enters `if low < s` and exits `while low < 4` with 0 retries)
    let span6 = NonZeroU64::new(6).unwrap();
    let x_exact_threshold = 0x5555_5555_5555_5556u64;
    let (sampled_eq_t, consumed_eq_t) =
        lemire_sample_from_tape(span6, &[x_exact_threshold]).unwrap();
    lemire_tape_vectors.push(LemireTapeVector {
        description: String::from("slow_branch_exact_threshold_accept_span_6"),
        span: String::from("6"),
        threshold: String::from("4"),
        tape_hex: vec![encode_u64_hex(x_exact_threshold)],
        expected_sampled: sampled_eq_t.to_string(),
        expected_consumed: consumed_eq_t,
    });

    // Span = 1 boundary (`0` accepted on first draw without retry).
    let span1 = NonZeroU64::new(1).unwrap();
    let (sampled_one, consumed_one) = lemire_sample_from_tape(span1, &[0]).unwrap();
    lemire_tape_vectors.push(LemireTapeVector {
        description: String::from("span_1_zero_draw_single_step"),
        span: String::from("1"),
        threshold: String::from("0"),
        tape_hex: vec![encode_u64_hex(0)],
        expected_sampled: sampled_one.to_string(),
        expected_consumed: consumed_one,
    });

    KdfAndRngFile {
        schema_version: "roll.conformance.kdf_rng.v1",
        chacha12_zero_seed_words,
        kdf_vectors,
        invalid_addresses,
        lemire_stream_vectors,
        lemire_tape_vectors,
    }
}

fn build_02_grammar_and_ast() -> GrammarAndAstFile {
    let valid_1000 = format!("1d6{}+1d6", " ".repeat(993));
    assert_eq!(valid_1000.len(), 1_000);
    let over_1000 = format!("1d6{}+1d6", " ".repeat(994));
    assert_eq!(over_1000.len(), 1_001);

    let accept_inputs: Vec<String> = [
        "42",
        "-2",
        "-9223372036854775808",
        "-(2)",
        "-(-9223372036854775808)",
        "2d6",
        "2D6",
        "d20",
        "D20",
        "d%",
        "4dF",
        "4df",
        "2d6+3",
        "2d6+1d4+3",
        "1d4+2d6*10",
        "(2d6+3)*2",
        "1+(2+3)",
        "10-(2+3)",
        "-(2*3)",
        "4d6kh3",
        "4d6kh",
        "4d6kl",
        "4d6kl2",
        "4d6dh",
        "4d6dh1",
        "4d6dl",
        "4d6kh0",
        "1d6!",
        "1d6!>4",
        "1d6!>=5",
        "1d6!!",
        "1d6!!>4",
        "1d6!p",
        "1d6!p>=4",
        "1d%!",
        "2d6r",
        "2d6r<2",
        "2d6ro",
        "2d6ro=1",
        "2d6min3",
        "2d6max5",
        "2d6max5min2",
        "4d6kh3r=1",
        "8d6r<2min2kh5sa",
        "8d6cs>=5",
        "8d6cs>=5cf<=1",
        "10d6cf<=1",
        "8d6cs>=5+2",
        "1d20cs",
        "1d20cf",
        "1d20cscf",
        "4dFcscf",
        "4d6khsa",
        "2d6rsa",
        "4d6sd",
        "4dFr=-1",
        "4dFmin-1max0",
        "5000d6 + 5000d6",
    ]
    .into_iter()
    .map(String::from)
    .chain(core::iter::once(valid_1000))
    .collect();

    let mut accept_cases = Vec::with_capacity(accept_inputs.len());
    for input in accept_inputs {
        let ast = parse(&input).expect("accept corpus expression must parse");
        let canonical_expression = ast.to_canonical_string();
        let total_base_dice = ast.total_base_dice();
        accept_cases.push(GrammarAcceptCase {
            input,
            canonical_expression,
            total_base_dice,
            ast,
        });
    }

    let reject_inputs: Vec<(&str, String)> = vec![
        ("empty string", String::new()),
        ("whitespace only", String::from("   \t ")),
        ("zero dice count 0d6", String::from("0d6")),
        ("zero dice count 00d20", String::from("00d20")),
        ("zero die sides 1d0", String::from("1d0")),
        ("die sides above 1_000_000", String::from("1d1000001")),
        (
            "inverted clamp bounds min > max",
            String::from("1d6min5max2"),
        ),
        (
            "inverted clamp bounds max < min",
            String::from("1d6max2min5"),
        ),
        ("duplicate min slot", String::from("1d6min2min4")),
        ("duplicate max slot", String::from("1d6max5max3")),
        ("duplicate explosion slot", String::from("1d6!>5!>4")),
        ("triple bang duplicate explosion", String::from("1d6!!!")),
        ("duplicate sort slot sa+sd", String::from("4d6sasd")),
        ("duplicate bare cs slot", String::from("1d20cscs")),
        ("duplicate bare cf slot", String::from("1d20cfcf")),
        ("exploding Fate dice !", String::from("4dF!")),
        ("compounding Fate dice !!", String::from("4dF!!")),
        ("penetrating Fate dice !p", String::from("4dF!p")),
        (
            "mixed bare cs and pool cs>=15",
            String::from("1d20cscs>=15"),
        ),
        ("mixed pool cs>=5 and bare cf", String::from("8d6cs>=5cf")),
        ("single group > 10,000 dice", String::from("10001d6")),
        (
            "multi-group > 10,000 total dice (6000+5000)",
            String::from("6000d6+5000d6"),
        ),
        (
            "multi-group > 10,000 total dice (2000+9000)",
            String::from("2000d6+9000d6"),
        ),
        ("expression over 1,000 bytes (1,001 bytes)", over_1000),
        ("invalid character @", String::from("2d6@3")),
        ("unknown identifier in ExprMode", String::from("foo")),
        ("trailing d after dice group", String::from("2d6 d")),
        ("unclosed parenthesis", String::from("(2d6+3")),
        (
            "literal exceeding i64::MAX",
            String::from("9223372036854775808"),
        ),
        (
            "literal below i64::MIN",
            String::from("-9223372036854775809"),
        ),
    ];

    let mut reject_cases = Vec::with_capacity(reject_inputs.len());
    for (desc, input) in reject_inputs {
        let err = parse(&input).expect_err("reject corpus expression must fail");
        let (expected_error_kind, expected_byte_offset) = classify_parse_error(&err);
        reject_cases.push(GrammarRejectCase {
            description: String::from(desc),
            input,
            expected_error_kind,
            expected_byte_offset,
        });
    }

    // Division & checked i64 arithmetic conformance cases (§4.3).
    let div_exprs: &[(&str, &str)] = &[
        ("positive exact division", "6/2"),
        ("positive floor division", "7/2"),
        ("negative dividend floor toward -inf (-7/2 == -4)", "-7/2"),
        ("negative divisor floor toward -inf (7/-2 == -4)", "7/-2"),
        ("two negatives positive floor (-7/-2 == 3)", "-7/-2"),
        ("negative exact division (-6/2 == -3)", "-6/2"),
        (
            "D&D ability modifier odd low score ((9-10)/2 == -1)",
            "(9-10)/2",
        ),
        ("D&D ability modifier score 1 ((1-10)/2 == -5)", "(1-10)/2"),
        ("zero divided by negative integer", "0/-5"),
        (
            "large i64 beyond IEEE-754 safe integer positive floor",
            "9007199254740993/2",
        ),
        (
            "large i64 beyond IEEE-754 safe integer negative floor",
            "-9007199254740993/2",
        ),
        ("division by literal zero", "5/0"),
        ("division by zero subexpression", "10/(3-3)"),
        ("addition overflow above i64::MAX", "9223372036854775807+1"),
        (
            "subtraction underflow below i64::MIN",
            "-9223372036854775807-2",
        ),
        ("multiplication overflow", "4000000000000*4000000000000"),
        (
            "i64::MIN divided by -1 overflow",
            "(-9223372036854775807-1)/-1",
        ),
        (
            "literal i64::MIN evaluates to i64::MIN",
            "-9223372036854775808",
        ),
        (
            "unary negation of literal i64::MIN overflows",
            "-(-9223372036854775808)",
        ),
    ];

    let mut division_and_arithmetic_cases = Vec::with_capacity(div_exprs.len());
    for &(desc, expr_str) in div_exprs {
        let expr = parse(expr_str).expect("arithmetic test expression parses");
        let mut rng = RollRng::from_raw_seed([0u8; 32]);
        match evaluate_with_rng(&expr, &mut rng) {
            Ok(outcome) => {
                division_and_arithmetic_cases.push(DivisionArithmeticCase {
                    description: String::from(desc),
                    expression: String::from(expr_str),
                    expected_outcome: "ok",
                    expected_total: Some(outcome.total.to_string()),
                });
            }
            Err(RollError::DivisionByZero) => {
                division_and_arithmetic_cases.push(DivisionArithmeticCase {
                    description: String::from(desc),
                    expression: String::from(expr_str),
                    expected_outcome: "division_by_zero",
                    expected_total: None,
                });
            }
            Err(RollError::ArithmeticOverflow) => {
                division_and_arithmetic_cases.push(DivisionArithmeticCase {
                    description: String::from(desc),
                    expression: String::from(expr_str),
                    expected_outcome: "arithmetic_overflow",
                    expected_total: None,
                });
            }
            Err(other) => panic!("unexpected arithmetic error: {other}"),
        }
    }
    // Sanity-check direct `checked_div_floor(i64::MIN, -1)` matches the expression case.
    assert_eq!(
        checked_div_floor(i64::MIN, -1),
        Err(RollError::ArithmeticOverflow)
    );

    GrammarAndAstFile {
        schema_version: "roll.conformance.grammar_ast.v1",
        accept_cases,
        reject_cases,
        division_and_arithmetic_cases,
    }
}

fn classify_parse_error(err: &RollError) -> (&'static str, Option<usize>) {
    match err {
        RollError::ExpressionTooLong { .. } => ("expression_too_long", None),
        RollError::Lex { byte_offset, .. } => ("lex", Some(*byte_offset)),
        RollError::Parse { byte_offset, .. } => ("parse", Some(*byte_offset)),
        RollError::DiceBudgetExceeded { .. } => ("dice_budget_exceeded", None),
        RollError::InvalidClampBounds { byte_offset, .. } => {
            ("invalid_clamp_bounds", Some(*byte_offset))
        }
        RollError::ArithmeticOverflow => ("arithmetic_overflow", None),
        _ => ("other", None),
    }
}

fn build_03_rolls_and_receipts() -> RollsAndReceiptsFile {
    // 1. Canonical JSON cases, including the mandatory §10.2 UTF-16 vs UTF-8 ordering inversion!
    let utf16_inversion_obj = json!({
        "\u{E000}": "bmp_private_use_u_e000",
        "🎲": "supplementary_die_u_1f3b2",
        "\u{FFFD}": "bmp_replacement_u_fffd",
        "alpha": "ascii_low"
    });
    let nested_escapes_obj = json!({
        "z_last": [true, false, null, 0, 10000],
        "a_ctrl": "\x00\x08\t\n\x0c\r\x1f\"\\",
        "m_nested": {
            "\u{E001}": "after_surrogate_in_utf16",
            "🧭": "compass_u_1f9ed_surrogate_first"
        }
    });

    let canonical_json_cases = vec![
        build_canonical_json_case(
            "sec_10_2_utf16_surrogate_vs_bmp_e000_key_order_inversion",
            utf16_inversion_obj,
        ),
        build_canonical_json_case(
            "rfc8785_control_char_escapes_and_nested_utf16_key_sorting",
            nested_escapes_obj,
        ),
    ];

    // 2. 200 valid addressed expression receipts across all modifier stages.
    const RECEIPT_EXPRS: &[&str] = &[
        "1d6",
        "2d6+3",
        "d20",
        "d%",
        "4dF",
        "4dFr=-1",
        "4dFmin-1max0",
        "4dFcscf",
        "1d20cscf",
        "1d20cs",
        "1d20cf",
        "4d6khsa",
        "2d6rsa",
        "4d6r=1min2kh3+5",
        "2d4ro=1min2max4",
        "1d6!",
        "1d6!!>4",
        "1d6!p>=5",
        "8d6cs>=5cf<=1",
        "10d6cf<=1",
        "(3d6-10)/2",
        "6d6dl1dh1*2-3",
        "3d8kl2+2d6!>=6",
        "-(2d6+1)+10",
        "5d10r<=2ro=3kh3sd",
    ];

    let mut valid_receipts = Vec::with_capacity(200);
    let mut base_receipt_structs = Vec::with_capacity(200);

    for idx in 0..200usize {
        let input_expression = String::from(RECEIPT_EXPRS[idx % RECEIPT_EXPRS.len()]);
        let expr = parse(&input_expression).expect("valid receipt expression");
        let seed = if idx.is_multiple_of(4) {
            let digest: [u8; 32] =
                Sha256::digest(format!("receipt.beacon.{idx:04}").as_bytes()).into();
            SeedMaterial::Bytes32(digest)
        } else {
            SeedMaterial::Int64(((idx as i64) - 50) * 1_000_000_007)
        };
        let domain = match idx % 3 {
            0 => "road_event",
            1 => "market_shock",
            _ => "cli",
        };
        let entity = if idx.is_multiple_of(6) {
            format!("caravan:🎲-{idx:02}")
        } else {
            format!("caravan:north-{idx:02}")
        };
        let addr = RollAddress::new(seed, (idx / 3) as u64, domain, entity, (idx % 3) as u64);
        let (outcome, receipt) = evaluate_addressed(&expr, &addr).expect("roll succeeds");
        let canonical_receipt_json = to_canonical_receipt_json(&receipt);
        let receipt_sha256 = encode_hex_lower(&receipt.receipt_sha256);

        valid_receipts.push(ValidReceiptCase {
            index: idx,
            input_expression,
            canonical_receipt_json,
            receipt_sha256,
            total: outcome.total.to_string(),
        });
        base_receipt_structs.push(receipt);
    }

    // 3. 50 adversarial tampered receipts (both un-rehashed and re-hashed forgeries).
    let tampered_receipts = build_50_tampered_receipts(&base_receipt_structs);
    assert_eq!(tampered_receipts.len(), 50);

    // 4. Spec §2.4 10,000-receipt canonical JSON running SHA-256 digest.
    let ten_thousand_receipts_sha256 = compute_10k_receipts_sha256();

    RollsAndReceiptsFile {
        schema_version: "roll.conformance.rolls_receipts.v1",
        canonical_json_cases,
        valid_receipts,
        tampered_receipts,
        ten_thousand_receipts_sha256,
    }
}

fn build_canonical_json_case(description: &'static str, input: Value) -> CanonicalJsonCase {
    let map = input
        .as_object()
        .expect("canonical json test case is object");
    let utf8_key_order: Vec<String> = map.keys().cloned().collect();
    let mut utf16_key_order = utf8_key_order.clone();
    utf16_key_order.sort_by(|a, b| cmp_utf16_code_units(a, b));
    let canonical_json = to_canonical_json(&input).expect("canonicalizes");
    let sha256_hex = encode_hex_lower(&Sha256::digest(canonical_json.as_bytes()));
    CanonicalJsonCase {
        description,
        input,
        utf8_key_order,
        utf16_key_order,
        canonical_json,
        sha256_hex,
    }
}

fn build_50_tampered_receipts(bases: &[RollReceipt]) -> Vec<TamperedReceiptCase> {
    let mut out = Vec::with_capacity(50);

    // Helper that verifies the tampered JSON actually fails with the expected code!
    let mut push_checked = |description: String,
                            tampered_receipt_json: String,
                            expected_error_code: &'static str| {
        let err = verify_receipt_json(&tampered_receipt_json)
            .expect_err("tampered receipt must fail verification");
        let RollError::ReceiptInvalid(ref verify_err) = err else {
            panic!("expected ReceiptInvalid, got {err:?}");
        };
        let actual_code = verify_error_code(verify_err);
        assert_eq!(
            actual_code, expected_error_code,
            "tamper case '{description}' produced '{actual_code}' instead of '{expected_error_code}'"
        );
        let index = out.len();
        out.push(TamperedReceiptCase {
            index,
            description,
            tampered_receipt_json,
            expected_error_code,
        });
    };

    // (A) 3 schema / rules_version tamper cases.
    {
        let mut r = bases[0].clone();
        r.schema_version = String::from("roll.receipt.v0");
        push_checked(
            String::from("unsupported schema_version roll.receipt.v0"),
            to_canonical_receipt_json(&r),
            "unsupported_schema_version",
        );
    }
    {
        let mut r = bases[1].clone();
        r.rules_version = String::from("roll.v2");
        push_checked(
            String::from("top-level rules_version disagrees with address.rules_version"),
            to_canonical_receipt_json(&r),
            "rules_version_mismatch",
        );
    }
    {
        let mut r = bases[2].clone();
        r.rules_version = String::from("roll.v2");
        r.address.rules_version = String::from("roll.v2");
        push_checked(
            String::from("unsupported rules_version roll.v2 in both envelope and address"),
            to_canonical_receipt_json(&r),
            "unsupported_rules_version",
        );
    }

    // (B) 10 un-rehashed single-field mutations -> digest_mismatch.
    for i in 0..10usize {
        let mut r = bases[3 + i].clone();
        match i % 5 {
            0 => r.address.turn += 1,
            1 => r.address.roll_index += 1,
            2 => r.engine_version = String::from("roll-core/9.9.9"),
            3 => r.raw_draws[0] ^= 0x1,
            _ => r.receipt_sha256[31] ^= 0xff,
        }
        push_checked(
            format!("unrehashed mutation #{i} fails integrity digest"),
            to_canonical_receipt_json(&r),
            "digest_mismatch",
        );
    }

    // (C) 8 re-hashed mutated raw_draws words -> prng_stream_mismatch.
    for i in 0..8usize {
        let mut r = bases[13 + i].clone();
        let target_idx = i % r.raw_draws.len();
        r.raw_draws[target_idx] ^= 1u64 << (i * 7);
        r.receipt_sha256 = compute_receipt_sha256(&r).unwrap();
        push_checked(
            format!("rehashed mutated raw_draws[{target_idx}] fails ChaCha12 stream check"),
            to_canonical_receipt_json(&r),
            "prng_stream_mismatch",
        );
    }

    // (D) 6 re-hashed truncated raw_draws -> draw_tape_underflow.
    for i in 0..6usize {
        let mut r = bases[21 + i].clone();
        r.raw_draws.pop();
        r.receipt_sha256 = compute_receipt_sha256(&r).unwrap();
        push_checked(
            format!("rehashed truncated raw_draws case #{i} underflows replay tape"),
            to_canonical_receipt_json(&r),
            "draw_tape_underflow",
        );
    }

    // (E) 6 re-hashed extended raw_draws (genuine next ChaCha12 words appended) -> unconsumed_draws.
    for i in 0..6usize {
        let mut r = bases[27 + i].clone();
        let key = derive_roll_key(&r.address).unwrap();
        let mut stream = ChaCha12Rng::from_seed(key);
        for _ in 0..r.raw_draws.len() {
            let _ = stream.next_u64();
        }
        for _ in 0..=(i % 2) {
            r.raw_draws.push(stream.next_u64());
        }
        r.receipt_sha256 = compute_receipt_sha256(&r).unwrap();
        push_checked(
            format!(
                "rehashed genuine trailing ChaCha12 draw word case #{i} fails exhaustion check"
            ),
            to_canonical_receipt_json(&r),
            "unconsumed_draws",
        );
    }

    // (F) 8 re-hashed result outcome/trace mutations -> result_mismatch.
    for i in 0..8usize {
        let mut r = bases[33 + i].clone();
        {
            let ReceiptResult::Expression {
                ref mut expression_outcome,
            } = r.result;
            match i % 4 {
                0 => expression_outcome.total += 1,
                1 => expression_outcome.groups[0].total -= 1,
                2 => {
                    expression_outcome.groups[0].dice[0].kept =
                        !expression_outcome.groups[0].dice[0].kept;
                }
                _ => expression_outcome.groups[0].dice[0].final_value += 1,
            }
        }
        r.receipt_sha256 = compute_receipt_sha256(&r).unwrap();
        push_checked(
            format!("rehashed forged result/trace field case #{i}"),
            to_canonical_receipt_json(&r),
            "result_mismatch",
        );
    }

    // (G) 2 re-hashed non-canonical spec expressions -> non_canonical_expression.
    for (i, non_canon) in [("1d20", "d20"), ("4d6r=1kh3", "4d6kh3r=1")]
        .into_iter()
        .enumerate()
    {
        let expr = parse(non_canon.0).unwrap();
        let addr = RollAddress::new(SeedMaterial::Int64(900 + i as i64), 1, "cli", "", 0);
        let (_, mut r) = evaluate_addressed(&expr, &addr).unwrap();
        r.spec = ReceiptSpec::Expression {
            canonical_expression: String::from(non_canon.1),
        };
        r.receipt_sha256 = compute_receipt_sha256(&r).unwrap();
        push_checked(
            format!("rehashed non-canonical spec '{}'", non_canon.1),
            to_canonical_receipt_json(&r),
            "non_canonical_expression",
        );
    }

    // (H) 2 re-hashed invalid spec expressions -> invalid_spec_expression.
    for (i, bad_expr) in ["0d6", "1d6min5max2"].into_iter().enumerate() {
        let mut r = bases[41 + i].clone();
        r.spec = ReceiptSpec::Expression {
            canonical_expression: String::from(bad_expr),
        };
        r.receipt_sha256 = compute_receipt_sha256(&r).unwrap();
        push_checked(
            format!("rehashed invalid spec '{bad_expr}'"),
            to_canonical_receipt_json(&r),
            "invalid_spec_expression",
        );
    }

    // (I) 1 re-hashed non-null eligible_weight_total on expression roll -> unexpected_eligible_weight_total.
    {
        let mut r = bases[43].clone();
        r.eligible_weight_total = NonZeroU64::new(36);
        r.receipt_sha256 = compute_receipt_sha256(&r).unwrap();
        push_checked(
            String::from("rehashed non-null eligible_weight_total on expression receipt"),
            to_canonical_receipt_json(&r),
            "unexpected_eligible_weight_total",
        );
    }

    // (J) 1 re-hashed invalid address -> invalid_address.
    {
        let mut r = bases[44].clone();
        r.address.domain = String::from("invalid space");
        r.receipt_sha256 = compute_receipt_sha256(&r).unwrap();
        push_checked(
            String::from("rehashed invalid space in address.domain"),
            to_canonical_receipt_json(&r),
            "invalid_address",
        );
    }

    // (K) 3 malformed JSON / strict encoding rejections -> malformed_json.
    {
        let base_json = to_canonical_receipt_json(&bases[45]);
        let bad_hex = base_json.replacen(
            &encode_hex_lower(&bases[45].receipt_sha256),
            &encode_hex_lower(&bases[45].receipt_sha256).to_ascii_uppercase(),
            1,
        );
        push_checked(
            String::from("uppercase hex in receipt_sha256 rejected"),
            bad_hex,
            "malformed_json",
        );
    }
    {
        let base_json = to_canonical_receipt_json(&bases[46]);
        let leading_zero = base_json.replacen(
            &format!("\"turn\":\"{}\"", bases[46].address.turn),
            "\"turn\":\"01\"",
            1,
        );
        push_checked(
            String::from("non-canonical leading zero in turn string rejected"),
            leading_zero,
            "malformed_json",
        );
    }
    {
        let base_json = to_canonical_receipt_json(&bases[47]);
        let mut injected = base_json;
        injected.pop(); // strip trailing '}'
        injected.push_str(",\"injected_extra\":1}");
        push_checked(
            String::from("unknown top-level JSON property rejected"),
            injected,
            "malformed_json",
        );
    }

    out
}

fn verify_error_code(err: &ReceiptVerifyError) -> &'static str {
    match err {
        ReceiptVerifyError::MalformedJson { .. } => "malformed_json",
        ReceiptVerifyError::UnsupportedSchemaVersion { .. } => "unsupported_schema_version",
        ReceiptVerifyError::RulesVersionMismatch { .. } => "rules_version_mismatch",
        ReceiptVerifyError::UnsupportedRulesVersion { .. } => "unsupported_rules_version",
        ReceiptVerifyError::InvalidAddress { .. } => "invalid_address",
        ReceiptVerifyError::DigestMismatch { .. } => "digest_mismatch",
        ReceiptVerifyError::UnsupportedKind { .. } => "unsupported_kind",
        ReceiptVerifyError::UnexpectedEligibleWeightTotal => "unexpected_eligible_weight_total",
        ReceiptVerifyError::InvalidSpecExpression { .. } => "invalid_spec_expression",
        ReceiptVerifyError::NonCanonicalExpression { .. } => "non_canonical_expression",
        ReceiptVerifyError::PrngStreamMismatch { .. } => "prng_stream_mismatch",
        ReceiptVerifyError::DrawTapeUnderflow { .. } => "draw_tape_underflow",
        ReceiptVerifyError::UnconsumedDraws { .. } => "unconsumed_draws",
        ReceiptVerifyError::ExecutionError { .. } => "execution_error",
        ReceiptVerifyError::ResultMismatch => "result_mismatch",
    }
}

fn format_stats_fixture(stats: &DistributionStats) -> StatsFixture {
    let mut percentiles = BTreeMap::new();
    for (&k, &v) in &stats.percentiles {
        percentiles.insert(k.to_string(), v.to_string());
    }
    StatsFixture {
        min: stats.min.to_string(),
        max: stats.max.to_string(),
        mean: stats.mean,
        median: stats.median.to_string(),
        mode: stats.mode.to_string(),
        stddev: stats.stddev,
        percentiles,
        entropy: stats.entropy,
    }
}

fn sample_curve_anchors(curve: &[(i64, f64)], max_points: usize) -> Vec<PmfEntryFixture> {
    if curve.len() <= max_points {
        return curve
            .iter()
            .map(|&(v, p)| PmfEntryFixture {
                outcome: v.to_string(),
                probability: p,
            })
            .collect();
    }
    let last = curve.len() - 1;
    let mut indices = Vec::with_capacity(max_points);
    for step in 0..max_points {
        let idx = (step * last) / (max_points - 1);
        if indices.last().copied() != Some(idx) {
            indices.push(idx);
        }
    }
    if indices.last().copied() != Some(last) {
        indices.push(last);
    }
    indices
        .into_iter()
        .map(|idx| {
            let (v, p) = curve[idx];
            PmfEntryFixture {
                outcome: v.to_string(),
                probability: p,
            }
        })
        .collect()
}

fn classify_analyze_error(err: &RollError) -> &'static str {
    match err {
        RollError::DivisionByZero => "division_by_zero",
        RollError::AnalysisBudgetExceeded { .. } => "analysis_budget_exceeded",
        RollError::ArithmeticOverflow => "arithmetic_overflow",
        RollError::InvalidProbability { .. } => "invalid_probability",
        _ => "other",
    }
}

fn build_04_exact_analysis() -> ExactAnalysisFile {
    const ANALYZE_INPUTS: &[(&str, &str)] = &[
        ("standard 2d6 sum", "2d6"),
        ("classic ability roll 4d6kh3", "4d6kh3"),
        ("combined reroll + standard explode 2d6r=1!", "2d6r=1!"),
        (
            "combined reroll-once + clamp + explode 2d4ro=1min2!",
            "2d4ro=1min2!",
        ),
        (
            "combined capped reroll + keep-highest 3d4r=1kh2",
            "3d4r=1kh2",
        ),
        ("capped binary explosion 1d2!", "1d2!"),
        ("capped reroll residual 1d100r<=99", "1d100r<=99"),
        ("underflowed reachable support 5d20r=1", "5d20r=1"),
        (
            "every-face explosion hits MAX_EXPLOSIONS 1d6!>=1",
            "1d6!>=1",
        ),
        (
            "every-face reroll hits MAX_REROLLS uniformly 1d6r>=1",
            "1d6r>=1",
        ),
        ("unmatched reroll threshold reports no cap 1d6r=7", "1d6r=7"),
        (
            "clamped depth-0 single explosion without cap 1d6min7!>=7",
            "1d6min7!>=7",
        ),
        (
            "penetrate explosion floor and raw-face threshold 1d2!p",
            "1d2!p",
        ),
        ("order-statistic DP wide keep-highest 10d20kh3", "10d20kh3"),
        (
            "order-statistic DP chained drop-lowest/highest 6d6dl1dh1",
            "6d6dl1dh1",
        ),
        ("compounding explosion + keep-highest 4d6!!kh3", "4d6!!kh3"),
        ("empty rank interval keep-zero 4d6kh0", "4d6kh0"),
        ("exploding pool success count 8d6!cs>=5", "8d6!cs>=5"),
        ("penetrating pool success count 8d6!pcs>=5", "8d6!pcs>=5"),
        ("compounding pool success count 4d6!!cs>=10", "4d6!!cs>=10"),
        ("pool critical failure subtraction 10d6cf<=1", "10d6cf<=1"),
        ("Fate reroll 4dFr=-1", "4dFr=-1"),
        (
            "exact non-constant multiplication (1d6)*(1d6)",
            "(1d6)*(1d6)",
        ),
        (
            "exact floor division over non-zero support 1d6/(1d2!-22)",
            "1d6/(1d2!-22)",
        ),
        (
            "D&D ability modifier floor division (4d6kh3-10)/2",
            "(4d6kh3-10)/2",
        ),
        (
            "Monte Carlo fallback for standard explode + keep-highest 4d6!kh3",
            "4d6!kh3",
        ),
        (
            "Monte Carlo fallback when support product exceeds MAX_EXACT_STATES 12d1000",
            "12d1000",
        ),
    ];

    const QUERY_PROBS: [f64; 5] = [0.05, 0.25, 0.5, 0.75, 0.95];

    let mut analyze_cases = Vec::with_capacity(ANALYZE_INPUTS.len());
    for &(description, expression) in ANALYZE_INPUTS {
        let ast = parse(expression).expect("valid analyze fixture expression");
        let canonical_expression = ast.to_canonical_string();
        let report = analyze(&ast).expect("analyze fixture succeeds");
        let support_len = report.distribution.len();
        let pmf = if support_len <= 200 {
            report
                .distribution
                .entries()
                .iter()
                .map(|&(v, p)| PmfEntryFixture {
                    outcome: v.to_string(),
                    probability: p,
                })
                .collect()
        } else {
            Vec::new()
        };
        let cdf_samples = sample_curve_anchors(&report.distribution.cdf(), 16);
        let survival_samples = sample_curve_anchors(&report.distribution.survival(), 16);
        let mut target_queries = Vec::with_capacity(QUERY_PROBS.len());
        for &probability in &QUERY_PROBS {
            let at_least = report
                .distribution
                .target_for_probability(probability, TargetDirection::AtLeast)
                .expect("valid query probability");
            let at_most = report
                .distribution
                .target_for_probability(probability, TargetDirection::AtMost)
                .expect("valid query probability");
            target_queries.push(TargetQueryFixture {
                probability,
                at_least: at_least.to_string(),
                at_most: at_most.to_string(),
            });
        }

        analyze_cases.push(AnalyzeFixtureCase {
            description,
            expression,
            canonical_expression,
            method: report.method,
            support_len,
            stats: format_stats_fixture(&report.stats),
            pmf,
            cdf_samples,
            survival_samples,
            target_queries,
        });
    }

    const COMPARE_INPUTS: &[(&str, &str, &str)] = &[
        (
            "exact margin convolution 4d6kh3 vs 3d6+2",
            "4d6kh3",
            "3d6+2",
        ),
        (
            "exact margin with merged caps 2d6r=1! vs 3d6",
            "2d6r=1!",
            "3d6",
        ),
        (
            "symmetric two-pointer fallback without margin 100d100 vs 100d100",
            "100d100",
            "100d100",
        ),
        ("Monte Carlo comparison 4d6!kh3 vs 3d6", "4d6!kh3", "3d6"),
    ];

    let mut compare_cases = Vec::with_capacity(COMPARE_INPUTS.len());
    for &(description, left_expression, right_expression) in COMPARE_INPUTS {
        let left_ast = parse(left_expression).expect("valid left compare fixture");
        let right_ast = parse(right_expression).expect("valid right compare fixture");
        let cmp = compare(&left_ast, &right_ast).expect("compare fixture succeeds");
        compare_cases.push(CompareFixtureCase {
            description,
            left_expression,
            right_expression,
            method: cmp.method,
            p_left_greater: cmp.p_left_greater,
            p_equal: cmp.p_equal,
            p_right_greater: cmp.p_right_greater,
            mean_margin: cmp.mean_margin,
            has_exact_margin: cmp.margin.is_some(),
            margin_support_len: cmp.margin.as_ref().map(crate::analyze::Distribution::len),
        });
    }

    const ERROR_INPUTS: &[(&str, &str, &str)] = &[
        (
            "literal division by zero 1d6/0",
            "1d6/0",
            "division_by_zero",
        ),
        (
            "reachable zero in simple divisor 1d6/(1d2-1)",
            "1d6/(1d2-1)",
            "division_by_zero",
        ),
        (
            "§5.4 case 1 capped reroll residual zero 1d6/(1d100r<=99-50)",
            "1d6/(1d100r<=99-50)",
            "division_by_zero",
        ),
        (
            "§5.4 underflowed f64 zero probability 1d6/(5d20r=1-5)",
            "1d6/(5d20r=1-5)",
            "division_by_zero",
        ),
        (
            "§5.4 case 2 divisor checked before oversized dividend 500d1000/(5d20-5)",
            "500d1000/(5d20-5)",
            "division_by_zero",
        ),
        (
            "§5.4 branch isolation across oversized sibling (1d6/(5d20-5))+500d1000",
            "(1d6/(5d20-5))+500d1000",
            "division_by_zero",
        ),
        (
            "§5.4 case 4 Monte Carlo divisor hits zero 1d6/(4d6!kh3-12)",
            "1d6/(4d6!kh3-12)",
            "division_by_zero",
        ),
        (
            "single-group analysis budget exceeded 1001d6",
            "1001d6",
            "analysis_budget_exceeded",
        ),
        (
            "multi-group analysis budget exceeded 600d6+401d6",
            "600d6+401d6",
            "analysis_budget_exceeded",
        ),
        (
            "unary negation overflow in analyzer -(-9223372036854775808)",
            "-(-9223372036854775808)",
            "arithmetic_overflow",
        ),
        (
            "shift addition overflow in analyzer 9223372036854775807+1d6",
            "9223372036854775807+1d6",
            "arithmetic_overflow",
        ),
        (
            "i64::MIN / -1 floor division overflow in analyzer (-9223372036854775808)/-1",
            "(-9223372036854775808)/-1",
            "arithmetic_overflow",
        ),
    ];

    let mut error_cases = Vec::with_capacity(ERROR_INPUTS.len());
    for &(description, expression, expected_error_kind) in ERROR_INPUTS {
        let ast = parse(expression).expect("error fixture expression parses");
        let err = analyze(&ast).expect_err("error fixture must fail in analyze");
        let actual_kind = classify_analyze_error(&err);
        assert_eq!(
            actual_kind, expected_error_kind,
            "unexpected error kind for {expression}: {err}"
        );
        error_cases.push(AnalyzeErrorFixtureCase {
            description,
            expression,
            expected_error_kind: actual_kind,
        });
    }

    ExactAnalysisFile {
        schema_version: "roll.conformance.exact_analysis.v1",
        analyze_cases,
        compare_cases,
        error_cases,
    }
}
