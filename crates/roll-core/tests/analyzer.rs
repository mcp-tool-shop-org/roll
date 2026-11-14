#![forbid(unsafe_code)]

use core::num::NonZeroU64;
use roll_core::{
    AnalysisMethod, DEFAULT_MONTE_CARLO_SAMPLES, Distribution, KeepDropOp, MAX_ANALYZE_DICE,
    MAX_EXPLOSIONS, MAX_REROLLS, MIN_MONTE_CARLO_SAMPLES, ModelledCaps, RollError, TargetDirection,
    analyze, compare, compute_stats, lemire_witness_word, monte_carlo_distribution, parse,
    reduce_keep_drop_interval,
};

/// Sample count of a Monte Carlo method, after checking its `ci95_half_width`.
fn mc_samples(method: AnalysisMethod) -> u32 {
    match method {
        AnalysisMethod::MonteCarlo {
            samples,
            ci95_half_width,
        } => {
            let expected = 1.96 * (0.25 / f64::from(samples)).sqrt();
            assert!(
                (ci95_half_width - expected).abs() <= 1e-15,
                "ci95_half_width {ci95_half_width} != {expected} at {samples} samples"
            );
            samples
        }
        other => panic!("expected MonteCarlo, got {other:?}"),
    }
}

fn assert_close(actual: f64, expected: f64, tol: f64, label: &str) {
    let diff = (actual - expected).abs();
    assert!(
        diff <= tol,
        "{label}: actual={actual:.17e}, expected={expected:.17e}, diff={diff:.3e} > tol={tol:.3e}"
    );
}

fn sum_pmf_compensated(dist: &Distribution) -> f64 {
    let mut sum = 0.0_f64;
    let mut comp = 0.0_f64;
    for &(_, p) in dist.entries() {
        let t = sum + p;
        if sum.abs() >= p.abs() {
            comp += (sum - t) + p;
        } else {
            comp += (p - t) + sum;
        }
        sum = t;
    }
    sum + comp
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
    // Sample counts are deterministic: the exact DP's spent transitions are charged against the
    // same work ceiling, so `200d1000kh100` stops short of the default 100,000.
    for (dp_guard_expr, samples) in [("50d1000kh25", 100_000), ("200d1000kh100", 77_102)] {
        let dp_fallback = analyze(&parse(dp_guard_expr).unwrap()).unwrap();
        assert_eq!(mc_samples(dp_fallback.method), samples, "{dp_guard_expr}");
    }
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
        AnalysisMethod::monte_carlo(DEFAULT_MONTE_CARLO_SAMPLES)
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
        AnalysisMethod::monte_carlo(DEFAULT_MONTE_CARLO_SAMPLES)
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

    // §5.4 Numbered Case 3: a divisor too large for the exact pass (`5d20!kh4-4`) whose zero has
    // `P(0) = 20^-5` and is never sampled. The support pass sees it anyway: with no die exploding, the
    // four kept dice can all be `1`, so the zero is reachable and the engine can raise it.
    assert_eq!(
        analyze(&parse("1d6/(5d20!kh4-4)").unwrap()),
        Err(RollError::DivisionByZero)
    );

    // §5.4 Numbered Case 4: Non-exact divisor (`4d6!kh3-12`) where `0` IS sampled during the
    // `100,000`-trial `MONTE_CARLO_DEFAULT_SEED` run -> propagates `Err(RollError::DivisionByZero)`.
    assert_eq!(
        analyze(&parse("1d6/(4d6!kh3-12)").unwrap()),
        Err(RollError::DivisionByZero)
    );
}

#[test]
fn wide_clamps_preserve_unit_mass_and_quantile_one_returns_true_extrema() {
    // Single-point wide clamps normalize to exact `(v, 1.0)` with zero drift across 1,000 dice.
    for (expr_str, expected_point) in [
        ("1000d999997min999997", 999_997_000_i64),
        ("1000d777777min777777", 777_777_000_i64),
        ("1000d999997max1", 1_000_i64),
    ] {
        let rep = analyze(&parse(expr_str).unwrap()).unwrap();
        assert_eq!(rep.method, AnalysisMethod::Exact { caps: None });
        assert_eq!(rep.distribution, Distribution::point(expected_point));
        let mass: f64 = rep.distribution.entries().iter().map(|&(_, p)| p).sum();
        assert_eq!(mass, 1.0, "{expr_str} singleton mass must be 1.0");
        assert_eq!(
            rep.distribution
                .target_for_probability(1.0, TargetDirection::AtMost)
                .unwrap(),
            rep.stats.max
        );
        assert_eq!(
            rep.distribution
                .target_for_probability(1.0, TargetDirection::AtLeast)
                .unwrap(),
            rep.stats.min
        );
    }

    // Two-point and multi-point wide clamps (both direct integer-count path and post-`ro` Neumaier path)
    // conserve mass within `1e-12` and return `stats.max` on `target_for_probability(1.0, AtMost)`.
    for (expr_str, expected_min, expected_max) in [
        ("1000d777777min777776", 777_776_000_i64, 777_777_000_i64),
        ("1000d999997min999995", 999_995_000_i64, 999_997_000_i64),
        ("1000d777777max2", 1_000_i64, 2_000_i64),
        ("1000d777777ro=1min777776", 777_776_000_i64, 777_777_000_i64),
    ] {
        let rep = analyze(&parse(expr_str).unwrap()).unwrap();
        assert_eq!(rep.method, AnalysisMethod::Exact { caps: None });
        assert_eq!(rep.stats.min, expected_min);
        assert_eq!(rep.stats.max, expected_max);
        let mass: f64 = rep.distribution.entries().iter().map(|&(_, p)| p).sum();
        assert_close(mass, 1.0, 1e-12, expr_str);
        assert_eq!(
            rep.distribution
                .target_for_probability(1.0, TargetDirection::AtMost)
                .unwrap(),
            expected_max,
            "{expr_str} target_for_probability(1.0, AtMost) must hit true max"
        );
        assert_eq!(
            rep.distribution
                .target_for_probability(1.0, TargetDirection::AtLeast)
                .unwrap(),
            expected_min,
            "{expr_str} target_for_probability(1.0, AtLeast) must hit true min"
        );
    }
}

