#![forbid(unsafe_code)]

use core::num::NonZeroU64;
use roll_core::{
    AnalysisMethod, DEFAULT_MONTE_CARLO_SAMPLES, Distribution, KeepDropOp, MAX_ANALYZE_DICE,
    MAX_EXPLOSIONS, MAX_REROLLS, ModelledCaps, RollError, TargetDirection, analyze, compare,
    compute_stats, lemire_witness_word, monte_carlo_distribution, parse, reduce_keep_drop_interval,
};

fn assert_close(actual: f64, expected: f64, tol: f64, label: &str) {
    let diff = (actual - expected).abs();
    assert!(
        diff <= tol,
        "{label}: actual={actual:.17e}, expected={expected:.17e}, diff={diff:.3e} > tol={tol:.3e}"
    );
}

#[test]
fn single_die_stages_rerolls_clamps_explosions_pools_and_caps() {
    // 1. Standard 2d6: Exact with `caps: None`.
    let r_2d6 = analyze(&parse("2d6").unwrap()).unwrap();
    assert_eq!(r_2d6.method, AnalysisMethod::Exact { caps: None });
    assert_eq!(r_2d6.distribution.len(), 11);
    assert_eq!(r_2d6.stats.min, 2);
    assert_eq!(r_2d6.stats.max, 12);
    assert_close(r_2d6.stats.mean, 7.0, 1e-14, "2d6 mean");
    assert_eq!(r_2d6.stats.median, 7);
    assert_eq!(r_2d6.stats.mode, 7);
    assert_close(
        r_2d6.distribution.prob_exactly(7),
        6.0 / 36.0,
        1e-15,
        "P(2d6=7)",
    );

    // 2. Unmatched reroll (`m == 0`): `caps: None`, uniform 1/6.
    let r_unmatched = analyze(&parse("1d6r=7").unwrap()).unwrap();
    assert_eq!(r_unmatched.method, AnalysisMethod::Exact { caps: None });
    for face in 1..=6 {
        assert_close(
            r_unmatched.distribution.prob_exactly(face),
            1.0 / 6.0,
            1e-15,
            "1d6r=7 face",
        );
    }

    // 3. Every-face reroll (`m == s`): closed-form Exact with `max_rerolls = Some(100)`, uniform 1/6.
    let r_all = analyze(&parse("1d6r>=1").unwrap()).unwrap();
    assert_eq!(
        r_all.method,
        AnalysisMethod::Exact {
            caps: Some(ModelledCaps {
                max_explosions: None,
                max_rerolls: Some(MAX_REROLLS),
            })
        }
    );
    for face in 1..=6 {
        assert_close(
            r_all.distribution.prob_exactly(face),
            1.0 / 6.0,
            1e-15,
            "1d6r>=1 face",
        );
    }

    // 4. Partial capped reroll (`0 < m < s`): `1d100r<=99` preserves residual `(0.99^101)/99` on `1..=99`.
    let r_residual = analyze(&parse("1d100r<=99").unwrap()).unwrap();
    assert_eq!(
        r_residual.method,
        AnalysisMethod::Exact {
            caps: Some(ModelledCaps {
                max_explosions: None,
                max_rerolls: Some(MAX_REROLLS),
            })
        }
    );
    assert_eq!(r_residual.distribution.len(), 100);
    let q_101 = 0.99_f64.powi(101);
    let expected_res = q_101 / 99.0;
    for f in 1..=99 {
        assert!(r_residual.distribution.is_reachable(f));
        assert_close(
            r_residual.distribution.prob_exactly(f),
            expected_res,
            1e-15,
            "1d100r<=99 residual",
        );
    }
    assert_close(
        r_residual.distribution.prob_exactly(100),
        1.0 - q_101,
        1e-14,
        "1d100r<=99 kept 100",
    );

    // 5. Clamped depth-0 explosion where raw bonus faces never re-explode (`1d6min7!>=7`):
    //    explodes once at depth 0 (`7 + 1..=6 = 8..=13`) and NEVER hits `MAX_EXPLOSIONS` (`caps: None`).
    let r_clamp_exp = analyze(&parse("1d6min7!>=7").unwrap()).unwrap();
    assert_eq!(r_clamp_exp.method, AnalysisMethod::Exact { caps: None });
    assert_eq!(r_clamp_exp.distribution.len(), 6);
    for total in 8..=13 {
        assert_close(
            r_clamp_exp.distribution.prob_exactly(total),
            1.0 / 6.0,
            1e-15,
            "1d6min7!>=7",
        );
    }

    // 6. Every-face explosion (`1d6!>=1`): hits `MAX_EXPLOSIONS = 100` on every chain (`mean = 101 * 3.5 = 353.5`).
    let r_all_exp = analyze(&parse("1d6!>=1").unwrap()).unwrap();
    assert_eq!(
        r_all_exp.method,
        AnalysisMethod::Exact {
            caps: Some(ModelledCaps {
                max_explosions: Some(MAX_EXPLOSIONS),
                max_rerolls: None,
            })
        }
    );
    assert_eq!(r_all_exp.stats.min, 101);
    assert_eq!(r_all_exp.stats.max, 606);
    assert_close(r_all_exp.stats.mean, 353.5, 1e-11, "1d6!>=1 mean");

    // 7. Penetrate (`1d2!p`): depth 0 face `1` -> `1` (0.5); depth `d >= 1` adds `max(1, raw - 1) == 1`
    //    while testing `raw >= 2` on the unadjusted raw face!
    let r_pen = analyze(&parse("1d2!p").unwrap()).unwrap();
    assert_eq!(
        r_pen.method,
        AnalysisMethod::Exact {
            caps: Some(ModelledCaps {
                max_explosions: Some(MAX_EXPLOSIONS),
                max_rerolls: None,
            })
        }
    );
    assert_close(r_pen.distribution.prob_exactly(1), 0.5, 1e-15, "1d2!p=1");
    assert_eq!(r_pen.distribution.prob_exactly(2), 0.0);
    assert!(!r_pen.distribution.is_reachable(2));
    assert_close(r_pen.distribution.prob_exactly(3), 0.25, 1e-15, "1d2!p=3");
    assert_close(r_pen.distribution.prob_exactly(4), 0.125, 1e-15, "1d2!p=4");
    assert_eq!(r_pen.stats.max, 102);
    assert_close(
        r_pen.distribution.prob_exactly(102),
        0.5_f64.powi(100),
        1e-45,
        "1d2!p capped tail at 102",
    );

    // 8. Combined reroll + explode (`2d6r=1!`) populates both caps; exploding pools (`8d6!cs>=5`, `8d6!pcs>=5`, `2d4!!cs>=5`) are Exact.
    let r_both = analyze(&parse("2d6r=1!").unwrap()).unwrap();
    assert_eq!(
        r_both.method,
        AnalysisMethod::Exact {
            caps: Some(ModelledCaps {
                max_explosions: Some(MAX_EXPLOSIONS),
                max_rerolls: Some(MAX_REROLLS),
            })
        }
    );

    let r_exp_pool = analyze(&parse("8d6!cs>=5").unwrap()).unwrap();
    assert!(matches!(r_exp_pool.method, AnalysisMethod::Exact { .. }));
    assert_eq!(r_exp_pool.stats.min, 0);
    assert_eq!(r_exp_pool.stats.max, 808);

    let r_pen_pool = analyze(&parse("8d6!pcs>=5").unwrap()).unwrap();
    assert!(matches!(r_pen_pool.method, AnalysisMethod::Exact { .. }));
    // On d6!p, bonus rolls have max effective `6 - 1 = 5`, which still satisfies `cs>=5`!
    assert_eq!(r_pen_pool.stats.max, 808);

    // Compound (`!!`) sums into the initial die before Stage 8 Pool (`2d4!!cs>=5` has max 2 successes, NOT 202!).
    let r_comp_pool = analyze(&parse("2d4!!cs>=5").unwrap()).unwrap();
    assert!(matches!(r_comp_pool.method, AnalysisMethod::Exact { .. }));
    assert_eq!(r_comp_pool.stats.min, 0);
    assert_eq!(r_comp_pool.stats.max, 2);
    // Each d4 reaches >= 5 iff its initial face is 4 (`p = 0.25`, since `4 + raw >= 5`).
    assert_close(
        r_comp_pool.distribution.prob_exactly(0),
        9.0 / 16.0,
        1e-14,
        "2d4!!cs>=5 P(0)",
    );
    assert_close(
        r_comp_pool.distribution.prob_exactly(1),
        6.0 / 16.0,
        1e-14,
        "2d4!!cs>=5 P(1)",
    );
    assert_close(
        r_comp_pool.distribution.prob_exactly(2),
        1.0 / 16.0,
        1e-14,
        "2d4!!cs>=5 P(2)",
    );
}

