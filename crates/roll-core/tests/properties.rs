#![forbid(unsafe_code)]

use core::num::{NonZeroU32, NonZeroU64};
use proptest::prelude::*;
use proptest::test_runner::FileFailurePersistence;
use roll_core::{
    AnalysisMethod, BinaryOp, ClampBounds, CompareOp, ComparePoint, DiceSides, DiceSpec,
    ExplosionRule, ExplosionVariant, Expr, KeepDropOp, ReceiptVerifyError, ResultMode, RollAddress,
    RollError, RollRng, SeedMaterial, SortOrder, TargetDirection, analyze, compute_receipt_sha256,
    evaluate_addressed, lemire_sample_from_tape,
    math::{log2_f64, sqrt_f64},
    parse, to_canonical_receipt_json, verify_receipt, verify_receipt_json,
};

fn proptest_cfg() -> ProptestConfig {
    ProptestConfig {
        cases: 256,
        failure_persistence: Some(Box::new(FileFailurePersistence::Off)),
        ..ProptestConfig::default()
    }
}

fn arb_compare_op() -> impl Strategy<Value = CompareOp> {
    prop_oneof![
        Just(CompareOp::Eq),
        Just(CompareOp::Gt),
        Just(CompareOp::Gte),
        Just(CompareOp::Lt),
        Just(CompareOp::Lte),
    ]
}

fn arb_compare_point() -> impl Strategy<Value = ComparePoint> {
    (arb_compare_op(), -20i64..=100i64).prop_map(|(op, value)| ComparePoint { op, value })
}

fn arb_dice_sides() -> impl Strategy<Value = DiceSides> {
    prop_oneof![
        (1u32..=1000u32).prop_map(|n| DiceSides::Standard(NonZeroU32::new(n).unwrap())),
        Just(DiceSides::Percentile),
        Just(DiceSides::Fate),
    ]
}

fn arb_clamp() -> impl Strategy<Value = Option<ClampBounds>> {
    prop_oneof![
        Just(None),
        (-10i64..=50i64).prop_map(|lo| Some(ClampBounds {
            min: Some(lo),
            max: None,
        })),
        (-10i64..=50i64).prop_map(|hi| Some(ClampBounds {
            min: None,
            max: Some(hi),
        })),
        (-10i64..=50i64, 0i64..=50i64).prop_map(|(lo, delta)| Some(ClampBounds {
            min: Some(lo),
            max: Some(lo + delta),
        })),
    ]
}

fn arb_keep_drop() -> impl Strategy<Value = KeepDropOp> {
    prop_oneof![
        (0u32..=10u32).prop_map(KeepDropOp::KeepHighest),
        (0u32..=10u32).prop_map(KeepDropOp::KeepLowest),
        (0u32..=10u32).prop_map(KeepDropOp::DropHighest),
        (0u32..=10u32).prop_map(KeepDropOp::DropLowest),
    ]
}

fn arb_result_mode() -> impl Strategy<Value = ResultMode> {
    prop_oneof![
        (any::<bool>(), any::<bool>()).prop_map(|(crit_success_max, crit_failure_min)| {
            ResultMode::Sum {
                crit_success_max,
                crit_failure_min,
            }
        }),
        (
            prop::collection::vec(arb_compare_point(), 1..=2),
            prop::collection::vec(arb_compare_point(), 0..=2),
        )
            .prop_map(|(cs, cf)| ResultMode::Pool { cs, cf }),
        prop::collection::vec(arb_compare_point(), 1..=2)
            .prop_map(|cf| ResultMode::Pool { cs: Vec::new(), cf }),
    ]
}

fn arb_sort() -> impl Strategy<Value = Option<SortOrder>> {
    prop_oneof![
        Just(None),
        Just(Some(SortOrder::Asc)),
        Just(Some(SortOrder::Desc)),
    ]
}

fn arb_dice_spec(max_count: u32) -> impl Strategy<Value = DiceSpec> {
    (
        1u32..=max_count,
        arb_dice_sides(),
        prop::collection::vec(arb_compare_point(), 0..=2),
        prop::collection::vec(arb_compare_point(), 0..=2),
        arb_clamp(),
        prop::option::of((
            prop_oneof![
                Just(ExplosionVariant::Standard),
                Just(ExplosionVariant::Compound),
                Just(ExplosionVariant::Penetrate),
            ],
            arb_compare_point(),
        )),
        prop::collection::vec(arb_keep_drop(), 0..=2),
        arb_result_mode(),
        arb_sort(),
    )
        .prop_map(
            |(
                count_raw,
                sides,
                reroll_unlimited,
                reroll_once,
                clamp,
                explode_raw,
                keep_drop,
                mode,
                sort,
            )| {
                let explode = if sides == DiceSides::Fate {
                    None
                } else {
                    explode_raw.map(|(variant, threshold)| ExplosionRule { variant, threshold })
                };
                DiceSpec {
                    count: NonZeroU32::new(count_raw).unwrap(),
                    sides,
                    reroll_unlimited,
                    reroll_once,
                    clamp,
                    explode,
                    keep_drop,
                    mode,
                    sort,
                }
            },
        )
}

