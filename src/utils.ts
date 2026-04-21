export function isAiFeedbackText(rawText: string): boolean {
  return rawText.trimStart().toLowerCase().startsWith("#aifeedback");
}

export function parseFirstLineHashtags(text: string): string[] {
  const firstLine = text.split("\n")[0];
  const matches = firstLine.matchAll(/#(\w+)/g);
  return [...matches].map((m) => m[1].toLowerCase());
}
