import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WaText, jumboEmoji, parseInline, parseWaText, safeHref } from './waText';

const html = (text: string, mentions: { id: string; name: string | null }[] = []) =>
  renderToStaticMarkup(<WaText text={text} mentions={mentions} />);

describe('parseInline', () => {
  it('parses bold, italic, strike, code and nesting', () => {
    expect(parseInline('*bold*')).toEqual([{ t: 'b', c: [{ t: 'text', v: 'bold' }] }]);
    expect(parseInline('a _it_ b')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'i', c: [{ t: 'text', v: 'it' }] },
      { t: 'text', v: ' b' },
    ]);
    expect(parseInline('~gone~')[0]).toEqual({ t: 's', c: [{ t: 'text', v: 'gone' }] });
    expect(parseInline('`x = *y*`')[0]).toEqual({ t: 'code', v: 'x = *y*' });
    expect(parseInline('*bold _and italic_*')[0]).toEqual({
      t: 'b',
      c: [{ t: 'text', v: 'bold ' }, { t: 'i', c: [{ t: 'text', v: 'and italic' }] }],
    });
  });

  it('does not format inside words or with spaces next to markers', () => {
    expect(parseInline('snake_case_name')).toEqual([{ t: 'text', v: 'snake_case_name' }]);
    expect(parseInline('2 * 3 * 4')).toEqual([{ t: 'text', v: '2 * 3 * 4' }]);
    expect(parseInline('* not bold*')).toEqual([{ t: 'text', v: '* not bold*' }]);
    expect(parseInline('**')).toEqual([{ t: 'text', v: '**' }]);
  });

  it('links http(s) URLs without breaking underscores in them', () => {
    const nodes = parseInline('see https://example.com/a_b_c?x=1. ok');
    expect(nodes).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', href: 'https://example.com/a_b_c?x=1', v: 'https://example.com/a_b_c?x=1' },
      { t: 'text', v: '. ok' },
    ]);
    expect(parseInline('www.example.org')[0]).toMatchObject({ t: 'link', href: 'https://www.example.org/' });
  });

  it('resolves mentions', () => {
    expect(parseInline('hi @905551112233!', [{ id: '905551112233@c.us', name: 'Ali' }])).toEqual([
      { t: 'text', v: 'hi ' },
      { t: 'mention', id: '905551112233@c.us', name: 'Ali' },
      { t: 'text', v: '!' },
    ]);
  });
});

describe('parseWaText', () => {
  it('handles code blocks, quotes and lists', () => {
    const blocks = parseWaText('> quoted\n- item\n1. first\n```\nconst a = *1*;\n```\nend');
    expect(blocks.map((b) => (b.t === 'pre' ? 'pre' : b.kind))).toEqual(['quote', 'bullet', 'number', 'pre', 'p']);
    expect(blocks[3]).toEqual({ t: 'pre', v: 'const a = *1*;\n' });
  });
});

describe('WaText rendering is injection-safe', () => {
  it('escapes HTML', () => {
    const out = html('<img src=x onerror=alert(1)> <script>alert(2)</script> *<b>x</b>*');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
  });

  it('never links dangerous schemes', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(html('javascript:alert(1)')).not.toContain('href');
    expect(html('data:text/html,<script>alert(1)</script>')).not.toContain('href');
    const out = html('https://ok.example/"onmouseover="alert(1)');
    expect(out).toContain('href="https://ok.example/"');
    expect(out).not.toContain('onmouseover="alert');
  });

  it('adds safe link attributes', () => {
    expect(html('https://example.com')).toContain('rel="noopener noreferrer nofollow"');
  });
});

describe('jumboEmoji', () => {
  it('detects short emoji-only messages', () => {
    expect(jumboEmoji('😂')).toBe(true);
    expect(jumboEmoji('👍🏽👍🏽')).toBe(true);
    expect(jumboEmoji('😂😂😂😂')).toBe(false);
    expect(jumboEmoji('ok 😂')).toBe(false);
    expect(jumboEmoji('123')).toBe(false);
  });
});

import { stripWaFormatting } from './waText';

describe('stripWaFormatting', () => {
  it('removes markers for previews', () => {
    expect(stripWaFormatting('*Hi* _there_ ~x~')).toBe('Hi there x');
    expect(stripWaFormatting('```\nconst a = 1;\n```\n> quoted\n- item')).toBe('const a = 1; quoted item');
  });
});
