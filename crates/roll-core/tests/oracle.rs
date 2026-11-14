#![forbid(unsafe_code)]

use std::collections::BTreeSet;

use roll_core::{AnalysisMethod, analyze, parse, run_prefix_tape_oracle};

/// Asserts that `analyze(expr)` is `AnalysisMethod::Exact` and matches exhaustive black-box
/// prefix-tape enumeration (`tail_mass == 0.0`) over the real `eval.rs` engine within `1e-14`,
/// including exact reachable support key equality (`§9.3`).
fn assert_exhaustive_oracle(expr_str: &str, max_draws: usize) {
    let expr = parse(expr_str).unwrap_or_else(|e| panic!("parse failed for '{expr_str}': {e}"));
    let report = analyze(&expr).unwrap_or_else(|e| panic!("analyze failed for '{expr_str}': {e}"));
    assert!(
        matches!(report.method, AnalysisMethod::Exact { .. }),
        "expected Exact for '{expr_str}', got {:?}",
        report.method
    );

    let oracle = run_prefix_tape_oracle(&expr, max_draws, 0.0)
        .unwrap_or_else(|e| panic!("oracle failed for '{expr_str}': {e}"));
    assert_eq!(
        oracle.tail_mass, 0.0,
        "expected tail_mass == 0.0 for finite/capped '{expr_str}' (max_draws={max_draws})"
    );

    let exact_keys: Vec<i64> = report
        .distribution
        .entries()
        .iter()
        .map(|&(k, _)| k)
        .collect();
    let oracle_keys: Vec<i64> = oracle
        .distribution
        .entries()
        .iter()
        .map(|&(k, _)| k)
        .collect();
    assert_eq!(
        exact_keys, oracle_keys,
        "support mismatch for '{expr_str}': exact={exact_keys:?} vs oracle={oracle_keys:?}"
    );

    for &k in &exact_keys {
        let p_exact = report.distribution.prob_exactly(k);
        let p_oracle = oracle.distribution.prob_exactly(k);
        let diff = (p_exact - p_oracle).abs();
        assert!(
            diff <= 1e-14,
            "PMF mismatch on '{expr_str}' at outcome {k}: exact={p_exact:.17e}, oracle={p_oracle:.17e}, diff={diff:.3e}"
        );
    }
}

/// Asserts that `analyze(expr)` is `AnalysisMethod::Exact` and agrees with adaptive prefix-tape
/// enumeration (`tail_mass < 1e-7`) within the `§9.3` lower/upper bounds at every integer outcome.
fn assert_adaptive_oracle(expr_str: &str, max_draws: usize, min_branch_prob: f64) {
    let expr = parse(expr_str).unwrap_or_else(|e| panic!("parse failed for '{expr_str}': {e}"));
    let report = analyze(&expr).unwrap_or_else(|e| panic!("analyze failed for '{expr_str}': {e}"));
    assert!(
        matches!(report.method, AnalysisMethod::Exact { .. }),
        "expected Exact for '{expr_str}', got {:?}",
        report.method
    );

    let oracle = run_prefix_tape_oracle(&expr, max_draws, min_branch_prob)
        .unwrap_or_else(|e| panic!("oracle failed for '{expr_str}': {e}"));
    assert!(
        oracle.tail_mass < 1e-7,
        "expected tail_mass < 1e-7 for '{expr_str}', got {:.3e}",
        oracle.tail_mass
    );

    let mut all_keys = BTreeSet::new();
    for &(k, _) in report.distribution.entries() {
        all_keys.insert(k);
    }
    for &(k, _) in oracle.distribution.entries() {
        assert!(
            report.distribution.is_reachable(k),
            "oracle reached outcome {k} on '{expr_str}' missing from exact support!"
        );
        all_keys.insert(k);
    }

    for k in all_keys {
        let p_exact = report.distribution.prob_exactly(k);
        let p_oracle = oracle.distribution.prob_exactly(k);
        assert!(
            p_exact + 1e-13 >= p_oracle,
            "exact probability below partial-tree oracle on '{expr_str}' at {k}: exact={p_exact:.17e} < oracle={p_oracle:.17e}"
        );
        let diff = (p_exact - p_oracle).abs();
        assert!(
            diff <= oracle.tail_mass + 1e-12,
            "exact vs adaptive oracle exceeded tail_mass on '{expr_str}' at {k}: diff={diff:.3e} > tail_mass={:.3e}",
            oracle.tail_mass
        );
    }
}

