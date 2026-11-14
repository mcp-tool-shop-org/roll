use alloc::string::String;
use alloc::vec::Vec;
use serde_json::Value;

use crate::error::RollError;

/// Compares two UTF-8 strings by their UTF-16 code unit sequences (RFC 8785 JCS §3.2.3).
///
/// Note that UTF-8 byte order (`str::cmp`) disagrees with UTF-16 code unit order
/// whenever comparing a BMP code point in `U+E000..=U+FFFF` against a supplementary
/// code point above `U+FFFF` (encoded as a surrogate pair `0xD800..=0xDFFF`).
/// For example, `"🎲"` (`U+1F3B2`, UTF-16 `[0xD83C, 0xDFB2]`) sorts BEFORE `"\u{E000}"`
/// (UTF-16 `[0xE000]`) in JCS / `JSON.stringify`, whereas UTF-8 sorts `"\u{E000}"` first.
pub fn cmp_utf16_code_units(a: &str, b: &str) -> core::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Serializes a float-free [`serde_json::Value`] to deterministic RFC 8785 (JCS) canonical JSON.
pub fn to_canonical_json(value: &Value) -> Result<String, RollError> {
    let mut out = String::new();
    write_canonical_value(value, &mut out)?;
    Ok(out)
}

fn write_canonical_value(value: &Value, out: &mut String) -> Result<(), RollError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                out.push_str(&alloc::string::ToString::to_string(&i));
            } else if let Some(u) = n.as_u64() {
                out.push_str(&alloc::string::ToString::to_string(&u));
            } else {
                return Err(RollError::CanonicalJsonFloatUnsupported);
            }
        }
        Value::String(s) => write_canonical_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (idx, item) in items.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                write_canonical_value(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|(ka, _), (kb, _)| cmp_utf16_code_units(ka, kb));
            out.push('{');
            for (idx, (key, val)) in entries.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                write_canonical_string(key, out);
                out.push(':');
                write_canonical_value(val, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// Writes a JSON string per RFC 8785 §3.2.2.2 (RFC 8259 minimal escapes + lowercase `\u00xx`).
fn write_canonical_string(s: &str, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\x08' => out.push_str("\\b"),
            '\x0c' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) <= 0x1f => {
                let b = c as u8;
                out.push_str("\\u00");
                out.push(HEX[(b >> 4) as usize] as char);
                out.push(HEX[(b & 0x0f) as usize] as char);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
