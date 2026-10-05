// Text helpers for extraction (step 2): HTML to plain text, whitespace
// normalisation, rejoining hard-wrapped email lines, and a length measure
// that treats Chinese and English text alike.

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  copy: "©",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const BLOCK =
  "p|div|h[1-6]|li|blockquote|tr|section|article|header|footer|figure|figcaption|table|ul|ol|pre|hr|center";

export interface HtmlToTextOptions {
  // WordPress stores paragraphs as blank lines inside the HTML (wpautop runs
  // at render time), so its source newlines are text. Everywhere else a
  // newline in HTML source is just whitespace.
  keepSourceNewlines?: boolean;
}

export function htmlToText(html: string, opts: HtmlToTextOptions = {}): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = opts.keepSourceNewlines ? s.replace(/\r\n?/g, "\n") : s.replace(/[\r\n\t]+/g, " ");
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(new RegExp(`<\\/(?:${BLOCK})\\s*>`, "gi"), "\n\n")
    .replace(new RegExp(`<(?:${BLOCK})\\b[^>]*>`, "gi"), "\n")
    .replace(/<\/?t[dh]\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  return normalizeText(decodeEntities(s));
}

export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[​‌‍﻿]/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const CJK = /[⺀-⿿　-〿぀-ヿ㐀-鿿豈-﫿＀-￯]/;

export function isCjk(ch: string | undefined): boolean {
  return !!ch && CJK.test(ch);
}

// Plain-text email bodies are hard-wrapped at ~76 columns, often mid-sentence
// ("在 Threads\n上面見到"). When the text separates paragraphs with blank
// lines, a single newline inside a paragraph is such a wrap: rejoin it, with
// no space between Chinese characters and one space otherwise. Text that
// uses single newlines as paragraph breaks is left alone.
export function unwrapSoftBreaks(text: string): string {
  const paragraphs = text.split(/\n{2,}/);
  if (paragraphs.length < 3) return text;
  return paragraphs
    .map((p) => {
      const lines = p.split("\n");
      let out = lines[0];
      for (const line of lines.slice(1)) {
        // Lists and quoted lines keep their own line.
        if (/^([-*•>]|\d+[.、)]|[一二三四五六七八九十]+[、，,])\s*/.test(line)) {
          out += "\n" + line;
          continue;
        }
        const joinWithoutSpace = isCjk(out.slice(-1)) && isCjk(line[0]);
        out += (joinWithoutSpace ? "" : " ") + line;
      }
      return out;
    })
    .join("\n\n");
}

// Characters that carry text; a Chinese character counts as one, so length
// thresholds mean roughly the same for Chinese and English pieces.
export function textLength(s: string | null | undefined): number {
  return s ? s.replace(/\s+/g, "").length : 0;
}

export function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
