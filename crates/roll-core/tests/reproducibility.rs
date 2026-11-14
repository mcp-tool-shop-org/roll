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
        bundle.manifest_sha256, "3533b69c95de895aaa84b2e6df05c93bed7b7fbc914e6693981bb395f3f8ccbf",
        "top-level MANIFEST.sha256 digest differed on target"
    );
}
