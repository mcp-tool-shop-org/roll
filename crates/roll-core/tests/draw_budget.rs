#![forbid(unsafe_code)]

use core::num::NonZeroU64;
use std::time::Instant;

use rand_chacha::ChaCha12Rng;
use rand_core::{Rng, SeedableRng};
use roll_core::{
    DEFAULT_MONTE_CARLO_SAMPLES, MAX_EXPRESSION_BYTES, MAX_TOTAL_DRAWS, RECEIPT_SCHEMA_VERSION,
    ReceiptResult, ReceiptSpec, ReceiptVerifyError, RollAddress, RollError, RollReceipt, RollRng,
    SeedMaterial, analyze, compute_receipt_sha256, derive_roll_key, evaluate_addressed,
    evaluate_with_rng, evaluate_with_tape, lemire_witness_word, monte_carlo_distribution, parse,
    verify_receipt,
};

#[test]
fn stacked_reroll_dos_expressions_fail_fast_at_max_total_draws() {
    use core::error::Error as _;

    // 1. Brief problem case: `10000d1` + `r=1` x 330 (997 bytes; requests ~3.3e8 draws without budget).
    let expr_330_str = format!("10000d1{}", "r=1".repeat(330));
    assert_eq!(expr_330_str.len(), 997);
    let expr_330 = parse(&expr_330_str).expect("997-byte stacked reroll expression parses");

    let addr = RollAddress::new(SeedMaterial::Int64(42), 0, "dos_test", "", 0);
    let t0 = Instant::now();
    let res_330 = evaluate_addressed(&expr_330, &addr);
    let elapsed_330 = t0.elapsed();
    let err_330 = res_330.expect_err("10000d1 + r=1 x 330 must fail at MAX_TOTAL_DRAWS");
    assert_eq!(
        err_330,
        RollError::DrawBudgetExceeded {
            limit: MAX_TOTAL_DRAWS,
        }
    );
    assert!(err_330.source().is_none());
    assert_eq!(
        err_330.to_string(),
        format!("evaluation exceeded maximum draw budget of {MAX_TOTAL_DRAWS} RNG draws")
    );
    assert!(
        elapsed_330.as_secs() < 15,
        "10000d1 + r=1 x 330 took too long: {elapsed_330:?}"
    );
    println!("timing 10000d1 + r=1 x 330 (997B): {elapsed_330:?}");

    // Confirm raw RNG log stops strictly at `MAX_TOTAL_DRAWS` (checked before taking draw `limit + 1`).
    let mut rng = RollRng::from_address(&addr).unwrap();
    assert_eq!(
        evaluate_with_rng(&expr_330, &mut rng),
        Err(RollError::DrawBudgetExceeded {
            limit: MAX_TOTAL_DRAWS,
        })
    );
    assert_eq!(rng.draws().len(), MAX_TOTAL_DRAWS as usize);

    // 2. Longest `r=1` form fitting `MAX_EXPRESSION_BYTES = 1,000`: `10000d1` + `r=1` x 331 (1,000 bytes).
    let expr_331_str = format!("10000d1{}", "r=1".repeat(331));
    assert_eq!(expr_331_str.len(), MAX_EXPRESSION_BYTES);
    let expr_331 = parse(&expr_331_str).expect("1000-byte r=1 x 331 expression parses");
    let t1 = Instant::now();
    let res_331 = evaluate_addressed(&expr_331, &addr);
    let elapsed_331 = t1.elapsed();
    assert_eq!(
        res_331,
        Err(RollError::DrawBudgetExceeded {
            limit: MAX_TOTAL_DRAWS,
        })
    );
    assert!(
        elapsed_331.as_secs() < 15,
        "10000d1 + r=1 x 331 took too long: {elapsed_331:?}"
    );
    println!("timing 10000d1 + r=1 x 331 (1000B): {elapsed_331:?}");

    // 3. Longest bare-`r` form fitting `MAX_EXPRESSION_BYTES = 1,000`: `10000d1` + `r` x 993 (1,000 bytes; ~9.93e8 draws).
    let expr_993_str = format!("10000d1{}", "r".repeat(993));
    assert_eq!(expr_993_str.len(), MAX_EXPRESSION_BYTES);
    let expr_993 = parse(&expr_993_str).expect("1000-byte bare r x 993 expression parses");
    let t2 = Instant::now();
    let res_993 = evaluate_addressed(&expr_993, &addr);
    let elapsed_993 = t2.elapsed();
    assert_eq!(
        res_993,
        Err(RollError::DrawBudgetExceeded {
            limit: MAX_TOTAL_DRAWS,
        })
    );
    assert!(
        elapsed_993.as_secs() < 15,
        "10000d1 + r x 993 took too long: {elapsed_993:?}"
    );
    println!("timing 10000d1 + r x 993 (1000B): {elapsed_993:?}");
}