fn arb_roundtrip_expr() -> impl Strategy<Value = Expr> {
    let leaf = prop_oneof![
        prop_oneof![
            Just(i64::MIN),
            Just(i64::MAX),
            Just(-1i64),
            Just(0i64),
            Just(1i64),
            any::<i64>(),
        ]
        .prop_map(Expr::Number),
        arb_dice_spec(50).prop_map(Expr::Dice),
    ];
    leaf.prop_recursive(4, 16, 2, |inner| {
        prop_oneof![
            inner.clone().prop_map(|e| Expr::UnaryNeg(Box::new(e))),
            (
                prop_oneof![
                    Just(BinaryOp::Add),
                    Just(BinaryOp::Sub),
                    Just(BinaryOp::Mul),
                    Just(BinaryOp::DivFloor),
                ],
                inner.clone(),
                inner,
            )
                .prop_map(|(op, left, right)| Expr::Binary {
                    op,
                    left: Box::new(left),
                    right: Box::new(right),
                }),
        ]
    })
}

/// Safe evaluable expression strategy (avoids division by zero and i64 overflow so every roll yields a receipt).
fn arb_evaluable_expr() -> impl Strategy<Value = Expr> {
    let safe_dice = (
        1u32..=6u32,
        prop_oneof![
            (2u32..=20u32).prop_map(|n| DiceSides::Standard(NonZeroU32::new(n).unwrap())),
            Just(DiceSides::Percentile),
            Just(DiceSides::Fate),
        ],
        prop::collection::vec(
            (arb_compare_op(), -2i64..=20i64).prop_map(|(op, value)| ComparePoint { op, value }),
            0..=1,
        ),
        arb_clamp(),
        prop::collection::vec(arb_keep_drop(), 0..=1),
        arb_result_mode(),
        arb_sort(),
    )
        .prop_map(|(c, sides, reroll_once, clamp, keep_drop, mode, sort)| {
            Expr::Dice(DiceSpec {
                count: NonZeroU32::new(c).unwrap(),
                sides,
                reroll_unlimited: Vec::new(),
                reroll_once,
                clamp,
                explode: None,
                keep_drop,
                mode,
                sort,
            })
        });

    let leaf = prop_oneof![(1i64..=100i64).prop_map(Expr::Number), safe_dice];
    leaf.prop_recursive(2, 6, 2, |inner| {
        prop_oneof![
            inner.clone().prop_map(|e| Expr::UnaryNeg(Box::new(e))),
            (
                prop_oneof![
                    Just(BinaryOp::Add),
                    Just(BinaryOp::Sub),
                    Just(BinaryOp::Mul)
                ],
                inner.clone(),
                inner.clone(),
            )
                .prop_map(|(op, left, right)| Expr::Binary {
                    op,
                    left: Box::new(left),
                    right: Box::new(right),
                }),
            (inner, 1i64..=10i64).prop_map(|(left, div)| Expr::Binary {
                op: BinaryOp::DivFloor,
                left: Box::new(left),
                right: Box::new(Expr::Number(div)),
            }),
        ]
    })
}

fn arb_roll_address() -> impl Strategy<Value = RollAddress> {
    let seed = prop_oneof![
        any::<i64>().prop_map(SeedMaterial::Int64),
        any::<[u8; 32]>().prop_map(SeedMaterial::Bytes32),
    ];
    let domain = "[a-zA-Z0-9_.:-]{1,32}";
    let entity = "[a-zA-Z0-9_.:/-]{0,48}";
    (seed, any::<u64>(), domain, entity, any::<u64>()).prop_map(
        |(campaign_seed, turn, domain, entity_id, roll_index)| {
            RollAddress::new(campaign_seed, turn, domain, entity_id, roll_index)
        },
    )
}

