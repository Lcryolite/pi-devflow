/** Collapse multiline / markdown-heading glue so titles stay one scannable line. */
export function normalizeTitle(title: string): string {
  return title
    .replace(/\r\n?|\n/g, " ")
    // Heading glue only: `#` runs must be preceded by a non-alphanumeric (so
    // "C#" / "#42" in real titles survive) and followed by whitespace.
    .replace(/(?<![A-Za-z0-9])#{1,6}\s+/g, " · ")
    .replace(/\s+/g, " ")
    .replace(/(?:^\s*·\s*)|(?:\s*·\s*$)/g, "")
    .replace(/\s·\s·\s/g, " · ")
    .trim();
}