#[test]
fn legitimate_single_modifier_worst_cases_pass_on_live_and_forced_rng() {
    let addr = RollAddress::new(SeedMaterial::Int64(7), 1, "worst_case", "", 0);

    // 1a. `10000d6r=1ro=1!` on live addressed ChaCha12Rng (including full receipt verification).
    let one_of_each = parse("10000d6r=1ro=1!").unwrap();
    let t_live = Instant::now();
    let (out_live, receipt_live) =
        evaluate_addressed(&one_of_each, &addr).expect("10000d6r=1ro=1! must succeed");
    let elapsed_live = t_live.elapsed();
    assert!(receipt_live.raw_draws.len() <= MAX_TOTAL_DRAWS as usize);
    assert!(out_live.total >= 20_000);
    verify_receipt(&receipt_live).expect("10000d6r=1ro=1! receipt must verify");
    println!(
        "timing 10000d6r=1ro=1! (live RNG, {} draws): {elapsed_live:?}",
        receipt_live.raw_draws.len()
    );

    // 1b. `10000d6r=1ro=1!` with a FORCED worst-case RNG exercising all 2,020,000 draws:
    //     - Stage 1: 10,000 rolls of face `1`
    //     - Stage 2a (`r=1`): 1,000,000 rerolls of face `1` (100 per die)
    //     - Stage 2b (`ro=1`): 10,000 rerolls landing on face `6` (1 per die, triggering Stage 4 `!`)
    //     - Stage 4 (`!`): 1,000,000 explosions landing on face `6` (100 per die)
    let span6 = NonZeroU64::new(6).unwrap();
    let word_face_1 = lemire_witness_word(span6, 0);
    let word_face_6 = lemire_witness_word(span6, 5);
    let mut forced_6_tape = Vec::with_capacity(2_020_000);
    forced_6_tape.resize(10_000 + 1_000_000, word_face_1);
    forced_6_tape.resize(10_000 + 1_000_000 + 10_000 + 1_000_000, word_face_6);
    assert_eq!(forced_6_tape.len(), 2_020_000);

    let t_forced_6 = Instant::now();
    let (out_forced_6, consumed_6) = evaluate_with_tape(&one_of_each, &forced_6_tape)
        .expect("forced 2,020,000-draw worst case on 10000d6r=1ro=1! must pass");
    let elapsed_forced_6 = t_forced_6.elapsed();
    assert_eq!(consumed_6, 2_020_000);
    assert_eq!(out_forced_6.total, 10_000 * 101 * 6);
    assert_eq!(out_forced_6.groups[0].dice.len(), 1_010_000);
    assert_eq!(out_forced_6.groups[0].dice[0].rerolls.len(), 101);
    assert_eq!(out_forced_6.groups[0].dice[0].explosions.len(), 100);
    println!("timing 10000d6r=1ro=1! (forced 2,020,000-draw tape): {elapsed_forced_6:?}");

    // 2. `10000d6!>=1` (every die explodes to `MAX_EXPLOSIONS = 100` -> 1,010,000 draws).
    let explode_all = parse("10000d6!>=1").unwrap();
    let mut rng_exp = RollRng::from_address(&addr).unwrap();
    let t_exp = Instant::now();
    let out_exp =
        evaluate_with_rng(&explode_all, &mut rng_exp).expect("10000d6!>=1 must pass budget");
    let elapsed_exp = t_exp.elapsed();
    assert_eq!(rng_exp.draws().len(), 1_010_000);
    assert_eq!(out_exp.groups[0].dice.len(), 1_010_000);
    println!("timing 10000d6!>=1 (1,010,000 draws): {elapsed_exp:?}");

    // 3. `10000d2r=1` with a forced worst-case RNG (`0u64` maps to face `1` with zero Lemire retries -> 1,010,000 draws).
    let reroll_d2 = parse("10000d2r=1").unwrap();
    let forced_d2_tape = vec![0u64; 1_010_000];
    let t_d2 = Instant::now();
    let (out_d2, consumed_d2) = evaluate_with_tape(&reroll_d2, &forced_d2_tape)
        .expect("10000d2r=1 with forced worst-case RNG must pass");
    let elapsed_d2 = t_d2.elapsed();
    assert_eq!(consumed_d2, 1_010_000);
    assert_eq!(out_d2.total, 10_000);
    assert_eq!(out_d2.groups[0].dice.len(), 10_000);
    assert!(out_d2.groups[0].dice.iter().all(|d| d.rerolls.len() == 100));
    println!("timing 10000d2r=1 (forced 1,010,000-draw tape): {elapsed_d2:?}");
}