#[test]
fn ast_wide_budget_bounds_adversarial_inputs_in_time_and_method() {
    use std::time::{Duration, Instant};

    let bound = if cfg!(all(not(debug_assertions), not(target_arch = "wasm32"))) {
        Duration::from_secs(1)
    } else {
        Duration::from_secs(60)
    };

    // 1. Reported input #1: 52 copies of `(3163*d3162+d3162)` on a left-associative `+` spine (987 B, 104 dice).
    let spine_left = vec!["(3163*d3162+d3162)"; 52].join("+");
    assert_eq!(spine_left.len(), 987);

    // 2. Right-associative parenthesized mirror: 47 nested `(term+(term+...))` copies (984 B, 94 dice).
    let mut spine_right = String::from("(3163*d3162+d3162)");
    for _ in 1..47 {
        spine_right = format!("((3163*d3162+d3162)+{spine_right})");
    }
    assert_eq!(spine_right.len(), 984);

    // 3. Reported input #2: `"d999999"` followed by 248 `"/d10"` steps (999 B, 249 dice).
    let div_chain = format!("d999999{}", "/d10".repeat(248));
    assert_eq!(div_chain.len(), 999);

    // Sample counts are deterministic and pinned. Inputs that reach the default 100,000 samples
    // stop short of the work ceiling and keep the time bound; the two that run to the ceiling
    // (`div_k248`, `dp_200d1000kh100`) are not timed here (see `runs_ceiling_inputs`).
    let full_mc_cases: &[(&str, &str, u32)] = &[
        ("spine_k52_left", &spine_left, DEFAULT_MONTE_CARLO_SAMPLES),
        ("spine_k47_right", &spine_right, DEFAULT_MONTE_CARLO_SAMPLES),
        ("div_k248", &div_chain, 84_159),
        (
            "wide_explosion_1m",
            "1d1000000!",
            DEFAULT_MONTE_CARLO_SAMPLES,
        ),
        (
            "deep_explosion_100k",
            "1d100000!>=1",
            DEFAULT_MONTE_CARLO_SAMPLES,
        ),
        ("dp_200d1000kh100", "200d1000kh100", 77_102),
        (
            "sparse_mul_3162",
            "(1d3162)*(1d3162)",
            DEFAULT_MONTE_CARLO_SAMPLES,
        ),
    ];

    for &(label, expr_str, samples) in full_mc_cases {
        assert!(expr_str.len() <= roll_core::MAX_EXPRESSION_BYTES);
        let expr = parse(expr_str).unwrap();
        let t0 = Instant::now();
        let rep = analyze(&expr).unwrap();
        let elapsed = t0.elapsed();
        if samples == DEFAULT_MONTE_CARLO_SAMPLES {
            assert!(
                elapsed < bound,
                "{label} exceeded time bound {:?}: {:?}",
                bound,
                elapsed
            );
        }
        assert_eq!(mc_samples(rep.method), samples, "{label}");
        let mass = sum_pmf_compensated(&rep.distribution);
        assert_close(mass, 1.0, 1e-12, label);
    }

    // 4. Adversarial `< 1,000`-byte expressions whose per-sample cost exercises the work ceiling:
    //    above the floor they report the real count, below it they are refused (`§5.3`).
    let chained_reroll_mc = format!("10d6{}!kh1", "r>=1".repeat(240));
    let chained_keep_mc = format!("1000d6!{}", "kh999".repeat(198));
    let budgeted_mc_cases: &[(&str, &str, Option<u32>)] = &[
        ("uniform_1000d100", "1000d100", Some(95_854)),
        ("dp_1000d1m_kh500", "1000d1000000kh500", Some(16_907)),
        ("capped_reroll_explode_1000d6", "1000d6r>=1!>=1kh500", None),
        ("chained_240_rerolls", &chained_reroll_mc, None),
        ("chained_198_keep_drops", &chained_keep_mc, None),
    ];

    for &(label, expr_str, expected) in budgeted_mc_cases {
        assert!(expr_str.len() <= roll_core::MAX_EXPRESSION_BYTES);
        if expected.is_some() && !runs_ceiling_inputs() {
            // Samples close to the work ceiling: pinned in native release only.
            continue;
        }
        let expr = parse(expr_str).unwrap();
        let t0 = Instant::now();
        let res = analyze(&expr);
        let elapsed = t0.elapsed();
        // Refusals stop early and keep the time bound; sampled counts are pinned, not timed.
        if expected.is_none() {
            assert!(
                elapsed < bound,
                "{label} exceeded time bound {:?}: {:?}",
                bound,
                elapsed
            );
        }
        match (expected, res) {
            (Some(samples), Ok(rep)) => {
                assert_eq!(mc_samples(rep.method), samples, "{label}");
                assert_close(sum_pmf_compensated(&rep.distribution), 1.0, 1e-12, label);
            }
            (
                None,
                Err(RollError::AnalysisTooExpensive {
                    samples_affordable,
                    min_samples,
                }),
            ) => {
                assert!(samples_affordable < min_samples, "{label}");
                assert_eq!(min_samples, MIN_MONTE_CARLO_SAMPLES);
            }
            (want, got) => panic!("{label}: expected {want:?} samples, got {got:?}"),
        }
    }

    // 5. §5.4 Divisor-first interaction with the AST-wide budget: an oversized left sibling on `+`
    //    must NOT starve an exact divisor with reachable `0` on the right!
    assert_eq!(
        analyze(&parse("500d1000+(1d6/(5d20-5))").unwrap()),
        Err(RollError::DivisionByZero)
    );
    let spine_then_zero_div = format!(
        "{}+(1d6/(5d20-5))",
        vec!["(3163*d3162+d3162)"; 40].join("+")
    );
    assert!(spine_then_zero_div.len() <= roll_core::MAX_EXPRESSION_BYTES);
    assert_eq!(
        analyze(&parse(&spine_then_zero_div).unwrap()),
        Err(RollError::DivisionByZero)
    );
}

