#![forbid(unsafe_code)]

use core::num::NonZeroU64;
use roll_core::codec::encode_hex_lower;
use roll_core::{
    DEFAULT_RULES_VERSION, KDF_PROTOCOL_TAG, RollAddress, RollError, RollRng, SeedMaterial,
    derive_roll_key, lemire_sample_from_tape,
};
use sha2::{Digest, Sha256};

#[test]
fn kdf_known_answer_int64_and_bytes32() {
    let addr = RollAddress::new(SeedMaterial::Int64(42), 0, "cli", "", 0);
    let derived = derive_roll_key(&addr).expect("valid address");

    // Reconstruct exact preimage manually per Roll 3.0 §2.2.
    let mut manual = Vec::new();
    manual.extend_from_slice(KDF_PROTOCOL_TAG);
    manual.push(0x01);
    manual.extend_from_slice(&42i64.to_le_bytes());
    manual.extend_from_slice(&0u64.to_le_bytes());
    manual.extend_from_slice(&3u32.to_le_bytes());
    manual.extend_from_slice(b"cli");
    manual.extend_from_slice(&0u32.to_le_bytes());
    manual.extend_from_slice(&0u64.to_le_bytes());
    manual.extend_from_slice(&7u32.to_le_bytes());
    manual.extend_from_slice(b"roll.v3");
    assert_eq!(manual.len(), 18 + 9 + 8 + (4 + 3) + 4 + 8 + (4 + 7));

    let expected: [u8; 32] = Sha256::digest(&manual).into();
    assert_eq!(derived, expected);
    // Independently verified via Node.js `node:crypto` SHA-256 over the §2.2 byte preimage.
    assert_eq!(
        encode_hex_lower(&derived),
        "679750e0905e4677463c46683b5772204bdd265ae2d382a309995cc9ee4a9dac"
    );

    let beacon = [0xabu8; 32];
    let addr_b32 = RollAddress::new(
        SeedMaterial::Bytes32(beacon),
        4,
        "road_event",
        "caravan:north-04",
        7,
    );
    let derived_b32 = derive_roll_key(&addr_b32).expect("valid bytes32 address");
    assert_ne!(derived, derived_b32);

    let mut manual_b32 = Vec::new();
    manual_b32.extend_from_slice(b"roll.v3.seed_kdf\x00\x01");
    manual_b32.push(0x02);
    manual_b32.extend_from_slice(&beacon);
    manual_b32.extend_from_slice(&4u64.to_le_bytes());
    manual_b32.extend_from_slice(&10u32.to_le_bytes());
    manual_b32.extend_from_slice(b"road_event");
    manual_b32.extend_from_slice(&16u32.to_le_bytes());
    manual_b32.extend_from_slice(b"caravan:north-04");
    manual_b32.extend_from_slice(&7u64.to_le_bytes());
    manual_b32.extend_from_slice(&7u32.to_le_bytes());
    manual_b32.extend_from_slice(b"roll.v3");
    let expected_b32: [u8; 32] = Sha256::digest(&manual_b32).into();
    assert_eq!(derived_b32, expected_b32);
}

#[test]
fn kdf_eliminates_32bit_seed_truncation_and_prefix_collisions() {
    // In 2.x, `1 | 0 === 4294967297 | 0 === 1`. In 3.0 they must diverge.
    let a1 = RollAddress::new(SeedMaterial::Int64(1), 0, "cli", "", 0);
    let a2 = RollAddress::new(SeedMaterial::Int64(4_294_967_297), 0, "cli", "", 0);
    assert_ne!(derive_roll_key(&a1).unwrap(), derive_roll_key(&a2).unwrap());

    // Prefix-collision check: ("ab", "c") vs ("a", "bc").
    let p1 = RollAddress::new(SeedMaterial::Int64(0), 1, "ab", "c", 0);
    let p2 = RollAddress::new(SeedMaterial::Int64(0), 1, "a", "bc", 0);
    assert_ne!(derive_roll_key(&p1).unwrap(), derive_roll_key(&p2).unwrap());

    // Extreme i64 values remain distinct.
    let min_addr = RollAddress::new(SeedMaterial::Int64(i64::MIN), 0, "cli", "", 0);
    let neg_addr = RollAddress::new(SeedMaterial::Int64(-1), 0, "cli", "", 0);
    let zero_addr = RollAddress::new(SeedMaterial::Int64(0), 0, "cli", "", 0);
    let max_addr = RollAddress::new(SeedMaterial::Int64(i64::MAX), 0, "cli", "", 0);
    let keys = [
        derive_roll_key(&min_addr).unwrap(),
        derive_roll_key(&neg_addr).unwrap(),
        derive_roll_key(&zero_addr).unwrap(),
        derive_roll_key(&max_addr).unwrap(),
    ];
    for i in 0..keys.len() {
        for j in (i + 1)..keys.len() {
            assert_ne!(keys[i], keys[j]);
        }
    }
}

