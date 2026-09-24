//! Listing sort and the filter that precedes it. mc's ordering rules, made
//! explicit:
//!
//! - `..` is always the first row — sort order never moves it, and no filter
//!   ever removes it (a panel you cannot walk out of is a trap).
//! - "directories first" survives reverse (mc reverses within the groups, it
//!   does not push directories to the bottom).
//! - every key falls back to the name, so the order is total and a redraw of
//!   the same directory never shuffles rows.
//!
//! Filter and sort live in ONE function because they live in one wasm call:
//! packing 100_000 names into linear memory costs more than either step, so
//! doing it twice is the thing worth removing.

use crate::glob;

pub const KEY_NAME: u32 = 0;
pub const KEY_EXT: u32 = 1;
pub const KEY_SIZE: u32 = 2;
pub const KEY_MTIME: u32 = 3;
pub const KEY_UNSORTED: u32 = 4;
pub const KEY_VERSION: u32 = 5;

const OPT_REVERSE: u32 = 1;
const OPT_DIRS_FIRST: u32 = 2;
const OPT_CASE_SENSITIVE: u32 = 4;
/// Keep dotfiles. Off by default, exactly like mc's `M-.`.
const OPT_SHOW_HIDDEN: u32 = 8;

const FLAG_DIR: u8 = 1;
const FLAG_UPDIR: u8 = 2;

#[inline]
fn fold(b: u8) -> u8 {
    if b.is_ascii_uppercase() {
        b + 32
    } else {
        b
    }
}

/// Byte-wise name comparison. Case-insensitive folds ASCII only — beyond ASCII,
/// UTF-8 byte order is codepoint order, which is the stable, locale-free
/// ordering mcx wants (mc's strcoll ordering shifts with $LC_COLLATE; ours does
/// not, and that is deliberate: the same directory looks the same everywhere).
#[inline]
fn cmp_name(a: &[u8], b: &[u8], case_sensitive: bool) -> core::cmp::Ordering {
    if case_sensitive {
        return a.cmp(b);
    }
    let n = a.len().min(b.len());
    for i in 0..n {
        let (x, y) = (fold(a[i]), fold(b[i]));
        if x != y {
            return x.cmp(&y);
        }
    }
    // Equal ignoring case — fall back to the raw bytes so the order is total.
    a.cmp(b)
}

/// mc's "version" sort (`sort_vers`): digits compare as numbers, everything
/// else byte by byte. It is what puts `f2` before `f10`, which every other
/// ordering gets wrong on a directory of numbered files.
///
/// Leading zeros lose only as a tie-break, so `01` and `1` are not "equal" —
/// an ordering that called them equal would be unstable across two runs.
fn cmp_version(a: &[u8], b: &[u8], case_sensitive: bool) -> core::cmp::Ordering {
    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() && j < b.len() {
        let (ca, cb) = (a[i], b[j]);
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            // Skip leading zeros, remembering how many, then compare the runs
            // by length first — the longer run of digits is the bigger number.
            let za = i;
            while i < a.len() && a[i] == b'0' {
                i += 1;
            }
            let zb = j;
            while j < b.len() && b[j] == b'0' {
                j += 1;
            }
            let sa = i;
            while i < a.len() && a[i].is_ascii_digit() {
                i += 1;
            }
            let sb = j;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            let (da, db) = (&a[sa..i], &b[sb..j]);
            let ord = da.len().cmp(&db.len()).then_with(|| da.cmp(db));
            if ord != core::cmp::Ordering::Equal {
                return ord;
            }
            // Same number: fewer leading zeros first, as `strverscmp` has it.
            let ord = (sa - za).cmp(&(sb - zb));
            if ord != core::cmp::Ordering::Equal {
                return ord;
            }
            continue;
        }
        let (x, y) = if case_sensitive {
            (ca, cb)
        } else {
            (fold(ca), fold(cb))
        };
        if x != y {
            return x.cmp(&y);
        }
        i += 1;
        j += 1;
    }
    (a.len() - i).cmp(&(b.len() - j)).then_with(|| a.cmp(b))
}

/// Extension = everything after the last `.` that is not the leading character
/// (so dotfiles are all-name, matching mc).
#[inline]
fn ext(name: &[u8]) -> &[u8] {
    match name.iter().rposition(|&c| c == b'.') {
        Some(i) if i > 0 => &name[i + 1..],
        _ => &[],
    }
}

/// One directory listing as flat buffers — the shape the host hands over.
pub struct Listing<'a> {
    pub names: &'a [u8],
    pub offs: &'a [u32],
    pub sizes: &'a [f64],
    pub mtimes: &'a [f64],
    pub flags: &'a [u8],
}