#[test]
fn regression_flaky_proptest_5d9_compound_keep_lowest_returns_monte_carlo() {
    // Regression for CI run 43596669077: each `d9!!>2` die has 908 reachable outcomes up to
    // `MAX_EXPLOSIONS = 100` (`1..=909` skipping `3`), so `5d9!!>2kl2` legitimately requires
    // ~10.29M order-statistic DP transitions across `dp[0..=5]`, exceeding `MAX_EXACT_STATES`
    // (`10,000,000`) and falling back to `AnalysisMethod::MonteCarlo` (PR #17 bounded the
    // exact-only proptest generator accordingly).
    let expr = parse("5d9!!>2kl2 / -2").unwrap();
    assert_eq!(expr.to_canonical_string(), "5d9!!>2kl2/-2");

    let rep = analyze(&expr).unwrap();
    assert_eq!(
        rep.method,
        AnalysisMethod::monte_carlo(DEFAULT_MONTE_CARLO_SAMPLES)
    );
    assert!(rep.stats.min >= -909 && rep.stats.max <= -1);
    let mass = sum_pmf_compensated(&rep.distribution);
    assert_close(mass, 1.0, 1e-12, "5d9!!>2kl2/-2 mass");
    assert_eq!(
        rep.distribution
            .target_for_probability(1.0, TargetDirection::AtMost)
            .unwrap(),
        rep.stats.max
    );
}

#[test]
fn divisor_prepass_catches_reachable_zero_regardless_of_sibling_order_or_budget() {
    // 1. Exact 73-byte input from the #18 review (both operands of `+` contain a division, and the
    //    left operand spends ~5M transitions before `1d6/(5d20-5)`, or ~10M with 10 knobs).
    let left_heavy_73 = "(1d999990*0+1d999990*0+1d999990*0+1d999990*0+1d999899*0+1/1)+1d6/(5d20-5)";
    assert_eq!(left_heavy_73.len(), 73);
    assert_eq!(
        analyze(&parse(left_heavy_73).unwrap()),
        Err(RollError::DivisionByZero)
    );

    // 2. Mirror: budget-heavy sibling on the right, both sides containing a division (73 B).
    let right_heavy_73 =
        "1d6/(5d20-5)+(1d999990*0+1d999990*0+1d999990*0+1d999990*0+1d999899*0+1/1)";
    assert_eq!(right_heavy_73.len(), 73);
    assert_eq!(
        analyze(&parse(right_heavy_73).unwrap()),
        Err(RollError::DivisionByZero)
    );

    // 3. Zero divisor sitting deep inside the budget-heavy side (with divisions on both branches
    //    at every `+` level AND with 10 `1d999990*0` terms exhausting the full 10M main budget).
    let deep_79 = "((1/1+1d999990*0+1d999990*0+1d999990*0+1d999990*0+1d999899*0)+1d6/(5d20-5))+1/1";
    assert_eq!(deep_79.len(), 79);
    assert_eq!(
        analyze(&parse(deep_79).unwrap()),
        Err(RollError::DivisionByZero)
    );

    let ten_knobs = ["1d999990*0"; 10].join("+");
    let deep_10m = format!("(((1/1+{ten_knobs})+1d6/(5d20-5))+{ten_knobs})+1/1");
    assert!(deep_10m.len() <= roll_core::MAX_EXPRESSION_BYTES);
    assert_eq!(
        analyze(&parse(&deep_10m).unwrap()),
        Err(RollError::DivisionByZero)
    );
}