#[test]
fn roll_address_validation_enforces_namespace_and_control_char_bounds() {
    let empty_domain = RollAddress::new(SeedMaterial::Int64(1), 0, "", "", 0);
    assert!(matches!(
        derive_roll_key(&empty_domain),
        Err(RollError::InvalidAddress {
            field: "domain",
            ..
        })
    ));

    let space_domain = RollAddress::new(SeedMaterial::Int64(1), 0, "road event", "", 0);
    assert!(matches!(
        derive_roll_key(&space_domain),
        Err(RollError::InvalidAddress {
            field: "domain",
            ..
        })
    ));

    let long_domain = RollAddress::new(SeedMaterial::Int64(1), 0, "a".repeat(129), "", 0);
    assert!(matches!(
        derive_roll_key(&long_domain),
        Err(RollError::InvalidAddress {
            field: "domain",
            ..
        })
    ));

    // Printable UTF-8 in `entity_id` is allowed up to 256 bytes, while control chars are rejected.
    let utf8_entity = RollAddress::new(SeedMaterial::Int64(1), 0, "market", "caravan:🎲-北", 0);
    assert!(derive_roll_key(&utf8_entity).is_ok());

    let ctrl_entity = RollAddress::new(SeedMaterial::Int64(1), 0, "market", "bad\x1bname", 0);
    assert!(matches!(
        derive_roll_key(&ctrl_entity),
        Err(RollError::InvalidAddress {
            field: "entity_id",
            ..
        })
    ));

    let long_entity = RollAddress::new(SeedMaterial::Int64(1), 0, "market", "e".repeat(257), 0);
    assert!(matches!(
        derive_roll_key(&long_entity),
        Err(RollError::InvalidAddress {
            field: "entity_id",
            ..
        })
    ));

    let mut bad_rules = RollAddress::new(SeedMaterial::Int64(1), 0, "cli", "", 0);
    bad_rules.rules_version = String::new();
    assert!(matches!(
        derive_roll_key(&bad_rules),
        Err(RollError::InvalidAddress {
            field: "rules_version",
            ..
        })
    ));
    assert_eq!(DEFAULT_RULES_VERSION, "roll.v3");
}

#[test]
fn chacha12_zero_seed_known_answer_words() {
    let mut rng = RollRng::from_raw_seed([0u8; 32]);
    let w0 = rng.next_u64_recorded();
    // Spec §2.4 & rand_chacha 0.10.0 anchor for ChaCha12Rng::from_seed([0u8; 32]).next_u64().
    assert_eq!(w0, 0x53f9_5507_6a9a_f49b);

    // Draw remaining 7 words of block 0 plus first word of block 1.
    let mut words = vec![w0];
    for _ in 0..8 {
        words.push(rng.next_u64_recorded());
    }
    assert_eq!(rng.draws(), words.as_slice());

    // Re-seeding identically reproduces the exact 9-word sequence.
    let mut rng2 = RollRng::from_raw_seed([0u8; 32]);
    for &expected in &words {
        assert_eq!(rng2.next_u64_recorded(), expected);
    }
}

#[test]
fn lemire_slow_path_rejection_and_boundary_spans() {
    let span6 = NonZeroU64::new(6).unwrap();
    // For s = 6, threshold = 2^64 mod 6 = 4.
    // Witness x1 = 0x2aaaaaaaaaaaaaab satisfies x1 * 6 = 2^64 + 2 => low = 2 < 4 (rejected!).
    // Witness x2 = 0x5555555555555556 satisfies x2 * 6 = 2 * 2^64 + 4 => low = 4 == threshold < 6 (accepted!).
    let x_reject_nonzero: u64 = 0x2aaa_aaaa_aaaa_aaab;
    let x_accept_slow_check: u64 = 0x5555_5555_5555_5556;

    // Verify the 128-bit products directly.
    let m1 = u128::from(x_reject_nonzero) * 6u128;
    assert_eq!(m1 as u64, 2);
    let m2 = u128::from(x_accept_slow_check) * 6u128;
    assert_eq!(m2 as u64, 4);
    assert_eq!((m2 >> 64) as u64, 2);

    // Tape with two rejected words (`0` -> low=0 < 4, `x_reject_nonzero` -> low=2 < 4)
    // followed by `x_accept_slow_check` (low=4 >= 4 -> accepted, value = 2).
    let tape = [0u64, x_reject_nonzero, x_accept_slow_check];
    let (sampled, consumed) =
        lemire_sample_from_tape(span6, &tape).expect("should accept 3rd word");
    assert_eq!(sampled, 2);
    assert_eq!(consumed, 3);

    // Truncated tape with only the rejected word must report underflow at index 1.
    assert_eq!(lemire_sample_from_tape(span6, &[x_reject_nonzero]), Err(1));

    // Boundary span = 1: consumes exactly 1 word and always yields 0, even on x = 0.
    let span1 = NonZeroU64::new(1).unwrap();
    assert_eq!(lemire_sample_from_tape(span1, &[0]), Ok((0, 1)));
    assert_eq!(lemire_sample_from_tape(span1, &[u64::MAX]), Ok((0, 1)));

    // Boundary span = u64::MAX (2^64 - 1): threshold = 1, so x = 0 rejects and x = 1..=u64::MAX map to 0..u64::MAX-1.
    let span_max = NonZeroU64::new(u64::MAX).unwrap();
    assert_eq!(lemire_sample_from_tape(span_max, &[0, 1]), Ok((0, 2)));
    assert_eq!(
        lemire_sample_from_tape(span_max, &[u64::MAX]),
        Ok((u64::MAX - 1, 1))
    );

    // sample_inclusive across full i64::MIN..=i64::MAX domain.
    let mut rng = RollRng::from_raw_seed([7u8; 32]);
    let full = rng.sample_inclusive(i64::MIN, i64::MAX).unwrap();
    let _ = full;
    assert_eq!(rng.draws().len(), 1);
    assert!(matches!(
        rng.sample_inclusive(10, 5),
        Err(RollError::InvalidClampBounds {
            min: 10,
            max: 5,
            ..
        })
    ));
}
