// Turn an error from a Google API call into a line that is safe to log.
//
// googleapis throws GaxiosError objects whose `config.data` / `config.body`
// hold the token request itself — including the OAuth refresh token in plain
// text — so logging the whole object (console.error("…", err)) writes that
// secret to the service logs. Only the message, the HTTP status and Google's
// own error code/description are kept here.

type GaxiosLike = {
  message?: unknown;
  code?: unknown;
  status?: unknown;
  response?: { status?: unknown; data?: unknown };
  config?: unknown;
};

const looksLikeGaxios = (err: unknown): err is GaxiosLike =>
  !!err && typeof err === "object" && ("response" in err || "config" in err);

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 300) : undefined;

export function describeGoogleError(err: unknown): string {
  if (looksLikeGaxios(err)) {
    const status = err.response?.status ?? err.status ?? err.code;
    const data = err.response?.data;
    const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const nested = body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : {};
    const code = str(body.error) ?? str(nested.status);
    const description = str(body.error_description) ?? str(nested.message);
    const detail = [code, description].filter(Boolean).join(" — ");
    const message = str(err.message) ?? "Google API error";
    return `${message} (HTTP ${status ?? "?"}${detail ? `: ${detail}` : ""})`;
  }
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}
