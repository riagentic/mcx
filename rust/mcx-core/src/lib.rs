//! mcx-core — the parts of mcx that must not be slow.
//!
//! Everything here is pure computation over flat buffers: no syscalls, no
//! allocation across the boundary beyond `alloc`/`dealloc`. The host (Deno)
//! owns the filesystem; this crate owns the CPU-bound work that a 100k-entry
//! directory or a 2 GB file makes visible — sorting, globbing, searching,
//! line indexing.
//!
//! ABI: raw `extern "C"` over `wasm32-unknown-unknown`. No wasm-bindgen, so the
//! build needs nothing but `cargo` + the `wasm32-unknown-unknown` target, and
//! the module loads with plain `WebAssembly.instantiate`.

mod glob;
mod search;
mod sort;

use core::mem;

/// Allocate `n` bytes in the module's linear memory and hand the pointer to the
/// host. The host writes its buffer there, calls a function, then `dealloc`s.
///
/// # Safety
/// The returned pointer is valid until passed to [`dealloc`] with the same `n`.
#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut buf: Vec<u8> = Vec::with_capacity(n);
    let ptr = buf.as_mut_ptr();
    mem::forget(buf);
    ptr
}

/// Release memory obtained from [`alloc`].
///
/// # Safety
/// `ptr`/`n` must be exactly what [`alloc`] returned and was asked for.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, n: usize) {
    if !ptr.is_null() && n > 0 {
        drop(Vec::from_raw_parts(ptr, 0, n));
    }
}

/// Sort a directory listing, returning the permutation rather than the data:
/// the host keeps its entry objects put and reorders indices, so nothing large
/// crosses the boundary twice.
///
/// `names` is every name concatenated as UTF-8; `offs` has `count + 1` u32
/// boundaries into it. `sizes`/`mtimes` are f64 (a file can exceed 2^32 bytes,
/// and mtimes are epoch millis). `flags` is one byte per entry: bit0 = is
/// directory, bit1 = is "..".
///
/// `key`: 0 name · 1 extension · 2 size · 3 mtime · 4 unsorted.
/// `opts` bitfield: bit0 reverse · bit1 directories first · bit2 case sensitive.
///
/// Writes `count` u32 indices to `out` and returns `count`, or -1 on malformed
/// input (which the host treats as a bug, not a fallback path).
///
/// # Safety
/// All pointers must be valid for the lengths implied by `count`.
#[no_mangle]
pub unsafe extern "C" fn sort_index(
    names: *const u8,
    names_len: usize,
    offs: *const u32,
    count: usize,
    sizes: *const f64,
    mtimes: *const f64,
    flags: *const u8,
    key: u32,
    opts: u32,
    out: *mut u32,
    scratch: *mut u8,
) -> i32 {
    let l = match listing(names, names_len, offs, count, sizes, mtimes, flags) {
        Some(l) => l,
        None => return -1,
    };
    if out.is_null() || scratch.is_null() {
        return -1;
    }
    let out = core::slice::from_raw_parts_mut(out, count);
    let keys = core::slice::from_raw_parts_mut(scratch as *mut sort::Key, count);

    sort::sort_index(&l, key, opts, out, keys);
    count as i32
}

/// Bytes of scratch per entry that [`sort_index`] and [`arrange_index`] need.
/// The host asks rather than hard-coding it, so the layout can change here
/// without a silently undersized buffer on the other side.
#[no_mangle]
pub extern "C" fn scratch_per_entry() -> usize {
    sort::SCRATCH_PER_ENTRY
}

/// Borrow the host's flat buffers as one [`sort::Listing`], or `None` when the
/// offsets do not describe the name buffer they claim to.
///
/// # Safety
/// All pointers must be valid for the lengths implied by `count`.
unsafe fn listing<'a>(
    names: *const u8,
    names_len: usize,
    offs: *const u32,
    count: usize,
    sizes: *const f64,
    mtimes: *const f64,
    flags: *const u8,
) -> Option<sort::Listing<'a>> {
    if names.is_null() || offs.is_null() || sizes.is_null() || mtimes.is_null() || flags.is_null() {
        return None;
    }
    let offs = core::slice::from_raw_parts(offs, count + 1);
    if offs[count] as usize > names_len {
        return None;
    }
    Some(sort::Listing {
        names: core::slice::from_raw_parts(names, names_len),
        offs,
        sizes: core::slice::from_raw_parts(sizes, count),
        mtimes: core::slice::from_raw_parts(mtimes, count),
        flags: core::slice::from_raw_parts(flags, count),
    })
}

/// Filter and sort in one crossing: drop hidden files (unless `opts` bit3),
/// apply the file mask (`pat_len == 0` means "no mask"), then sort what
/// survives. `..` is exempt from both filters.
///
/// This is what a panel actually asks for. Doing it as `glob_filter` +
/// `sort_index` meant packing every name into linear memory twice, and that
/// packing — not the matching or the comparing — is the cost at 100_000
/// entries.
///
/// Returns the number of indices written to `out`, or -1 on malformed input.
///
/// # Safety
/// All pointers must be valid for the lengths implied by `count`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn arrange_index(
    names: *const u8,
    names_len: usize,
    offs: *const u32,
    count: usize,
    sizes: *const f64,
    mtimes: *const f64,
    flags: *const u8,
    pat: *const u8,
    pat_len: usize,
    key: u32,
    opts: u32,
    out: *mut u32,
    scratch: *mut u8,
) -> i32 {
    let l = match listing(names, names_len, offs, count, sizes, mtimes, flags) {
        Some(l) => l,
        None => return -1,
    };
    if out.is_null() || scratch.is_null() || (pat_len > 0 && pat.is_null()) {
        return -1;
    }
    let mask = if pat_len == 0 {
        &[][..]
    } else {
        core::slice::from_raw_parts(pat, pat_len)
    };
    let out = core::slice::from_raw_parts_mut(out, count);
    let keys = core::slice::from_raw_parts_mut(scratch as *mut sort::Key, count);

    sort::arrange(&l, mask, key, opts, out, keys) as i32
}

