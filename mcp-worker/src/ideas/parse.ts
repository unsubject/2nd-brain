// Parsing helpers for the one-time import (docs/idea-parking-lot-protocol.md §4).

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// "+08:00" | "-05:00" | "+0800" | "Z" → minutes east of UTC, or null.
export function parseUtcOffset(offset: string): number | null {
  const s = offset.trim();
  if (s === 'Z' || s === 'z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(s);
  if (!m) return null;
  const hours = Number(m[2]);
  const minutes = Number(m[3]);
  if (hours > 14 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return m[1] === '-' ? -total : total;
}

// Accepts an ISO 8601 timestamp (with offset or Z), or Notion's export
// form "March 8, 2026 12:26 PM" / "March 8, 2026" interpreted at the
// given UTC offset. Returns an ISO string, or null when unparseable.
export function parseCapturedAt(input: string, utcOffset = '+00:00'): string | null {
  const s = input.trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const offsetMinutes = parseUtcOffset(utcOffset);
  if (offsetMinutes === null) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, mo, d] = s.split('-').map(Number);
    return fromLocal(y, mo - 1, d, 0, 0, offsetMinutes);
  }

  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm]))?$/.exec(s);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  let hour = 0;
  let minute = 0;
  if (m[4] !== undefined) {
    hour = Number(m[4]);
    minute = Number(m[5]);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const pm = m[6].toLowerCase() === 'pm';
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  return fromLocal(year, month, day, hour, minute, offsetMinutes);
}

function fromLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  offsetMinutes: number,
): string | null {
  const utcMs = Date.UTC(year, month, day, hour, minute) - offsetMinutes * 60_000;
  const d = new Date(utcMs);
  // Reject overflow like "February 30".
  const check = new Date(utcMs + offsetMinutes * 60_000);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) {
    return null;
  }
  return d.toISOString();
}

export type DatedNote = { at: string; text: string };

const DATE_MARKER = /\[(\d{4}-\d{2}-\d{2})\]/g;

// Split a dev-log blob on "[YYYY-MM-DD]" markers. Text before the first
// marker becomes one note at `fallbackAt`. Each marker's text runs to the
// next marker; the marker itself is dropped (its date becomes `at`).
// Note text is otherwise kept verbatim (only outer whitespace trimmed).
export function splitDatedNotes(raw: string, fallbackAt: string): DatedNote[] {
  const notes: DatedNote[] = [];
  const markers = [...raw.matchAll(DATE_MARKER)];
  const preamble = (markers.length ? raw.slice(0, markers[0].index) : raw).trim();
  if (preamble) notes.push({ at: fallbackAt, text: preamble });
  markers.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < markers.length ? markers[i + 1].index ?? raw.length : raw.length;
    const text = raw.slice(start, end).trim();
    const at = new Date(`${m[1]}T00:00:00Z`);
    if (!text) return;
    notes.push({ at: Number.isNaN(at.getTime()) ? fallbackAt : at.toISOString(), text });
  });
  return notes;
}
