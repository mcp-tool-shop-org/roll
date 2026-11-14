//! Deterministic `#![no_std]` IEEE-754 `f64` math primitives.
//!
//! `roll-core` avoids platform `libm` calls so `roll-core` compiles on bare
//! `no_std` targets (`wasm32-unknown-unknown`) and produces bit-for-bit
//! identical `DistributionStats` (`stddev`, `entropy`) across Windows MSVCRT,
//! Linux glibc, macOS, and `wasm32-wasip1`.

/// Normalizes `-0.0` to `+0.0`, leaving all other `f64` values unchanged.
#[inline]
pub(crate) fn canon_f64(x: f64) -> f64 {
    if x == 0.0 { 0.0 } else { x }
}

/// Binary exponentiation `base.powi(exp as i32)` for `u32` exponents using only
/// deterministic IEEE-754 multiplications.
#[inline]
pub(crate) fn powi_u32(mut base: f64, mut exp: u32) -> f64 {
    let mut acc = 1.0_f64;
    while exp > 0 {
        if (exp & 1) != 0 {
            acc *= base;
        }
        exp >>= 1;
        if exp > 0 {
            base *= base;
        }
    }
    acc
}

/// Correctly-rounded IEEE-754 `sqrt(x)` (`0.0` ULP error across all `f64` values)
/// implemented via `u128::isqrt`.
pub fn sqrt_f64(x: f64) -> f64 {
    if x.is_nan() || x < 0.0 {
        return f64::NAN;
    }
    if x == 0.0 {
        return 0.0;
    }
    if x.is_infinite() {
        return x;
    }

    let bits = x.to_bits();
    let exp_bits = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1u64 << 52) - 1);

    let (mut m, mut unbiased_exp) = if exp_bits == 0 {
        // Subnormal: `frac != 0` in `1..(1 << 52)`. Shift left until bit 52 is set.
        let shift = frac.leading_zeros() - 11;
        (frac << shift, -1022 - (shift as i32))
    } else {
        ((1u64 << 52) | frac, exp_bits - 1023)
    };

    // Ensure `unbiased_exp = 2 * k` is even so `sqrt(m * 2^52)` aligns directly.
    if (unbiased_exp & 1) != 0 {
        m <<= 1;
        unbiased_exp -= 1;
    }
    let mut k = unbiased_exp >> 1;

    // `m` is in `[2^52, 2^54)`, so `n = m * 2^54` is in `[2^106, 2^108)` and `0 mod 4`.
    // Because `(2s + 1)^2 == 1 mod 4`, `n` is never an exact half-ULP midpoint, so bit 0
    // of `floor(sqrt(n))` gives exact IEEE-754 round-to-nearest-even rounding.
    let n: u128 = (m as u128) << 54;
    let q: u64 = n.isqrt() as u64;
    let mut sig: u64 = (q >> 1) + (q & 1);
    if sig == (1u64 << 53) {
        sig >>= 1;
        k += 1;
    }

    let biased_k = (k + 1023) as u64;
    f64::from_bits((biased_k << 52) | (sig & ((1u64 << 52) - 1)))
}

/// Deterministic pure-Rust `log2(x)` using IEEE-754 exponent extraction and an
/// odd-power Horner rational expansion over `z = (f - 1) / (f + 1)` for
/// `f in [sqrt(1/2), sqrt(2)]` (`|z| <= 0.171573`, truncation error `< 2e-21`).
pub fn log2_f64(x: f64) -> f64 {
    if x.is_nan() || x < 0.0 {
        return f64::NAN;
    }
    if x == 0.0 {
        return f64::NEG_INFINITY;
    }
    if x.is_infinite() {
        return f64::INFINITY;
    }

    let bits = x.to_bits();
    let exp_bits = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1u64 << 52) - 1);

    let (m, mut e) = if exp_bits == 0 {
        let shift = frac.leading_zeros() - 11;
        (frac << shift, -1022 - (shift as i32))
    } else {
        ((1u64 << 52) | frac, exp_bits - 1023)
    };

    // Reconstruct normalized mantissa `f` in `[1.0, 2.0)`.
    let mut f = f64::from_bits((1023u64 << 52) | (m & ((1u64 << 52) - 1)));
    if f > core::f64::consts::SQRT_2 {
        f *= 0.5;
        e += 1;
    }

    if f == 1.0 {
        return canon_f64(e as f64);
    }

    let z = (f - 1.0) / (f + 1.0);
    let z2 = z * z;

    // Horner evaluation of `sum_{k=0}^{11} z2^k / (2k + 1)`.
    let mut poly = 1.0 / 23.0;
    let mut denom = 21.0;
    while denom >= 1.0 {
        poly = (1.0 / denom) + z2 * poly;
        denom -= 2.0;
    }

    let ln_f = 2.0 * z * poly;
    canon_f64((e as f64) + ln_f * core::f64::consts::LOG2_E)
}
