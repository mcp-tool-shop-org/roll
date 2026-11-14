#![forbid(unsafe_code)]

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use roll_cli::{ExitCode, run_cli};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

const COMMITTED_01: &[u8] = include_bytes!("../../../fixtures/conformance/v3/01_kdf_and_rng.json");
const COMMITTED_02: &[u8] =
    include_bytes!("../../../fixtures/conformance/v3/02_grammar_and_ast.json");
const COMMITTED_03: &[u8] =
    include_bytes!("../../../fixtures/conformance/v3/03_rolls_and_receipts.json");
const COMMITTED_04: &[u8] =
    include_bytes!("../../../fixtures/conformance/v3/04_exact_analysis.json");
const COMMITTED_MANIFEST: &[u8] =
    include_bytes!("../../../fixtures/conformance/v3/MANIFEST.sha256");

fn unique_temp_dir(label: &str) -> PathBuf {
    let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let (base, pid) = if cfg!(target_arch = "wasm32") {
        (PathBuf::from(".wasm-test-tmp"), 0)
    } else {
        (std::env::temp_dir(), std::process::id())
    };
    let dir = base.join(format!("roll3_cli_fixtures_test_{pid}_{label}_{id}"));
    let _ = fs::remove_dir_all(&dir);
    dir
}

#[test]
fn fixtures_subcommand_is_deterministic_across_runs_and_matches_committed_v3_dir() {
    let dir1 = unique_temp_dir("run1");
    let dir2 = unique_temp_dir("run2");

    let mut out1 = Vec::new();
    let mut err1 = Vec::new();
    let code1 = run_cli(
        [
            "roll",
            "fixtures",
            "--out",
            dir1.to_str().expect("utf8 path"),
        ],
        &mut out1,
        &mut err1,
    );
    assert_eq!(code1, ExitCode::Success);
    assert!(err1.is_empty());

    let mut out2 = Vec::new();
    let mut err2 = Vec::new();
    let code2 = run_cli(
        [
            "roll",
            "fixtures",
            "--out",
            dir2.to_str().expect("utf8 path"),
        ],
        &mut out2,
        &mut err2,
    );
    assert_eq!(code2, ExitCode::Success);
    assert!(err2.is_empty());

    // Also run a second time overwriting dir1 in-place.
    let mut out1_repeat = Vec::new();
    let mut err1_repeat = Vec::new();
    let code1_repeat = run_cli(
        [
            "roll",
            "fixtures",
            "--out",
            dir1.to_str().expect("utf8 path"),
        ],
        &mut out1_repeat,
        &mut err1_repeat,
    );
    assert_eq!(code1_repeat, ExitCode::Success);
    assert_eq!(out1, out1_repeat);

    let expected_files: [(&str, &[u8]); 5] = [
        ("01_kdf_and_rng.json", COMMITTED_01),
        ("02_grammar_and_ast.json", COMMITTED_02),
        ("03_rolls_and_receipts.json", COMMITTED_03),
        ("04_exact_analysis.json", COMMITTED_04),
        ("MANIFEST.sha256", COMMITTED_MANIFEST),
    ];

    for (name, committed) in expected_files {
        let b1 = fs::read(dir1.join(name)).expect("read dir1 file");
        let b2 = fs::read(dir2.join(name)).expect("read dir2 file");
        assert_eq!(b1, b2, "two runs produced different bytes for {name}");
        assert_eq!(
            b1.as_slice(),
            committed,
            "generated {name} drifted from committed fixtures/conformance/v3/{name}"
        );
    }

    let _ = fs::remove_dir_all(&dir1);
    let _ = fs::remove_dir_all(&dir2);
    if cfg!(target_arch = "wasm32") {
        let _ = fs::remove_dir_all(".wasm-test-tmp");
    }
}

#[test]
fn cli_help_version_and_invalid_arguments_behave_cleanly() {
    let mut out = Vec::new();
    let mut err = Vec::new();
    assert_eq!(
        run_cli(["roll", "--help"], &mut out, &mut err),
        ExitCode::Success
    );
    assert!(String::from_utf8_lossy(&out).contains("fixtures"));
    assert!(err.is_empty());

    out.clear();
    assert_eq!(
        run_cli(["roll", "--version"], &mut out, &mut err),
        ExitCode::Success
    );
    assert!(String::from_utf8_lossy(&out).contains("roll "));
    assert!(err.is_empty());

    out.clear();
    assert_eq!(
        run_cli(["roll", "--unknown-flag"], &mut out, &mut err),
        ExitCode::Error
    );
    assert!(!err.is_empty());

    // Passing an existing regular file path as `--out` fails cleanly with ExitCode::Error.
    let blocker_dir = unique_temp_dir("io_err");
    fs::create_dir_all(&blocker_dir).expect("create temp parent");
    let blocker_file = blocker_dir.join("not_a_dir");
    fs::write(&blocker_file, b"file").expect("write regular file");
    out.clear();
    err.clear();
    assert_eq!(
        run_cli(
            [
                "roll",
                "fixtures",
                "--out",
                blocker_file.to_str().expect("utf8 path"),
            ],
            &mut out,
            &mut err,
        ),
        ExitCode::Error
    );
    assert!(String::from_utf8_lossy(&err).contains("error writing fixtures"));
    let _ = fs::remove_dir_all(&blocker_dir);
    if cfg!(target_arch = "wasm32") {
        let _ = fs::remove_dir_all(".wasm-test-tmp");
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn roll_binary_entrypoint_handles_version_and_error_exit_codes() {
    use std::process::{Command, Stdio};

    let ok = Command::new(env!("CARGO_BIN_EXE_roll"))
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .expect("spawn roll --version");
    assert!(ok.status.success());
    assert!(String::from_utf8_lossy(&ok.stdout).contains("roll "));

    let bad = Command::new(env!("CARGO_BIN_EXE_roll"))
        .arg("--unknown-flag")
        .stdin(Stdio::null())
        .output()
        .expect("spawn roll --unknown-flag");
    assert_eq!(bad.status.code(), Some(ExitCode::Error as i32));
}
