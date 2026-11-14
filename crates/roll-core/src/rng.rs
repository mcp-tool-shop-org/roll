use alloc::string::String;
use alloc::vec::Vec;
use core::num::NonZeroU64;
use rand_chacha::ChaCha12Rng;
use rand_core::{Rng, SeedableRng};
use sha2::{Digest, Sha256};

use crate::error::{ReceiptVerifyError, RollError};

/// Normative Roll 3.0 rules version tag bound into every `RollAddress` KDF preimage.
pub const DEFAULT_RULES_VERSION: &str = "roll.v3";

/// Maximum byte length of `RollAddress::domain`.
pub const MAX_DOMAIN_BYTES: usize = 128;
/// Maximum byte length of `RollAddress::entity_id`.
pub const MAX_ENTITY_ID_BYTES: usize = 256;
/// Maximum byte length of `RollAddress::rules_version`.
pub const MAX_RULES_VERSION_BYTES: usize = 64;

/// 18-byte protocol domain-separation tag and KDF version byte (`0x01`).
pub const KDF_PROTOCOL_TAG: &[u8; 18] = b"roll.v3.seed_kdf\x00\x01";

/// Root campaign seed material for [`RollAddress`].
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum SeedMaterial {
    /// Signed 64-bit integer seed (`--seed`, unit tests, safe/BigInt JS seeds).
    Int64(#[serde(with = "crate::codec::i64_str")] i64),
    /// Raw 256-bit seed material (e.g. a `drand` round randomness digest).
    Bytes32(#[serde(with = "crate::codec::bytes32_hex")] [u8; 32]),
}

/// Stateless 6-tuple coordinate uniquely addressing a single deterministic roll stream.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RollAddress {
    pub campaign_seed: SeedMaterial,
    #[serde(with = "crate::codec::u64_str")]
    pub turn: u64,
    pub domain: String,
    pub entity_id: String,
    #[serde(with = "crate::codec::u64_str")]
    pub roll_index: u64,
    pub rules_version: String,
}

impl RollAddress {
    /// Constructs a `RollAddress` with `rules_version` set to [`DEFAULT_RULES_VERSION`].
    pub fn new(
        campaign_seed: SeedMaterial,
        turn: u64,
        domain: impl Into<String>,
        entity_id: impl Into<String>,
        roll_index: u64,
    ) -> Self {
        Self {
            campaign_seed,
            turn,
            domain: domain.into(),
            entity_id: entity_id.into(),
            roll_index,
            rules_version: String::from(DEFAULT_RULES_VERSION),
        }
    }

    /// Validates static field bounds and character invariants per Roll 3.0 §2.2.
    pub fn validate(&self) -> Result<(), RollError> {
        if self.domain.is_empty() {
            return Err(RollError::InvalidAddress {
                field: "domain",
                reason: "domain must not be empty",
            });
        }
        if self.domain.len() > MAX_DOMAIN_BYTES {
            return Err(RollError::InvalidAddress {
                field: "domain",
                reason: "domain exceeds 128 bytes",
            });
        }
        if !self.domain.bytes().all(|b| (b'!'..=b'~').contains(&b)) {
            return Err(RollError::InvalidAddress {
                field: "domain",
                reason: "domain must contain only ASCII printable characters [!-~]",
            });
        }

        if self.entity_id.len() > MAX_ENTITY_ID_BYTES {
            return Err(RollError::InvalidAddress {
                field: "entity_id",
                reason: "entity_id exceeds 256 bytes",
            });
        }
        if self.entity_id.chars().any(char::is_control) {
            return Err(RollError::InvalidAddress {
                field: "entity_id",
                reason: "entity_id must not contain control characters",
            });
        }

        if self.rules_version.is_empty() {
            return Err(RollError::InvalidAddress {
                field: "rules_version",
                reason: "rules_version must not be empty",
            });
        }
        if self.rules_version.len() > MAX_RULES_VERSION_BYTES {
            return Err(RollError::InvalidAddress {
                field: "rules_version",
                reason: "rules_version exceeds 64 bytes",
            });
        }
        if !self
            .rules_version
            .bytes()
            .all(|b| (b'!'..=b'~').contains(&b))
        {
            return Err(RollError::InvalidAddress {
                field: "rules_version",
                reason: "rules_version must contain only ASCII printable characters [!-~]",
            });
        }

        Ok(())
    }
}

/// Derives the 256-bit `ChaCha12Rng` key from `addr` using injective length-prefixed SHA-256 framing.
pub fn derive_roll_key(addr: &RollAddress) -> Result<[u8; 32], RollError> {
    addr.validate()?;

    let mut hasher = Sha256::new();
    hasher.update(KDF_PROTOCOL_TAG);

    match &addr.campaign_seed {
        SeedMaterial::Int64(n) => {
            hasher.update([0x01u8]);
            hasher.update(n.to_le_bytes());
        }
        SeedMaterial::Bytes32(b) => {
            hasher.update([0x02u8]);
            hasher.update(b);
        }
    }

    hasher.update(addr.turn.to_le_bytes());

    let domain_len = u32::try_from(addr.domain.len()).map_err(|_| RollError::InvalidAddress {
        field: "domain",
        reason: "domain length overflows u32",
    })?;
    hasher.update(domain_len.to_le_bytes());
    hasher.update(addr.domain.as_bytes());

    let entity_len =
        u32::try_from(addr.entity_id.len()).map_err(|_| RollError::InvalidAddress {
            field: "entity_id",
            reason: "entity_id length overflows u32",
        })?;
    hasher.update(entity_len.to_le_bytes());
    hasher.update(addr.entity_id.as_bytes());

    hasher.update(addr.roll_index.to_le_bytes());

    let rules_len =
        u32::try_from(addr.rules_version.len()).map_err(|_| RollError::InvalidAddress {
            field: "rules_version",
            reason: "rules_version length overflows u32",
        })?;
    hasher.update(rules_len.to_le_bytes());
    hasher.update(addr.rules_version.as_bytes());

    Ok(hasher.finalize().into())
}

/// Internal draw source shared between live `ChaCha12Rng` execution and bounded receipt replay tapes.
pub(crate) trait DrawSource {
    fn next_u64_word(&mut self) -> Result<u64, RollError>;

    fn sample_lemire_u64(&mut self, span: NonZeroU64) -> Result<u64, RollError> {
        let s: u64 = span.get();
        let x: u64 = self.next_u64_word()?;
        let mut m: u128 = u128::from(x) * u128::from(s);
        let mut low: u64 = m as u64;
        if low < s {
            let threshold: u64 = s.wrapping_neg() % s;
            while low < threshold {
                let x_retry: u64 = self.next_u64_word()?;
                m = u128::from(x_retry) * u128::from(s);
                low = m as u64;
            }
        }
        Ok((m >> 64) as u64)
    }
}

/// Executes 64-bit Lemire range mapping against an explicit slice of raw `u64` words.
///
/// Returns `Ok((sampled, words_consumed))` or `Err(needed_at_index)` if the slice ends early.
pub fn lemire_sample_from_tape(span: NonZeroU64, tape: &[u64]) -> Result<(u64, usize), usize> {
    let mut cursor = TapeSource::new(tape);
    match cursor.sample_lemire_u64(span) {
        Ok(val) => Ok((val, cursor.cursor())),
        Err(_) => Err(cursor.cursor()),
    }
}

pub(crate) struct TapeSource<'a> {
    words: &'a [u64],
    cursor: usize,
}