#[test]
fn order_statistic_dp_interval_reduction_exactness_and_cost_guard() {
    assert_eq!(reduce_keep_drop_interval(4, &[]), (0, 4));
    assert_eq!(
        reduce_keep_drop_interval(4, &[KeepDropOp::KeepHighest(3)]),
        (1, 4)
    );
    assert_eq!(
        reduce_keep_drop_interval(6, &[KeepDropOp::DropLowest(1), KeepDropOp::DropHighest(1)]),
        (1, 5)
    );
    assert_eq!(
        reduce_keep_drop_interval(3, &[KeepDropOp::KeepHighest(10)]),
        (0, 3)
    );
    assert_eq!(
        reduce_keep_drop_interval(4, &[KeepDropOp::KeepHighest(0)]),
        (4, 4)
    );
    assert_eq!(
        reduce_keep_drop_interval(3, &[KeepDropOp::DropLowest(2), KeepDropOp::DropHighest(2)]),
        (2, 2)
    );

    // Exact 4d6kh3 rational values (`1296` equiprobable outcomes).
    let kh3 = analyze(&parse("4d6kh3").unwrap()).unwrap();
    assert_eq!(kh3.method, AnalysisMethod::Exact { caps: None });
    assert_eq!(kh3.stats.min, 3);
    assert_eq!(kh3.stats.max, 18);
    assert_close(
        kh3.distribution.prob_exactly(3),
        1.0 / 1296.0,
        1e-15,
        "4d6kh3 P(3)",
    );
    assert_close(
        kh3.distribution.prob_exactly(18),
        21.0 / 1296.0,
        1e-15,
        "4d6kh3 P(18)",
    );
    assert_close(kh3.stats.mean, 15869.0 / 1296.0, 1e-13, "4d6kh3 mean");

    // 4d6kh0 -> point mass at 0.
    let kh0 = analyze(&parse("4d6kh0").unwrap()).unwrap();
    assert_eq!(kh0.distribution, Distribution::point(0));

    // Equivalent rank intervals (`6d6dl1dh1` vs `6d6dl1kl4`, both keeping ranks `[1, 5)`) produce identical exact distributions.
    let mid_a = analyze(&parse("6d6dl1dh1").unwrap()).unwrap();
    let mid_b = analyze(&parse("6d6dl1kl4").unwrap()).unwrap();
    assert_eq!(mid_a.method, AnalysisMethod::Exact { caps: None });
    assert_eq!(mid_a.distribution, mid_b.distribution);

    // Wide keep-highest `10d20kh3` (`20^10` naive states) finishes instantaneously as Exact!
    let wide = analyze(&parse("10d20kh3").unwrap()).unwrap();
    assert_eq!(wide.method, AnalysisMethod::Exact { caps: None });
    assert_eq!(wide.stats.min, 3);
    assert_eq!(wide.stats.max, 60);
    assert_eq!(wide.distribution.len(), 58);
    assert_close(
        wide.distribution.prob_exactly(3),
        0.05_f64.powi(10),
        1e-25,
        "10d20kh3 P(3)",
    );

    // Compounding + keep-highest (`4d6!!kh3`) is Exact with `max_explosions = Some(100)`.
    let comp_kh = analyze(&parse("4d6!!kh3").unwrap()).unwrap();
    assert_eq!(
        comp_kh.method,
        AnalysisMethod::Exact {
            caps: Some(ModelledCaps {
                max_explosions: Some(MAX_EXPLOSIONS),
                max_rerolls: None,
            })
        }
    );
    assert_eq!(comp_kh.stats.min, 3);
    assert_eq!(comp_kh.stats.max, 3 * 606);

    // §5.2 Cost guard: stays within `MAX_ANALYZE_DICE = 1_000` and has final support `<< 10^7`,
    // yet inner DP transitions exceed `MAX_EXACT_STATES`, cleanly aborting to Monte Carlo!
    let dp_guard_expr = if cfg!(target_arch = "wasm32") {
        "50d1000kh25"
    } else {
        "200d1000kh100"
    };
    let dp_fallback = analyze(&parse(dp_guard_expr).unwrap()).unwrap();
    assert_eq!(
        dp_fallback.method,
        AnalysisMethod::MonteCarlo {
            samples: DEFAULT_MONTE_CARLO_SAMPLES
        }
    );
}

