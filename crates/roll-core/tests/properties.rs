#![forbid(unsafe_code)]

use core::num::{NonZeroU32, NonZeroU64};
use proptest::prelude::*;
use proptest::test_runner::FileFailurePersistence;
use roll_core::{
    BinaryOp, ClampBounds, CompareOp, ComparePoint, DiceSides, DiceSpec, ExplosionRule,
    ExplosionVariant, Expr, KeepDropOp, ReceiptVerifyError, ResultMode, RollAddress, RollError,
    RollRng, SeedMaterial, SortOrder, compute_receipt_sha256, evaluate_addressed,
    lemire_sample_from_tape, parse, to_canonical_receipt_json, verify_receipt, verify_receipt_json,
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
        (0i64..=i64::MAX).prop_map(Expr::Number),
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
}