#[test]
fn divisor_prepass_orders_cheapest_first_breaks_ties_by_byte_offset_and_prioritizes_zero_over_other_errors()
 {
    // 1. Cheapest-first by static cost bound (`§5.4` item 1):
    //    11 copies of `1/(1d1000*1d1000)` (`2,002,000` actual transitions each -> `22,022,000 > MAX_DIVISOR_PREPASS_STATES = 20,000,000`)
    //    appear BEFORE `1/(5d20-5)` in source order. Without cheapest-first ordering, the 11 non-zero
    //    divisors would exhaust `MAX_DIVISOR_PREPASS_STATES` (and `MAX_EXACT_STATES` in the main pass),
    //    forcing MC (`P(0) = 20^-5`, missed by `MONTE_CARLO_DEFAULT_SEED`). With cheapest-first ordering,
    //    `5d20-5` runs first and returns `Err(RollError::DivisionByZero)`.
    let eleven_heavy_divisors = ["1/(1d1000*1d1000)"; 11].join("+");
    let cheapest_first_expr = format!("{eleven_heavy_divisors}+1/(5d20-5)");
    assert!(cheapest_first_expr.len() <= roll_core::MAX_EXPRESSION_BYTES);
    assert_eq!(
        analyze(&parse(&cheapest_first_expr).unwrap()),
        Err(RollError::DivisionByZero)
    );

    // 2. Tie-breaking by source byte offset (`§5.4` item 1):
    //    `1d1000*1d1000-998001` (`998,001 = 999 * 999`, reachable `0` with `P(0) = 1e-6`, missed by MC)
    //    and 10 copies of `1d1000*1d1000-999999` (`999,999 = 999 * 1001`, unreachable `0`, `2,002,010`
    //    transitions each -> `> 20,000,000` total) have identical dice counts, sides, and operators, so
    //    they tie on `divisor_static_cost_bound`. Breaking ties by ascending source byte offset checks
    //    the first divisor (`-998001`) before the 10 `-999999` divisors exhaust the pre-pass budget.
    let ten_tied_nonzero = ["1/(1d1000*1d1000-999999)"; 10].join("+");
    let tie_break_expr = format!("1/(1d1000*1d1000-998001)+{ten_tied_nonzero}");
    assert!(tie_break_expr.len() <= roll_core::MAX_EXPRESSION_BYTES);
    assert_eq!(
        analyze(&parse(&tie_break_expr).unwrap()),
        Err(RollError::DivisionByZero)
    );

    // 3. Every exact divisor is checked for a reachable `0` before returning any other pre-pass error
    //    (`§5.4` items 1 & 5):
    //    a) and b) (#20 finding 1b): the left divisor overflows on every evaluation, and the engine
    //       evaluates it first, so the later zero divisor is never reached. The analyzer reports
    //       the engine's error, `ArithmeticOverflow`, not a `DivisionByZero` the engine cannot raise.
    assert_eq!(
        analyze(&parse("1/(9223372036854775807+1)+1/(5d20-5)").unwrap()),
        Err(RollError::ArithmeticOverflow)
    );
    assert_eq!(
        analyze(&parse("1/(9223372036854775807+1d6)+1/(1d6-1)").unwrap()),
        Err(RollError::ArithmeticOverflow)
    );
    //       With the zero divisor first, both errors are reachable and the zero wins (`§5.4` item 5).
    assert_eq!(
        analyze(&parse("1/(1d6-1)+1/(9223372036854775807+1d6)").unwrap()),
        Err(RollError::DivisionByZero)
    );
    //    c) When NO exact divisor has a reachable `0`, the deferred divisor error still surfaces
    //       even alongside an oversized sibling (`500d1000`).
    assert_eq!(
        analyze(&parse("1/(9223372036854775807+1d6)+1/(1d6+1)+500d1000").unwrap()),
        Err(RollError::ArithmeticOverflow)
    );
}

