export function normalizeMarkdown(raw: string): string {
  let text = raw;

  // Strip HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Collapse multiple blank lines to one
  text = text.replace(/\n{3,}/g, "\n\n");

  // Normalize whitespace on each line (preserve newlines)
  text = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n");

  // Trim leading/trailing whitespace
  text = text.trim();

  return text;
}

export function extractExcerpt(text: string, maxLength: number = 300): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  for (const line of lines) {
    // Skip headings and short metadata lines
    if (line.startsWith("#") || line.length < 20) continue;
    if (line.length <= maxLength) return line;
    return line.slice(0, maxLength).replace(/\s\S*$/, "") + "…";
  }

  return lines[0]?.slice(0, maxLength) || "";
}