impl Listing<'_> {
    #[inline]
    fn name(&self, i: usize) -> &[u8] {
        &self.names[self.offs[i] as usize..self.offs[i + 1] as usize]
    }
    #[inline]
    fn is_updir(&self, i: usize) -> bool {
        self.flags[i] & FLAG_UPDIR != 0
    }
    #[inline]
    fn is_hidden(&self, i: usize) -> bool {
        !self.is_updir(i) && self.name(i).first() == Some(&b'.')
    }
}

/// Which block an entry sorts into, before any key is consulted: `..` first,
/// then directories when "directories first" is on. Reverse order applies
/// WITHIN a block, never across — mc does not push directories to the bottom.
#[inline]
fn group(flags: u8, dirs_first: bool) -> u8 {
    if flags & FLAG_UPDIR != 0 {
        0
    } else if dirs_first && flags & FLAG_DIR != 0 {
        1
    } else {
        2
    }
}

/// The first 8 bytes of a name as one big-endian integer, case-folded when the
/// comparison is.
///
/// This is what makes the name sort fast. Comparing names byte by byte means
/// chasing a pointer into a 2 MB buffer for every one of the ~1.7 million
/// comparisons a 100_000-entry sort makes, and the cache misses — not the
/// comparing — are the cost. Almost every pair differs within eight bytes, so
/// almost every comparison becomes one `u64` compare against a value already in
/// the sort's working set; the full byte compare is only reached on a genuine
/// 8-byte tie.
#[inline]
fn prefix(name: &[u8], case_sensitive: bool) -> u64 {
    let mut k = 0u64;
    for i in 0..8 {
        let b = match name.get(i) {
            Some(&b) if case_sensitive => b,
            Some(&b) => fold(b),
            None => 0,
        };
        k = (k << 8) | b as u64;
    }
    k
}

/// One entry reduced to what the name sort compares. `repr(C)` because the
/// host allocates the array this lives in — nothing here allocates.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Key {
    /// The sort key itself when it is a number (size, mtime), in [`ord_bits`]
    /// form; `0` for the name sort, which has only the name.
    primary: u64,
    prefix: u64,
    idx: u32,
    group: u8,
    _pad: [u8; 3],
}

/// An `f64` as a `u64` whose unsigned order IS the number's order, so the
/// sort compares integers already in its working set instead of chasing two
/// indices into `sizes`/`mtimes` per comparison. `-0.0` folds into `+0.0`
/// (they compare equal as numbers); NaN — never a real size or time — sorts
/// after everything, where it cannot make the order intransitive.
#[inline]
fn ord_bits(x: f64) -> u64 {
    if x.is_nan() {
        return u64::MAX;
    }
    let bits = (if x == 0.0 { 0.0 } else { x }).to_bits();
    if bits >> 63 == 1 {
        !bits
    } else {
        bits | 1 << 63
    }
}

/// Bytes of scratch the host must provide per entry for [`sort_by_key`].
pub const SCRATCH_PER_ENTRY: usize = core::mem::size_of::<Key>();

/// How many leading bytes every name shares.
///
/// Real directories are full of them — `IMG_0001.jpg`, `entry-00042.ts`,
/// `2024-11-08-notes.md` — and a key built from the first eight bytes of names
/// like those is the same value for every entry, which turns the fast path back
/// into the slow one. Skipping the shared run puts the eight discriminating
/// bytes in the key instead. The scan itself stops at the first difference, so
/// on a directory with nothing in common it costs one byte per name.
///
/// `..` takes no part in it. It shares nothing with a real filename, so the one
/// `..` row that every panel but `/` has would drive the answer to zero and
/// switch the fast path off exactly where it is meant to fire — 100_000 names
/// sorted in 29ms instead of 14. Leaving it out costs nothing, because
/// [`group`] puts `..` ahead of every other row without ever consulting the key.
fn common_prefix(l: &Listing, idx: &[u32], case_sensitive: bool) -> usize {
    let mut rest = idx.iter().map(|&i| i as usize).filter(|&i| !l.is_updir(i));
    let first = match rest.next() {
        Some(i) => l.name(i),
        None => return 0,
    };
    let mut lcp = first.len();
    for i in rest {
        let n = l.name(i);
        let mut k = 0;
        let m = lcp.min(n.len());
        while k < m
            && (if case_sensitive {
                first[k] == n[k]
            } else {
                fold(first[k]) == fold(n[k])
            })
        {
            k += 1;
        }
        lcp = k;
        if lcp == 0 {
            break;
        }
    }
    lcp
}

