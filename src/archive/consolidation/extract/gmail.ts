// Step 2 for Gmail: turn one staged message (or .docx attachment) into a
// candidate. The rules follow what the "Writing" label actually holds
// (2010–2024): column submissions to the desks, resends with a note to the
// editor, quoted earlier versions, editor replies and acknowledgements,
// reader replies, forwards, drafts to self, and newsletter copies.

import { candidate, type Candidate, type StagedItem } from "./types";
import { htmlToText, normalizeText, paragraphs, textLength, unwrapSoftBreaks } from "./text";

// Simon's own mailboxes: a message from one of these is his even without
// the SENT label (copies that arrived through forwarding).
const OWN_DOMAINS = ["leesimon.me", "simoncf.com", "unsubject.com", "unsubject.me"];
const OWN_ADDRESSES = new Set(["simoncf@gmail.com", "simon.lee@advb.com.hk"]);

export function emailAddress(s: string): string {
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>/);
  return (m ? m[1] : s).trim().replace(/^["']+|["']+$/g, "").toLowerCase();
}

export function isOwnAddress(s: string): boolean {
  const a = emailAddress(s);
  return OWN_ADDRESSES.has(a) || OWN_DOMAINS.includes(a.split("@")[1] ?? "");
}

export type Platform = "revue" | "unsubject.me" | "patreon" | "substack";

export function newsletterPlatform(from: string | null): Platform | null {
  const a = from ? emailAddress(from) : "";
  if (a.endsWith("@substack.com")) return "substack";
  if (a.endsWith("@patreon.com")) return "patreon";
  if (a === "newsletter@unsubject.me") return "unsubject.me";
  if (a === "newsletter@leesimon.me" || a.endsWith("@revue.email") || a.endsWith("@getrevue.co")) return "revue";
  return null;
}

const PLATFORM_OUTLET: Record<Platform, string> = {
  revue: "Revue",
  "unsubject.me": "unsubject.me",
  patreon: "Patreon",
  substack: "Substack",
};

// ── Columns and outlets ─────────────────────────────────────────────────

const COLUMNS: { name: string; re: RegExp; outlet?: string }[] = [
  { name: "利字當頭", re: /利字當頭/ },
  { name: "蘋果論壇", re: /蘋果論壇|apple\s*daily\s*forum/i, outlet: "蘋果日報" },
  { name: "壹擋專政", re: /壹擋專政/, outlet: "壹週刊" },
  { name: "另壹角度", re: /另壹角度/, outlet: "壹週刊" },
  { name: "金融一條針", re: /金融一條針/, outlet: "爽報" },
];
const COLUMN_PREFIX = /^(利字當頭|蘋果論壇|壹擋專政|另壹角度|金融一條針|apple\s*daily\s*forum)/i;

// In priority order: a 金融一條針 piece goes to 爽報 with an Apple Daily
// editor in Cc, so the first matching outlet wins, not the first recipient.
const OUTLET_DOMAINS: [string, string][] = [
  ["sharpdaily.com.hk", "爽報"],
  ["nextmedia.com", "壹週刊"],
  ["appledaily.com", "蘋果日報"],
  ["appledaily.com.hk", "蘋果日報"],
  ["livesup.co", "尚生活"],
  ["victoriaharbor.group", "尚生活"],
  ["points-media.com", "Points Media"],
];

export function detectColumn(...texts: (string | null | undefined)[]): { name: string; outlet?: string } | null {
  for (const t of texts) {
    if (!t) continue;
    const c = COLUMNS.find((x) => x.re.test(t));
    if (c) return c;
  }
  return null;
}

export function detectOutlet(recipients: string[], column: { outlet?: string } | null): string | null {
  if (column?.outlet) return column.outlet;
  const domains = recipients.map((r) => emailAddress(r).split("@")[1] ?? "");
  for (const [domain, outlet] of OUTLET_DOMAINS) {
    if (domains.some((d) => d === domain || d.endsWith(`.${domain}`))) return outlet;
  }
  return null;
}

// ── Subjects and titles ─────────────────────────────────────────────────

export function cleanSubject(subject: string | null): string {
  let s = (subject ?? "").trim();
  for (;;) {
    const t = s.replace(/^\s*(re|fwd?|fw|回覆|轉寄|答覆)\s*[:：]\s*/i, "");
    if (t === s) break;
    s = t;
  }
  return s.replace(/[（(]\s*留稿[^）)]*[）)]/g, "").trim();
}