#[test]
fn monte_carlo_scan_budget_refuses_q1_inputs_15_to_19_under_one_second() {
    use std::time::{Duration, Instant};

    let bound = if cfg!(all(not(debug_assertions), not(target_arch = "wasm32"))) {
        Duration::from_secs(1)
    } else {
        Duration::from_secs(60)
    };

    let q1_15 = format!("996d6!kh995{}", "r=7".repeat(240));
    let q1_16 = format!("996d6!kh995{}", "ro=7".repeat(240));
    let q1_17 = format!("1000d6!>=7{}kh999", "ro=7".repeat(240));
    let q1_18 = format!("1000d6{}{}", "r=1".repeat(20), "ro=1".repeat(99));
    assert_eq!(q1_15.len(), 731);
    assert_eq!(q1_16.len(), 971);
    assert_eq!(q1_17.len(), 975);
    assert_eq!(q1_18.len(), 462);

    for (label, expr_str) in [
        ("q1_15_996d6_explode_kh995_240_r7", q1_15.as_str()),
        ("q1_16_996d6_explode_kh995_240_ro7", q1_16.as_str()),
        ("q1_17_1000d6_explode7_240_ro7_kh999", q1_17.as_str()),
        ("q1_18_1000d6_20_r1_99_ro1", q1_18.as_str()),
    ] {
        let expr = parse(expr_str).unwrap();
        let t0 = Instant::now();
        let res = analyze(&expr);
        let elapsed = t0.elapsed();
        assert!(
            elapsed < bound,
            "{label} exceeded time bound {:?}: {:?}",
            bound,
            elapsed
        );
        // Each sample scans or rolls about a thousand dice hundreds of times, so fewer than
        // `MIN_MONTE_CARLO_SAMPLES` fit the ceiling: refused, with no low-sample estimate.
        match res {
            Err(RollError::AnalysisTooExpensive {
                samples_affordable,
                min_samples,
            }) => {
                assert!(samples_affordable < MIN_MONTE_CARLO_SAMPLES, "{label}");
                assert_eq!(min_samples, MIN_MONTE_CARLO_SAMPLES);
            }
            other => panic!("{label} expected AnalysisTooExpensive, got {other:?}"),
        }
    }

    // Q1 #19: `compare(#15, #15)` is refused the same way, well under 1 second in release.
    let expr_15 = parse(&q1_15).unwrap();
    let t_cmp = Instant::now();
    let cmp_res = compare(&expr_15, &expr_15);
    let elapsed_cmp = t_cmp.elapsed();
    assert!(
        elapsed_cmp < bound,
        "q1_19 compare(#15, #15) exceeded time bound {:?}: {:?}",
        bound,
        elapsed_cmp
    );
    assert!(matches!(
        cmp_res,
        Err(RollError::AnalysisTooExpensive { .. })
    ));
}

