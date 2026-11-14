#![forbid(unsafe_code)]

use roll_core::{
    CompareOp, ComparePoint, CritKind, DiceSides, Expr, KeepDropOp, MAX_EXPRESSION_BYTES,
    MAX_TOTAL_DICE_PER_EXPR, ResultMode, RollAddress, RollError, RollRng, SeedMaterial, SortOrder,
    checked_div_floor, evaluate_addressed, evaluate_with_rng, parse,
};

#[test]
fn lexer_fix_1d20cscf_parses_round_trips_and_marks_crits_in_sum_mode() {
    let expr = parse("1d20cscf").expect("1d20cscf must parse");
    assert_eq!(expr.to_canonical_string(), "1d20cscf");
    assert_eq!(parse(&expr.to_canonical_string()).unwrap(), expr);

    let Expr::Dice(ref spec) = expr else {
        panic!("expected Dice");
    };
    assert_eq!(
        spec.mode,
        ResultMode::Sum {
            crit_success_max: true,
            crit_failure_min: true,
        }
    );

    // Roll across seeds until we observe both natural 20 (Success) and natural 1 (Failure)
    // while confirming the sum total equals the face value (never zeroed!).
    let mut saw_crit_success = false;
    let mut saw_crit_failure = false;
    for seed in 0..500i64 {
        let addr = RollAddress::new(SeedMaterial::Int64(seed), 0, "test", "", 0);
        let (outcome, _receipt) = evaluate_addressed(&expr, &addr).unwrap();
        let die = &outcome.groups[0].dice[0];
        assert_eq!(outcome.total, die.final_value);
        assert!(!outcome.groups[0].is_pool);
        match die.final_value {
            20 => {
                assert_eq!(die.critical, Some(CritKind::Success));
                saw_crit_success = true;
            }
            1 => {
                assert_eq!(die.critical, Some(CritKind::Failure));
                saw_crit_failure = true;
            }
            _ => assert_eq!(die.critical, None),
        }
        if saw_crit_success && saw_crit_failure {
            break;
        }
    }
    assert!(saw_crit_success && saw_crit_failure);
}

#[test]
fn lexer_fix_4d6khsa_parses_and_round_trips() {
    let expr = parse("4d6khsa").expect("4d6khsa must parse");
    assert_eq!(expr.to_canonical_string(), "4d6kh1sa");
    assert_eq!(parse(&expr.to_canonical_string()).unwrap(), expr);

    let Expr::Dice(ref spec) = expr else {
        panic!("expected Dice");
    };
    assert_eq!(spec.keep_drop, vec![KeepDropOp::KeepHighest(1)]);
    assert_eq!(spec.sort, Some(SortOrder::Asc));

    let mut rng = RollRng::from_raw_seed([1u8; 32]);
    let outcome = evaluate_with_rng(&expr, &mut rng).unwrap();
    let kept: Vec<_> = outcome.groups[0].dice.iter().filter(|d| d.kept).collect();
    assert_eq!(kept.len(), 1);
    let max_val = outcome.groups[0]
        .dice
        .iter()
        .map(|d| d.final_value)
        .max()
        .unwrap();
    assert_eq!(outcome.total, max_val);
}

#[test]
fn lexer_fix_2d6rsa_parses_and_round_trips() {
    let expr = parse("2d6rsa").expect("2d6rsa must parse");
    assert_eq!(expr.to_canonical_string(), "2d6r=1sa");
    assert_eq!(parse(&expr.to_canonical_string()).unwrap(), expr);

    let Expr::Dice(ref spec) = expr else {
        panic!("expected Dice");
    };
    assert_eq!(
        spec.reroll_unlimited,
        vec![ComparePoint {
            op: CompareOp::Eq,
            value: 1,
        }]
    );
    assert_eq!(spec.sort, Some(SortOrder::Asc));

    for seed in 0..50u8 {
        let mut rng = RollRng::from_raw_seed([seed; 32]);
        let outcome = evaluate_with_rng(&expr, &mut rng).unwrap();
        for d in &outcome.groups[0].dice {
            assert!((2..=6).contains(&d.final_value));
        }
    }
}

