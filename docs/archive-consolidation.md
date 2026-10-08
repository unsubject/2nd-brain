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
- Occasional contributions to outlets or columns outside the known ones are
  published pieces too, filed with no column (2026-10-06).
- Drafts sent to note@leesimon.me were never published (2026-10-06).
- Only the "Article Archive" folder and the exports folder are read from Drive.
- PDFs in those folders are skipped (2026-10-05).

## Steps

1. **Collect** (done 2026-10-05). Copy every candidate verbatim into
   `archive_source_item` (migration `021_archive_staging.sql`). Nothing is cleaned, matched or
   deleted; re-runs are idempotent.
2. **Extract.** Turn each staged item into a candidate in `archive_candidate`
   (migration `027_archive_candidates.sql`): for an email, the version Simon
   sent, without quoted replies, notes to the editor or signatures; reader
   replies and duplicate newsletter copies dropped; HTML converted to text.
   Rule-based, with uncertain items marked `review`. See "Running step 2".
3. **Match.** Group candidates of the same piece across sources into works
   in `archive_work` / `archive_work_member` (migration
   `029_archive_works.sql`), by text similarity. Canonical text, in order:
   final emailed version → Substack / WordPress as published → newsletter →
   Drive doc (the old `public_artifact` rows come in at step 4). See
   "Running step 3".
4. **Load.** Write every work to `public_artifact` (source system
   `archive`, migration `030_archive_load.sql`) and mark the old
   Notion/email rows it replaces superseded (not deleted). See "Running
   step 4".
5. **Keep current.** New Substack posts arrive by email at Simon's own
   address with the full text, including paid posts, so they can be picked
   up from Gmail daily without re-exporting.

## How the steps run

Each step runs in the background inside the app and is tracked as a run in
`archive_collect_run` (source `gmail`, `gdrive`, `extract`, `match` or
`load`), with at most one live run per source. Once something is
collected, the rest follows by itself, collect → extract → match → load:
when a run ends it starts the step after it (`runner.nextStep`):

| Run that ended | Next |
|---|---|
| Gmail or Drive collection, whatever its outcome | extraction, if any staged item lacks a current candidate |
| Extraction that succeeded | extraction again if items were staged or changed while it ran, else matching |
| Extraction that failed | extraction again only if items were staged or changed while it ran |
| Match, whatever its outcome | matching again if an extraction succeeded while it ran |
| Match that succeeded (otherwise) | loading |
| Load that succeeded | loading again if the works are not the ones it read |
| Load that failed | loading again only if a match succeeded while it ran |

A step asked to start while a run of it is live is refused, so the live run
checks when it ends whether something it missed arrived meanwhile: that is
what the "again" rows are for. Extraction is also held back while a Gmail or
Drive collection is live (it reads everything staged); the collection
starts it when it ends. A failed run is followed again only for what came in
while it ran, so a step that always fails doesn't start run after run. A run
taken over by the resume sweeper (see "Running step 1") starts nothing; the
run that continues it does when it ends.

On boot (90 s after, so after every deploy and after the sweeper has
resumed the runs it cut short) the app checks, in order, whether the
candidates, the works or the loaded rows are out of date (a staged item
with no candidate, one made by an older `EXTRACTOR_VERSION` or one older
than the item; works older than the candidates or than `MATCHER_VERSION`;
no load by this `LOADER_VERSION` that read the current works) and starts
the first step that is due, which then starts the rest (`extract/auto.ts`). While a
collection is live it waits for it, checking again every minute.
Collection, extraction and loading can also be started by hand
(`POST /archive/consolidation/collect`, `/extract`, `/load`; a refused
start answers 409); matching starts only after an extraction or on boot.

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

Google calls are paced and, when Google answers "quota exceeded", the whole
run pauses (15 s, 30 s, … up to 2 min), slows down and retries the call;
`stats.rateLimitPauses` counts the pauses. Drive reads one file at a time,
so it is not paced until its first limit; from then on each request waits
250 ms (doubling on each further limit, up to 4 s), and only the limited
request is retried. The first Gmail run, before this existed, lost 4,039 of
4,297 messages to Gmail's per-minute quota within 30 seconds.

The Google connection page lists any permission Google didn't grant (the
consent screen lets you untick each one); connect again if Drive is listed.