#[test]
fn restored_exact_expressions_and_draw_gate_retry_margin() {
    use roll_core::{EXACT_DRAW_RETRY_MARGIN, MAX_EXACT_DIE_ROLLS, MAX_TOTAL_DRAWS};
    use std::time::{Duration, Instant};

    assert_eq!(EXACT_DRAW_RETRY_MARGIN, 80_000);
    assert_eq!(
        MAX_EXACT_DIE_ROLLS,
        u64::from(MAX_TOTAL_DRAWS) - EXACT_DRAW_RETRY_MARGIN
    );
    assert_eq!(MAX_EXACT_DIE_ROLLS, 2_020_000);

    let bound = if cfg!(all(not(debug_assertions), not(target_arch = "wasm32"))) {
        Duration::from_secs(1)
    } else {
        Duration::from_secs(60)
    };

    let sum_200_5d6 = format!("{}1", "5d6+".repeat(200));
    let sum_100_10d6 = format!("{}1", "10d6+".repeat(100));
    assert_eq!(sum_200_5d6.len(), 801);
    assert_eq!(sum_100_10d6.len(), 501);

    let reroll_cap = Some(ModelledCaps {
        max_explosions: None,
        max_rerolls: Some(100),
    });

    type RestoredCase<'a> = (&'a str, Option<ModelledCaps>, i64, i64, Option<usize>, f64);

    // All 9 restored Problem 3 expressions return `AnalysisMethod::Exact` within budget and `< 1 s`.
    let restored_cases: &[RestoredCase<'_>] = &[
        ("1000d6r=1", reroll_cap, 1_000, 6_000, Some(5_001), 4_000.0),
        (
            "1000d6ro=1",
            None,
            1_000,
            6_000,
            Some(5_001),
            1_000.0 * (23.5 / 6.0),
        ),
        (
            "300d20ro=1",
            None,
            300,
            6_000,
            Some(5_701),
            300.0 * (19.0 * 11.0 + 10.5) / 20.0,
        ),
        (
            "100d100ro=1",
            None,
            100,
            10_000,
            Some(9_901),
            100.0 * (99.0 * 51.0 + 50.5) / 100.0,
        ),
        ("1000d20min2", None, 2_000, 20_000, Some(18_001), 10_550.0),
        (&sum_200_5d6, None, 1_001, 6_001, Some(5_001), 3_501.0),
        (&sum_100_10d6, None, 1_001, 6_001, Some(5_001), 3_501.0),
        ("1d1000*1d1000", None, 1, 1_000_000, None, 250_500.25),
        (
            "1d6+1d1000000",
            None,
            2,
            1_000_006,
            Some(1_000_005),
            500_004.0,
        ),
    ];

    for &(expr_str, expected_caps, min_v, max_v, expected_len, expected_mean) in restored_cases {
        let expr = parse(expr_str).unwrap();
        let t0 = Instant::now();
        let rep = analyze(&expr).unwrap();
        let elapsed = t0.elapsed();
        assert!(
            elapsed < bound,
            "restored exact case '{expr_str}' exceeded bound {:?}: {:?}",
            bound,
            elapsed
        );
        assert_eq!(
            rep.method,
            AnalysisMethod::Exact {
                caps: expected_caps
            },
            "'{expr_str}' must be Exact"
        );
        assert_eq!(rep.stats.min, min_v, "'{expr_str}' min");
        assert_eq!(rep.stats.max, max_v, "'{expr_str}' max");
        if let Some(len) = expected_len {
            assert_eq!(rep.distribution.len(), len, "'{expr_str}' support len");
        }
        assert_close(
            rep.stats.mean,
            expected_mean,
            1e-12 * expected_mean.abs().max(1.0),
            expr_str,
        );
        assert_close(sum_pmf_compensated(&rep.distribution), 1.0, 1e-12, expr_str);
    }

    // Problem 3 #10 (`1000d6` + 20 × `r=1` + 99 × `ro=1`): `expr_max_die_rolls == 2,100,000 == MAX_TOTAL_DRAWS`,
    // where a single 64-bit Lemire rejection retry (`2^64 mod 6 == 4 != 0`) triggers `DrawBudgetExceeded`
    // in `eval.rs`. Because `2,100,000 > MAX_EXACT_DIE_ROLLS (2,020,000)`, it is never `Exact`; its
    // 119,000 reroll scans per sample also keep it below the Monte Carlo floor, so it is refused.
    let p3_10 = format!("1000d6{}{}", "r=1".repeat(20), "ro=1".repeat(99));
    assert!(
        matches!(
            analyze(&parse(&p3_10).unwrap()),
            Err(RollError::AnalysisTooExpensive { .. })
        ),
        "2,100,000 max die rolls leaves 0 retry margin and must not claim Exact"
    );

    // Exact draw-gate boundary check (`2,020,000` -> `Exact`, `2,020,001` -> `MonteCarlo`):
    let at_gate = format!("1000d6{}{}", "r=1".repeat(20), "ro=1".repeat(19));
    let rep_at_gate = analyze(&parse(&at_gate).unwrap()).unwrap();
    assert_eq!(
        rep_at_gate.method,
        AnalysisMethod::Exact { caps: reroll_cap }
    );

    let one_over_gate = format!(
        "999d6{}{}+1d6{}{}",
        "r=1".repeat(20),
        "ro=1".repeat(19),
        "r=1".repeat(20),
        "ro=1".repeat(20)
    );
    let rep_over_gate = analyze(&parse(&one_over_gate).unwrap()).unwrap();
    assert!(matches!(
        rep_over_gate.method,
        AnalysisMethod::MonteCarlo { .. }
    ));
}

/// Time bound for inputs that stop well short of the analysis work ceiling.
fn quick_bound() -> std::time::Duration {
    if cfg!(all(not(debug_assertions), not(target_arch = "wasm32"))) {
        std::time::Duration::from_secs(1)
    } else {
        std::time::Duration::from_secs(60)
    }
}

/// Whether this build runs the inputs that sample up to the work ceiling (`MAX_ANALYSIS_WORK`, about
/// 0.93 s on the reference machine): native release only. Their sample counts are deterministic and
/// pinned exactly; their wall time is measured by the calibration probe, not asserted here, because
/// CI runners are about twice as slow as the reference machine.
fn runs_ceiling_inputs() -> bool {
    cfg!(all(not(debug_assertions), not(target_arch = "wasm32")))
}

#[test]
fn divisor_check_finds_review_zeros_a_and_b_in_every_sibling_order() {
    // #20 finding 1a: the shared pre-pass reserve let two ~9.4M-transition divisors starve a third,
    // and which one depended on order. The support pass decides each divisor on its own.
    let a = [
        "1d6/(1d3000+1d50000)",
        "1d6/(1d3000+1d50001)",
        "1d6/(1d3000+1d50000-2)",
    ];
    let b = [
        "1d6/(1d3000+1d50000)",
        "1d6/(1d3000+1d50001)",
        "1d6/(200d6kh100-100)",
    ];
    let orders = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];
    for terms in [a, b] {
        for order in orders {
            let src = order.map(|i| terms[i]).join("+");
            let t0 = std::time::Instant::now();
            let res = analyze(&parse(&src).unwrap());
            let elapsed = t0.elapsed();
            assert_eq!(res, Err(RollError::DivisionByZero), "{src}");
            assert!(elapsed < quick_bound(), "{src}: {elapsed:?}");
        }
    }
    // Each zero divisor alone is caught.
    assert_eq!(
        analyze(&parse(a[2]).unwrap()),
        Err(RollError::DivisionByZero)
    );
    assert_eq!(
        analyze(&parse(b[2]).unwrap()),
        Err(RollError::DivisionByZero)
    );
}

