import OpenAI from "openai";

const openai = new OpenAI();
const MODEL = "text-embedding-3-small";
const BATCH_SIZE = 100;

export async function batchEmbed(texts: string[]): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await openai.embeddings.create({
      model: MODEL,
      input: batch,
    });

    for (let j = 0; j < response.data.length; j++) {
      results[i + j] = response.data[j].embedding;
    }
  }

  return results;
}

export { MODEL as EMBEDDING_MODEL };
