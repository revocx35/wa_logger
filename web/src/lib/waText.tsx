import { Fragment, type ReactNode } from 'react';

/*
 * WhatsApp text formatting → React elements. Never produces HTML strings, so message content can
 * never inject markup. Supported: *bold* _italic_ ~strike~ `code` ```block```, "> " quotes,
 * "- " / "* " / "1. " lists, http(s) links, @mentions.
 */

export type WaNode =
  | { t: 'text'; v: string }
  | { t: 'b' | 'i' | 's'; c: WaNode[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; v: string }
  | { t: 'mention'; id: string; name: string };

export type WaBlock =
  | { t: 'pre'; v: string }
  | { t: 'line'; kind: 'p' | 'quote' | 'bullet' | 'number'; marker?: string; c: WaNode[] };

export interface Mention {
  id: string;
  name: string | null;
}

const MARKERS: Record<string, 'b' | 'i' | 's' | 'code'> = { '*': 'b', _: 'i', '~': 's', '`': 'code' };
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/gi;
const MENTION_RE = /@(\d{5,20})/g;

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

export function safeHref(raw: string): string | null {
  const href = /^www\./i.test(raw) ? `https://${raw}` : raw;
  try {
    const u = new URL(href);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function withMentions(text: string, mentions: Mention[]): WaNode[] {
  if (!mentions.length || !text.includes('@')) return text ? [{ t: 'text', v: text }] : [];
  const out: WaNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const digits = m[1]!;
    const mention = mentions.find((x) => x.id.startsWith(`${digits}@`));
    if (!mention) continue;
    const idx = m.index!;
    if (idx > last) out.push({ t: 'text', v: text.slice(last, idx) });
    out.push({ t: 'mention', id: mention.id, name: mention.name ?? `+${digits}` });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

/** Beyond this length a message is shown without inline formatting (keeps rendering cheap). */
const MAX_FORMAT_CHARS = 20_000;

/**
 * Formatting markers (no URLs inside `text`). Runs in O(n log n): valid closing positions for each
 * marker are precomputed once, and each opener finds its closer by binary search (a naive scan per
 * opener was quadratic — a crafted message could freeze the tab).
 */
function parseMarkers(text: string, mentions: Mention[], depth = 0): WaNode[] {
  if (text.length > MAX_FORMAT_CHARS) return withMentions(text, mentions);
  const closers = new Map<string, number[]>();
  for (let j = 1; j < text.length; j++) {
    const ch = text[j]!;
    if (!MARKERS[ch]) continue;
    if (!isSpace(text[j - 1]) && !isWordChar(text[j + 1])) {
      let list = closers.get(ch);
      if (!list) closers.set(ch, (list = []));
      list.push(j);
    }
  }
  const nextCloser = (ch: string, after: number): number => {
    const list = closers.get(ch);
    if (!list) return -1;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]! <= after) lo = mid + 1;
      else hi = mid;
    }
    return lo < list.length ? list[lo]! : -1;
  };

  const out: WaNode[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(...withMentions(buf, mentions));
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const kind = MARKERS[ch];
    if (kind && depth < 4 && !isWordChar(text[i - 1]) && !isSpace(text[i + 1]) && text[i + 1] !== ch) {
      const close = nextCloser(ch, i + 1);
      if (close > i + 1) {
        flush();
        const inner = text.slice(i + 1, close);
        if (kind === 'code') out.push({ t: 'code', v: inner });
        else out.push({ t: kind, c: parseMarkers(inner, mentions, depth + 1) });
        i = close + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

export function parseInline(text: string, mentions: Mention[] = []): WaNode[] {
  const out: WaNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index!;
    const href = safeHref(m[0]);
    if (!href) continue;
    if (idx > last) out.push(...parseMarkers(text.slice(last, idx), mentions));
    out.push({ t: 'link', href, v: m[0] });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(...parseMarkers(text.slice(last), mentions));
  return out;
}

export function parseWaText(text: string, mentions: Mention[] = []): WaBlock[] {
  const blocks: WaBlock[] = [];
  const parts = text.split(/```([\s\S]+?)```/g);
  parts.forEach((part, idx) => {
    if (idx % 2 === 1) {
      blocks.push({ t: 'pre', v: part.replace(/^\n/, '') });
      return;
    }
    if (!part) return;
    const lines = part.split('\n');
    // A code block eats the newline boundaries around it.
    if (idx > 0 && lines[0] === '') lines.shift();
    if (idx < parts.length - 1 && lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) {
      // Prefix checks only (no backtracking over the rest of the line).
      let m: RegExpExecArray | null;
      if (line.startsWith('>')) blocks.push({ t: 'line', kind: 'quote', c: parseInline(line.slice(line[1] === ' ' ? 2 : 1), mentions) });
      else if ((m = /^[-*][ \t]/.exec(line))) blocks.push({ t: 'line', kind: 'bullet', c: parseInline(line.slice(m[0].length).trimStart(), mentions) });
      else if ((m = /^(\d{1,3})\.[ \t]/.exec(line))) blocks.push({ t: 'line', kind: 'number', marker: m[1]!, c: parseInline(line.slice(m[0].length).trimStart(), mentions) });
      else blocks.push({ t: 'line', kind: 'p', c: parseInline(line, mentions) });
    }
  });
  return blocks;
}

function renderNodes(nodes: WaNode[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return <Fragment key={i}>{n.v}</Fragment>;
      case 'b':
        return <strong key={i}>{renderNodes(n.c)}</strong>;
      case 'i':
        return <em key={i}>{renderNodes(n.c)}</em>;
      case 's':
        return <s key={i}>{renderNodes(n.c)}</s>;
      case 'code':
        return (
          <code key={i} className="wa-code">
            {n.v}
          </code>
        );
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="wa-link">
            {n.v}
          </a>
        );
      case 'mention':
        return (
          <span key={i} className="wa-mention">
            @{n.name}
          </span>
        );
    }
  });
}

function flatten(nodes: WaNode[]): string {
  return nodes
    .map((n) => (n.t === 'text' || n.t === 'code' || n.t === 'link' ? n.v : n.t === 'mention' ? `@${n.name}` : flatten(n.c)))
    .join('');
}

/** Plain one-line text without WhatsApp formatting markers (for previews and quotes). */
export function stripWaFormatting(text: string): string {
  return parseWaText(text)
    .map((b) => (b.t === 'pre' ? b.v.trim() : flatten(b.c)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|\s)+$/u;

export function jumboEmoji(text: string): boolean {
  if (!EMOJI_ONLY.test(text)) return false;
  const count = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.trim())].length;
  return count > 0 && count <= 3;
}

export function WaText({ text, mentions = [] }: { text: string; mentions?: Mention[] }) {
  const blocks = parseWaText(text, mentions);
  return (
    <span className={jumboEmoji(text) ? 'wa-text jumbo' : 'wa-text'}>
      {blocks.map((b, i) => {
        if (b.t === 'pre') {
          return (
            <pre key={i} className="wa-pre">
              {b.v}
            </pre>
          );
        }
        const content = renderNodes(b.c);
        const nl = i < blocks.length - 1 ? '\n' : null;
        switch (b.kind) {
          case 'quote':
            return (
              <span key={i} className="wa-quote">
                {content}
                {nl}
              </span>
            );
          case 'bullet':
            return (
              <span key={i} className="wa-li">
                • {content}
                {nl}
              </span>
            );
          case 'number':
            return (
              <span key={i} className="wa-li">
                {b.marker}. {content}
                {nl}
              </span>
            );
          default:
            return (
              <Fragment key={i}>
                {content}
                {nl}
              </Fragment>
            );
        }
      })}
    </span>
  );
}