#[test]
fn analyzer_errors_are_errors_the_engine_raises_first() {
    let cases: &[(&str, RollError)] = &[
        // #20 finding 1b: the left divisor overflows on every evaluation, before the zero.
        (
            "1d6/(9223372036854775807+1d2)+1d6/(1d2-1)",
            RollError::ArithmeticOverflow,
        ),
        // Reversed, the zero is reached on half the evaluations and wins (`§5.4` item 5).
        (
            "1d6/(1d2-1)+1d6/(9223372036854775807+1d2)",
            RollError::DivisionByZero,
        ),
        // The main pass evaluates a division first on `+`, but the left operand always overflows.
        (
            "(9223372036854775807+1d2)+1d6/(1d2-1)",
            RollError::ArithmeticOverflow,
        ),
        (
            "(9223372036854775807+1d2)+500d1000/(1d2-1)",
            RollError::ArithmeticOverflow,
        ),
        // A too-large left operand that can succeed still lets the right operand error stand.
        (
            "500d1000+(9223372036854775807+1d2)",
            RollError::ArithmeticOverflow,
        ),
        ("500d1000/(5d20-5)", RollError::DivisionByZero),
    ];
    for (src, want) in cases {
        assert_eq!(analyze(&parse(src).unwrap()).as_ref(), Err(want), "{src}");
    }
}

#[test]
fn unchecked_divisor_refuses_a_sampled_result_and_exact_passes_still_decide() {
    // `1000003` is prime and above the die size, so this divisor is never `0`, but neither the
    // support pass nor an exact divisor round (10^12 pairs) can show it: a sampled result is refused.
    assert_eq!(
        analyze(&parse("1/(1d1000000*1d1000000-1000003)").unwrap()),
        Err(RollError::DivisorUnchecked { divisors: 1 })
    );
    // When the exact rounds can decide it, the answer is exact either way.
    assert_eq!(
        analyze(&parse("1/(1d1000*1d1000-998001)").unwrap()),
        Err(RollError::DivisionByZero)
    );
    let exact = analyze(&parse("1/(1d1000*1d1000-999999)").unwrap()).unwrap();
    assert!(matches!(exact.method, AnalysisMethod::Exact { .. }));
}

#[test]
fn monte_carlo_floor_refuses_low_sample_results_unless_opted_in() {
    use roll_core::analyze_with_min_samples;

    // Below the floor: refused quickly, with how many samples would fit.
    let q1_15 = parse(&format!("996d6!kh995{}", "r=7".repeat(240))).unwrap();
    let t0 = std::time::Instant::now();
    let refused = analyze(&q1_15);
    assert!(t0.elapsed() < quick_bound());
    let Err(RollError::AnalysisTooExpensive {
        samples_affordable,
        min_samples,
    }) = refused
    else {
        panic!("expected AnalysisTooExpensive, got {refused:?}");
    };
    assert_eq!(min_samples, MIN_MONTE_CARLO_SAMPLES);
    assert!(samples_affordable < MIN_MONTE_CARLO_SAMPLES);
    let msg = RollError::AnalysisTooExpensive {
        samples_affordable,
        min_samples,
    }
    .to_string();
    assert!(msg.contains("roll it instead"), "{msg}");

    // The only way to a low-sample estimate: an explicit floor.
    if runs_ceiling_inputs() {
        let low = analyze_with_min_samples(&q1_15, 1).unwrap();
        let n = mc_samples(low.method);
        assert!((1..MIN_MONTE_CARLO_SAMPLES).contains(&n), "{n}");
        assert_close(sum_pmf_compensated(&low.distribution), 1.0, 1e-12, "low");
        // A floor of 0 is clamped to 1.
        assert_eq!(analyze_with_min_samples(&q1_15, 0).unwrap(), low);
    }

    // The fixture draw-budget case still reports the engine error from its first sample.
    let draw = parse(&format!("1000d2{}!kh1", "r>=1".repeat(21))).unwrap();
    assert_eq!(
        analyze(&draw),
        Err(RollError::DrawBudgetExceeded {
            limit: roll_core::MAX_TOTAL_DRAWS
        })
    );

    // Above the floor, the default result reports its samples and worst-case half-width.
    let rep = analyze(&parse("4d6!kh3").unwrap()).unwrap();
    assert_eq!(mc_samples(rep.method), DEFAULT_MONTE_CARLO_SAMPLES);
    let AnalysisMethod::MonteCarlo {
        ci95_half_width, ..
    } = rep.method
    else {
        unreachable!("checked by mc_samples")
    };
    assert_close(ci95_half_width, 0.98 / 100_000_f64.sqrt(), 1e-15, "ci95");

    if runs_ceiling_inputs() {
        // The #20 review inputs that must reach the floor (4,665, 2,915 and 3,044 samples at main).
        for (src, samples) in [
            ("1000d6!p>=2", 13_207),
            ("1000d6!>=2kh500", 10_302),
            ("1000d6r<=5!kh999", 10_749),
        ] {
            let rep = analyze(&parse(src).unwrap()).unwrap();
            assert_eq!(mc_samples(rep.method), samples, "{src}");
            assert_close(sum_pmf_compensated(&rep.distribution), 1.0, 1e-12, src);
        }
    }
}

