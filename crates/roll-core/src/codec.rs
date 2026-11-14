use alloc::string::{String, ToString};
use alloc::vec::Vec;
use core::num::NonZeroU64;
use serde::de::Error as DeError;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

const HEX_LOWER: &[u8; 16] = b"0123456789abcdef";

/// Encodes `bytes` as lowercase hexadecimal.
pub fn encode_hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX_LOWER[(b >> 4) as usize] as char);
        out.push(HEX_LOWER[(b & 0x0f) as usize] as char);
    }
    out
}

/// Encodes a `u64` word as a fixed 16-character lowercase hex string.
pub fn encode_u64_hex(word: u64) -> String {
    encode_hex_lower(&word.to_be_bytes())
}

fn decode_nibble_lower(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

/// Decodes a fixed-size `[u8; 32]` from a strict 64-character lowercase hex string.
pub fn decode_bytes32_hex(s: &str) -> Result<[u8; 32], &'static str> {
    if s.len() != 64 {
        return Err("expected exactly 64 lowercase hex characters");
    }
    let raw = s.as_bytes();
    let mut out = [0u8; 32];
    for (idx, slot) in out.iter_mut().enumerate() {
        let hi =
            decode_nibble_lower(raw[idx * 2]).ok_or("expected lowercase hex character [0-9a-f]")?;
        let lo = decode_nibble_lower(raw[idx * 2 + 1])
            .ok_or("expected lowercase hex character [0-9a-f]")?;
        *slot = (hi << 4) | lo;
    }
    Ok(out)
}

/// Decodes a `u64` draw word from a strict 16-character lowercase hex string.
pub fn decode_u64_hex(s: &str) -> Result<u64, &'static str> {
    if s.len() != 16 {
        return Err("expected exactly 16 lowercase hex characters");
    }
    let raw = s.as_bytes();
    let mut out = [0u8; 8];
    for (idx, slot) in out.iter_mut().enumerate() {
        let hi =
            decode_nibble_lower(raw[idx * 2]).ok_or("expected lowercase hex character [0-9a-f]")?;
        let lo = decode_nibble_lower(raw[idx * 2 + 1])
            .ok_or("expected lowercase hex character [0-9a-f]")?;
        *slot = (hi << 4) | lo;
    }
    Ok(u64::from_be_bytes(out))
}

/// Parses a canonical base-10 signed 64-bit integer string (`"0"` or `"-?[1-9][0-9]*"`).
pub fn parse_canonical_i64(s: &str) -> Result<i64, &'static str> {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return Err("empty integer string");
    }
    if bytes == b"0" {
        return Ok(0);
    }
    let digits = if bytes[0] == b'-' { &bytes[1..] } else { bytes };
    if digits.is_empty() || digits[0] == b'0' || !digits.iter().all(u8::is_ascii_digit) {
        return Err("non-canonical base-10 i64 string");
    }
    s.parse::<i64>().map_err(|_| "i64 string out of range")
}

/// Parses a canonical base-10 unsigned 64-bit integer string (`"0"` or `"[1-9][0-9]*"`).
pub fn parse_canonical_u64(s: &str) -> Result<u64, &'static str> {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return Err("empty integer string");
    }
    if bytes == b"0" {
        return Ok(0);
    }
    if bytes[0] == b'0' || !bytes.iter().all(u8::is_ascii_digit) {
        return Err("non-canonical base-10 u64 string");
    }
    s.parse::<u64>().map_err(|_| "u64 string out of range")
}

pub mod i64_str {
    use super::*;

    pub fn serialize<S: Serializer>(val: &i64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&val.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        let s = String::deserialize(deserializer)?;
        parse_canonical_i64(&s).map_err(D::Error::custom)
    }
}

pub mod opt_i64_str {
    use super::*;

    pub fn serialize<S: Serializer>(val: &Option<i64>, serializer: S) -> Result<S::Ok, S::Error> {
        match val {
            Some(v) => serializer.serialize_some(&v.to_string()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<i64>, D::Error> {
        let opt = Option::<String>::deserialize(deserializer)?;
        match opt {
            Some(s) => parse_canonical_i64(&s).map(Some).map_err(D::Error::custom),
            None => Ok(None),
        }
    }
}

pub mod vec_i64_str {
    use super::*;

    pub fn serialize<S: Serializer>(vals: &[i64], serializer: S) -> Result<S::Ok, S::Error> {
        let strings: Vec<String> = vals.iter().map(ToString::to_string).collect();
        strings.serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<i64>, D::Error> {
        let raw = Vec::<String>::deserialize(deserializer)?;
        raw.into_iter()
            .map(|s| parse_canonical_i64(&s).map_err(D::Error::custom))
            .collect()
    }
}

pub mod u64_str {
    use super::*;

    pub fn serialize<S: Serializer>(val: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&val.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let s = String::deserialize(deserializer)?;
        parse_canonical_u64(&s).map_err(D::Error::custom)
    }
}

pub mod opt_nonzero_u64_str {
    use super::*;

    pub fn serialize<S: Serializer>(
        val: &Option<NonZeroU64>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match val {
            Some(v) => serializer.serialize_some(&v.get().to_string()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<NonZeroU64>, D::Error> {
        let opt = Option::<String>::deserialize(deserializer)?;
        match opt {
            Some(s) => {
                let n = parse_canonical_u64(&s).map_err(D::Error::custom)?;
                let nz = NonZeroU64::new(n)
                    .ok_or_else(|| D::Error::custom("expected positive integer >= 1"))?;
                Ok(Some(nz))
            }
            None => Ok(None),
        }
    }
}

pub mod bytes32_hex {
    use super::*;

    pub fn serialize<S: Serializer>(bytes: &[u8; 32], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&encode_hex_lower(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<[u8; 32], D::Error> {
        let s = String::deserialize(deserializer)?;
        decode_bytes32_hex(&s).map_err(D::Error::custom)
    }
}

pub mod vec_u64_hex {
    use super::*;

    pub fn serialize<S: Serializer>(words: &[u64], serializer: S) -> Result<S::Ok, S::Error> {
        let strings: Vec<String> = words.iter().copied().map(encode_u64_hex).collect();
        strings.serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u64>, D::Error> {
        let raw = Vec::<String>::deserialize(deserializer)?;
        raw.into_iter()
            .map(|s| decode_u64_hex(&s).map_err(D::Error::custom))
            .collect()
    }
}
