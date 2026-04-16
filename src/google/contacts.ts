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
      personFields: "names,emailAddresses,phoneNumbers,biographies",
      pageToken,
    });

    for (const person of data.connections || []) {
      const resourceName = person.resourceName;
      if (!resourceName) continue;

      const name =
        person.names?.[0]?.displayName ||
        person.emailAddresses?.[0]?.value ||
        "Unknown";
      const email = person.emailAddresses?.[0]?.value || null;
      const phone = person.phoneNumbers?.[0]?.value || null;
      const notes = person.biographies?.[0]?.value || null;

      await pool.query(
        `INSERT INTO person_ref
           (user_id, external_system, external_person_id, full_name,
            primary_email, primary_phone, notes, updated_at)
         VALUES ('default', 'google_contacts', $1, $2, $3, $4, $5, now())
         ON CONFLICT (external_system, external_person_id) DO UPDATE
           SET full_name = EXCLUDED.full_name,
               primary_email = EXCLUDED.primary_email,
               primary_phone = EXCLUDED.primary_phone,
               notes = EXCLUDED.notes,
               updated_at = now()`,
        [resourceName, name, email, phone, notes]
      );
    }

    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
}