// The piece's own title: no column marker, date, "投稿" or "- Simon Lee".
export function bareTitle(s: string | null): string {
  let t = (s ?? "").trim().replace(/^[*_]+|[*_]+$/g, "");
  t = t.replace(/【[^】]*】/g, " ").trim();
  t = t.replace(COLUMN_PREFIX, "").trim();
  t = t.replace(/^[（(]?\s*\d{4}[\s\-./]?\d{1,2}[\s\-./]?\d{1,2}\s*[）)]?/, "").trim();
  t = t.replace(/^[:：\-–—|·．]+/, "").trim();
  t = t.replace(/\s*[-–—|]\s*simon\s*lee\s*$/i, "").replace(/\s*[x×]\s*尚生活\s*$/i, "").replace(/^投稿$/, "");
  t = t.trim();
  return /^[\d\s\-./]*$/.test(t) ? "" : t;
}

function sameTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[\s*_「」『』《》"'“”‘’．·。，,:：!！?？\-–—]/g, "").toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (x.length < 2 || y.length < 2) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// A line that is `title` with at most a short prefix or suffix ("講聲你聽
// #12："), not a sentence that happens to contain it.
function isTitleOf(line: string, title: string): boolean {
  return (
    !line.includes("\n") &&
    !/[。！？.!?]$/.test(line) &&
    textLength(line) <= textLength(title) + 15 &&
    sameTitle(line, title)
  );
}

// A column's publication date often sits in the subject ("利字當頭
// 2020 06 30", "Apple Daily Forum 20200624", "（留稿：12月30日見報）").
export function subjectDate(subject: string | null, sentAt: Date | null): Date | null {
  if (!subject || !sentAt) return null;
  const ok = (d: Date) => {
    const days = (d.getTime() - sentAt.getTime()) / 86_400_000;
    return days > -3 && days < 45 ? d : null;
  };
  const scheduled = subject.match(/留稿\s*[:：]?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (scheduled) {
    const month = Number(scheduled[1]);
    const day = Number(scheduled[2]);
    let year = sentAt.getUTCFullYear();
    if (month < sentAt.getUTCMonth() + 1 - 6) year += 1;
    return ok(new Date(Date.UTC(year, month - 1, day)));
  }
  if (!COLUMN_PREFIX.test(cleanSubject(subject).replace(/^【/, ""))) return null;
  const m = subject.match(/(20\d{2})[\s\-./]?(\d{2})[\s\-./]?(\d{2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return ok(new Date(Date.UTC(y, mo - 1, d)));
}

// ── Quotes, signatures and notes to the editor ──────────────────────────

const QUOTE_HEADERS: RegExp[] = [
  /^On\b.{3,250}\bwrote:\s*$/i,
  /^.{0,160}[於在]\s*\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日.{0,60}寫道\s*[:：]\s*$/,
  /^\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}\s*GMT[+-]\d{1,2}:\d{2}\s+.{1,160}:\s*$/,
  /^-{2,}\s*(original message|forwarded message|原始郵件|原始邮件|轉寄郵件|轉寄的郵件)\s*-{2,}\s*$/i,
  /^_{8,}\s*$/,
];
const OUTLOOK_FROM = /^(from|寄件者|發件人)\s*[:：]/i;
const OUTLOOK_NEXT = /^(sent|date|to|subject|傳送時間|寄件日期|收件者|主旨)\s*[:：]/i;

// Everything from the first quote header on is an earlier message.
export function cutQuoted(text: string): { text: string; cut: boolean } {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const joined = i + 1 < lines.length ? `${line} ${lines[i + 1].trim()}` : line;
    const isHeader =
      QUOTE_HEADERS.some((re) => re.test(line)) ||
      // Gmail wraps "On …, Name <addr>" / "wrote:" over two lines.
      (/^On\b/i.test(line) && QUOTE_HEADERS[0].test(joined)) ||
      (OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 4).some((l) => OUTLOOK_NEXT.test(l.trim())));
    if (isHeader) return { text: lines.slice(0, i).join("\n").trim(), cut: true };
  }
  // No header, but a trailing block of "> " lines is still a quote.
  let end = lines.length;
  while (end > 0 && (lines[end - 1].trim() === "" || lines[end - 1].trim().startsWith(">"))) end--;
  const quotedTail = lines.slice(end).filter((l) => l.trim().startsWith(">")).length;
  if (quotedTail >= 2) return { text: lines.slice(0, end).join("\n").trim(), cut: true };
  return { text: text.trim(), cut: false };
}

const DEVICE_SIGNATURE =
  /^(sent from my (iphone|ipad|blackberry|mobile|android).*|從我的\s*(iphone|ipad)\s*傳送|從我的 iPhone 傳送|get outlook for .+|發自我的\s*iphone)$/i;
const SIGN_OFF_NAME = /^(利世民|simon|simon lee|simon lee\s*\|\s*利世民|simon\s*\(利世民\))$/i;
const CLOSING = /^(regards|best|best regards|thanks|thank you|cheers|謝謝|多謝|thx)[,，!！.]?$/i;

export function stripSignature(text: string): string {
  let lines = text.split("\n");
  const delimiter = lines.findIndex((l, i) => i >= lines.length - 15 && /^--\s?$/.test(l));
  if (delimiter >= 0) lines = lines.slice(0, delimiter);
  const trimEnd = () => {
    while (lines.length && (lines[lines.length - 1].trim() === "" || DEVICE_SIGNATURE.test(lines[lines.length - 1].trim()))) {
      lines.pop();
    }
  };
  trimEnd();
  // A sign-off ("利世民") among the last lines, followed by at most a short
  // tag ("講聲你聽 001"), ends the essay.
  const tail = lines.slice(-4);
  const nameAt = tail.findIndex((l) => SIGN_OFF_NAME.test(l.trim()));
  if (nameAt >= 0) {
    const after = tail.slice(nameAt + 1).join("");
    if (textLength(after) <= 30) {
      lines = lines.slice(0, lines.length - tail.length + nameAt);
      trimEnd();
      if (lines.length && CLOSING.test(lines[lines.length - 1].trim())) lines.pop();
    }
  }
  trimEnd();
  return lines.join("\n");
}

const NOTE_HINT =
  /(dear|hi\b|hello|thanks|thank you|attached|edited|version|piece|老總|編輯|版本|修正|修改|請用|附上|稿|麻煩|不好意思|sorry|唔該|請查收)/i;

function isTitleLine(p: string, subjectTitle: string): boolean {
  if (p.includes("\n") || textLength(p) > 60) return false;
  if (/^\*[^*]+\*$/.test(p) || /^【[^】]+】/.test(p)) return true;
  if (COLUMN_PREFIX.test(p) && /^\S+?[\s：:】]/.test(p)) return true;
  return !!subjectTitle && isTitleOf(bareTitle(p), subjectTitle);
}

export interface PrefaceResult {
  body: string;
  title: string | null;
  note: string | null;
  reasons: string[];
}

// A note to the editor before the essay ("稍為修正了內容，請用以下這個
// 版本。", "Dear Jane, … Simon") ends at the essay's title line.
export function stripPreface(text: string, subject: string | null): PrefaceResult {
  const paras = paragraphs(text);
  const subjectTitle = bareTitle(cleanSubject(subject));
  const reasons: string[] = [];
  const titleAt = paras.slice(0, 6).findIndex((p) => isTitleLine(p, subjectTitle));
  if (titleAt === 0) {
    return { body: paras.slice(1).join("\n\n"), title: bareTitle(paras[0]) || null, note: null, reasons };
  }
  if (titleAt > 0) {
    const preface = paras.slice(0, titleAt).join("\n\n");
    if (textLength(preface) <= 400) {
      return {
        body: paras.slice(titleAt + 1).join("\n\n"),
        title: bareTitle(paras[titleAt]) || null,
        note: preface,
        reasons: ["note-before-title"],
      };
    }
    reasons.push("long-text-before-title");
  }
  if (paras.length > 1 && textLength(paras[0]) <= 150 && NOTE_HINT.test(paras[0])) {
    return {
      body: paras.slice(1).join("\n\n"),
      title: null,
      note: paras[0],
      reasons: [...reasons, "possible-note-removed"],
    };
  }
  return { body: paras.join("\n\n"), title: null, note: null, reasons };
}

// ── Newsletters ─────────────────────────────────────────────────────────

const NEWSLETTER_RULES: Record<Exclude<Platform, "substack">, { start: RegExp[]; end: RegExp[] }> = {
  revue: {
    start: [/View online\s*(\[[^\]]*\])?\s*\|?/],
    end: [/Did you enjoy this issue\?/, /If you don't want these updates anymore/, /Powered by Revue/],
  },
  "unsubject.me": {
    start: [/View online\s*→?\s*(\[[^\]]*\])?/],
    end: [/假如你從朋友轉送收到這封電郵/, /unsubject\s*©/, /You received this email because/i, /Unsubscribe/],
  },
  patreon: {
    start: [],
    end: [/View on Patreon/, /Get\s+the Patreon app/, /Patreon Inc\./],
  },
};

export function patreonTitle(subject: string | null): string | null {
  const m = (subject ?? "").match(/just shared\s+["“](.+?)["”]/);
  return m ? m[1].trim() : null;
}

export function cleanNewsletter(text: string, platform: Exclude<Platform, "substack">, title: string | null): string {
  let s = text;
  const rules = NEWSLETTER_RULES[platform];
  for (const re of rules.start) {
    const m = s.match(re);
    if (m && m.index !== undefined) {
      s = s.slice(m.index + m[0].length);
      break;
    }
  }
  if (platform === "patreon" && title) {
    // Header: creator name, then the post title on its own line.
    const at = s.indexOf(title);
    if (at >= 0 && at < 400) s = s.slice(at + title.length);
  }
  let end = s.length;
  for (const re of rules.end) {
    const m = s.match(re);
    if (m && m.index !== undefined && m.index < end) end = m.index;
  }
  s = s.slice(0, end);
  // Plain-text parts carry links as " [https://…]".
  s = s.replace(/\s*\[https?:\/\/[^\]\s]*\]/g, "");
  s = normalizeText(s.replace(/^\s*\|\s*$/gm, ""));
  // Like a submission's body, the essay text starts after its title.
  const paras = paragraphs(s);
  if (title && paras.length > 1 && isTitleOf(paras[0], title)) {
    return paras.slice(1).join("\n\n");
  }
  return s;
}

