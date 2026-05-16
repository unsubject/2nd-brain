const EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

export async function embed(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch(EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, input: text }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI embeddings ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const v = data.data?.[0]?.embedding;
  if (!Array.isArray(v) || v.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Unexpected embedding shape: length ${v?.length}`);
  }
  return v;
}

export function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}
