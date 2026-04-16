import { google } from "googleapis";
import { getAuthenticatedClient } from "./auth";
import { pool } from "../db/client";

export async function syncCalendar(): Promise<void> {
  const auth = await getAuthenticatedClient();
  const service = google.calendar({ version: "v3", auth });

  // Sync events from 30 days ago to 30 days ahead
  const timeMin = new Date();
  timeMin.setDate(timeMin.getDate() - 30);
  const timeMax = new Date();
  timeMax.setDate(timeMax.getDate() + 30);

  let pageToken: string | undefined;
  do {
    const { data } = await service.events.list({
      calendarId: "primary",
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: 250,
      singleEvents: true,
      orderBy: "startTime",
      pageToken,
    });

    for (const event of data.items || []) {
      if (!event.id || !event.summary) continue;

      const startAt = event.start?.dateTime || event.start?.date;
      const endAt = event.end?.dateTime || event.end?.date;
      if (!startAt || !endAt) continue;

      const attendees = event.attendees?.map((a) => ({
        email: a.email,
        name: a.displayName || null,
        response: a.responseStatus || null,
      }));

      await pool.query(
        `INSERT INTO calendar_event_ref
           (user_id, external_system, external_event_id, calendar_id,
            title, description, start_at, end_at, attendees, location, status, updated_at)
         VALUES ('default', 'google_calendar', $1, 'primary', $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (external_system, external_event_id) DO UPDATE
           SET title = EXCLUDED.title,
               description = EXCLUDED.description,
               start_at = EXCLUDED.start_at,
               end_at = EXCLUDED.end_at,
               attendees = EXCLUDED.attendees,
               location = EXCLUDED.location,
               status = EXCLUDED.status,
               updated_at = now()`,
        [
          event.id,
          event.summary,
          event.description || null,
          new Date(startAt),
          new Date(endAt),
          attendees ? JSON.stringify(attendees) : null,
          event.location || null,
          event.status || null,
        ]
      );
    }

    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
}