// ── The extractor ───────────────────────────────────────────────────────

const MIN_ESSAY = 280;

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function dayKey(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "undated";
}

export function extractGmail(item: StagedItem): Candidate {
  const m = item.metadata;
  const from = str(m.from);
  const subject = str(m.subject) ?? item.title;
  const mine = m.isSent === true || (!!from && isOwnAddress(from));

  if (m.kind === "attachment") return extractAttachment(item, mine, subject);

  // Before the own-address test: Revue and Ghost sent from newsletter@ his
  // own domains, but those copies arrived as mail, never through SENT.
  const platform = newsletterPlatform(from);
  if (platform && m.isSent !== true) return extractNewsletter(item, platform, subject);
  if (!mine) {
    return candidate({ kind: "received", status: "drop", reasons: ["not-from-simon"], title: cleanSubject(subject) || null });
  }

  const recipients = [...strings(m.to), ...strings(m.cc)];
  const cleanSubj = cleanSubject(subject);
  if (/^\s*(fwd?|fw|轉寄)\s*[:：]/i.test(subject ?? "")) {
    return candidate({ kind: "forward", status: "drop", reasons: ["forwarded"], title: bareTitle(cleanSubj) || cleanSubj || null });
  }

  const fromText = !!item.rawText && textLength(item.rawText) > 0;
  let body = normalizeText(fromText ? item.rawText! : item.rawHtml ? htmlToText(item.rawHtml) : "");
  const quoted = cutQuoted(body);
  body = stripSignature(quoted.text);
  if (fromText) body = unwrapSoftBreaks(body);
  const pre = stripPreface(body, subject);
  body = pre.body.trim();

  const reasons = [...pre.reasons];
  if (quoted.cut) reasons.push("quote-removed");
  const column = detectColumn(pre.title, cleanSubj);
  const title = pre.title ?? (bareTitle(cleanSubj) || null);
  const fromSubject = subjectDate(subject, item.authoredAt);
  const base = {
    title,
    column: column?.name ?? null,
    outlet: detectOutlet(recipients, column),
    publishedAt: fromSubject ?? item.authoredAt,
    dateSource: fromSubject ? "subject" : "sent",
    bodyText: body || null,
    note: pre.note,
  };

  if (textLength(body) < MIN_ESSAY) {
    return candidate({ ...base, kind: "reply", status: "drop", reasons: [...reasons, "short-message"] });
  }
  if (recipients.length > 0 && recipients.every(isOwnAddress)) {
    return candidate({ ...base, kind: "self_draft", status: "review", isPublished: false, reasons: [...reasons, "sent-only-to-own-addresses"] });
  }
  const uncertain = reasons.some((r) => r === "possible-note-removed" || r === "long-text-before-title");
  return candidate({ ...base, kind: "submission", status: uncertain ? "review" : "keep", isPublished: true, reasons });
}

