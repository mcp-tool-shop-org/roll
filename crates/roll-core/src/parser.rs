use alloc::boxed::Box;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use core::num::NonZeroU32;

use crate::ast::{
    BinaryOp, ClampBounds, CompareOp, ComparePoint, DiceSides, DiceSpec, ExplosionRule,
    ExplosionVariant, Expr, KeepDropOp, MAX_DICE_PER_GROUP, MAX_DIE_SIDES, MAX_EXPRESSION_BYTES,
    MAX_NESTING_DEPTH, MAX_TOTAL_DICE_PER_EXPR, ResultMode, SortOrder,
};
use crate::error::RollError;

/// Parses a Roll 3.0 dice/arithmetic expression into a statically validated [`Expr`].
pub fn parse(input: &str) -> Result<Expr, RollError> {
    if input.len() > MAX_EXPRESSION_BYTES {
        return Err(RollError::ExpressionTooLong {
            len: input.len(),
            max: MAX_EXPRESSION_BYTES,
        });
    }

    let mut scanner = Scanner {
        input,
        bytes: input.as_bytes(),
        pos: 0,
        total_dice: 0,
        depth: 0,
    };

    let expr = scanner.parse_expression()?;
    scanner.skip_ws();

    if scanner.pos < scanner.bytes.len() {
        let b = scanner.bytes[scanner.pos];
        if is_expr_mode_token_start(b) {
            let ch = scanner.next_char_display();
            return Err(RollError::Parse {
                message: format!("unexpected token '{ch}' after expression"),
                byte_offset: scanner.pos,
            });
        }
        let ch = scanner.next_char_display();
        return Err(RollError::Lex {
            message: format!("unexpected character '{ch}'"),
            byte_offset: scanner.pos,
        });
    }

    Ok(expr)
}

const fn is_expr_mode_token_start(b: u8) -> bool {
    matches!(
        b,
        b'0'..=b'9' | b'+' | b'-' | b'*' | b'/' | b'(' | b')' | b'd' | b'D'
    )
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum ModifierKeyword {
    Min,
    Max,
    Kh,
    Kl,
    Dh,
    Dl,
    Ro,
    Cs,
    Cf,
    Sa,
    Sd,
    BangP,
    BangBang,
    Bang,
    R,
}

/// Ordered longest-match modifier prefix table (Roll 3.0 §4.1).
const MODIFIER_TABLE: &[(&str, ModifierKeyword)] = &[
    ("min", ModifierKeyword::Min),
    ("max", ModifierKeyword::Max),
    ("kh", ModifierKeyword::Kh),
    ("kl", ModifierKeyword::Kl),
    ("dh", ModifierKeyword::Dh),
    ("dl", ModifierKeyword::Dl),
    ("ro", ModifierKeyword::Ro),
    ("cs", ModifierKeyword::Cs),
    ("cf", ModifierKeyword::Cf),
    ("sa", ModifierKeyword::Sa),
    ("sd", ModifierKeyword::Sd),
    ("!p", ModifierKeyword::BangP),
    ("!!", ModifierKeyword::BangBang),
    ("!", ModifierKeyword::Bang),
    ("r", ModifierKeyword::R),
];

struct Scanner<'a> {
    input: &'a str,
    bytes: &'a [u8],
    pos: usize,
    total_dice: u64,
    depth: usize,
}