#[test]
fn near_miss_exact_budget_passes_and_one_draw_more_fails() {
    let addr = RollAddress::new(SeedMaterial::Int64(99), 0, "boundary", "", 0);

    // 1. One draw under `MAX_TOTAL_DRAWS`: 9,999 * 210 + 1 * 209 = 2,099,790 + 209 = 2,099,999 draws.
    let under_by_1 = parse(
        "9999d1r=1r=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1+1d1r=1r=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1",
    )
    .unwrap();
    let mut rng_under = RollRng::from_address(&addr).unwrap();
    let t_under = Instant::now();
    let out_under = evaluate_with_rng(&under_by_1, &mut rng_under)
        .expect("2,099,999 draws (limit - 1) must pass");
    let elapsed_under = t_under.elapsed();
    assert_eq!(out_under.total, 10_000);
    assert_eq!(rng_under.draws().len(), (MAX_TOTAL_DRAWS - 1) as usize);
    println!("timing near-miss 2,099,999 draws (limit - 1): {elapsed_under:?}");

    // 2. Exact budget `MAX_TOTAL_DRAWS`: 9,999 * 210 + 1 * 210 = 2,100,000 draws.
    let exact_limit = parse(
        "9999d1r=1r=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1+1d1r=1r=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1",
    )
    .unwrap();
    let mut rng_exact = RollRng::from_address(&addr).unwrap();
    let t_exact = Instant::now();
    let out_exact = evaluate_with_rng(&exact_limit, &mut rng_exact)
        .expect("exact 2,100,000 draws (limit) must pass");
    let elapsed_exact = t_exact.elapsed();
    assert_eq!(out_exact.total, 10_000);
    assert_eq!(rng_exact.draws().len(), MAX_TOTAL_DRAWS as usize);
    println!("timing exact budget 2,100,000 draws (limit): {elapsed_exact:?}");

    // 3. One draw over `MAX_TOTAL_DRAWS`: 9,999 * 210 + 1 * 211 = 2,099,790 + 211 = 2,100,001 draws.
    let over_by_1 = parse(
        "9999d1r=1r=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1+1d1r=1r=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1",
    )
    .unwrap();
    let mut rng_over = RollRng::from_address(&addr).unwrap();
    let t_over = Instant::now();
    let err_over = evaluate_with_rng(&over_by_1, &mut rng_over)
        .expect_err("2,100,001 draws (limit + 1) must fail");
    let elapsed_over = t_over.elapsed();
    assert_eq!(
        err_over,
        RollError::DrawBudgetExceeded {
            limit: MAX_TOTAL_DRAWS,
        }
    );
    // Checked BEFORE taking the 2,100,001-st draw.
    assert_eq!(rng_over.draws().len(), MAX_TOTAL_DRAWS as usize);
    println!("timing over-by-1 2,100,001 draws (limit + 1): {elapsed_over:?}");
}

