import { Marked, Token, Tokens } from "marked";

const TARGET_CHUNK_TOKENS = 500;
const MAX_CHUNK_TOKENS = 800;
const OVERLAP_TOKENS = 100;

// Rough token estimate: ~4 chars per token for English
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface RawSection {
  headingPath: string[];
  text: string;
  startOffset: number;
  endOffset: number;
}

function extractSections(markdown: string): RawSection[] {
  const lexer = new Marked();
  const tokens = lexer.lexer(markdown);

  const sections: RawSection[] = [];
  const headingStack: string[] = [];
  let currentText = "";
  let currentStart = 0;
  let offset = 0;

  function flushSection() {
    const trimmed = currentText.trim();
    if (trimmed.length > 0) {
      sections.push({
        headingPath: [...headingStack],
        text: trimmed,
        startOffset: currentStart,
        endOffset: offset,
      });
    }
    currentText = "";
    currentStart = offset;
  }

  for (const token of tokens) {
    const raw = (token as Token & { raw?: string }).raw || "";

    if (token.type === "heading") {
      flushSection();
      const depth = (token as Tokens.Heading).depth;
      const headingText = (token as Tokens.Heading).text;

      // Adjust heading stack to current depth
      while (headingStack.length >= depth) {
        headingStack.pop();
      }
      headingStack.push(headingText);
      currentStart = offset;
    } else {
      currentText += raw;
    }

    offset += raw.length;
  }

  flushSection();
  return sections;
}

export interface Chunk {
  chunkIndex: number;
  chunkText: string;
  chunkTokens: number;
  headingPath: string[];
  startOffset: number;
  endOffset: number;
}

function splitLargeSection(section: RawSection): Chunk[] {
  const words = section.text.split(/(\s+)/);
  const chunks: Chunk[] = [];
  let current = "";
  let chunkStart = section.startOffset;

  for (const word of words) {
    const candidate = current + word;
    if (
      estimateTokens(candidate) > TARGET_CHUNK_TOKENS &&
      current.trim().length > 0
    ) {
      const trimmed = current.trim();
      chunks.push({
        chunkIndex: 0, // re-indexed later
        chunkText: trimmed,
        chunkTokens: estimateTokens(trimmed),
        headingPath: section.headingPath,
        startOffset: chunkStart,
        endOffset: chunkStart + current.length,
      });

      // Overlap: take last ~OVERLAP_TOKENS worth of text
      const overlapChars = OVERLAP_TOKENS * 4;
      const overlapStart = Math.max(0, current.length - overlapChars);
      current = current.slice(overlapStart) + word;
      chunkStart = chunkStart + overlapStart;
    } else {
      current = candidate;
    }
  }

  if (current.trim().length > 0) {
    const trimmed = current.trim();
    chunks.push({
      chunkIndex: 0,
      chunkText: trimmed,
      chunkTokens: estimateTokens(trimmed),
      headingPath: section.headingPath,
      startOffset: chunkStart,
      endOffset: section.endOffset,
    });
  }

  return chunks;
}

export function chunkArtifact(markdown: string): Chunk[] {
  const sections = extractSections(markdown);

  if (sections.length === 0) {
    const trimmed = markdown.trim();
    if (!trimmed) return [];
    return [
      {
        chunkIndex: 0,
        chunkText: trimmed,
        chunkTokens: estimateTokens(trimmed),
        headingPath: [],
        startOffset: 0,
        endOffset: markdown.length,
      },
    ];
  }

  const allChunks: Chunk[] = [];

  for (const section of sections) {
    const tokens = estimateTokens(section.text);

    if (tokens <= MAX_CHUNK_TOKENS) {
      allChunks.push({
        chunkIndex: 0,
        chunkText: section.text,
        chunkTokens: tokens,
        headingPath: section.headingPath,
        startOffset: section.startOffset,
        endOffset: section.endOffset,
      });
    } else {
      allChunks.push(...splitLargeSection(section));
    }
  }

  // Re-index sequentially
  for (let i = 0; i < allChunks.length; i++) {
    allChunks[i].chunkIndex = i;
  }

  return allChunks;
}