impl<'a> Scanner<'a> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(b' ' | b'\t') = self.peek() {
            self.pos += 1;
        }
    }

    fn next_char_display(&self) -> char {
        self.input[self.pos..].chars().next().unwrap_or('\0')
    }

    fn parse_expression(&mut self) -> Result<Expr, RollError> {
        let mut left = self.parse_term()?;
        loop {
            self.skip_ws();
            let op = match self.peek() {
                Some(b'+') => BinaryOp::Add,
                Some(b'-') => BinaryOp::Sub,
                _ => break,
            };
            self.pos += 1;
            let right = self.parse_term()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_term(&mut self) -> Result<Expr, RollError> {
        let mut left = self.parse_factor()?;
        loop {
            self.skip_ws();
            let op = match self.peek() {
                Some(b'*') => BinaryOp::Mul,
                Some(b'/') => BinaryOp::DivFloor,
                _ => break,
            };
            self.pos += 1;
            let right = self.parse_factor()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_factor(&mut self) -> Result<Expr, RollError> {
        self.skip_ws();
        let Some(b) = self.peek() else {
            return Err(RollError::Parse {
                message: String::from("unexpected end of expression"),
                byte_offset: self.pos,
            });
        };

        match b {
            b'-' => {
                let minus_start = self.pos;
                let mut digit_end = self.pos + 1;
                while digit_end < self.bytes.len() && self.bytes[digit_end].is_ascii_digit() {
                    digit_end += 1;
                }
                if digit_end > self.pos + 1
                    && !matches!(self.bytes.get(digit_end), Some(b'd' | b'D'))
                {
                    self.pos = digit_end;
                    let signed = &self.input[minus_start..digit_end];
                    let value = signed
                        .parse::<i64>()
                        .map_err(|_| RollError::ArithmeticOverflow)?;
                    Ok(Expr::Number(value))
                } else {
                    let next_depth = self.depth + 1;
                    if next_depth > MAX_NESTING_DEPTH {
                        return Err(RollError::ExpressionTooDeep {
                            depth: next_depth,
                            max: MAX_NESTING_DEPTH,
                            byte_offset: minus_start,
                        });
                    }
                    self.pos += 1;
                    self.depth = next_depth;
                    let operand_res = self.parse_factor();
                    self.depth -= 1;
                    let operand = operand_res?;
                    Ok(Expr::UnaryNeg(Box::new(operand)))
                }
            }
            b'(' => {
                let open_pos = self.pos;
                let next_depth = self.depth + 1;
                if next_depth > MAX_NESTING_DEPTH {
                    return Err(RollError::ExpressionTooDeep {
                        depth: next_depth,
                        max: MAX_NESTING_DEPTH,
                        byte_offset: open_pos,
                    });
                }
                self.pos += 1;
                self.depth = next_depth;
                let inner_res = self.parse_expression();
                self.depth -= 1;
                let inner = inner_res?;
                self.skip_ws();
                match self.peek() {
                    Some(b')') => {
                        self.pos += 1;
                        Ok(inner)
                    }
                    Some(other) if !is_expr_mode_token_start(other) => {
                        let ch = self.next_char_display();
                        Err(RollError::Lex {
                            message: format!("unexpected character '{ch}'"),
                            byte_offset: self.pos,
                        })
                    }
                    _ => Err(RollError::Parse {
                        message: format!("unclosed '(' opened at byte {open_pos}"),
                        byte_offset: self.pos,
                    }),
                }
            }
            b'0'..=b'9' => {
                let start = self.pos;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
                let digits = &self.input[start..self.pos];

                if matches!(self.peek(), Some(b'd' | b'D')) {
                    if digits.bytes().all(|c| c == b'0') {
                        return Err(RollError::Parse {
                            message: String::from("dice count must be at least 1"),
                            byte_offset: start,
                        });
                    }
                    let count_u64 = digits.parse::<u64>().unwrap_or(u64::MAX);
                    self.pos += 1; // consume 'd' | 'D'
                    self.parse_dice(count_u64)
                } else {
                    let value = digits
                        .parse::<i64>()
                        .map_err(|_| RollError::ArithmeticOverflow)?;
                    Ok(Expr::Number(value))
                }
            }
            b'd' | b'D' => {
                self.pos += 1;
                self.parse_dice(1)
            }
            b'+' | b'*' | b'/' | b')' => {
                let ch = b as char;
                Err(RollError::Parse {
                    message: format!("unexpected operator '{ch}'"),
                    byte_offset: self.pos,
                })
            }
            _ => {
                let ch = self.next_char_display();
                Err(RollError::Lex {
                    message: format!("unexpected character '{ch}'"),
                    byte_offset: self.pos,
                })
            }
        }
    }

    fn parse_dice(&mut self, count_u64: u64) -> Result<Expr, RollError> {
        self.total_dice = self.total_dice.saturating_add(count_u64);
        if count_u64 > u64::from(MAX_DICE_PER_GROUP)
            || self.total_dice > u64::from(MAX_TOTAL_DICE_PER_EXPR)
        {
            return Err(RollError::DiceBudgetExceeded {
                total_dice: self.total_dice,
                max: u64::from(MAX_TOTAL_DICE_PER_EXPR),
            });
        }
        let count = NonZeroU32::new(count_u64 as u32).expect("count_u64 >= 1");

        // Sides slot (parsed once immediately after `[dD]`).
        let sides = match self.peek() {
            Some(b'%') => {
                self.pos += 1;
                DiceSides::Percentile
            }
            Some(b'f' | b'F') => {
                self.pos += 1;
                DiceSides::Fate
            }
            Some(b'0'..=b'9') => {
                let sides_start = self.pos;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
                let digits = &self.input[sides_start..self.pos];
                if digits.bytes().all(|c| c == b'0') {
                    return Err(RollError::Parse {
                        message: String::from("die must have at least 1 side"),
                        byte_offset: sides_start,
                    });
                }
                let sides_u64 = digits.parse::<u64>().unwrap_or(u64::MAX);
                if sides_u64 > u64::from(MAX_DIE_SIDES) {
                    return Err(RollError::Parse {
                        message: format!(
                            "die sides {sides_u64} exceeds maximum of {MAX_DIE_SIDES}"
                        ),
                        byte_offset: sides_start,
                    });
                }
                DiceSides::Standard(NonZeroU32::new(sides_u64 as u32).expect("sides_u64 >= 1"))
            }
            _ => {
                return Err(RollError::Parse {
                    message: String::from(
                        "expected die sides ('%', 'F', or positive integer) after 'd'",
                    ),
                    byte_offset: self.pos,
                });
            }
        };

        let mut reroll_unlimited: Vec<ComparePoint> = Vec::new();
        let mut reroll_once: Vec<ComparePoint> = Vec::new();
        let mut min_bound: Option<i64> = None;
        let mut max_bound: Option<i64> = None;
        let mut explode: Option<ExplosionRule> = None;
        let mut keep_drop: Vec<KeepDropOp> = Vec::new();
        let mut crit_success_max = false;
        let mut crit_failure_min = false;
        let mut pool_cs: Vec<ComparePoint> = Vec::new();
        let mut pool_cf: Vec<ComparePoint> = Vec::new();
        let mut sort: Option<SortOrder> = None;

        // Modifier loop: longest-match prefix scan with zero word-boundary lookahead.
        while let Some((kw, kw_len)) = self.match_modifier_keyword() {
            let mod_offset = self.pos;
            self.pos += kw_len;

            match kw {
                ModifierKeyword::Min => {
                    if min_bound.is_some() {
                        return Err(RollError::Parse {
                            message: String::from("duplicate 'min' modifier on dice group"),
                            byte_offset: mod_offset,
                        });
                    }
                    let lo = self.parse_required_i64("min")?;
                    if let Some(hi) = max_bound
                        && lo > hi
                    {
                        return Err(RollError::InvalidClampBounds {
                            min: lo,
                            max: hi,
                            byte_offset: mod_offset,
                        });
                    }
                    min_bound = Some(lo);
                }
                ModifierKeyword::Max => {
                    if max_bound.is_some() {
                        return Err(RollError::Parse {
                            message: String::from("duplicate 'max' modifier on dice group"),
                            byte_offset: mod_offset,
                        });
                    }
                    let hi = self.parse_required_i64("max")?;
                    if let Some(lo) = min_bound
                        && lo > hi
                    {
                        return Err(RollError::InvalidClampBounds {
                            min: lo,
                            max: hi,
                            byte_offset: mod_offset,
                        });
                    }
                    max_bound = Some(hi);
                }
                ModifierKeyword::Kh => {
                    let n = self.parse_optional_u32(1)?;
                    keep_drop.push(KeepDropOp::KeepHighest(n));
                }
                ModifierKeyword::Kl => {
                    let n = self.parse_optional_u32(1)?;
                    keep_drop.push(KeepDropOp::KeepLowest(n));
                }
                ModifierKeyword::Dh => {
                    let n = self.parse_optional_u32(1)?;
                    keep_drop.push(KeepDropOp::DropHighest(n));
                }
                ModifierKeyword::Dl => {
                    let n = self.parse_optional_u32(1)?;
                    keep_drop.push(KeepDropOp::DropLowest(n));
                }
                ModifierKeyword::R => {
                    let cp = self
                        .parse_optional_compare_point()?
                        .unwrap_or(ComparePoint {
                            op: CompareOp::Eq,
                            value: 1,
                        });
                    reroll_unlimited.push(cp);
                }
                ModifierKeyword::Ro => {
                    let cp = self
                        .parse_optional_compare_point()?
                        .unwrap_or(ComparePoint {
                            op: CompareOp::Eq,
                            value: 1,
                        });
                    reroll_once.push(cp);
                }
                ModifierKeyword::Bang | ModifierKeyword::BangBang | ModifierKeyword::BangP => {
                    if sides == DiceSides::Fate {
                        return Err(RollError::Parse {
                            message: String::from("Fate dice (dF) cannot explode"),
                            byte_offset: mod_offset,
                        });
                    }
                    if explode.is_some() {
                        return Err(RollError::Parse {
                            message: String::from("duplicate explosion modifier on dice group"),
                            byte_offset: mod_offset,
                        });
                    }
                    let variant = match kw {
                        ModifierKeyword::Bang => ExplosionVariant::Standard,
                        ModifierKeyword::BangBang => ExplosionVariant::Compound,
                        ModifierKeyword::BangP => ExplosionVariant::Penetrate,
                        _ => unreachable!(),
                    };
                    let threshold = self
                        .parse_optional_compare_point()?
                        .unwrap_or(ComparePoint {
                            op: CompareOp::Gte,
                            value: sides.max_face(),
                        });
                    explode = Some(ExplosionRule { variant, threshold });
                }
                ModifierKeyword::Cs => {
                    if let Some(cp) = self.parse_optional_compare_point()? {
                        if crit_success_max || crit_failure_min {
                            return Err(RollError::Parse {
                                message: String::from(
                                    "cannot mix bare sum-mode critical marking (e.g. 1d20cscf) with pool success/failure counting (e.g. 8d6cs>=5cf<=1)",
                                ),
                                byte_offset: mod_offset,
                            });
                        }
                        pool_cs.push(cp);
                    } else {
                        if !pool_cs.is_empty() || !pool_cf.is_empty() {
                            return Err(RollError::Parse {
                                message: String::from(
                                    "cannot mix bare sum-mode critical marking (e.g. 1d20cscf) with pool success/failure counting (e.g. 8d6cs>=5cf<=1)",
                                ),
                                byte_offset: mod_offset,
                            });
                        }
                        if crit_success_max {
                            return Err(RollError::Parse {
                                message: String::from("duplicate bare 'cs' modifier on dice group"),
                                byte_offset: mod_offset,
                            });
                        }
                        crit_success_max = true;
                    }
                }
                ModifierKeyword::Cf => {
                    if let Some(cp) = self.parse_optional_compare_point()? {
                        if crit_success_max || crit_failure_min {
                            return Err(RollError::Parse {
                                message: String::from(
                                    "cannot mix bare sum-mode critical marking (e.g. 1d20cscf) with pool success/failure counting (e.g. 8d6cs>=5cf<=1)",
                                ),
                                byte_offset: mod_offset,
                            });
                        }
                        pool_cf.push(cp);
                    } else {
                        if !pool_cs.is_empty() || !pool_cf.is_empty() {
                            return Err(RollError::Parse {
                                message: String::from(
                                    "cannot mix bare sum-mode critical marking (e.g. 1d20cscf) with pool success/failure counting (e.g. 8d6cs>=5cf<=1)",
                                ),
                                byte_offset: mod_offset,
                            });
                        }
                        if crit_failure_min {
                            return Err(RollError::Parse {
                                message: String::from("duplicate bare 'cf' modifier on dice group"),
                                byte_offset: mod_offset,
                            });
                        }
                        crit_failure_min = true;
                    }
                }
                ModifierKeyword::Sa => {
                    if sort.is_some() {
                        return Err(RollError::Parse {
                            message: String::from("duplicate sort modifier on dice group"),
                            byte_offset: mod_offset,
                        });
                    }
                    sort = Some(SortOrder::Asc);
                }
                ModifierKeyword::Sd => {
                    if sort.is_some() {
                        return Err(RollError::Parse {
                            message: String::from("duplicate sort modifier on dice group"),
                            byte_offset: mod_offset,
                        });
                    }
                    sort = Some(SortOrder::Desc);
                }
            }
        }

        let clamp = if min_bound.is_some() || max_bound.is_some() {
            Some(ClampBounds {
                min: min_bound,
                max: max_bound,
            })
        } else {
            None
        };

        let mode = if !pool_cs.is_empty() || !pool_cf.is_empty() {
            ResultMode::Pool {
                cs: pool_cs,
                cf: pool_cf,
            }
        } else {
            ResultMode::Sum {
                crit_success_max,
                crit_failure_min,
            }
        };

        Ok(Expr::Dice(DiceSpec {
            count,
            sides,
            reroll_unlimited,
            reroll_once,
            clamp,
            explode,
            keep_drop,
            mode,
            sort,
        }))
    }

    fn match_modifier_keyword(&self) -> Option<(ModifierKeyword, usize)> {
        let rest = &self.bytes[self.pos..];
        for &(prefix, kw) in MODIFIER_TABLE {
            let pbytes = prefix.as_bytes();
            if rest.len() >= pbytes.len() && rest[..pbytes.len()].eq_ignore_ascii_case(pbytes) {
                return Some((kw, pbytes.len()));
            }
        }
        None
    }

    fn parse_required_i64(&mut self, context: &str) -> Result<i64, RollError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        let digit_start = self.pos;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        if self.pos == digit_start {
            return Err(RollError::Parse {
                message: format!("expected integer argument after '{context}'"),
                byte_offset: start,
            });
        }
        self.input[start..self.pos]
            .parse::<i64>()
            .map_err(|_| RollError::ArithmeticOverflow)
    }

    fn parse_optional_u32(&mut self, default: u32) -> Result<u32, RollError> {
        if !matches!(self.peek(), Some(b'0'..=b'9')) {
            return Ok(default);
        }
        let start = self.pos;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        self.input[start..self.pos]
            .parse::<u32>()
            .map_err(|_| RollError::Parse {
                message: String::from("keep/drop count exceeds u32::MAX"),
                byte_offset: start,
            })
    }

    fn parse_optional_compare_point(&mut self) -> Result<Option<ComparePoint>, RollError> {
        let rest = &self.bytes[self.pos..];
        let (op, op_len) = if rest.starts_with(b">=") {
            (CompareOp::Gte, 2)
        } else if rest.starts_with(b"<=") {
            (CompareOp::Lte, 2)
        } else if rest.starts_with(b">") {
            (CompareOp::Gt, 1)
        } else if rest.starts_with(b"<") {
            (CompareOp::Lt, 1)
        } else if rest.starts_with(b"=") {
            (CompareOp::Eq, 1)
        } else {
            return Ok(None);
        };

        self.pos += op_len;
        let value = self.parse_required_i64(op.as_str())?;
        Ok(Some(ComparePoint { op, value }))
    }
}