#[test]
fn multi_group_shared_counter_rejects_combined_over_budget_expression() {
    let addr = RollAddress::new(SeedMaterial::Int64(123), 0, "multigroup", "", 0);

    // Each 5,000-die group takes 5,000 * (1 + 200 + 11) = 1,060,000 draws (< 2,100,000).
    let half_group_str = "5000d1r=1r=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1ro=1";
    let single_half = parse(half_group_str).unwrap();
    let mut rng_half = RollRng::from_address(&addr).unwrap();
    let t_half = Instant::now();
    let out_half =
        evaluate_with_rng(&single_half, &mut rng_half).expect("single 1,060,000-draw group passes");
    let elapsed_half = t_half.elapsed();
    assert_eq!(out_half.total, 5_000);
    assert_eq!(rng_half.draws().len(), 1_060_000);

    // Together in one expression (`5000 + 5000 = 10,000` dice), they request `2,120,000 > 2,100,000` draws.
    let combined_str = format!("{half_group_str}+{half_group_str}");
    let combined = parse(&combined_str).unwrap();
    let mut rng_combined = RollRng::from_address(&addr).unwrap();
    let t_comb = Instant::now();
    assert_eq!(
        evaluate_with_rng(&combined, &mut rng_combined),
        Err(RollError::DrawBudgetExceeded {
            limit: MAX_TOTAL_DRAWS,
        })
    );
    let elapsed_comb = t_comb.elapsed();
    assert_eq!(rng_combined.draws().len(), MAX_TOTAL_DRAWS as usize);
    println!("timing multi-group single={elapsed_half:?}, combined-over-budget={elapsed_comb:?}");
}

#[test]
fn hand_built_receipt_claiming_more_draws_than_budget_fails_verification_with_named_error() {
    let addr = RollAddress::new(SeedMaterial::Int64(555), 2, "forged_budget", "entity:1", 0);
    let over_limit_len = (MAX_TOTAL_DRAWS as usize) + 1;

    // Case A: `raw_draws.len() > MAX_TOTAL_DRAWS` (`2,100,001`) with bogus draw words and zeroed
    // `receipt_sha256` MUST be refused immediately with `ReceiptVerifyError::DrawBudgetExceeded`
    // BEFORE `compute_receipt_sha256` or any `ChaCha12Rng` walk (`DigestMismatch` / `PrngStreamMismatch`
    // would fire instead if hashing or ChaCha ran first).
    let (_, valid_1d6) = evaluate_addressed(&parse("1d6").unwrap(), &addr).unwrap();
    let ReceiptResult::Expression { expression_outcome } = valid_1d6.result;
    let bogus_over_budget = RollReceipt {
        address: addr.clone(),
        eligible_weight_total: None,
        engine_version: String::from(roll_core::ENGINE_VERSION),
        raw_draws: vec![0xdead_beef_cafe_babe; over_limit_len],
        receipt_sha256: [0u8; 32],
        result: ReceiptResult::Expression {
            expression_outcome: expression_outcome.clone(),
        },
        rules_version: addr.rules_version.clone(),
        schema_version: String::from(RECEIPT_SCHEMA_VERSION),
        spec: ReceiptSpec::Expression {
            canonical_expression: String::from("1d6"),
        },
    };

    let t_verify_fast = Instant::now();
    assert_eq!(
        verify_receipt(&bogus_over_budget),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::DrawBudgetExceeded {
                total: over_limit_len,
                limit: MAX_TOTAL_DRAWS,
            }
        ))
    );
    let elapsed_fast = t_verify_fast.elapsed();
    assert!(
        elapsed_fast.as_millis() < 50,
        "over-limit raw_draws check must reject in O(1) before hashing/ChaCha, took {elapsed_fast:?}"
    );

    // Case B: Even with genuine ChaCha12 words and a valid `receipt_sha256`, `2,100,001` draws is
    // refused upfront with `ReceiptVerifyError::DrawBudgetExceeded`.
    let key = derive_roll_key(&addr).unwrap();
    let mut stream = ChaCha12Rng::from_seed(key);
    let genuine_draws: Vec<u64> = (0..over_limit_len).map(|_| stream.next_u64()).collect();
    let mut signed_over_budget = bogus_over_budget;
    signed_over_budget.raw_draws = genuine_draws;
    signed_over_budget.receipt_sha256 = compute_receipt_sha256(&signed_over_budget).unwrap();
    assert_eq!(
        verify_receipt(&signed_over_budget),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::DrawBudgetExceeded {
                total: over_limit_len,
                limit: MAX_TOTAL_DRAWS,
            }
        ))
    );

    // Case C: At exactly `MAX_TOTAL_DRAWS` (`2,100,000 <= MAX_TOTAL_DRAWS`), the length pre-check
    // passes and replay catches trailing unconsumed words on `"1d6"` -> `UnconsumedDraws`.
    let exact_limit_len = MAX_TOTAL_DRAWS as usize;
    let mut exact_limit_receipt = signed_over_budget;
    exact_limit_receipt.raw_draws.truncate(exact_limit_len);
    exact_limit_receipt.result = ReceiptResult::Expression { expression_outcome };
    exact_limit_receipt.receipt_sha256 = compute_receipt_sha256(&exact_limit_receipt).unwrap();

    let t_verify_c = Instant::now();
    assert_eq!(
        verify_receipt(&exact_limit_receipt),
        Err(RollError::ReceiptInvalid(
            ReceiptVerifyError::UnconsumedDraws {
                consumed: 1,
                total: exact_limit_len,
            }
        ))
    );
    let elapsed_verify_c = t_verify_c.elapsed();
    println!(
        "timing verify_receipt budget boundary: DrawBudgetExceeded={elapsed_fast:?}, exact-limit UnconsumedDraws={elapsed_verify_c:?}"
    );
}

