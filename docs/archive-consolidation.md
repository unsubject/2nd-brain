# Published-archive consolidation

Goal: one complete, clean copy of every piece Simon has published, with its
date, outlet and canonical text, as the base for the searchable archive, the
paywalled archive and the public wiki. Journals stay out of this entirely.

The first archive import (Notion, 2026-04/05) mixed essays with emails to
editors, kept some pieces only partially, and cut long ones at 2,000
characters. This pipeline rebuilds the text archive from the original
sources instead of patching those rows.

## Sources

| Source | What it holds | How it is read |
|---|---|---|
| Gmail label `Writing` (~4,300 messages) | Column submissions and revised resends (蘋果論壇, 利字當頭 for 尚生活 / Points Media, …), editor replies, drafts sent to self, newsletter copies (Revue, unsubject.me, Patreon, Substack), reader replies | Gmail API, `gmail.readonly` (already granted) |
| Drive folder "Article Archive" | Google Docs of columns and essays (2018–), some duplicated by a 2024-02 bulk copy; subfolders Web 3, Speaking Note, CCC, Book Project | Drive API, `drive.readonly` |
| Drive exports folder | WordPress export (WXR XML) and the Substack export zip | Drive API, `drive.readonly` |
| Existing `public_artifact` rows | The Notion/email import and YouTube transcripts | Gap-filler only, always flagged |

Decisions (Simon, 2026-10-04):

- For columns, **the last version Simon emailed is canonical**, even where an
  editor later changed the printed text.
- **Every past platform counts as published**: 蘋果論壇, 利字當頭 (all
  outlets), Revue, unsubject.me, Patreon, WordPress, Substack.
- Only the "Article Archive" folder and the exports folder are read from Drive.

## Steps

1. **Collect** (this step). Copy every candidate verbatim into
   `archive_source_item` (migration 021). Nothing is cleaned, matched or
   deleted; re-runs are idempotent.
2. **Extract.** Turn each staged item into candidate essay text: for an email
   thread, the last version Simon sent, without quoted replies, notes to the
   editor or signatures; reader replies and duplicate newsletter copies
   dropped; HTML converted to text. Rule-based first, with uncertain items
   sent to review.
3. **Match.** Group candidates of the same piece across sources into works
   (title + date + text similarity). Canonical text, in order: final emailed
   version → Substack / WordPress as published → Drive doc → old row.
   Truncated or conflicting versions go to a review list.
4. **Load.** Write canonical works to `public_artifact` under new source
   systems and mark the old Notion/email rows superseded (not deleted).
5. **Keep current.** New Substack posts arrive by email at Simon's own
   address with the full text, including paid posts, so they can be picked
   up from Gmail daily without re-exporting.

## Running step 1

All routes sit behind the existing `/archive/*` bearer auth (`ARCHIVE_API_KEY`).

1. Deploy, then re-authorise Google once so the app gains `drive.readonly`:
   open `<app url>/auth/google`, enter the owner secret (`OWNER_SECRET`), and
   accept the new Drive permission on Google's consent screen. Until then a
   Drive run fails with "Google Drive access not granted yet".
2. Collect Gmail (runs in the background, ~20–30 min the first time):

   ```sh
   curl -X POST "$BASE/archive/consolidation/collect" \
     -H "Authorization: Bearer $ARCHIVE_API_KEY" -H "Content-Type: application/json" \
     -d '{"source":"gmail","label":"Writing"}'
   ```

3. Collect Drive (both folders in one run):

   ```sh
   curl -X POST "$BASE/archive/consolidation/collect" \
     -H "Authorization: Bearer $ARCHIVE_API_KEY" -H "Content-Type: application/json" \
     -d '{"source":"gdrive","folderIds":["1-t93X29Zx94KBa0E2WxM7Izu4S8CLOvl","19xMNprsamGSLdZw6EgRd2uCeppKS2gzZ"]}'
   ```

4. Check progress, results and the audit of the current `public_artifact`:

   ```sh
   curl "$BASE/archive/consolidation/status" -H "Authorization: Bearer $ARCHIVE_API_KEY"
   ```

A run ends `failed` if any item failed; the run's `stats.errors` lists them.
Failed items are picked up by the next normal run: a message whose body
couldn't be fetched is never staged, and a staged message with a `.docx`
attachment row missing is fetched again (`stats.retriedIncomplete`).
Only one run per source can be active; a run with no progress for 15
minutes (e.g. a restart mid-run) is marked failed when the next one starts.
Pass `"refetch": true` to re-read items that are already staged.

## What is stored

- **gmail**: one row per message (body as text and/or HTML, headers, labels,
  `isSent`, attachment list), plus one row per `.docx` attachment
  (`<message id>#<part id>`) with its text. Long bodies that Gmail stores
  out of line are fetched separately (`externalBodies` in the metadata).
- **gdrive**: one row per Google Doc (text + HTML export) or `.docx`, with its
  folder path and Drive timestamps. Unchanged files are skipped on re-runs.
- **wordpress**: one row per post or page (`<site host>:<post id>`), HTML as
  exported, with status, slug, link, categories and tags. Attachments, menus
  and theme records are skipped.
- **substack**: one row per post (`<post id>`), HTML from `posts/*.html`
  joined with `posts.csv` (title, subtitle, date, audience, published flag).
  The export's subscriber lists are never opened: entries are filtered by
  name before anything is read.
- If the folder holds several WordPress or Substack exports, they are read
  oldest first (by Drive modified time), so the newest snapshot's copy of
  each post is the one left staged.