#[test]
fn checked_i64_arithmetic_and_floor_division_semantics() {
    // Spec §4.3 floor division toward -infinity (matching Math.floor(a / b), NOT truncation or div_euclid).
    assert_eq!(checked_div_floor(7, 2), Ok(3));
    assert_eq!(checked_div_floor(-7, 2), Ok(-4));
    assert_eq!(checked_div_floor(7, -2), Ok(-4));
    assert_eq!(checked_div_floor(-7, -2), Ok(3));
    assert_eq!(checked_div_floor(-6, 2), Ok(-3));
    assert_eq!(checked_div_floor(6, -2), Ok(-3));
    assert_eq!(checked_div_floor(0, -5), Ok(0));
    assert_eq!(checked_div_floor(5, 0), Err(RollError::DivisionByZero));
    assert_eq!(
        checked_div_floor(i64::MIN, -1),
        Err(RollError::ArithmeticOverflow)
    );
    assert_eq!(checked_div_floor(i64::MIN, 1), Ok(i64::MIN));

    // End-to-end expression division & overflow checks.
    let mut rng = RollRng::from_raw_seed([0u8; 32]);
    assert_eq!(
        evaluate_with_rng(&parse("-7/2").unwrap(), &mut rng)
            .unwrap()
            .total,
        -4
    );
    assert_eq!(
        evaluate_with_rng(&parse("7/-2").unwrap(), &mut rng)
            .unwrap()
            .total,
        -4
    );
    assert_eq!(
        evaluate_with_rng(&parse("-7/-2").unwrap(), &mut rng)
            .unwrap()
            .total,
        3
    );
    assert_eq!(
        evaluate_with_rng(&parse("(8-10)/2").unwrap(), &mut rng)
            .unwrap()
            .total,
        -1
    );
    assert_eq!(
        evaluate_with_rng(&parse("(9-10)/2").unwrap(), &mut rng)
            .unwrap()
            .total,
        -1
    );
    assert_eq!(
        evaluate_with_rng(&parse("1d6/0").unwrap(), &mut rng),
        Err(RollError::DivisionByZero)
    );
    assert_eq!(
        evaluate_with_rng(&parse("9223372036854775807+1").unwrap(), &mut rng),
        Err(RollError::ArithmeticOverflow)
    );
    assert_eq!(
        evaluate_with_rng(&parse("-9223372036854775807-2").unwrap(), &mut rng),
        Err(RollError::ArithmeticOverflow)
    );
    assert_eq!(
        evaluate_with_rng(&parse("4000000000000*4000000000000").unwrap(), &mut rng),
        Err(RollError::ArithmeticOverflow)
    );
    assert_eq!(
        parse("9223372036854775808"),
        Err(RollError::ArithmeticOverflow)
    );
}