#[test]
fn compare_shares_one_work_ceiling_between_sampled_sides() {
    use roll_core::compare_with_min_samples;

    if !runs_ceiling_inputs() {
        return;
    }
    // #20 review C2: `compare(E, E)` with E = 124 x `d2!>1kh+` then `1` took about 1.10 s; each side
    // now samples under half of the ceiling.
    let n10 = parse(&format!("{}1", "d2!>1kh+".repeat(124))).unwrap();
    let alone = mc_samples(analyze(&n10).unwrap().method);
    assert_eq!(alone, 69_821);
    let cmp = compare(&n10, &n10).unwrap();
    let side = mc_samples(cmp.left.method);
    assert_eq!(side, mc_samples(cmp.right.method));
    assert_eq!(mc_samples(cmp.method), side);
    assert!(side >= MIN_MONTE_CARLO_SAMPLES && side < alone, "{side}");
    assert_eq!(cmp.p_left_greater, cmp.p_right_greater);

    // One sampled side against an exact side gets the whole remainder.
    let kh500 = parse("1000d6!>=2kh500").unwrap();
    let vs_exact = compare(&kh500, &parse("3d6").unwrap()).unwrap();
    assert_eq!(mc_samples(vs_exact.method), 10_302);
    assert!(matches!(
        vs_exact.right.method,
        AnalysisMethod::Exact { .. }
    ));

    // Two such sides do not both fit: refused, unless the caller lowers the floor.
    assert!(matches!(
        compare(&kh500, &kh500),
        Err(RollError::AnalysisTooExpensive { .. })
    ));
    let low = compare_with_min_samples(&kh500, &kh500, 1).unwrap();
    assert!(mc_samples(low.method) < MIN_MONTE_CARLO_SAMPLES);
}

#[test]
fn mode_is_the_smallest_outcome_within_relative_tolerance_of_the_maximum() {
    use roll_core::MODE_TIE_RELATIVE_TOLERANCE;

    // `(1d6)*(1d6)`: `6` and `12` both have probability 4/36.
    let prod = analyze(&parse("(1d6)*(1d6)").unwrap()).unwrap();
    assert_eq!(prod.stats.mode, 6);
    assert_eq!(
        prod.distribution.prob_exactly(6),
        prod.distribution.prob_exactly(12)
    );

    let dist = |entries: &[(i64, f64)]| -> Distribution {
        let body: Vec<String> = entries
            .iter()
            .map(|(v, p)| format!("[{v},{p:?}]"))
            .collect();
        serde_json::from_str(&format!("{{\"entries\":[{}]}}", body.join(","))).unwrap()
    };
    // A near-tie made by summation order: four 1/36 terms added in two different orders, and
    // the same value nudged one ulp up.
    let q = 1.0_f64 / 36.0;
    let left_to_right = ((q + q) + q) + q;
    let paired = (q + q) + (q + q);
    let one_ulp_up = f64::from_bits(left_to_right.to_bits() + 1);
    for (p6, p12) in [
        (left_to_right, paired),
        (left_to_right, one_ulp_up),
        (one_ulp_up, left_to_right),
    ] {
        // The other 7/9 of the mass is spread over ten outcomes below the tie.
        let mut entries = alloc_entries(p6, p12);
        entries.sort_by_key(|&(v, _)| v);
        let d = dist(&entries);
        assert_eq!(compute_stats(&d).mode, 6, "p6={p6:e} p12={p12:e}");
    }
    fn alloc_entries(p6: f64, p12: f64) -> Vec<(i64, f64)> {
        let rest = (1.0 - p6 - p12) / 10.0;
        let mut v: Vec<(i64, f64)> = (20..30).map(|k| (k, rest)).collect();
        v.push((6, p6));
        v.push((12, p12));
        v
    }
    // Beyond the tolerance the larger probability wins, whatever its position.
    let gap = 0.25 * (1.0 + 4.0 * MODE_TIE_RELATIVE_TOLERANCE);
    let d = dist(&[(1, 0.5 - gap), (6, 0.25), (12, gap)]);
    assert_eq!(compute_stats(&d).mode, 12);
}
