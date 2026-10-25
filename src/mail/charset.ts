/** Decode raw bytes with the charset declared by the message part.

MIME charsets predate the WHATWG Encoding Standard: servers still emit
``gb2312``/``gb_2312-80`` labels that Node's TextDecoder does not accept
verbatim, so aliases are normalized first. Unknown or invalid labels fall
back to Latin-1, which never fails and keeps bytes inspectable.
*/
const ALIASES: Record<string, string> = {
  gb2312: "gbk",
  "gb_2312": "gbk",
  "gb_2312-80": "gbk",
  "gb-2312": "gbk",
  "csgb2312": "gbk",
  "iso-ir-58": "gbk",
  "x-gbk": "gbk",
  gb18030: "gb18030",
  utf8: "utf-8",
  "unicode-1-1-utf-8": "utf-8",
  "ansi_x3.4-1968": "latin1",
  "us-ascii": "latin1",
  ascii: "latin1",
};

export function decodeText(buffer: Buffer, charset: string): string {
  const label = String(charset ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
  const name = ALIASES[label] ?? (label || "utf-8");
  try {
    return new TextDecoder(name).decode(buffer);
  } catch {
    return buffer.toString("latin1");
  }
}