#[test]
fn compatibility_matrix_2x_unchanged_and_extended_forms() {
    // Row 1: 2d6, d20, d%, 4dF, + - * /, unary -, (...)
    let unchanged = [
        ("2d6", "2d6"),
        ("d20", "1d20"),
        ("d%", "1d%"),
        ("4dF", "4dF"),
        ("4df", "4dF"),
        ("(2d6+3)*2-1d4/2", "(2d6+3)*2-1d4/2"),
        ("-1d6+4", "-1d6+4"),
        ("-(2d6+3)", "-(2d6+3)"),
        ("10-(2+3)", "10-(2+3)"),
    ];
    let mut rng = RollRng::from_raw_seed([9u8; 32]);
    for (raw, expected_canonical) in unchanged {
        let ast = parse(raw).unwrap_or_else(|e| panic!("failed to parse '{raw}': {e}"));
        assert_eq!(ast.to_canonical_string(), expected_canonical);
        assert_eq!(parse(expected_canonical).unwrap(), ast);
        assert!(evaluate_with_rng(&ast, &mut rng).is_ok());
    }

    // Row 2: kh/kl/dh/dl, r/ro, min/max, !/!!/!p, and canonical stage normalization (`4d6kh3r=1` -> `4d6r=1kh3`).
    let reordered = parse("4d6kh3r=1").unwrap();
    let canonical = parse("4d6r=1kh3").unwrap();
    assert_eq!(reordered, canonical);
    assert_eq!(reordered.to_canonical_string(), "4d6r=1kh3");

    let mod_forms = [
        ("4d6kh", "4d6kh1"),
        ("4d6kl2", "4d6kl2"),
        ("4d6dh", "4d6dh1"),
        ("4d6dl1", "4d6dl1"),
        ("4d6kh0", "4d6kh0"),
        ("2d6r", "2d6r=1"),
        ("2d6ro<3", "2d6ro<3"),
        ("2d6min2max5", "2d6min2max5"),
        ("2d6max5min2", "2d6min2max5"),
        ("1d6!", "1d6!>=6"),
        ("1d6!!>4", "1d6!!>4"),
        ("1d6!p>=5", "1d6!p>=5"),
        ("1d%!", "1d%!>=100"),
    ];
    for (raw, expected_canonical) in mod_forms {
        let ast = parse(raw).unwrap_or_else(|e| panic!("failed to parse '{raw}': {e}"));
        assert_eq!(ast.to_canonical_string(), expected_canonical);
        assert!(evaluate_with_rng(&ast, &mut rng).is_ok());
    }

    // Row 3: Pool success/failure counting (`8d6cs>=5`, `8d6cs>=5cf<=1`, `10d6cf<=1`).
    for pool_expr in ["8d6cs>=5", "8d6cs>=5cf<=1", "10d6cf<=1"] {
        let ast = parse(pool_expr).unwrap();
        assert_eq!(ast.to_canonical_string(), pool_expr);
        let outcome = evaluate_with_rng(&ast, &mut rng).unwrap();
        assert!(outcome.groups[0].is_pool);
    }

    // Row 5: Bare `1d20cs`, `1d20cf`, `4dFcscf` mark natural faces in Sum mode.
    let cs_only = parse("1d20cs").unwrap();
    let cf_only = parse("1d20cf").unwrap();
    let fate_crit = parse("4dFcscf").unwrap();
    assert_eq!(cs_only.to_canonical_string(), "1d20cs");
    assert_eq!(cf_only.to_canonical_string(), "1d20cf");
    assert_eq!(fate_crit.to_canonical_string(), "4dFcscf");
    if let Expr::Dice(spec) = &fate_crit {
        assert_eq!(spec.sides, DiceSides::Fate);
    }
    let fate_out = evaluate_with_rng(&fate_crit, &mut rng).unwrap();
    assert!(!fate_out.groups[0].is_pool);
    for d in &fate_out.groups[0].dice {
        match d.final_value {
            1 => assert_eq!(d.critical, Some(CritKind::Success)),
            -1 => assert_eq!(d.critical, Some(CritKind::Failure)),
            0 => assert_eq!(d.critical, None),
            other => panic!("unexpected Fate die value {other}"),
        }
    }

    // Row 6: Negative compare/clamp literals (`4dFr=-1`, `4dFmin-1max0`).
    let fate_reroll = parse("4dFr=-1").unwrap();
    assert_eq!(fate_reroll.to_canonical_string(), "4dFr=-1");
    for s in 0..30u8 {
        let mut r = RollRng::from_raw_seed([s; 32]);
        let out = evaluate_with_rng(&fate_reroll, &mut r).unwrap();
        for d in &out.groups[0].dice {
            assert!(d.final_value == 0 || d.final_value == 1);
        }
    }
    let fate_clamp = parse("4dFmin0").unwrap();
    assert_eq!(fate_clamp.to_canonical_string(), "4dFmin0");
}