A run ends `failed` if any item failed; the run's `stats.errors` lists them.
Failed items are picked up by the next normal run: a message whose body
couldn't be fetched is never staged, and a staged message with a `.docx`
attachment row missing is fetched again (`stats.retriedIncomplete`).
Only one run per source can be active. Pass `"refetch": true` to re-read
items that are already staged. When a collection ends, whatever its
outcome, it starts extraction (step 2) if any staged item lacks a current
candidate; extraction doesn't start while a Gmail or Drive collection is
live (asked for by hand, it answers 409).

Runs survive deploys. Collectors run inside the app, so a restart stops a
run mid-way; a live run heartbeats every 30 s, so a `running` row silent for
2 minutes belongs to a process that is gone. A sweeper (every minute, from
30 s after boot) starts a fresh run with the same settings and marks the
old one failed (`interrupted: …`) in the same transaction, so if the new run
can't be recorded the old one waits for the next sweep. A normal run skips
what is already staged, so it continues where the old one stopped; a
`refetch` run re-reads everything again. The new run's params carry
`resumedFrom` and `resumeCount`. A run is resumed at most 3 times in a row,
so one that keeps crashing the app stops and has to be started again by
hand. If a run's row is taken over while its old process is still alive,
that process stops at its next item and can neither overwrite the outcome
nor start the step after it: the run that continues it does that.

## Running step 2

Extraction reads only the database (no Google calls) and takes a minute or
two. Every run rewrites every candidate, so a rule change applies to all of
it on the next run; `archive_source_item` is never changed.

It runs by itself after every collection that left items to extract, and
90 s after boot (so after every deploy) the app checks whether any staged
item has no candidate, one made by an older `EXTRACTOR_VERSION`
(`extract/types.ts`, bumped with every rule change) or one older than the
item (collected again since) or, for a `.docx` attachment, than the
message whose recipients it takes, and if so starts a run (`extract/auto.ts`;
while a collection is live it checks again every minute). If items were
staged or changed while an extraction ran (a collection started
alongside), it runs again before matching, whether it succeeded or
failed; after a failed run only those items count, so an item that always
fails waits for the next boot check or a run by hand. A candidate is
stamped with the time its item was read, so an item changed while the run
held it counts as changed. The run's counts appear in the logs
(`[consolidation] extract run … finished: {…}`). To run it by hand:

```sh
curl -X POST "$BASE/archive/consolidation/extract" -H "Authorization: Bearer $ARCHIVE_API_KEY"
curl "$BASE/archive/consolidation/status" -H "Authorization: Bearer $ARCHIVE_API_KEY"   # candidates: counts by source, kind, status
```

To check the rules by eye, fetch a before/after page and open it locally.
It shows one candidate from each kind first, Gmail submissions before
anything else; the same `seed` gives the same sample, so a rule change can
be compared on the same items. `source`, `kind` and `status` narrow it.

```sh
curl "$BASE/archive/consolidation/review?sample=12" -H "Authorization: Bearer $ARCHIVE_API_KEY" -o review.html
curl "$BASE/archive/consolidation/review?source=gmail&status=review&sample=30&seed=b" -H "Authorization: Bearer $ARCHIVE_API_KEY" -o review.html
```

`GET /archive/consolidation/candidates?source=&kind=&status=&limit=&offset=`
lists candidates with a snippet; `GET /archive/consolidation/candidates/<id>`
returns one with the staged item it came from.

Each candidate has a `kind`, a `status` (`keep` an essay, `review` probably
one but a rule was unsure, `drop` not one) and the `reasons` behind them:

| Source | Kind | Status | Rule |
|---|---|---|---|
| gmail | `submission` | keep / review | Sent by Simon (SENT label, or from one of his addresses) with at least 280 characters after cleaning. `review` when a short first paragraph that looks like a note was removed without a title line to confirm it. Pieces for outlets or columns not listed below (occasional contributions) are kept the same way, with no column (`outlet-unknown`); but a `Re:` to no known outlet is more likely a conversation with a reader, so it goes to review (`reply-outside-outlets`). |
| gmail | `attachment` | keep | His `.docx` attachment; title from the file name, or from the subject when the file name is only a column and date ("利字當頭 20240220"). Column, outlet and the self-draft rule follow the message that carried it (its recipients are read from the message's row). |
| gmail | `self_draft` | drop / review | A message, or its `.docx`, sent only to his own addresses. Dropped when note@leesimon.me is among them (nothing sent there was published; Simon, 2026-10-06); otherwise review. |
| gmail | `reply` | drop | His message, under 280 characters once quotes and signature are gone. |
| gmail | `forward` | drop | Subject starts `Fwd:`; the original is staged on its own. |
| gmail | `received` | drop | From anyone else: editors, readers, acknowledgements. |
| gmail | `newsletter` | keep | A Revue (newsletter@leesimon.me), unsubject.me or Patreon issue as mailed, platform header and footer removed. Patreon mail about another creator's post ("X just shared", X not 利世民 / Simon Lee) is `received`. |
| gmail | `duplicate` | drop | A later copy of the same issue (same platform, title and day); the earliest is kept. |
| gmail | `platform_copy` | drop | A Substack email: the Substack export has the post. |
| wordpress | `post` / `page` | keep / review | Published posts kept; pages and private posts to review; drafts dropped. |
| substack | `post` | keep | Published posts, any audience (`audience-only_paid` noted); drafts dropped. |
| gdrive | `doc` | keep | As written; date from the file name (`利字當頭 20190730`) or else the file's creation date (also when the name's date is a day that doesn't exist, such as `20230231`). |

Cleaning an email, in order: drop Gmail's link targets (`text <https://…>`);
cut everything from the first quote header ("On … wrote:", also as "> On …"
in iPhone replies, "… 於 2020年6月1日 … 寫道：", "2016-03-01 10:22 GMT+08:00 …:",
older Gmail's "2013/12/26 Name <address>", Outlook "From: / Sent:",
"Original message") or a trailing block of `>` lines; cut the signature
(`-- `, "Sent from my iPhone", a sign-off name such as 利世民, 李兆富 (his
signature until about 2014) or Simon in the last lines with at most a short
tag after it);
rejoin hard-wrapped lines (no space between Chinese characters); then, when
a title line (`*title*`, `【利字當頭】title`, `蘋果論壇：title`, or the
subject's title) appears in the first paragraphs, the text before it is the
note to the editor (kept in `note`) and the essay starts after it.

The publication date is the column date in the subject when there is one
("留稿：12月30日見報", "利字當頭 2020 06 30"; a real date within 45 days of sending),
else the send date (`date_source`). The outlet follows the column (蘋果論壇 →
蘋果日報, 壹擋專政 → 壹週刊, 金融一條針 → 爽報), else the recipients' domain.
A piece mailed to forum@appledaily.com is a 蘋果論壇 piece even when the
subject doesn't say so. A leading "李兆富：" or "利世民：" in a subject is the
author's name, not part of the title; a leading 投稿 followed by a separator,
a space or a quote ("投稿：title") is a marker, but a title that starts with
the word ("投稿文化的轉變") keeps it.

These rules were checked against about 15 real messages from the label
(2013–2024) on 2026-10-07; that pass added the 李兆富 sign-off, the older
Gmail and iPhone quote headers, link targets, the forum address, the
reader-reply review and the Patreon creator check.

## Running step 3

Matching runs by itself after every successful extraction that left every
staged item with a current candidate (and on boot when
the works are older than the candidates or than `MATCHER_VERSION` in
`match/run.ts`). It reads the candidates that extraction kept or sent to
review, takes a few seconds, and rebuilds every work in one transaction.
An extraction that succeeds while a match runs can't start its own (one
run per step), so a match, whatever its outcome, runs again when one did;
otherwise a successful match starts a load (step 4).
The run's counts appear in the logs (`[consolidation] match run …
finished: {…}`): `works`, `byStatus`, `bySize` (works with 1, 2, 3–5, 6–10,
11+ members) and the five `largest` works by title; a very large work would
mean different pieces were merged.

Same piece: each text becomes the set of its 4-unit shingles (a unit is one
Chinese character or one Latin word; spacing and punctuation don't count).
Two candidates are the same piece when at least 60% of the shorter text's
shingles are in the longer one and the shorter is at least 30% of the
longer's size, so an edited resend, a repost with a new opening, or a
Drive draft joins its work, but a paragraph quoted in another essay does
not. Likely pairs come from sampled shingles (the same 1-in-8 slice of
hashes in every text, so a short copy's samples are all in the long text's
samples, which a containment screen needs; banded MinHash, used at first,
missed many short copies). Pairs are found through shared samples that
are in at most 50 texts, then screened on all their shared samples. A
text whose samples in over 50 texts could pass the screen by themselves
also counts those it shares with each other text, so a pair that shares
only such samples is found too. A
text the index can't vouch for (fewer than 32 ordinary samples, or more
than 40% of its samples in over 50 texts, as with a piece in many copies
or a widely quoted passage) is checked against every text of a size it
could match. A pair at the 60% limit is then missed only by sampling
noise (about 3 in 100,000). Each pair is checked exactly, and pairs chain
into works.

Each work's canonical text, in order: the latest version emailed to a known
outlet (Simon's decision: the last version he sent wins, not the editor's
edit); the published Substack post; the published WordPress post (a page or
private post ranks with the drafts); the newsletter issue; an email
to an address at no known outlet; the Drive document; anything else.
Between a message and the `.docx` it carried (one send, the essay inline
and attached), the message wins: its title line, note and sign-off were
removed.

A work's title is its canonical's, except that a `.docx` is named by its
file ("final"): a canonical `.docx` takes the title of the best-ranked
message or published copy when there is one. Its date is the first
publication (the earliest date among published members), its outlet and
column those of that first publication, and `outlets` lists every outlet a
member went to.

A work is `review` when none of its members was published or its canonical
candidate is itself under review; `versions-differ` notes a member whose
text is much changed from the canonical (Jaccard below 0.6).

```sh
curl "$BASE/archive/consolidation/works?status=review&limit=50" -H "Authorization: Bearer $ARCHIVE_API_KEY"
curl "$BASE/archive/consolidation/works/<id>" -H "Authorization: Bearer $ARCHIVE_API_KEY"   # with its members
```

## Running step 4

Decisions (Simon, 2026-10-08): load **every** work, the ones in review
flagged; an old row that matches a work is superseded, one that matches
nothing stays searchable, flagged.

A load runs by itself after every successful match, and on boot when no
load by the current `LOADER_VERSION` has read the current works (an empty
set of works included). A load that finds the works changed while it ran (a
match finished meanwhile, whose own load it blocked) loads again; after a
failed load, only when a match succeeded while it ran, so a load that keeps
failing waits for the boot check or a run by hand. To start one by hand:

```sh
curl -X POST "$BASE/archive/consolidation/load" -H "Authorization: Bearer $ARCHIVE_API_KEY"
```

What a load writes, in one transaction:

- **One row per work**, `source_system = 'archive'`, keyed by the source
  item of the canonical text (`gmail:<message id>`, `wordpress:<host>:<id>`,
  …). Title, first publication date, the canonical text, `series` (the
  column, else the outlet), `outlets` (every outlet), and the link of a
  published WordPress copy if there is one. A work in review gets
  `flag = 'review'`. A new or changed text goes to the archive worker
  (`processing_status = 'pending'`), which summarises, chunks and embeds it
  as for any row; an unchanged one is left as it is. The worker saves its
  result only if the row still holds the text it processed, so a text
  changed mid-way is processed again rather than overwritten (a failure on
  the old text is not recorded against the new one either), and marks a row
  `processed` only once its summary, chunks and entities are all in.
- **The rows it replaces** get `superseded_by` pointing at the new row:
  - a row from the first import (any source but `youtube`) that is a copy
    of any version of the work: the step 3 test, or, for a row the import
    cut at 2,000 characters, at least 60% of the row found in the version;
  - an `archive` row from an earlier load whose text is no longer a work's
    canonical (the work changed, or the item joined another work).

  Such a row leaves search (`status = 'superseded'`) only once its
  replacement has been processed, so a piece never drops out of search
  while its new row waits in the queue. Links to it then move to the
  replacement: those the calendar/task linker made (journal echoes,
  shared entities) and idea links (`became`, `revisits`, any status), each
  idea link recording the row it pointed at in its history. An `archive`
  row that no work replaces is superseded at once; `get_entry` no longer
  shows journal links to a row that has left search.
- **Old rows that match no work** stay searchable with
  `flag = 'unmatched'`. Video transcripts are not touched.

Search leaves out superseded rows: the `/archive/search` route and the
calendar/task linker filter on `status = 'published'`, as the MCP tools
already did. The `/archive/search` route and the MCP `archive_search_text`
tool also return `flag`, so a reader can tell a confirmed piece from one
still to check. The status
route lists `public_artifact` rows by source, status, flag and processing
state; the run log gives works, rows inserted / changed / unchanged,
`flaggedReview`, `retired` (archive rows replaced), and for the old rows
how many matched, left search, wait for their replacement, or matched
nothing.

## What is stored

- **gmail**: one row per message (body as text and/or HTML, headers, labels,
  `isSent`, attachment list), plus one row per `.docx` attachment
  (`<message id>#<part id>`) with its text (its recipients stay on the
  message's row). Long bodies that Gmail stores out of line are fetched
  separately (`externalBodies` in the metadata).
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