fn arb_nonzero_span() -> impl Strategy<Value = NonZeroU64> {
    prop_oneof![
        (1u64..=100u64),
        (1u64..=63u64).prop_map(|k| 1u64 << k),
        (1u64..=1000u64).prop_map(|k| (1u64 << 53) + k),
        (0u64..=1000u64).prop_map(|k| u64::MAX - k),
        (1u64..=u64::MAX),
    ]
    .prop_map(|n| NonZeroU64::new(n).unwrap())
}

proptest! {
    #![proptest_config(proptest_cfg())]

    #[test]
    fn prop_parser_canonical_round_trip_idempotence(expr in arb_roundtrip_expr()) {
        // Generated AST respects total dice budget (<= 16 * 50 = 800 <= 10,000) and <= 1,000 bytes.
        let canonical = expr.to_canonical_string();
        prop_assume!(canonical.len() <= roll_core::MAX_EXPRESSION_BYTES);

        let reparsed = parse(&canonical).expect("canonical string of valid Expr must parse");
        prop_assert_eq!(&reparsed, &expr);
        prop_assert_eq!(reparsed.to_canonical_string(), canonical);
    }

    #[test]
    fn prop_receipt_round_trip_and_tamper_soundness(
        addr in arb_roll_address(),
        expr in arb_evaluable_expr(),
    ) {
        let (_outcome, receipt) = evaluate_addressed(&expr, &addr)
            .expect("addressed evaluation of bounded expression succeeds");

        let json = to_canonical_receipt_json(&receipt);
        let verified = verify_receipt_json(&json).expect("canonical receipt JSON must verify");
        prop_assert_eq!(&verified, &receipt);
        prop_assert_eq!(to_canonical_receipt_json(&verified), json);

        // Mutating any field without recomputing `receipt_sha256` fails with `DigestMismatch`.
        let mut mutated_turn = receipt.clone();
        mutated_turn.address.turn = mutated_turn.address.turn.wrapping_add(1);
        let err = verify_receipt(&mutated_turn).unwrap_err();
        let is_digest_mismatch = matches!(
            err,
            RollError::ReceiptInvalid(ReceiptVerifyError::DigestMismatch { .. })
        );
        prop_assert!(
            is_digest_mismatch,
            "expected DigestMismatch, got {:?}",
            err
        );

        // Extending `raw_draws` (even when re-hashed) fails verification (`PrngStreamMismatch` or `UnconsumedDraws`).
        let mut extended = receipt.clone();
        extended.raw_draws.push(0xdead_beef_cafe_babe);
        extended.receipt_sha256 = compute_receipt_sha256(&extended).unwrap();
        let is_invalid = matches!(
            verify_receipt(&extended),
            Err(RollError::ReceiptInvalid(_))
        );
        prop_assert!(is_invalid, "expected ReceiptInvalid on extended draws");

        // Truncating `raw_draws` (when non-empty and re-hashed) fails with `DrawTapeUnderflow`.
        if !receipt.raw_draws.is_empty() {
            let mut truncated = receipt;
            truncated.raw_draws.pop();
            truncated.receipt_sha256 = compute_receipt_sha256(&truncated).unwrap();
            let trunc_res = verify_receipt(&truncated);
            let is_underflow = matches!(
                trunc_res,
                Err(RollError::ReceiptInvalid(
                    ReceiptVerifyError::DrawTapeUnderflow { .. }
                ))
            );
            prop_assert!(
                is_underflow,
                "expected DrawTapeUnderflow, got {:?}",
                trunc_res
            );
        }
    }

    #[test]
    fn prop_lemire_output_stays_in_range(
        seed in any::<[u8; 32]>(),
        span in arb_nonzero_span(),
        a in any::<i64>(),
        b in any::<i64>(),
        tape_word in 1u64..=u64::MAX,
    ) {
        let mut rng = RollRng::from_raw_seed(seed);
        for _ in 0..8 {
            let sampled = rng.sample_u64(span);
            prop_assert!(sampled < span.get());
        }
        prop_assert!(rng.draws().len() >= 8);

        let lo = a.min(b);
        let hi = a.max(b);
        let inc = rng.sample_inclusive(lo, hi).expect("lo <= hi succeeds");
        prop_assert!(inc >= lo && inc <= hi);

        // Direct tape check: any tape ending in `u64::MAX` is guaranteed to accept (`low = u64::MAX - s + 1 >= s - 1 >= threshold`).
        let tape = [0u64, tape_word, u64::MAX];
        let (t_val, consumed) = lemire_sample_from_tape(span, &tape).expect("terminates by 3rd word");
        prop_assert!(t_val < span.get());
        prop_assert!((1..=3).contains(&consumed));
    }

    #[test]
    fn prop_pmf_conservation_and_query_identities(expr in arb_exact_analyzable_expr()) {
        let report = analyze(&expr).expect("bounded exact expression analyzes cleanly");
        let is_exact = matches!(report.method, AnalysisMethod::Exact { .. });
        prop_assert!(is_exact, "expected Exact method, got {:?}", report.method);

        let entries = report.distribution.entries();
        prop_assert!(!entries.is_empty());

        let mut prev_v: Option<i64> = None;
        let mut total_mass = 0.0_f64;
        for &(v, p) in entries {
            if let Some(prev) = prev_v {
                prop_assert!(v > prev, "support keys must be strictly ascending: {} <= {}", v, prev);
            }
            prev_v = Some(v);
            prop_assert!(p >= 0.0 && p.is_finite(), "invalid probability {} at {}", p, v);
            total_mass += p;
        }
        prop_assert!(
            (total_mass - 1.0).abs() <= 1e-12,
            "PMF mass drifted from 1.0: {}",
            total_mass
        );

        let min_v = report.stats.min;
        let max_v = report.stats.max;
        let mid_v = min_v + (max_v - min_v) / 2;
        for x in [min_v.saturating_sub(1), min_v, mid_v, max_v, max_v.saturating_add(1)] {
            if let Some(x_plus_1) = x.checked_add(1) {
                let sum_split =
                    report.distribution.prob_at_most(x) + report.distribution.prob_at_least(x_plus_1);
                prop_assert!(
                    (sum_split - total_mass).abs() <= 1e-12,
                    "CDF + survival split mismatch at {}: {}",
                    x,
                    sum_split
                );
            }
            if let Some(min_minus_1) = min_v.checked_sub(1)
                && x >= min_v
            {
                let range_p = report.distribution.prob_in_range(min_v, x);
                let cdf_diff =
                    report.distribution.prob_at_most(x) - report.distribution.prob_at_most(min_minus_1);
                prop_assert!(
                    (range_p - cdf_diff).abs() <= 1e-12,
                    "prob_in_range mismatch: {} vs {}",
                    range_p,
                    cdf_diff
                );
            }
        }

        for q in [0.01, 0.10, 0.25, 0.50, 0.75, 0.90, 0.99] {
            let t_ge = report
                .distribution
                .target_for_probability(q, TargetDirection::AtLeast)
                .unwrap();
            prop_assert!(report.distribution.is_reachable(t_ge));
            prop_assert!(report.distribution.prob_at_least(t_ge) >= q - 1e-12);
            let idx_ge = entries.binary_search_by_key(&t_ge, |&(v, _)| v).unwrap();
            if idx_ge + 1 < entries.len() {
                let next_v = entries[idx_ge + 1].0;
                prop_assert!(report.distribution.prob_at_least(next_v) < q + 1e-12);
            }

            let t_le = report
                .distribution
                .target_for_probability(q, TargetDirection::AtMost)
                .unwrap();
            prop_assert!(report.distribution.is_reachable(t_le));
            prop_assert!(report.distribution.prob_at_most(t_le) >= q - 1e-12);
            let idx_le = entries.binary_search_by_key(&t_le, |&(v, _)| v).unwrap();
            if idx_le > 0 {
                let prev = entries[idx_le - 1].0;
                prop_assert!(report.distribution.prob_at_most(prev) < q + 1e-12);
            }
        }
    }

    #[test]
    fn prop_no_std_math_matches_ieee_reference(raw_bits in any::<u64>()) {
        // Construct positive finite `f64` values across subnormals and normal exponents.
        let positive_bits = raw_bits & 0x7fff_ffff_ffff_ffff;
        let x = f64::from_bits(positive_bits);
        if x.is_finite() {
            // `sqrt_f64` is 0.0-ULP exact across every non-negative finite `f64` (including subnormals and +0.0).
            prop_assert_eq!(sqrt_f64(x).to_bits(), x.sqrt().to_bits());
            if x > 0.0 {
                let actual = log2_f64(x);
                let expected = x.log2();
                let tol = 2e-15 * expected.abs().max(1.0);
                prop_assert!(
                    (actual - expected).abs() <= tol,
                    "log2_f64 mismatch at {:e}: actual={}, expected={}",
                    x,
                    actual,
                    expected
                );
            }
        }
    }
}

