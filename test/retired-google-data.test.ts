// Static guards for the retired data (refocus Phase 3): the monolith no
// longer syncs Calendar or Contacts, links journal entries to people or
// events, or reads the old COS and discovery tables. Their tables and rows
// stay until a migration drops them, which is safe only while no code reads
// them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

// Comments may name the retired data (to say it is retired); only code counts.
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const files = ["src", "scripts"].flatMap((dir) =>
  (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ name: join(dir, f), code: stripComments(read(join(dir, f))) }))
);

const RETIRED = [
  // Tables
  "person_ref",
  "calendar_event_ref",
  "morning_review",
  "editorial_pick",
  "task_suggestion",
  // Link types the person and event matchers wrote
  "mentions_person",
  "relates_to_event",
  "same_day_as_event",
  "relates_to_location",
  // Google APIs, scopes and settings
  "google.people",
  "google.calendar",
  "contacts.readonly",
  "calendar.readonly",
  "FAMILY_GOOGLE_CALENDAR_ID",
];

test("scans the monolith and script sources", () => {
  assert.ok(files.length > 40, `only ${files.length} files`);
  assert.ok(files.some((f) => f.name === join("src", "google", "linker.ts")));
});

test("no code reads the retired Google data or COS tables", () => {
  const offenders = files.flatMap((f) => RETIRED.filter((r) => f.code.includes(r)).map((r) => `${f.name}: ${r}`));
  assert.deepEqual(offenders, []);
});

test("the relink backfill wipes only link types the linker writes back", () => {
  const script = stripComments(read("scripts/relink_journal_entries.ts"));
  const list = script.match(/const STALE_LINK_TYPES = \[([^\]]*)\]/);
  assert.ok(list, "STALE_LINK_TYPES not found");
  const wiped = [...list[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(wiped.length > 0);

  const written = new Set(
    [...stripComments(read("src/google/linker.ts")).matchAll(/linkType: "([a-z_]+)"/g)].map((m) => m[1])
  );
  assert.ok(written.has("mentions_entity"));
  assert.deepEqual(wiped.filter((t) => !written.has(t)), []);
});
