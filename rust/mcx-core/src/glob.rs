//! fnmatch-style globbing with linear-time backtracking.
//!
//! The classic recursive matcher is exponential on patterns like `*a*a*a*b`,
//! which is exactly the shape a user types into mc's "file mask" box. This is
//! the standard single-star-backtrack loop: each `*` remembers one resume
//! point, so the worst case is O(pattern × subject).

#[inline]
fn fold(b: u8, ci: bool) -> u8 {
    if ci && b.is_ascii_uppercase() {
        b + 32
    } else {
        b
    }
}

/// Match `[...]`: returns (matched, index just past the closing `]`).
/// An unterminated class is treated as a literal `[`, as fnmatch does.
fn class(pat: &[u8], mut p: usize, c: u8, ci: bool) -> (bool, usize, bool) {
    let start = p;
    p += 1; // consume '['
    let negate = matches!(pat.get(p), Some(b'!') | Some(b'^'));
    if negate {
        p += 1;
    }
    let mut matched = false;
    let mut first = true;
    while p < pat.len() {
        // A `]` in the first position is a literal, per POSIX.
        if pat[p] == b']' && !first {
            return (matched != negate, p + 1, true);
        }
        first = false;
        let lo = if pat[p] == b'\\' && p + 1 < pat.len() {
            p += 1;
            pat[p]
        } else {
            pat[p]
        };
        // range `a-z`, but a trailing `-` before `]` is a literal
        if p + 2 < pat.len() && pat[p + 1] == b'-' && pat[p + 2] != b']' {
            let hi = pat[p + 2];
            let cf = fold(c, ci);
            if (fold(lo, ci)..=fold(hi, ci)).contains(&cf) {
                matched = true;
            }
            p += 3;
        } else {
            if fold(lo, ci) == fold(c, ci) {
                matched = true;
            }
            p += 1;
        }
    }
    // Unterminated: caller falls back to literal `[`.
    (false, start, false)
}

pub fn matches(pat: &[u8], s: &[u8], ci: bool) -> bool {
    let (mut p, mut i) = (0usize, 0usize);
    // Resume point for the most recent `*`.
    let (mut star_p, mut star_i) = (usize::MAX, 0usize);

    while i < s.len() {
        if p < pat.len() {
            match pat[p] {
                b'*' => {
                    star_p = p;
                    p += 1;
                    star_i = i;
                    continue;
                }
                b'?' => {
                    p += 1;
                    i += 1;
                    continue;
                }
                b'[' => {
                    let (ok, next, terminated) = class(pat, p, s[i], ci);
                    if terminated {
                        if ok {
                            p = next;
                            i += 1;
                            continue;
                        }
                    } else if fold(b'[', ci) == fold(s[i], ci) {
                        p += 1;
                        i += 1;
                        continue;
                    }
                }
                b'\\' if p + 1 < pat.len() => {
                    if fold(pat[p + 1], ci) == fold(s[i], ci) {
                        p += 2;
                        i += 1;
                        continue;
                    }
                }
                c => {
                    if fold(c, ci) == fold(s[i], ci) {
                        p += 1;
                        i += 1;
                        continue;
                    }
                }
            }
        }
        // Mismatch: rewind to just after the last `*` and let it eat one more byte.
        if star_p != usize::MAX {
            p = star_p + 1;
            star_i += 1;
            i = star_i;
            continue;
        }
        return false;
    }

    while p < pat.len() && pat[p] == b'*' {
        p += 1;
    }
    p == pat.len()
}