/// The fast path: name, size and mtime — the name sort a panel pays for on
/// every directory it opens, and the two numeric sorts that tie-break on it.
/// Everything a comparison needs sits in the `Key`, so only a genuine tie on
/// value AND eight name bytes reaches back into the name buffer.
fn sort_by_key(l: &Listing, key: u32, opts: u32, idx: &mut [u32], keys: &mut [Key]) {
    let reverse = opts & OPT_REVERSE != 0;
    let dirs_first = opts & OPT_DIRS_FIRST != 0;
    let case_sensitive = opts & OPT_CASE_SENSITIVE != 0;
    let skip = common_prefix(l, idx, case_sensitive);

    for (slot, &i) in keys.iter_mut().zip(idx.iter()) {
        let n = i as usize;
        let name = l.name(n);
        *slot = Key {
            primary: match key {
                KEY_SIZE => ord_bits(l.sizes[n]),
                KEY_MTIME => ord_bits(l.mtimes[n]),
                _ => 0,
            },
            prefix: prefix(&name[skip.min(name.len())..], case_sensitive),
            idx: i,
            group: group(l.flags[n], dirs_first),
            _pad: [0; 3],
        };
    }

    keys.sort_unstable_by(|a, b| {
        a.group.cmp(&b.group).then_with(|| {
            let ord = (a.primary, a.prefix)
                .cmp(&(b.primary, b.prefix))
                .then_with(|| {
                    cmp_name(
                        l.name(a.idx as usize),
                        l.name(b.idx as usize),
                        case_sensitive,
                    )
                });
            if reverse {
                ord.reverse()
            } else {
                ord
            }
        })
    });

    for (slot, k) in idx.iter_mut().zip(keys.iter()) {
        *slot = k.idx;
    }
}

/// Sort `idx` in place. Every rule mc applies, in the order it applies them.
///
/// `keys` is host-provided scratch, at least as long as `idx`. Nothing here
/// allocates: a `Vec` inside the module can grow linear memory, and growing it
/// detaches every view the host is holding — the panel would pay for a new
/// page, and the host for a `TypeError`.
pub fn sort_perm(l: &Listing, key: u32, opts: u32, idx: &mut [u32], keys: &mut [Key]) {
    if matches!(key, KEY_NAME | KEY_SIZE | KEY_MTIME) {
        return sort_by_key(l, key, opts, idx, keys);
    }
    let reverse = opts & OPT_REVERSE != 0;
    let dirs_first = opts & OPT_DIRS_FIRST != 0;
    let case_sensitive = opts & OPT_CASE_SENSITIVE != 0;

    idx.sort_unstable_by(|&ia, &ib| {
        let (a, b) = (ia as usize, ib as usize);
        let (fa, fb) = (l.flags[a], l.flags[b]);

        // `..` pins to the top, ahead of every other rule.
        let (ua, ub) = (fa & FLAG_UPDIR != 0, fb & FLAG_UPDIR != 0);
        if ua != ub {
            return if ua {
                core::cmp::Ordering::Less
            } else {
                core::cmp::Ordering::Greater
            };
        }

        if dirs_first {
            let (da, db) = (fa & FLAG_DIR != 0, fb & FLAG_DIR != 0);
            if da != db {
                return if da {
                    core::cmp::Ordering::Less
                } else {
                    core::cmp::Ordering::Greater
                };
            }
        }

        let ord = match key {
            KEY_EXT => cmp_name(ext(l.name(a)), ext(l.name(b)), case_sensitive)
                .then_with(|| cmp_name(l.name(a), l.name(b), case_sensitive)),
            KEY_VERSION => cmp_version(l.name(a), l.name(b), case_sensitive),
            KEY_UNSORTED => a.cmp(&b),
            _ => cmp_name(l.name(a), l.name(b), case_sensitive),
        };

        if reverse && key != KEY_UNSORTED {
            ord.reverse()
        } else {
            ord
        }
    });
}

/// The whole "raw listing → what the panel shows" step: drop hidden files,
/// apply the file mask, sort what survives. Returns how many indices landed in
/// `out`.
///
/// `..` is exempt from both filters — it is navigation, not content.
pub fn arrange(
    l: &Listing,
    mask: &[u8],
    key: u32,
    opts: u32,
    out: &mut [u32],
    keys: &mut [Key],
) -> usize {
    let count = l.flags.len();
    let show_hidden = opts & OPT_SHOW_HIDDEN != 0;
    let ci = opts & OPT_CASE_SENSITIVE == 0;

    let mut n = 0usize;
    for i in 0..count {
        let keep = l.is_updir(i)
            || ((show_hidden || !l.is_hidden(i))
                && (mask.is_empty() || glob::matches(mask, l.name(i), ci)));
        if keep {
            out[n] = i as u32;
            n += 1;
        }
    }
    sort_perm(l, key, opts, &mut out[..n], &mut keys[..n]);
    n
}

pub fn sort_index(l: &Listing, key: u32, opts: u32, out: &mut [u32], keys: &mut [Key]) {
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = i as u32;
    }
    sort_perm(l, key, opts, out, keys);
}