#[test]
fn analyzer_monte_carlo_surfaces_draw_budget_error_without_100k_retries() {
    // 1,000 dice (within `MAX_ANALYZE_DICE = 1_000`), `!kh1` routes to Monte Carlo (`§5.1`),
    // and 21 `r>=1` modifiers force `1,000 * (1 + 2,100) = 2,101,000 > MAX_TOTAL_DRAWS` on sample 0.
    let mc_over_str = format!("1000d2{}!kh1", "r>=1".repeat(21));
    let mc_over = parse(&mc_over_str).unwrap();

    let t0 = Instant::now();
    let res = analyze(&mc_over);
    let elapsed = t0.elapsed();
    assert_eq!(
        res,
        Err(RollError::DrawBudgetExceeded {
            limit: MAX_TOTAL_DRAWS,
        })
    );
    assert!(
        elapsed.as_secs() < 15,
        "analyze() Monte Carlo path must abort on sample 0, not retry 100k times: {elapsed:?}"
    );
    println!("timing analyze() Monte Carlo over-budget abort (sample 0): {elapsed:?}");

    assert_eq!(
        monte_carlo_distribution(&mc_over, DEFAULT_MONTE_CARLO_SAMPLES),
        Err(RollError::DrawBudgetExceeded {
            limit: MAX_TOTAL_DRAWS,
        })
    );

    // Multi-group Monte Carlo expression: each 500-die half uses ~1,050,500 draws (< 2,100,000),
    // together in one evaluation they exceed `MAX_TOTAL_DRAWS`.
    let half_mc = format!("500d2{}!kh1", "r>=1".repeat(21));
    assert!(monte_carlo_distribution(&parse(&half_mc).unwrap(), 1).is_ok());
    let both_mc = parse(&format!("{half_mc}+{half_mc}")).unwrap();
    assert_eq!(
        analyze(&both_mc),
        Err(RollError::DrawBudgetExceeded {
            limit: MAX_TOTAL_DRAWS,
        })
    );
}
