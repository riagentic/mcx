/** What a fresh `~/.mcx` profile contains.
 *
 *  Compiled in rather than read from the source tree: a `deno compile` binary
 *  has no repository beside it, and a program whose defaults live in a file it
 *  might not have shipped is a program that works on the developer's machine.
 *  These strings are written to `~/.mcx` the first time mcx runs, and from then
 *  on they belong to the user — mcx never rewrites a file that exists. */

/** `~/.mcx/menu`, and the format of a `.mcx.menu` dropped beside any files.
 *
 *  The format is mc's, deliberately: it is a good one, it is documented in
 *  thirty years of manuals, and a user arriving from mc can copy their file
 *  across. What mcx does NOT do is read mc's copy behind their back. */
export const DEFAULT_MENU = `# mcx user menu — F2.
#
# This file is yours. mcx wrote it once and will not touch it again.
#
#   entry:      a hotkey character, whitespace, then the label
#   command:    the indented lines under it, run by your shell
#   condition:  a line before the entry, starting with + (show when) or = (default)
#                 f <regex>   the filename matches
#                 t <letters> r regular, d directory, l link, x executable,
#                             t something is tagged, n nothing is
#                 combine with & (and), | (or), ! (not)
#
#   macros:     %f this file          %d this directory
#               %t the tagged files   %s tagged, or this file
#               %n name without extension   %x the extension
#               %F %D %T %S           …the same, on the OTHER panel
#               %{Question}           ask, and substitute the answer
#               %0f                   do not quote this one

+ t r
c       Compress to .tar.gz
        tar czvf %n.tar.gz %f

+ t r
z       Compress to .zip
        zip -r %n.zip %f

+ f \\.(tar\\.gz|tgz|tar\\.bz2|tar\\.xz|tar|zip)$ & t r
x       Extract here
        case %f in
          *.zip) unzip -o %f ;;
          *) tar xvf %f ;;
        esac

+ t r
h       SHA-256 checksum
        sha256sum %f

+ t r
f       What kind of file is this
        file %f

= t d
u       Disk usage, largest first
        du -sh %f/* 2>/dev/null | sort -rh | head -40

d       Differences against the other panel
        diff -u %F %f

t       Run a command on the tagged files
        CMD=%{Command to run on each file}
        for i in %t; do
            echo "== $i"
            $CMD "$i"
        done

g       Git status here
        git status --short --branch

l       Git log
        git log --oneline -30
`;

/** `~/.mcx/ext.ini` — what Enter does to a file, by type.
 *
 *  `Shell=` is a suffix, `Regex=` a pattern (`Regex/i=` for a case-insensitive
 *  one). `Open=` runs when you press Enter. The first section that matches
 *  wins, so put the specific ones first. */
export const DEFAULT_EXT = `# mcx file associations — what Enter does.
#
#   [any name]
#   Shell=.tar.gz          a filename suffix, or
#   Regex/i=\\.(png|jpg)$   a pattern (add /i for case-insensitive)
#   Open=xdg-open %f       what Enter runs; %f is the file
#   View=…                 what F3 runs instead of the built-in viewer
#
# Archives are not here: mcx opens them as directories with Enter.

[images]
Regex/i=\\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$
Open=xdg-open %f

[audio-video]
Regex/i=\\.(mp3|flac|ogg|opus|wav|m4a|mp4|mkv|webm|avi|mov)$
Open=xdg-open %f

[pdf-and-documents]
Regex/i=\\.(pdf|epub|djvu|odt|ods|odp|docx?|xlsx?|pptx?)$
Open=xdg-open %f

[html]
Regex/i=\\.x?html?$
Open=xdg-open %f

[desktop-entry]
Shell=.desktop
Open=gio launch %f 2>/dev/null || xdg-open %f
`;

/** The skins mcx ships. The format is an ini of colour pairs — `fg;bg` — with
 *  an optional `[aliases]` section, which means a skin written for mc can be
 *  dropped into `~/.mcx/skins` unchanged. */
export const DEFAULT_SKINS: Record<string, string> = {
  "mcx-dark.ini": `[skin]
    description = mcx — the built-in dark palette, as a file you can edit

[core]
    _default_ = #cfd8e3;#161b25
    selected  = #ffffff;#2a4a6b
    marked    = #ffd866;
    header    = #9db2cc;#1d2431
    disabled  = #7c8798;
    frame     = #263041;
    reverse   = #4a9eff;

[menu]
    _default_ = #cfd8e3;#0c0f15

[error]
    _default_ = #ff6b6b;

[filehighlight]
    directory  = #6cc7f5;
    executable = #7ee787;
    symlink    = #d2a8ff;
    stalelink  = #ff7b72;
    device     = #e3b341;
`,

  "mcx-light.ini": `[skin]
    description = mcx — light, for a bright room

[core]
    _default_ = #1c2430;#ffffff
    selected  = #04203f;#cfe3ff
    marked    = #9a6700;
    header    = #3a4756;#e3e9f2
    disabled  = #64707f;
    frame     = #c3ccdb;
    reverse   = #1f6feb;

[menu]
    _default_ = #1c2430;#dde3ec

[error]
    _default_ = #cf222e;

[filehighlight]
    directory  = #0969da;
    executable = #1a7f37;
    symlink    = #8250df;
    stalelink  = #cf222e;
    device     = #9a6700;
`,

  "nord.ini": `[skin]
    description = Nord

[aliases]
    bg      = #2e3440
    bgLight = #3b4252
    fg      = #d8dee9
    blue    = #88c0d0
    green   = #a3be8c
    yellow  = #ebcb8b
    red     = #bf616a
    purple  = #b48ead

[core]
    _default_ = fg;bg
    selected  = bg;blue
    marked    = yellow;
    header    = fg;bgLight
    disabled  = #616e88;
    frame     = #4c566a;
    reverse   = blue;

[menu]
    _default_ = fg;bgLight

[error]
    _default_ = red;

[filehighlight]
    directory  = blue;
    executable = green;
    symlink    = purple;
    stalelink  = red;
    device     = yellow;
`,

  "gruvbox-dark.ini": `[skin]
    description = Gruvbox dark

[aliases]
    bg      = #282828
    bgLight = #3c3836
    fg      = #ebdbb2
    aqua    = #8ec07c
    green   = #b8bb26
    yellow  = #fabd2f
    red     = #fb4934
    purple  = #d3869b

[core]
    _default_ = fg;bg
    selected  = bg;yellow
    marked    = yellow;
    header    = fg;bgLight
    disabled  = #928374;
    frame     = #504945;
    reverse   = aqua;

[menu]
    _default_ = fg;bgLight

[error]
    _default_ = red;

[filehighlight]
    directory  = aqua;
    executable = green;
    symlink    = purple;
    stalelink  = red;
    device     = yellow;
`,
};
