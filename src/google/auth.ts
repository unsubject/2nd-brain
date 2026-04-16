import { google } from "googleapis";
import { pool } from "../db/client";

const SCOPES = [
  "https://www.googleapis.com/auth/tasks.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
];

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export function getAuthUrl(): string {
  const oauth2Client = createOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
}

export async function handleCallback(code: string): Promise<void> {
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
      SCOPES.join(" "),
      new Date(tokens.expiry_date || Date.now() + 3600 * 1000),
    ]
  );
}

export async function getAuthenticatedClient() {
  const { rows } = await pool.query(
    `SELECT access_token, refresh_token, expires_at FROM google_tokens WHERE user_id = 'default'`
  );

  if (rows.length === 0) {
    throw new Error("Not authenticated — visit /auth/google to connect");
  }

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    access_token: rows[0].access_token,
    refresh_token: rows[0].refresh_token,
    expiry_date: new Date(rows[0].expires_at).getTime(),
  });

  oauth2Client.on("tokens", async (tokens) => {
    await pool.query(
      `UPDATE google_tokens
       SET access_token = $1,
           expires_at = $2,
           updated_at = now()
       WHERE user_id = 'default'`,
      [
        tokens.access_token,
        new Date(tokens.expiry_date || Date.now() + 3600 * 1000),
      ]
    );
  });

  return oauth2Client;
}