#[test]
fn budgets_binary_algebra_compare_two_pointer_and_query_contracts() {
    // 1. MAX_ANALYZE_DICE budget (`1_000` allowed, `1_001` rejected before work).
    let exact_limit = parse("500d6+500d6").unwrap();
    assert_eq!(exact_limit.total_base_dice(), MAX_ANALYZE_DICE);
    let r_1000 = analyze(&exact_limit).unwrap();
    assert_eq!(r_1000.method, AnalysisMethod::Exact { caps: None });
    assert_close(r_1000.stats.mean, 3500.0, 1e-10, "1000d6 mean");

    assert_eq!(
        analyze(&parse("1001d6").unwrap()),
        Err(RollError::AnalysisBudgetExceeded {
            total_dice: 1_001,
            max: 1_000,
        })
    );
    assert_eq!(
        compare(&parse("600d6+401d6").unwrap(), &parse("1d6").unwrap()),
        Err(RollError::AnalysisBudgetExceeded {
            total_dice: 1_001,
            max: 1_000,
        })
    );

    // 2. Non-constant exact multiplication `(1d6)*(1d6)` (`§5.3`).
    let prod = analyze(&parse("(1d6)*(1d6)").unwrap()).unwrap();
    assert_eq!(prod.method, AnalysisMethod::Exact { caps: None });
    assert_eq!(prod.distribution.len(), 18);
    assert_close(prod.stats.mean, 12.25, 1e-14, "(1d6)*(1d6) mean");
    assert_close(
        prod.distribution.prob_exactly(6),
        4.0 / 36.0,
        1e-15,
        "P(prod=6)",
    );
    assert_close(
        prod.distribution.prob_exactly(12),
        4.0 / 36.0,
        1e-15,
        "P(prod=12)",
    );
    assert_close(
        prod.distribution.prob_exactly(36),
        1.0 / 36.0,
        1e-15,
        "P(prod=36)",
    );

    // Scalar zero multiplication collapses to `{0}` with unit probability.
    let zero_mul = analyze(&parse("0*2d6").unwrap()).unwrap();
    assert_eq!(zero_mul.distribution.len(), 1);
    assert_close(
        zero_mul.distribution.prob_exactly(0),
        1.0,
        1e-14,
        "0*2d6 P(0)",
    );
    let neg_mul = analyze(&parse("-2*1d4").unwrap()).unwrap();
    assert_eq!(neg_mul.stats.min, -8);
    assert_eq!(neg_mul.stats.max, -2);

    // Subtraction at `i64::MIN` without spurious `-i64::MIN` intermediate overflow:
    // `(-1) - (-9223372036854775808) == i64::MAX`.
    let min_sub = analyze(&parse("-1--9223372036854775808").unwrap()).unwrap();
    assert_eq!(min_sub.distribution, Distribution::point(i64::MAX));
    let cmp_min = compare(
        &parse("-1").unwrap(),
        &parse("-9223372036854775808").unwrap(),
    )
    .unwrap();
    assert_eq!(cmp_min.p_left_greater, 1.0);
    assert_eq!(cmp_min.margin, Some(Distribution::point(i64::MAX)));

    // 3. `compare` with exact margin vs symmetric two-pointer fallback (`100d100` vs `100d100`).
    let cmp_small = compare(&parse("4d6kh3").unwrap(), &parse("3d6").unwrap()).unwrap();
    assert_eq!(cmp_small.method, AnalysisMethod::Exact { caps: None });
    assert!(cmp_small.margin.is_some());
    assert_close(
        cmp_small.p_left_greater + cmp_small.p_equal + cmp_small.p_right_greater,
        1.0,
        1e-12,
        "compare probability conservation",
    );
    assert!(cmp_small.p_left_greater > cmp_small.p_right_greater);

    // `32d100` has support `3,169` (`3169^2 = 10,042,561 > MAX_EXACT_STATES`), triggering
    // the two-pointer fallback while small enough to verify against a direct quadratic check!
    let d32 = parse("32d100").unwrap();
    let cmp_32 = compare(&d32, &d32).unwrap();
    assert_eq!(cmp_32.method, AnalysisMethod::Exact { caps: None });
    assert!(cmp_32.margin.is_none());
    assert_eq!(cmp_32.p_left_greater, cmp_32.p_right_greater);
    let mut quad_gt = 0.0_f64;
    let mut quad_gt_comp = 0.0_f64;
    let mut quad_eq = 0.0_f64;
    for &(va, pa) in cmp_32.left.distribution.entries() {
        for &(vb, pb) in cmp_32.right.distribution.entries() {
            if va > vb {
                let y = (pa * pb) - quad_gt_comp;
                let t = quad_gt + y;
                quad_gt_comp = (t - quad_gt) - y;
                quad_gt = t;
            } else if va == vb {
                quad_eq += pa * pb;
            }
        }
    }
    assert_close(
        cmp_32.p_left_greater,
        quad_gt,
        1e-13,
        "two-pointer vs Kahan quadratic gt",
    );
    assert_close(
        cmp_32.p_equal,
        quad_eq,
        1e-13,
        "two-pointer vs quadratic eq",
    );

    let d100 = parse("100d100").unwrap();
    let cmp_100 = compare(&d100, &d100).unwrap();
    assert_eq!(cmp_100.method, AnalysisMethod::Exact { caps: None });
    assert!(cmp_100.margin.is_none());
    assert_eq!(cmp_100.p_left_greater, cmp_100.p_right_greater);
    assert_eq!(cmp_100.mean_margin, 0.0);
    assert_close(
        cmp_100.p_left_greater + cmp_100.p_equal + cmp_100.p_right_greater,
        1.0,
        1e-11,
        "100d100 compare sum",
    );

    // 4. Deterministic Monte Carlo stream (`4d6!kh3` and `500d1000`).
    let mc1 = analyze(&parse("4d6!kh3").unwrap()).unwrap();
    let mc2 = analyze(&parse("4d6!kh3").unwrap()).unwrap();
    assert_eq!(
        mc1.method,
        AnalysisMethod::MonteCarlo {
            samples: DEFAULT_MONTE_CARLO_SAMPLES
        }
    );
    assert_eq!(mc1, mc2);
    let direct_mc = monte_carlo_distribution(&parse("4d6!kh3").unwrap(), 1_000).unwrap();
    assert_close(
        direct_mc.entries().iter().map(|&(_, p)| p).sum::<f64>(),
        1.0,
        1e-12,
        "monte_carlo_distribution sum",
    );

    // Oversized exact support (`15d1000`, where `11d1000 * 1d1000 = 10,990,000 > MAX_EXACT_STATES`)
    // aborts `try_exact` via `ExactAbort::TooLarge` and falls back to deterministic Monte Carlo.
    let mc_big = analyze(&parse("15d1000").unwrap()).unwrap();
    assert_eq!(
        mc_big.method,
        AnalysisMethod::MonteCarlo {
            samples: DEFAULT_MONTE_CARLO_SAMPLES
        }
    );

    // 5. Query edge cases & InvalidProbability validation.
    assert_eq!(prod.distribution.prob_in_range(10, 5), 0.0);
    assert_eq!(compute_stats(&Distribution::point(9)).stddev, 0.0);
    assert_eq!(compute_stats(&Distribution::point(9)).entropy, 0.0);
    for bad_p in [
        0.0,
        -0.1,
        1.000_001,
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
    ] {
        assert!(matches!(
            prod.distribution
                .target_for_probability(bad_p, TargetDirection::AtLeast),
            Err(RollError::InvalidProbability { .. })
        ));
        assert!(matches!(
            prod.distribution
                .target_for_probability(bad_p, TargetDirection::AtMost),
            Err(RollError::InvalidProbability { .. })
        ));
    }

    // Direct `lemire_witness_word` sanity check across boundary offsets.
    let span6 = NonZeroU64::new(6).unwrap();
    for k in 0..6 {
        let w = lemire_witness_word(span6, k);
        let prod = u128::from(w) * 6u128;
        assert_eq!((prod >> 64) as u64, k);
        assert!((prod as u64) >= 6);
    }
}

