/** Plain-text rendering for HTML-only messages.

Many transactional Chinese mails (12306, banks, carriers) are
`multipart/alternative` with a single `text/html` part, so mailparser leaves
`text` undefined and the intake would otherwise see an empty body.
*/
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(
      /&#(\d+);|&#x([0-9a-f]+);|&(nbsp|amp|lt|gt|quot|#39|apos);/gi,
      (match, dec: string | undefined, hex: string | undefined, name: string | undefined) =>
        dec !== undefined
          ? String.fromCharCode(Number(dec))
          : hex !== undefined
            ? String.fromCharCode(parseInt(hex, 16))
            : NAMED_ENTITIES[name!.toLowerCase()] ?? match,
    )
    .replace(/[ \t\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The message body as text: the plain part when present, else the HTML part. */
export function textFromParsed(body: { text?: string | false; html?: string | false }): string {
  if (typeof body.text === "string" && body.text.trim()) return body.text;
  return typeof body.html === "string" && body.html ? htmlToText(body.html) : "";
}
