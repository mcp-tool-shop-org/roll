#![forbid(unsafe_code)]

use roll_core::{
    CompareOp, ComparePoint, CritKind, DiceSides, Expr, KeepDropOp, MAX_EXPLOSIONS,
    MAX_EXPRESSION_BYTES, MAX_REROLLS, MAX_TOTAL_DICE_PER_EXPR, ResultMode, RollAddress, RollError,
    RollRng, SeedMaterial, SortOrder, checked_div_floor, evaluate_addressed, evaluate_with_rng,
    parse,
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
        ("2D6", "2d6"),
        ("d20", "1d20"),
        ("D20", "1d20"),
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
        ("4d6kl", "4d6kl1"),
        ("4d6kl2", "4d6kl2"),
        ("4d6dh", "4d6dh1"),
        ("4d6dh1", "4d6dh1"),
        ("4d6dl", "4d6dl1"),
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

#[test]
fn i64_min_literal_and_negative_number_canonical_bijection() {
    // 1. Literal `i64::MIN` (`-9223372036854775808`) parses directly in expression position,
    //    while `-9223372036854775809` (`i64::MIN - 1`) is rejected with `ArithmeticOverflow`.
    let min_ast = parse("-9223372036854775808").expect("i64::MIN literal must parse");
    assert_eq!(min_ast, Expr::Number(i64::MIN));
    assert_eq!(min_ast.to_canonical_string(), "-9223372036854775808");
    assert_eq!(parse(&min_ast.to_canonical_string()), Ok(min_ast.clone()));

    let mut rng = RollRng::from_raw_seed([0u8; 32]);
    assert_eq!(
        evaluate_with_rng(&min_ast, &mut rng).unwrap().total,
        i64::MIN
    );

    assert_eq!(
        parse("-9223372036854775809"),
        Err(RollError::ArithmeticOverflow)
    );

    // 2. Programmatically constructed `Expr::Number(n)` and `Expr::UnaryNeg(Box::new(Expr::Number(n)))`
    //    both round-trip bijectively through `to_canonical_string()` -> `parse()` for every `i64`.
    for n in [i64::MIN, -42, -1, 0, 1, 42, i64::MAX] {
        let num_expr = Expr::Number(n);
        let num_canon = num_expr.to_canonical_string();
        assert_eq!(parse(&num_canon), Ok(num_expr));

        let neg_expr = Expr::UnaryNeg(Box::new(Expr::Number(n)));
        let neg_canon = neg_expr.to_canonical_string();
        assert_eq!(neg_canon, format!("-({n})"));
        assert_eq!(parse(&neg_canon), Ok(neg_expr));
    }

    // `-0` normalizes to `Expr::Number(0)` (`"0"`), while `-2d6` stays `UnaryNeg(Dice(2d6))`.
    assert_eq!(parse("-0"), Ok(Expr::Number(0)));
    let neg_dice = parse("-2d6").unwrap();
    assert!(matches!(neg_dice, Expr::UnaryNeg(_)));
    assert_eq!(neg_dice.to_canonical_string(), "-2d6");
    assert_eq!(parse("-2d6"), Ok(neg_dice));
}

#[test]
fn engine_loop_caps_penetrate_compound_die_traces_and_runtime_overflows() {
    let mut rng = RollRng::from_raw_seed([7u8; 32]);

    // 1. `MAX_REROLLS = 100` (`1d6r>=1`): executes exactly 100 rerolls and keeps the 100th roll.
    let reroll_cap = parse("1d6r>=1").unwrap();
    let r_out = evaluate_with_rng(&reroll_cap, &mut rng).unwrap();
    assert_eq!(r_out.groups[0].dice.len(), 1);
    let r_die = &r_out.groups[0].dice[0];
    assert_eq!(r_die.rerolls.len(), MAX_REROLLS as usize);
    assert_eq!(r_die.final_value, *r_die.rerolls.last().unwrap());
    assert_eq!(r_out.total, r_die.final_value);

    // 2. `MAX_EXPLOSIONS = 100` on Standard (`1d6!>=1`): 1 initial die + 100 `exploded_child` dice = 101 dice.
    let std_cap = parse("1d6!>=1").unwrap();
    let std_out = evaluate_with_rng(&std_cap, &mut rng).unwrap();
    let std_dice = &std_out.groups[0].dice;
    assert_eq!(std_dice.len(), (MAX_EXPLOSIONS as usize) + 1);
    assert!(!std_dice[0].exploded_child);
    assert_eq!(std_dice[0].explosions.len(), MAX_EXPLOSIONS as usize);
    for (idx, child) in std_dice[1..].iter().enumerate() {
        assert!(child.exploded_child);
        assert_eq!(child.initial_face, std_dice[0].explosions[idx]);
        assert_eq!(child.final_value, std_dice[0].explosions[idx]);
    }
    let expected_std_sum: i64 = std_dice.iter().map(|d| d.final_value).sum();
    assert_eq!(std_out.total, expected_std_sum);

    // 3. `MAX_EXPLOSIONS = 100` on Compound (`1d6!!>=1`): single `DieTrace` summing all 100 bonus rolls into `final_value`.
    let comp_cap = parse("1d6!!>=1").unwrap();
    let comp_out = evaluate_with_rng(&comp_cap, &mut rng).unwrap();
    assert_eq!(comp_out.groups[0].dice.len(), 1);
    let comp_die = &comp_out.groups[0].dice[0];
    assert!(!comp_die.exploded_child);
    assert_eq!(comp_die.explosions.len(), MAX_EXPLOSIONS as usize);
    let expected_comp_val = comp_die.initial_face + comp_die.explosions.iter().sum::<i64>();
    assert_eq!(comp_die.final_value, expected_comp_val);
    assert_eq!(comp_out.total, expected_comp_val);

    // 4. `Penetrate` (`!p`) `DieTrace` math:
    //    - On `1d6!p>=1`: 1 initial die + 100 child dice where every child has `final_value == (raw - 1).max(1)`
    //      (verifying both `raw == 1 -> 1` floor and `raw >= 2 -> raw - 1`).
    let pen_cap = parse("1d6!p>=1").unwrap();
    let pen_out = evaluate_with_rng(&pen_cap, &mut rng).unwrap();
    let pen_dice = &pen_out.groups[0].dice;
    assert_eq!(pen_dice.len(), (MAX_EXPLOSIONS as usize) + 1);
    let mut saw_raw_one_floor = false;
    let mut saw_raw_gt_one_sub = false;
    for (idx, child) in pen_dice[1..].iter().enumerate() {
        let raw = pen_dice[0].explosions[idx];
        assert!(child.exploded_child);
        assert_eq!(child.initial_face, raw);
        assert_eq!(child.final_value, (raw - 1).max(1));
        if raw == 1 {
            assert_eq!(child.final_value, 1);
            saw_raw_one_floor = true;
        } else {
            assert_eq!(child.final_value, raw - 1);
            saw_raw_gt_one_sub = true;
        }
    }
    assert!(saw_raw_one_floor && saw_raw_gt_one_sub);

    //    - On `1d6!p>=5`: verify that bonus raw face `5` (`effective = 4 < 5`) STILL triggers a further explosion
    //      because `threshold.matches(raw_face)` tests the unadjusted raw `5`!
    let pen_raw_thresh = parse("1d6!p>=5").unwrap();
    let mut found_raw_5_chain = false;
    for seed in 0..2_000i64 {
        let addr = RollAddress::new(SeedMaterial::Int64(seed), 0, "pen_test", "", 0);
        let (out, _) = evaluate_addressed(&pen_raw_thresh, &addr).unwrap();
        let exps = &out.groups[0].dice[0].explosions;
        if exps.len() >= 2 && exps[0] == 5 {
            // `exps[0] == 5` had child `final_value == 4` (< 5), yet still exploded to `exps[1]`!
            assert_eq!(out.groups[0].dice[1].initial_face, 5);
            assert_eq!(out.groups[0].dice[1].final_value, 4);
            found_raw_5_chain = true;
            break;
        }
    }
    assert!(found_raw_5_chain);

    // 5. Runtime `ArithmeticOverflow` in `UnaryNeg`, `Compound` accumulation, and `Sum` group total.
    assert_eq!(
        evaluate_with_rng(&parse("-(-9223372036854775808)").unwrap(), &mut rng),
        Err(RollError::ArithmeticOverflow)
    );
    assert_eq!(
        evaluate_with_rng(&parse("1d6min9223372036854775807!!>=1").unwrap(), &mut rng),
        Err(RollError::ArithmeticOverflow)
    );
    assert_eq!(
        evaluate_with_rng(&parse("2d6min9223372036854775807").unwrap(), &mut rng),
        Err(RollError::ArithmeticOverflow)
    );
    // Contrast: in Pool mode (`cs>=5`), clamping two dice to `i64::MAX` counts `+1 + +1 = 2` without overflowing!
    assert_eq!(
        evaluate_with_rng(&parse("2d6min9223372036854775807cs>=5").unwrap(), &mut rng)
            .unwrap()
            .total,
        2
    );
}

#[test]
fn parser_enforces_max_nesting_depth_with_structured_error_and_safe_debug_evaluation() {
    use roll_core::{MAX_NESTING_DEPTH, analyze};

    assert_eq!(MAX_NESTING_DEPTH, 64);

    // Exactly `MAX_NESTING_DEPTH = 64` nested parentheses and unary negations parse, evaluate, and analyze safely.
    let parens_ok = format!(
        "{}1d6{}",
        "(".repeat(MAX_NESTING_DEPTH),
        ")".repeat(MAX_NESTING_DEPTH)
    );
    let parsed_parens_ok = parse(&parens_ok).unwrap();
    let mut rng = RollRng::from_raw_seed([7u8; 32]);
    let out_parens = evaluate_with_rng(&parsed_parens_ok, &mut rng).unwrap();
    assert!((1..=6).contains(&out_parens.total));
    assert_eq!(analyze(&parsed_parens_ok).unwrap().stats.min, 1);

    let neg_ok = format!("{}1d6", "-".repeat(MAX_NESTING_DEPTH));
    let parsed_neg_ok = parse(&neg_ok).unwrap();
    let out_neg = evaluate_with_rng(&parsed_neg_ok, &mut rng).unwrap();
    assert!((1..=6).contains(&out_neg.total));
    assert_eq!(analyze(&parsed_neg_ok).unwrap().stats.min, 1);

    // One over (`depth = 65`) fails deterministically with `RollError::ExpressionTooDeep` and exact byte offset.
    let parens_over = format!(
        "{}1d6{}",
        "(".repeat(MAX_NESTING_DEPTH + 1),
        ")".repeat(MAX_NESTING_DEPTH + 1)
    );
    assert_eq!(
        parse(&parens_over),
        Err(RollError::ExpressionTooDeep {
            depth: MAX_NESTING_DEPTH + 1,
            max: MAX_NESTING_DEPTH,
            byte_offset: MAX_NESTING_DEPTH,
        })
    );

    let neg_over = format!("{}1d6", "-".repeat(MAX_NESTING_DEPTH + 1));
    assert_eq!(
        parse(&neg_over),
        Err(RollError::ExpressionTooDeep {
            depth: MAX_NESTING_DEPTH + 1,
            max: MAX_NESTING_DEPTH,
            byte_offset: MAX_NESTING_DEPTH,
        })
    );

    let mixed_over = format!("{}({}1d6{}", "(-".repeat(32), "", ")".repeat(33));
    assert_eq!(
        parse(&mixed_over),
        Err(RollError::ExpressionTooDeep {
            depth: MAX_NESTING_DEPTH + 1,
            max: MAX_NESTING_DEPTH,
            byte_offset: MAX_NESTING_DEPTH,
        })
    );

    // Flat left-associative binary chain near `MAX_EXPRESSION_BYTES` (`499` `+` operators, `999` B)
    // stays iterative in `parse` and safe in debug `evaluate_with_rng` and `analyze`.
    let flat_chain = format!("{}1", "1+".repeat(499));
    assert_eq!(flat_chain.len(), 999);
    let parsed_flat = parse(&flat_chain).unwrap();
    assert_eq!(
        evaluate_with_rng(&parsed_flat, &mut rng).unwrap().total,
        500
    );
    assert_eq!(analyze(&parsed_flat).unwrap().stats.min, 500);

    let flat_div_chain = format!("{}1", "1/".repeat(499));
    assert_eq!(flat_div_chain.len(), 999);
    let parsed_flat_div = parse(&flat_div_chain).unwrap();
    assert_eq!(
        evaluate_with_rng(&parsed_flat_div, &mut rng).unwrap().total,
        1
    );
    assert_eq!(analyze(&parsed_flat_div).unwrap().stats.min, 1);
}
