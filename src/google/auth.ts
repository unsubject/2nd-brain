import { google } from "googleapis";
import { pool } from "../db/client";

const SCOPES = [
  // Read-only: tasks are only read, for linking and the idea import.
  "https://www.googleapis.com/auth/tasks.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  // Archive consolidation reads the Drive archive folders and exports.
  "https://www.googleapis.com/auth/drive.readonly",
];

const SCOPE_LABELS: Record<string, string> = {
  "https://www.googleapis.com/auth/tasks.readonly": "Google Tasks (read-only)",
  "https://www.googleapis.com/auth/contacts.readonly": "Contacts (read-only)",
  "https://www.googleapis.com/auth/calendar.readonly": "Calendar (read-only)",
  "https://www.googleapis.com/auth/gmail.readonly": "Gmail (read-only)",
  "https://www.googleapis.com/auth/drive.readonly": "Google Drive (read-only)",
};

// Google's consent screen lets the owner untick individual permissions, so
// the token can carry fewer scopes than requested. Returns the labels of
// requested scopes missing from the granted list (none when Google didn't
// report the granted scopes).
export function missingScopes(granted: string | null | undefined): string[] {
  const have = new Set((granted ?? "").split(/\s+/).filter(Boolean));
  if (have.size === 0) return [];
  return SCOPES.filter((s) => !have.has(s)).map((s) => SCOPE_LABELS[s] ?? s);
}

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export function getAuthUrl(state: string): string {
  const oauth2Client = createOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });
}

export async function handleCallback(code: string): Promise<{ missingScopes: string[] }> {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error("No refresh token received — re-authorize with prompt=consent");
  }

  await pool.query(
    `INSERT INTO google_tokens (user_id, access_token, refresh_token, token_type, scope, expires_at)
     VALUES ('default', $1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE
       SET access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           token_type = EXCLUDED.token_type,
           scope = EXCLUDED.scope,
           expires_at = EXCLUDED.expires_at,
           updated_at = now()`,
    [
      tokens.access_token,
      tokens.refresh_token,
      tokens.token_type || "Bearer",
      // What Google actually granted, not what was asked for.
      tokens.scope || SCOPES.join(" "),
      new Date(tokens.expiry_date || Date.now() + 3600 * 1000),
    ]
  );
  return { missingScopes: missingScopes(tokens.scope) };
}

export async function getAuthenticatedClient() {
  const { rows } = await pool.query(
    `SELECT access_token, refresh_token, expires_at FROM google_tokens WHERE user_id = 'default'`
  );

  if (rows.length === 0) {
    throw new Error("Not authenticated — visit /auth/google (owner secret required) to connect");
  }

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    access_token: rows[0].access_token,
    refresh_token: rows[0].refresh_token,
    expiry_date: new Date(rows[0].expires_at).getTime(),
  });

  // EventEmitter ignores a listener's promise, so a failed UPDATE here would
  // be an unhandled rejection; the refreshed token is still used in memory.
  oauth2Client.on("tokens", (tokens) => {
    pool
      .query(
        `UPDATE google_tokens
         SET access_token = $1,
             expires_at = $2,
             updated_at = now()
         WHERE user_id = 'default'`,
        [
          tokens.access_token,
          new Date(tokens.expiry_date || Date.now() + 3600 * 1000),
        ]
      )
      .catch((err) =>
        console.error("[google] could not store the refreshed access token:", err instanceof Error ? err.message : String(err))
      );
  });

  return oauth2Client;
}