#[test]
fn compatibility_matrix_parse_time_rejections() {
    // Row 7: `0d6` (and `1d0`) rejected at parse time.
    assert!(matches!(
        parse("0d6"),
        Err(RollError::Parse { byte_offset: 0, .. })
    ));
    assert!(matches!(
        parse("00d20"),
        Err(RollError::Parse { byte_offset: 0, .. })
    ));
    assert!(matches!(
        parse("1d0"),
        Err(RollError::Parse { byte_offset: 2, .. })
    ));

    // Row 8: `1d6min5max2`, `1d6max2min5` rejected with InvalidClampBounds.
    assert_eq!(
        parse("1d6min5max2"),
        Err(RollError::InvalidClampBounds {
            min: 5,
            max: 2,
            byte_offset: 7,
        })
    );
    assert_eq!(
        parse("1d6max2min5"),
        Err(RollError::InvalidClampBounds {
            min: 5,
            max: 2,
            byte_offset: 7,
        })
    );

    // Row 9: Duplicate singleton slots (`1d6min2min4`, `1d6!>5!>4`, `4d6sasd`, etc.).
    for dup in [
        "1d6min2min4",
        "1d6max5max3",
        "1d6!>5!>4",
        "1d6!!!",
        "4d6sasd",
        "4d6sasa",
        "1d20cscs",
        "1d20cfcf",
    ] {
        assert!(
            matches!(parse(dup), Err(RollError::Parse { .. })),
            "expected Parse error on duplicate singleton '{dup}', got {:?}",
            parse(dup)
        );
    }

    // Row 10: `4dF!`, `4dF!!`, `4dF!p` rejected at parse time.
    for exploding_fate in ["4dF!", "4dF!!", "4dF!p"] {
        assert!(
            matches!(parse(exploding_fate), Err(RollError::Parse { .. })),
            "expected Parse error on '{exploding_fate}'"
        );
    }

    // Row 11: Mixing bare `cs`/`cf` + pool `cs>=15`/`cf<=1` rejected at parse time.
    for mixed in ["1d20cscs>=15", "1d20cs>=15cs", "8d6cs>=5cf", "8d6cfcs>=5"] {
        assert!(
            matches!(parse(mixed), Err(RollError::Parse { .. })),
            "expected Parse error on mixed crit/pool '{mixed}'"
        );
    }

    // Row 12: Multi-group > 10,000 total dice rejected with DiceBudgetExceeded, while == 10,000 passes.
    let exact_budget = parse("5000d6 + 5000d6").expect("exact 10,000 dice budget allowed");
    assert_eq!(exact_budget.total_base_dice(), MAX_TOTAL_DICE_PER_EXPR);

    assert_eq!(
        parse("2000d6+9000d6"),
        Err(RollError::DiceBudgetExceeded {
            total_dice: 11_000,
            max: 10_000,
        })
    );
    assert_eq!(
        parse("10001d6"),
        Err(RollError::DiceBudgetExceeded {
            total_dice: 10_001,
            max: 10_000,
        })
    );

    // Byte length cap (1000 allowed, 1001 rejected) and Lex errors.
    let exact_1000 = "1".repeat(MAX_EXPRESSION_BYTES);
    // 1000 digits overflows i64, so use "1+1+...+11" of exact length 1000:
    let mut valid_1000 = "1+".repeat(499);
    valid_1000.push_str("11");
    assert_eq!(valid_1000.len(), MAX_EXPRESSION_BYTES);
    assert!(parse(&valid_1000).is_ok());
    let _ = exact_1000;

    let over_1000 = format!("{valid_1000}1");
    assert_eq!(
        parse(&over_1000),
        Err(RollError::ExpressionTooLong {
            len: 1001,
            max: 1000,
        })
    );

    assert!(matches!(
        parse("2d6@3"),
        Err(RollError::Lex { byte_offset: 3, .. })
    ));
    assert!(matches!(
        parse("foo"),
        Err(RollError::Lex { byte_offset: 0, .. })
    ));
    assert!(matches!(
        parse(""),
        Err(RollError::Parse { byte_offset: 0, .. })
    ));
    assert!(matches!(
        parse("2d6 d"),
        Err(RollError::Parse { byte_offset: 4, .. })
    ));
}