#[test]
fn exhaustive_prefix_tape_oracle_matches_all_modifier_families_and_caps() {
    // 95 exhaustive (`tail_mass == 0.0`) cases spanning every modifier family, combination, and loop cap:
    let cases: &[(&str, usize)] = &[
        // 1. Base & arithmetic (`+ - * /`, unary `-`, Fate `dF`, and Percentile `d%`)
        ("42", 4),
        ("-7", 4),
        ("1d1", 4),
        ("1d2", 4),
        ("2d3", 4),
        ("1dF", 4),
        ("3dF", 6),
        ("1d%", 4),
        ("2d%kh1", 4),
        ("1d%ro<10", 4),
        ("1d%min20max80cs>50cf<25", 4),
        ("-(2d3-4)", 4),
        ("(1d3-2)/2", 4),
        ("1d6/-2", 4),
        ("(1d3)*(1d4)", 4),
        ("(1dF)*(2d2-3)", 5),
        ("1d4-(2d2)", 5),
        ("3d3ro=1kl1/-2", 8),
        // 2. Reroll-once (`ro`), chained `ro`, and strict `<` / `>` thresholds
        ("1d3ro=1", 4),
        ("2d3ro<=2", 6),
        ("1d4ro>3", 4),
        ("2dFro=-1", 6),
        ("1d4ro=1ro=2", 5),
        // 3. Clamp (`min`, `max`, `min..max`)
        ("1d6min2", 4),
        ("1d6max4", 4),
        ("2d4min2max3", 4),
        ("2dFmin0max1", 4),
        // 4. Keep / Drop (`kh`, `kl`, `dh`, `dl` and chained intervals) + Sort (`sa`, `sd`)
        ("3d3kh2", 5),
        ("3d3kl2", 5),
        ("3d3dh1", 5),
        ("3d3dl1", 5),
        ("4d3dl1dh1", 6),
        ("3d3kh0", 5),
        ("3dFkh2", 5),
        ("3d4max3kh2", 5),
        ("3d4sa", 5),
        ("3d4kh2sd", 5),
        ("3d4cs>2cf<2sa", 5),
        ("2d2!sd", 210),
        // 5. Pool (`cs`, `cf`), strict `>` / `<` pools, and bare Sum crit markers
        ("3d4cs>=3", 5),
        ("3d4cs>=4cf<=1", 5),
        ("3d4cs>3cf<2", 5),
        ("3d4cf<=2", 5),
        ("2d4cscf", 4),
        ("2dFcscf", 4),
        ("3dFcs=1cf=-1", 5),
        ("3d3kh2cs>=2cf<=1", 5),
        ("3d3kl1cs>=2cf<=1", 5),
        // 6. Capped `MAX_REROLLS = 100` (`r`) including `m == 0`, `0 < m < s`, `<`, `m == s`, and Fate
        ("1d4r=9", 4),
        ("1d1r=1", 105),
        ("1d1r>=1", 105),
        ("1d2r=1", 105),
        ("1d4r<2", 105),
        ("1d3r=1r=2", 210),
        ("1dFr=-1", 105),
        ("2d2r=1", 210),
        // 7. Capped `MAX_EXPLOSIONS = 100` (`!`, `!!`, `!p`), `>`, and `min`/`max`-then-explode
        ("1d1!>=1", 105),
        ("1d2!", 105),
        ("1d2!!", 105),
        ("1d2!p", 105),
        ("1d3!>2", 105),
        ("1d3!!>2", 105),
        ("1d3!p>2", 105),
        ("1d3min4!>=4", 5),
        ("1d4max3!", 4),
        ("1d4max3!=3", 105),
        ("1d4max3!!=3", 105),
        ("1d4max3!p=3", 105),
        ("2d2!", 210),
        ("2d2!!", 210),
        ("2d2!p", 210),
        // 8. Pairwise & multi-stage combinations across `r`, `ro`, `min`/`max`, `!`/`!!`/`!p`, `kh`/`kl`/`dh`/`dl`, `cs`/`cf`, and `/`
        ("2d2r=1kh1", 210),
        ("2d2!!kh1", 210),
        ("2d2!!kl1", 210),
        ("2d2!!kh1cs>=2", 210),
        ("2d2!!kl1cs>=2", 210),
        ("2d2!!dl1cs>2cf<2", 210),
        ("3d4min2cs>2cf<3", 5),
        ("3d4max3cs>=3cf<=1", 5),
        ("2d3ro=1cs>=2cf<=1", 6),
        ("2dFro=-1cs>0cf<0", 6),
        ("2d2r=1cs>=2cf<=1", 210),
        ("2d2r=1dh1cs>=2cf<=1", 210),
        ("2d2r=1dl1cs>1cf<2", 210),
        ("3d3ro=1dh1cs>2cf<2", 8),
        ("2d2!cs>=2", 210),
        ("2d2!pcs>=2cf<=1", 210),
        ("2d2!!cs>=3", 210),
        ("1d2r=1!", 210),
        ("1d2r=1!!", 210),
        ("1d2r=1!p", 210),
        ("1d3r=1ro=2min2!>=3", 215),
        ("1d3r=1ro=2min2!!>=3", 215),
        ("1d3r=1ro=2min2!p>=3", 215),
        ("1d6/(1d2!-22)", 110),
    ];

    assert_eq!(cases.len(), 95);
    for &(expr_str, max_draws) in cases {
        assert_exhaustive_oracle(expr_str, max_draws);
    }
}

#[test]
fn adaptive_prefix_tape_oracle_matches_multi_die_infinite_branching_combinations() {
    // 9 multi-die / multi-face branching combinations checked down to `tail_mass < 1e-7` (`§9.3`).
    let adaptive_cases: &[(&str, usize, f64)] = &[
        ("2d6r=1!", 32, 1e-11),
        ("3d4r=1kh2", 28, 1e-11),
        ("2d4ro=1min2!", 28, 1e-11),
        ("2d4ro=1min2!!kh1", 28, 1e-11),
        ("2d4ro=1min2!!kl1/-2", 28, 1e-11),
        ("1d6max5!>=5", 32, 1e-12),
        ("3d3r=1dh1cs>=2cf<=1", 30, 1e-11),
        ("2d4r=1!pcs>=3cf<=1", 30, 1e-11),
        ("3d3!cs>=3cf<=1", 30, 1e-11),
    ];

    assert_eq!(adaptive_cases.len(), 9);
    for &(expr_str, max_draws, min_branch_prob) in adaptive_cases {
        assert_adaptive_oracle(expr_str, max_draws, min_branch_prob);
    }
}
