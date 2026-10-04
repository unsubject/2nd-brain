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

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Minutes east of UTC for an IANA zone at a given instant (DST-aware).
function zoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

// Where local wall-clock times are interpreted: a fixed offset or an IANA zone.
export type LocalZone = { offset: string } | { timeZone: string };

function localToUtcMs(y: number, mo: number, d: number, h: number, mi: number, zone: LocalZone): number | null {
  const wall = Date.UTC(y, mo, d, h, mi);
  // Reject overflow like "February 30".
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo || check.getUTCDate() !== d) return null;
  if ('offset' in zone) {
    const off = parseUtcOffset(zone.offset);
    return off === null ? null : wall - off * 60_000;
  }
  if (!isValidTimeZone(zone.timeZone)) return null;
  // Two passes settle the offset across DST transitions.
  let utc = wall - zoneOffsetMinutes(wall, zone.timeZone) * 60_000;
  utc = wall - zoneOffsetMinutes(utc, zone.timeZone) * 60_000;
  return utc;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

// Accepts an ISO 8601 timestamp (with offset or Z), a bare YYYY-MM-DD, or
// Notion's export form "March 8, 2026 12:26 PM" / "March 8, 2026", the
// latter two read in `zone`. Returns an ISO string, or null.
export function parseCapturedAt(input: string, zone: LocalZone | string = { offset: '+00:00' }): string | null {
  const z: LocalZone = typeof zone === 'string' ? { offset: zone } : zone;
  const s = input.trim();
  if (!s) return null;

  const iso = ISO.exec(s);
  if (iso) {
    const [y, mo, d, h, mi, sec] = [1, 2, 3, 4, 5, 6].map((i) => Number(iso[i] ?? 0));
    if (h > 23 || mi > 59 || sec > 59) return null;
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
    const date = new Date(s);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, mo, d] = s.split('-').map(Number);
    const ms = localToUtcMs(y, mo - 1, d, 0, 0, z);
    return ms === null ? null : new Date(ms).toISOString();
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
  const ms = localToUtcMs(year, month, day, hour, minute, z);
  return ms === null ? null : new Date(ms).toISOString();
}

export type DatedNote = { at: string; text: string };

// A dev-log entry starts with "[YYYY-MM-DD]" at the beginning of a line.
const LINE_MARKER = /^[ \t]*\[(\d{4})-(\d{2})-(\d{2})\][ \t]*/gm;

// Split a dev-log blob into notes. Text before the first marker becomes
// one note at `fallbackAt`; each marker's text runs to the next marker
// and is dated at local midnight in `zone`. Markers that are not at the
// start of a line, or whose date is invalid, are kept verbatim as text.
// Note text is otherwise verbatim (outer whitespace trimmed).
export function splitDatedNotes(
  raw: string,
  fallbackAt: string,
  zone: LocalZone | string = { offset: '+00:00' },
): DatedNote[] {
  const z: LocalZone = typeof zone === 'string' ? { offset: zone } : zone;
  const markers: Array<{ index: number; end: number; at: string }> = [];
  for (const m of raw.matchAll(LINE_MARKER)) {
    const ms = localToUtcMs(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, z);
    if (ms === null) continue;
    markers.push({ index: m.index ?? 0, end: (m.index ?? 0) + m[0].length, at: new Date(ms).toISOString() });
  }
  const notes: DatedNote[] = [];
  const preamble = (markers.length ? raw.slice(0, markers[0].index) : raw).trim();
  if (preamble) notes.push({ at: fallbackAt, text: preamble });
  markers.forEach((mk, i) => {
    const stop = i + 1 < markers.length ? markers[i + 1].index : raw.length;
    const text = raw.slice(mk.end, stop).trim();
    if (text) notes.push({ at: mk.at, text });
  });
  return notes;
}
