/** Collapse multiline / markdown-heading glue so titles stay one scannable line. */
export function normalizeTitle(title: string): string {
  return title
    .replace(/\r\n?|\n/g, " ")
    .replace(/\s*#{1,6}\s*/g, " · ")
    .replace(/\s+/g, " ")
    .replace(/(?:^·\s*)|(?:\s*·$)/g, "")
    .replace(/\s·\s·\s/g, " · ")
    .trim();
}
