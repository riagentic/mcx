//! Byte search and line indexing — the viewer's and grep's inner loops.

#[inline]
fn fold(b: u8, ci: bool) -> u8 {
    if ci && b.is_ascii_uppercase() {
        b + 32
    } else {
        b
    }
}

/// Boyer–Moore–Horspool. The skip table costs 256 bytes and turns the common
/// case (a needle whose last byte is rare) into a sublinear scan — the
/// difference between "search a 2 GB log" and "wait for a 2 GB log".
pub fn find(hay: &[u8], needle: &[u8], from: usize, ci: bool) -> Option<usize> {
    let n = needle.len();
    if n == 0 {
        return if from <= hay.len() { Some(from) } else { None };
    }
    if from >= hay.len() || hay.len() - from < n {
        return None;
    }

    let mut skip = [0usize; 256];
    skip.fill(n);
    for (k, &b) in needle.iter().enumerate().take(n - 1) {
        skip[fold(b, ci) as usize] = n - 1 - k;
    }

    let last = n - 1;
    let mut i = from;
    while i + n <= hay.len() {
        let mut k = last;
        loop {
            if fold(hay[i + k], ci) != fold(needle[k], ci) {
                break;
            }
            if k == 0 {
                return Some(i);
            }
            k -= 1;
        }
        i += skip[fold(hay[i + last], ci) as usize];
    }
    None
}

/// Backwards search: the last match starting at or before `from`.
pub fn rfind(hay: &[u8], needle: &[u8], from: usize, ci: bool) -> Option<usize> {
    let n = needle.len();
    if n == 0 {
        return Some(from.min(hay.len()));
    }
    if n > hay.len() {
        return None;
    }
    let mut i = from.min(hay.len() - n);
    loop {
        if hay[i..i + n]
            .iter()
            .zip(needle)
            .all(|(&a, &b)| fold(a, ci) == fold(b, ci))
        {
            return Some(i);
        }
        if i == 0 {
            return None;
        }
        i -= 1;
    }
}

/// Line-start offsets, capped by `out.len()`. Offset 0 is always the first
/// entry, so `out[k]` is the start of line `k`.
pub fn line_index(buf: &[u8], out: &mut [u32]) -> usize {
    if out.is_empty() {
        return 0;
    }
    out[0] = 0;
    let mut n = 1;
    for (i, &b) in buf.iter().enumerate() {
        if b == b'\n' {
            if n >= out.len() {
                return n;
            }
            // A trailing newline does not open a line that exists.
            if i + 1 < buf.len() {
                out[n] = (i + 1) as u32;
                n += 1;
            }
        }
    }
    n
}