/// fnmatch-style glob (`*`, `?`, `[a-z]`, `[!abc]`, `\` escape) — mc's file
/// masks and filters, without the pathological backtracking a naive recursive
/// matcher has on `*a*a*a*`.
///
/// Returns 1 on match, 0 on no match.
///
/// # Safety
/// Both pointers must be valid for their lengths.
#[no_mangle]
pub unsafe extern "C" fn glob_match(
    pat: *const u8,
    pat_len: usize,
    s: *const u8,
    s_len: usize,
    case_insensitive: u32,
) -> i32 {
    let pat = core::slice::from_raw_parts(pat, pat_len);
    let s = core::slice::from_raw_parts(s, s_len);
    glob::matches(pat, s, case_insensitive != 0) as i32
}

/// Match a whole listing against one pattern in ONE call, writing the indices
/// of the matches to `out`.
///
/// The per-call version exists too, but a panel filters 100_000 names at once:
/// crossing the boundary once per name made the marshalling, not the matching,
/// the cost. This is the same fix `sort_index` already embodies.
///
/// Returns the number of matches.
///
/// # Safety
/// All pointers must be valid for the lengths implied by `count`.
#[no_mangle]
pub unsafe extern "C" fn glob_filter(
    names: *const u8,
    names_len: usize,
    offs: *const u32,
    count: usize,
    pat: *const u8,
    pat_len: usize,
    case_insensitive: u32,
    out: *mut u32,
) -> i32 {
    if names.is_null() || offs.is_null() || out.is_null() {
        return -1;
    }
    let offs = core::slice::from_raw_parts(offs, count + 1);
    if offs[count] as usize > names_len {
        return -1;
    }
    let names = core::slice::from_raw_parts(names, names_len);
    let pat = core::slice::from_raw_parts(pat, pat_len);
    let out = core::slice::from_raw_parts_mut(out, count);

    let ci = case_insensitive != 0;
    let mut n = 0usize;
    for i in 0..count {
        let name = &names[offs[i] as usize..offs[i + 1] as usize];
        if glob::matches(pat, name, ci) {
            out[n] = i as u32;
            n += 1;
        }
    }
    n as i32
}

/// Byte offset of `needle` in `haystack` at or after `from`, or -1.
/// Boyer–Moore–Horspool; ASCII-folded when `case_insensitive`.
///
/// # Safety
/// Both pointers must be valid for their lengths.
#[no_mangle]
pub unsafe extern "C" fn search_bytes(
    hay: *const u8,
    hay_len: usize,
    needle: *const u8,
    needle_len: usize,
    from: usize,
    case_insensitive: u32,
) -> i64 {
    let hay = core::slice::from_raw_parts(hay, hay_len);
    let needle = core::slice::from_raw_parts(needle, needle_len);
    match search::find(hay, needle, from, case_insensitive != 0) {
        Some(i) => i as i64,
        None => -1,
    }
}

/// Same as [`search_bytes`] but scanning backwards from `from` — the viewer's
/// reverse search.
///
/// # Safety
/// Both pointers must be valid for their lengths.
#[no_mangle]
pub unsafe extern "C" fn rsearch_bytes(
    hay: *const u8,
    hay_len: usize,
    needle: *const u8,
    needle_len: usize,
    from: usize,
    case_insensitive: u32,
) -> i64 {
    let hay = core::slice::from_raw_parts(hay, hay_len);
    let needle = core::slice::from_raw_parts(needle, needle_len);
    match search::rfind(hay, needle, from, case_insensitive != 0) {
        Some(i) => i as i64,
        None => -1,
    }
}

/// Offsets of every line start in `buf` (the first is always 0), capped at
/// `max`. The viewer indexes a file once and then seeks by line in O(1)
/// instead of rescanning — this is the loop that decides whether a 2 GB log
/// opens instantly or not at all.
///
/// Returns the number of offsets written.
///
/// # Safety
/// `buf` valid for `len`; `out` valid for `max` u32s.
#[no_mangle]
pub unsafe extern "C" fn line_index(
    buf: *const u8,
    len: usize,
    out: *mut u32,
    max: usize,
) -> i32 {
    let buf = core::slice::from_raw_parts(buf, len);
    let out = core::slice::from_raw_parts_mut(out, max);
    search::line_index(buf, out) as i32
}

/// Count of bytes that are NUL or otherwise non-text in the first `len` bytes —
/// the binary-file heuristic the viewer uses to auto-switch to hex mode.
///
/// # Safety
/// `buf` must be valid for `len`.
#[no_mangle]
pub unsafe extern "C" fn count_binary(buf: *const u8, len: usize) -> i32 {
    let buf = core::slice::from_raw_parts(buf, len);
    buf.iter()
        .filter(|&&b| b == 0 || (b < 0x09) || (b > 0x0d && b < 0x20))
        .count() as i32
}
