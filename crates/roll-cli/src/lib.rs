//! CLI library entry point and conformance fixture generator for Roll 3.0.
//!
//! Build 1 exposes the `fixtures` subcommand (`roll fixtures --out <DIR>`) plus
//! `--help` and `--version`. Full interactive rolling, exact analysis, table
//! commands, and `verify` land in subsequent Roll 3.0 PRs.

#![forbid(unsafe_code)]

use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};
use roll_core::conformance::build_conformance_suite;

/// Process exit code returned by [`run_cli`].
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ExitCode {
    Success = 0,
    Error = 1,
}

#[derive(Debug, Parser)]
#[command(
    name = "roll",
    version,
    about = "Roll 3.0 deterministic dice & conformance CLI",
    propagate_version = true
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Generate deterministic Roll 3.0 conformance fixtures and MANIFEST.sha256.
    Fixtures {
        /// Output directory for generated conformance JSON files and MANIFEST.sha256.
        #[arg(long = "out", value_name = "DIR")]
        out: PathBuf,
    },
}

/// Writes the deterministic Roll 3.0 conformance suite to `out_dir` and returns the manifest SHA-256 hex.
pub fn write_fixtures_to_dir(out_dir: &Path) -> std::io::Result<String> {
    let bundle = build_conformance_suite();
    fs::create_dir_all(out_dir)?;

    for (filename, contents) in &bundle.files {
        fs::write(out_dir.join(filename), contents.as_bytes())?;
    }
    fs::write(out_dir.join("MANIFEST.sha256"), bundle.manifest.as_bytes())?;

    Ok(bundle.manifest_sha256)
}

/// Executes the `roll` CLI in-process against caller-supplied streams.
pub fn run_cli<I, S>(args: I, stdout: &mut dyn Write, stderr: &mut dyn Write) -> ExitCode
where
    I: IntoIterator<Item = S>,
    S: Into<OsString> + Clone,
{
    let cli = match Cli::try_parse_from(args) {
        Ok(parsed) => parsed,
        Err(err) => {
            if err.use_stderr() {
                let _ = write!(stderr, "{err}");
                return ExitCode::Error;
            }
            let _ = write!(stdout, "{err}");
            return ExitCode::Success;
        }
    };

    match cli.command {
        Commands::Fixtures { out } => match write_fixtures_to_dir(&out) {
            Ok(manifest_sha) => {
                let _ = writeln!(
                    stdout,
                    "generated conformance fixtures in {} (manifest sha256: {manifest_sha})",
                    out.display()
                );
                ExitCode::Success
            }
            Err(io_err) => {
                let _ = writeln!(
                    stderr,
                    "error writing fixtures to {}: {io_err}",
                    out.display()
                );
                ExitCode::Error
            }
        },
    }
}
