import * as archiveQueries from "../queries";

export interface YouTubeImportBody {
  video_id: string;
  title: string;
  transcript: string;
  published_at?: string | null;
  summary?: string | null;
  keywords?: string | null;
  has_manual_transcript?: boolean;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

function parseKeywords(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\n]/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

export async function importYouTubeVideo(
  body: YouTubeImportBody,
  userId: string = "default"
): Promise<{ id: string; created: boolean }> {
  const tags = parseKeywords(body.keywords);
  if (body.has_manual_transcript === true) tags.push("manual-transcript");
  else if (body.has_manual_transcript === false) tags.push("auto-transcript");

  let publishedAt: Date | null = null;
  if (body.published_at) {
    const parsed = new Date(body.published_at);
    if (!isNaN(parsed.getTime())) publishedAt = parsed;
  }

  return archiveQueries.upsertArtifact({
    userId,
    type: "transcript",
    title: body.title,
    slug: slugify(body.title),
    publishedAt,
    rawSource: body.transcript,
    canonicalUrl: `https://youtube.com/watch?v=${body.video_id}`,
    series: null,
    seriesPosition: null,
    tags: tags.length > 0 ? tags : null,
    sourceSystem: "youtube",
    sourceExternalId: body.video_id,
    sourceSummary: body.summary ?? null,
  });
}
