/** The character sets mcx can read a file as — mc's M-e.
 *
 *  Every one of these is built into the platform's `TextDecoder`, so there is
 *  no table of code points here and nothing to keep up to date: the list is
 *  what a browser and Deno both already implement, narrowed to the encodings
 *  people actually still meet in files. UTF-8 is first because it is the
 *  answer nine times out of ten.
 *
 *  A label, not an object, is what travels: it is what `TextDecoder` takes. */
export const CHARSETS: ReadonlyArray<{ label: string; name: string }> = [
  { label: "utf-8", name: "UTF-8 (Unicode)" },
  { label: "iso-8859-1", name: "ISO-8859-1 (Latin-1, Western)" },
  { label: "iso-8859-2", name: "ISO-8859-2 (Latin-2, Central European)" },
  { label: "iso-8859-5", name: "ISO-8859-5 (Cyrillic)" },
  { label: "iso-8859-7", name: "ISO-8859-7 (Greek)" },
  { label: "iso-8859-15", name: "ISO-8859-15 (Latin-9, with €)" },
  { label: "windows-1250", name: "Windows-1250 (Central European)" },
  { label: "windows-1251", name: "Windows-1251 (Cyrillic)" },
  { label: "windows-1252", name: "Windows-1252 (Western)" },
  { label: "koi8-r", name: "KOI8-R (Russian)" },
  { label: "koi8-u", name: "KOI8-U (Ukrainian)" },
  { label: "shift_jis", name: "Shift_JIS (Japanese)" },
  { label: "euc-jp", name: "EUC-JP (Japanese)" },
  { label: "gbk", name: "GBK (Simplified Chinese)" },
  { label: "big5", name: "Big5 (Traditional Chinese)" },
  { label: "euc-kr", name: "EUC-KR (Korean)" },
];

/** Whether a label is one we offer — the guard between a stored preference (or
 *  a client a version behind) and `new TextDecoder(label)`, which throws on an
 *  unknown one. */
export const isCharset = (label: string): boolean =>
  CHARSETS.some((c) => c.label === label);

/** The name to show for a label, or the label itself if it is not in the list. */
export const charsetName = (label: string): string =>
  CHARSETS.find((c) => c.label === label)?.name ?? label;