fn arb_exact_analyzable_expr() -> impl Strategy<Value = Expr> {
    let exact_dice = (
        1u32..=5u32,
        prop_oneof![
            (2u32..=12u32).prop_map(|n| DiceSides::Standard(NonZeroU32::new(n).unwrap())),
            Just(DiceSides::Percentile),
            Just(DiceSides::Fate),
        ],
        prop::collection::vec(
            (arb_compare_op(), -2i64..=12i64).prop_map(|(op, value)| ComparePoint { op, value }),
            0..=1,
        ),
        prop::collection::vec(
            (arb_compare_op(), -2i64..=12i64).prop_map(|(op, value)| ComparePoint { op, value }),
            0..=1,
        ),
        arb_clamp(),
        prop::option::of((
            prop_oneof![
                Just(ExplosionVariant::Standard),
                Just(ExplosionVariant::Compound),
                Just(ExplosionVariant::Penetrate),
            ],
            (arb_compare_op(), 2i64..=12i64).prop_map(|(op, value)| ComparePoint { op, value }),
        )),
        prop::collection::vec(arb_keep_drop(), 0..=2),
        arb_result_mode(),
        arb_sort(),
    )
        .prop_map(
            |(
                c,
                sides,
                reroll_unlimited,
                reroll_once,
                clamp,
                explode_opt,
                keep_drop,
                mode,
                sort,
            )| {
                // Avoid Standard/Penetrate + non-empty keep_drop (`4d6!kh3` is the §5.1 MC case)
                // and bound exploding / Percentile groups so intermediate DP and binary state
                // products remain strictly below `MAX_EXACT_STATES = 10_000_000` on every seed
                // (e.g. `5d9!!>2kl2` has ~909 faces x 5 dice > 10M DP transitions).
                let explode = if sides == DiceSides::Fate || sides == DiceSides::Percentile {
                    None
                } else {
                    match explode_opt {
                        Some((variant, threshold))
                            if !keep_drop.is_empty() && variant != ExplosionVariant::Compound =>
                        {
                            Some(ExplosionRule {
                                variant: ExplosionVariant::Compound,
                                threshold,
                            })
                        }
                        Some((variant, threshold)) => Some(ExplosionRule { variant, threshold }),
                        None => None,
                    }
                };
                let effective_sides = match (sides, explode.is_some()) {
                    (DiceSides::Standard(n), true) if n.get() > 3 => {
                        DiceSides::Standard(NonZeroU32::new(2 + (n.get() % 2)).unwrap())
                    }
                    _ => sides,
                };
                let effective_count = if explode.is_some() {
                    c.min(3)
                } else if effective_sides == DiceSides::Percentile {
                    c.min(2)
                } else {
                    c
                };
                Expr::Dice(DiceSpec {
                    count: NonZeroU32::new(effective_count).unwrap(),
                    sides: effective_sides,
                    reroll_unlimited,
                    reroll_once,
                    clamp,
                    explode,
                    keep_drop,
                    mode,
                    sort,
                })
            },
        );

    let compact_mul_lhs = prop_oneof![
        (-5i64..=5i64).prop_map(Expr::Number),
        (1u32..=2u32, 2u32..=4u32).prop_map(|(c, s)| {
            Expr::Dice(DiceSpec {
                count: NonZeroU32::new(c).unwrap(),
                sides: DiceSides::Standard(NonZeroU32::new(s).unwrap()),
                reroll_unlimited: Vec::new(),
                reroll_once: Vec::new(),
                clamp: None,
                explode: None,
                keep_drop: Vec::new(),
                mode: ResultMode::Sum {
                    crit_success_max: false,
                    crit_failure_min: false,
                },
                sort: None,
            })
        }),
    ];

    let leaf = prop_oneof![(-20i64..=20i64).prop_map(Expr::Number), exact_dice];
    leaf.prop_recursive(2, 5, 2, move |inner| {
        prop_oneof![
            inner.clone().prop_map(|e| Expr::UnaryNeg(Box::new(e))),
            (
                prop_oneof![Just(BinaryOp::Add), Just(BinaryOp::Sub)],
                inner.clone(),
                inner.clone(),
            )
                .prop_map(|(op, left, right)| Expr::Binary {
                    op,
                    left: Box::new(left),
                    right: Box::new(right),
                }),
            (compact_mul_lhs.clone(), inner.clone()).prop_map(|(left, right)| Expr::Binary {
                op: BinaryOp::Mul,
                left: Box::new(left),
                right: Box::new(right),
            }),
            (inner, prop_oneof![-6i64..=-1i64, 1i64..=6i64],).prop_map(|(left, div)| {
                Expr::Binary {
                    op: BinaryOp::DivFloor,
                    left: Box::new(left),
                    right: Box::new(Expr::Number(div)),
                }
            }),
        ]
    })
}