impl<'a> TapeSource<'a> {
    pub(crate) fn new(words: &'a [u64]) -> Self {
        Self { words, cursor: 0 }
    }

    pub(crate) fn cursor(&self) -> usize {
        self.cursor
    }
}

impl DrawSource for TapeSource<'_> {
    fn next_u64_word(&mut self) -> Result<u64, RollError> {
        if let Some(&word) = self.words.get(self.cursor) {
            self.cursor += 1;
            Ok(word)
        } else {
            Err(RollError::ReceiptInvalid(
                ReceiptVerifyError::DrawTapeUnderflow {
                    needed_at_index: self.cursor,
                },
            ))
        }
    }
}

/// Deterministic `ChaCha12Rng` wrapper recording every `u64` word drawn for receipt auditing.
pub struct RollRng {
    inner: ChaCha12Rng,
    draws: Vec<u64>,
}

impl RollRng {
    /// Initializes a `RollRng` from a validated [`RollAddress`].
    pub fn from_address(addr: &RollAddress) -> Result<Self, RollError> {
        let key = derive_roll_key(addr)?;
        Ok(Self::from_raw_seed(key))
    }

    /// Initializes a `RollRng` directly from a 256-bit `ChaCha12Rng` key (`stream = 0`, `word_pos = 0`).
    pub fn from_raw_seed(key: [u8; 32]) -> Self {
        Self {
            inner: ChaCha12Rng::from_seed(key),
            draws: Vec::new(),
        }
    }

    /// Draws the next raw `u64` word from `ChaCha12Rng` and appends it to the draw log.
    pub fn next_u64_recorded(&mut self) -> u64 {
        let word = self.inner.next_u64();
        self.draws.push(word);
        word
    }

    /// Maps `ChaCha12Rng` words uniformly onto `0..span.get()` via 64-bit Lemire rejection sampling.
    pub fn sample_u64(&mut self, span: NonZeroU64) -> u64 {
        // `RollRng`'s `DrawSource` implementation is infallible.
        match self.sample_lemire_u64(span) {
            Ok(v) => v,
            Err(_) => unreachable!("RollRng::next_u64_word never errors"),
        }
    }

    /// Samples an unbiased integer uniformly in `min..=max`.
    pub fn sample_inclusive(&mut self, min: i64, max: i64) -> Result<i64, RollError> {
        if min > max {
            return Err(RollError::InvalidClampBounds {
                min,
                max,
                byte_offset: 0,
            });
        }
        let diff = (i128::from(max) - i128::from(min)) as u64;
        if diff == u64::MAX {
            // Full 2^64 domain (`i64::MIN..=i64::MAX`): 1-to-1 bijection with a single u64 word.
            let word = self.next_u64_recorded();
            Ok((i128::from(min) + i128::from(word)) as i64)
        } else {
            let span = NonZeroU64::new(diff + 1).expect("diff < u64::MAX implies diff + 1 >= 1");
            let offset = self.sample_u64(span);
            Ok((i128::from(min) + i128::from(offset)) as i64)
        }
    }

    /// Borrows the ordered slice of all `u64` words drawn so far.
    pub fn draws(&self) -> &[u64] {
        &self.draws
    }

    /// Consumes the generator and returns the ordered `Vec<u64>` of raw draws.
    pub fn into_draws(self) -> Vec<u64> {
        self.draws
    }
}

impl DrawSource for RollRng {
    fn next_u64_word(&mut self) -> Result<u64, RollError> {
        Ok(self.next_u64_recorded())
    }
}