function extractAttachment(item: StagedItem, mine: boolean, subject: string | null): Candidate {
  const filename = (str(item.metadata.filename) ?? item.title ?? "").replace(/\.docx$/i, "").trim();
  const title = bareTitle(filename) || filename || null;
  const body = normalizeText(item.rawText ?? (item.rawHtml ? htmlToText(item.rawHtml) : ""));
  const column = detectColumn(filename, cleanSubject(subject));
  const fromSubject = subjectDate(subject, item.authoredAt);
  const base = {
    title,
    column: column?.name ?? null,
    outlet: column?.outlet ?? null,
    publishedAt: fromSubject ?? item.authoredAt,
    dateSource: fromSubject ? "subject" : "sent",
    bodyText: body || null,
  };
  if (!mine) return candidate({ ...base, kind: "received", status: "drop", reasons: ["attachment-not-from-simon"] });
  if (textLength(body) < MIN_ESSAY) return candidate({ ...base, kind: "empty", status: "drop", reasons: ["short-attachment"] });
  return candidate({ ...base, kind: "attachment", status: "keep", isPublished: true });
}

function extractNewsletter(item: StagedItem, platform: Platform, subject: string | null): Candidate {
  const outlet = PLATFORM_OUTLET[platform];
  if (platform === "substack") {
    // The Substack export holds every post with its original HTML.
    return candidate({
      kind: "platform_copy",
      status: "drop",
      reasons: ["in-substack-export"],
      title: cleanSubject(subject) || null,
      outlet,
      publishedAt: item.authoredAt,
      dateSource: "email",
    });
  }
  const title = platform === "patreon" ? patreonTitle(subject) ?? cleanSubject(subject) : cleanSubject(subject);
  const raw = item.rawHtml ? htmlToText(item.rawHtml) : normalizeText(item.rawText ?? "");
  const body = cleanNewsletter(raw, platform, title);
  const base = {
    title: title || null,
    outlet,
    publishedAt: item.authoredAt,
    dateSource: "email",
    isPublished: true,
    bodyText: body || null,
    dedupeKey: `${platform}|${(title ?? "").replace(/\s+/g, "").toLowerCase()}|${dayKey(item.authoredAt)}`,
  };
  if (textLength(body) < MIN_ESSAY) {
    return candidate({ ...base, kind: "empty", status: "review", reasons: ["newsletter-body-not-found"] });
  }
  return candidate({ ...base, kind: "newsletter", status: "keep" });
}
