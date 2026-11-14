#![forbid(unsafe_code)]

use roll_core::conformance::build_conformance_suite;

const COMMITTED_MANIFEST: &str = include_str!("../../../fixtures/conformance/v3/MANIFEST.sha256");

#[test]
fn cross_target_conformance_manifest_matches_committed_bytes_and_digest() {
    let bundle = build_conformance_suite();
    assert_eq!(
        bundle.manifest, COMMITTED_MANIFEST,
        "MANIFEST.sha256 entries differed on target"
    );
    assert_eq!(
        bundle.manifest_sha256, "ec184aa7f5a3da36fe2d9c3000e734358546331654c340771836bf2c614f8054",
        "top-level MANIFEST.sha256 digest differed on target"
    );
}