#[test]
fn section_5_4_reachability_underflow_and_four_numbered_divide_by_zero_cases() {
    // Underflow reachability (`5d20r=1`): outcome `5` has exact rational probability `20^-505`,
    // which underflows IEEE-754 `f64` (`< 5e-324`) to `0.0`, yet remains reachable in the support!
    let underflow = analyze(&parse("5d20r=1").unwrap()).unwrap();
    assert!(underflow.distribution.is_reachable(5));
    assert!(underflow.distribution.is_reachable(6));
    assert!(underflow.distribution.is_reachable(7));
    assert!(!underflow.distribution.is_reachable(4));
    assert_eq!(underflow.distribution.prob_exactly(5), 0.0);
    assert!(underflow.distribution.prob_exactly(8) > 0.0);
    assert_eq!(underflow.stats.min, 5);
    assert_eq!(underflow.stats.max, 100);
    assert_eq!(underflow.distribution.len(), 96);
    // Tiny positive `p = 1e-300` must NOT false-match underflowed `0.0` outcomes `5, 6, 7`:
    assert_eq!(
        underflow
            .distribution
            .target_for_probability(1e-300, TargetDirection::AtMost)
            .unwrap(),
        8
    );
    // Dividing by `5d20r=1 - 5` or `5d20r=1kh3 - 3` (where `P(0)` underflowed to `0.0` in `f64`)
    // MUST still return `Err(RollError::DivisionByZero)` via `is_reachable(0)`!
    assert_eq!(
        analyze(&parse("1d6/(5d20r=1-5)").unwrap()),
        Err(RollError::DivisionByZero)
    );
    assert_eq!(
        analyze(&parse("1d6/(5d20r=1kh3-3)").unwrap()),
        Err(RollError::DivisionByZero)
    );

    // §5.4 Numbered Case 1: Exact divisor with `0` reachable via `MAX_REROLLS = 100` residual (`1d6/(1d100r<=99-50)`).
    assert_eq!(
        analyze(&parse("1d6/(1d100r<=99-50)").unwrap()),
        Err(RollError::DivisionByZero)
    );

    // §5.4 Numbered Case 2: Exact divisor with `0` reachable (`20^-5`), dividend exceeds `MAX_EXACT_STATES`
    // (`500d1000/(5d20-5)`), plus sibling branch isolation (`(1d6/(5d20-5))+500d1000` and `(4d6!kh3)/(5d20-5)`).
    assert_eq!(
        analyze(&parse("500d1000/(5d20-5)").unwrap()),
        Err(RollError::DivisionByZero)
    );
    assert_eq!(
        analyze(&parse("(1d6/(5d20-5))+500d1000").unwrap()),
        Err(RollError::DivisionByZero)
    );
    assert_eq!(
        analyze(&parse("(4d6!kh3)/(5d20-5)").unwrap()),
        Err(RollError::DivisionByZero)
    );

    // §5.4 Numbered Case 3: Non-exact divisor (`5d20!kh4-4`, `P(0) = 20^-5 ~ 3.125e-7`) where `0` is NOT
    // sampled during the `100,000`-trial `MONTE_CARLO_DEFAULT_SEED` run -> returns `Ok` with `MonteCarlo`.
    let case3 = analyze(&parse("1d6/(5d20!kh4-4)").unwrap()).unwrap();
    assert_eq!(
        case3.method,
        AnalysisMethod::MonteCarlo {
            samples: DEFAULT_MONTE_CARLO_SAMPLES
        }
    );

    // §5.4 Numbered Case 4: Non-exact divisor (`4d6!kh3-12`) where `0` IS sampled during the
    // `100,000`-trial `MONTE_CARLO_DEFAULT_SEED` run -> propagates `Err(RollError::DivisionByZero)`.
    assert_eq!(
        analyze(&parse("1d6/(4d6!kh3-12)").unwrap()),
        Err(RollError::DivisionByZero)
    );
}
