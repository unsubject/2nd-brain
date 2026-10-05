import { google } from "googleapis";
import { getAuthenticatedClient } from "./auth";
import { pool } from "../db/client";

export async function syncContacts(): Promise<void> {
  const auth = await getAuthenticatedClient();
  const service = google.people({ version: "v1", auth });

  let pageToken: string | undefined;
  do {
    const { data } = await service.people.connections.list({
      resourceName: "people/me",
      pageSize: 200,
      // Linking matches journal entries to contacts by name only.
      personFields: "names",
      pageToken,
    });

    for (const person of data.connections || []) {
      const resourceName = person.resourceName;
      const name = person.names?.[0]?.displayName?.trim();
      if (!resourceName || !name) continue;

      await pool.query(
        `INSERT INTO person_ref
           (user_id, external_system, external_person_id, full_name, updated_at)
         VALUES ('default', 'google_contacts', $1, $2, now())
         ON CONFLICT (external_system, external_person_id) DO UPDATE
           SET full_name = EXCLUDED.full_name,
               updated_at = now()`,
        [resourceName, name]
      );
    }

    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
}
