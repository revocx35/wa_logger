import { describe, expect, it } from 'vitest';
import { chatKind, jid, looksLikeBase64Blob, mapMessage, phoneOf, renderSystemText, type RawMsg } from './mapper.js';

const THUMB = '/9j/' + 'A'.repeat(400);

function id(fromMe: boolean, remote: string, msgId: string, participant?: string) {
  return {
    fromMe,
    remote,
    id: msgId,
    participant,
    _serialized: `${fromMe}_${remote}_${msgId}${participant ? `_${participant}` : ''}`,
  };
}

const base = (over: RawMsg): RawMsg => ({ t: 1_700_000_000, ack: 1, ...over });

describe('helpers', () => {
  it('normalizes jids and chat kinds', () => {
    expect(jid('a@c.us')).toBe('a@c.us');
    expect(jid({ _serialized: 'b@c.us' })).toBe('b@c.us');
    expect(jid(null)).toBeNull();
    expect(chatKind('123@g.us')).toBe('group');
    expect(chatKind('status@broadcast')).toBe('status');
    expect(chatKind('1@broadcast')).toBe('broadcast');
    expect(chatKind('1@newsletter')).toBe('newsletter');
    expect(chatKind('905551112233@c.us')).toBe('user');
    expect(chatKind('12345@lid')).toBe('user');
    expect(phoneOf('905551112233@c.us')).toBe('+905551112233');
    expect(phoneOf('12345@lid')).toBeNull();
    expect(looksLikeBase64Blob(THUMB)).toBe(true);
    expect(looksLikeBase64Blob('hello world')).toBe(false);
  });
});

describe('mapMessage', () => {
  it('maps an incoming 1:1 text message', () => {
    const m = mapMessage(
      base({ id: id(false, '905551112233@c.us', 'ABC'), type: 'chat', body: 'hi *there*', from: '905551112233@c.us', to: 'me@c.us', notifyName: 'Ali' }),
    );
    expect(m).toMatchObject({
      id: 'false_905551112233@c.us_ABC',
      chatId: '905551112233@c.us',
      senderId: '905551112233@c.us',
      fromMe: false,
      ts: 1_700_000_000_000,
      type: 'chat',
      body: 'hi *there*',
      downloadable: false,
      skip: false,
      notifyName: 'Ali',
    });
  });

  it('maps an outgoing message with no sender id', () => {
    const m = mapMessage(base({ id: id(true, '905551112233@c.us', 'X1'), type: 'chat', body: 'yo', from: 'me@c.us', to: '905551112233@c.us' }));
    expect(m.fromMe).toBe(true);
    expect(m.senderId).toBeNull();
    expect(m.chatId).toBe('905551112233@c.us');
  });

  it('maps group messages to the author', () => {
    const m = mapMessage(
      base({ id: id(false, '120363@g.us', 'G1', '905550000000@c.us'), type: 'chat', body: 'hello group', from: '120363@g.us', author: '905550000000@c.us' }),
    );
    expect(m.chatId).toBe('120363@g.us');
    expect(m.senderId).toBe('905550000000@c.us');
  });

  it('maps image with caption, thumbnail and media facts', () => {
    const m = mapMessage(
      base({
        id: id(false, 'a@c.us', 'IMG'),
        type: 'image',
        body: THUMB,
        caption: 'look',
        mimetype: 'image/jpeg',
        size: 12345,
        width: 800,
        height: 600,
        directPath: '/v/t62/abc',
        from: 'a@c.us',
      }),
    );
    expect(m.type).toBe('image');
    expect(m.body).toBe('look');
    expect(m.thumbBase64).toBe(THUMB);
    expect(m.downloadable).toBe(true);
    expect(m.media).toEqual({ mime: 'image/jpeg', filename: null, size: 12345, width: 800, height: 600, durationSec: null });
  });

  it('never treats a thumbnail as text', () => {
    const m = mapMessage(base({ id: id(false, 'a@c.us', 'V'), type: 'video', body: THUMB, directPath: '/x', from: 'a@c.us' }));
    expect(m.body).toBeNull();
  });

  it('maps gifs, voice notes, documents, stickers', () => {
    expect(mapMessage(base({ id: id(false, 'a@c.us', '1'), type: 'video', isGif: true, directPath: '/x' })).type).toBe('gif');
    expect(mapMessage(base({ id: id(false, 'a@c.us', '2'), type: 'ptt', directPath: '/x', duration: '7' })).media?.durationSec).toBe(7);
    const d = mapMessage(base({ id: id(false, 'a@c.us', '3'), type: 'document', filename: 'report.pdf', mimetype: 'application/pdf', directPath: '/x' }));
    expect(d.type).toBe('document');
    expect(d.media?.filename).toBe('report.pdf');
    expect(mapMessage(base({ id: id(false, 'a@c.us', '4'), type: 'sticker', directPath: '/x' })).type).toBe('sticker');
  });

  it('marks view-once media as not downloadable and drops the thumbnail', () => {
    const m = mapMessage(base({ id: id(false, 'a@c.us', 'VO'), type: 'image', isViewOnce: true, body: THUMB, directPath: '/x' }));
    expect(m.type).toBe('view_once');
    expect(m.isViewOnce).toBe(true);
    expect(m.downloadable).toBe(false);
    expect(m.thumbBase64).toBeNull();
  });

  it('maps quoted replies', () => {
    const m = mapMessage(
      base({
        id: id(false, 'a@c.us', 'Q'),
        type: 'chat',
        body: 'reply',
        quotedMsg: { type: 'image', body: THUMB, caption: 'orig caption' },
        quotedStanzaID: 'ORIG1',
        quotedParticipant: { _serialized: 'a@c.us' },
      }),
    );
    expect(m.meta?.quoted).toEqual({ stanzaId: 'ORIG1', participant: 'a@c.us', type: 'image', text: 'orig caption' });
    expect(m.quotedStanzaId).toBe('ORIG1');
  });

  it('maps location, live location, vcards, polls, calls', () => {
    const loc = mapMessage(base({ id: id(false, 'a@c.us', 'L'), type: 'location', lat: 41.0, lng: 29.0, loc: 'Cafe\nMain St 1', body: THUMB }));
    expect(loc.type).toBe('location');
    expect(loc.meta?.location).toEqual({ latitude: 41, longitude: 29, name: 'Cafe', address: 'Main St 1', url: null });
    expect(loc.body).toBeNull();
    expect(mapMessage(base({ id: id(false, 'a@c.us', 'LL'), type: 'location', isLive: true, lat: 1, lng: 2 })).type).toBe('live_location');
    const vc = mapMessage(base({ id: id(false, 'a@c.us', 'VC'), type: 'vcard', body: 'BEGIN:VCARD\nFN:Jane Doe\nEND:VCARD' }));
    expect(vc.meta?.vcards).toEqual([{ displayName: 'Jane Doe', vcard: 'BEGIN:VCARD\nFN:Jane Doe\nEND:VCARD' }]);
    expect(vc.body).toBeNull();
    const mv = mapMessage(base({ id: id(false, 'a@c.us', 'MV'), type: 'multi_vcard', vcardList: [{ displayName: 'A', vcard: 'x' }, { vcard: 'FN:B' }] }));
    expect(mv.meta?.vcards?.map((v) => v.displayName)).toEqual(['A', 'B']);
    const poll = mapMessage(base({ id: id(false, 'a@c.us', 'P'), type: 'poll_creation', pollName: 'Lunch?', pollOptions: [{ name: 'Yes' }, { name: 'No' }], pollSelectableOptionsCount: 0 }));
    expect(poll.type).toBe('poll');
    expect(poll.body).toBe('Lunch?');
    expect(poll.meta?.poll).toEqual({ question: 'Lunch?', options: [{ name: 'Yes', votes: null }, { name: 'No', votes: null }], multiSelect: true });
    const call = mapMessage(base({ id: id(false, 'a@c.us', 'C'), type: 'call_log', isVideoCall: true, callOutcome: 'missed' }));
    expect(call.type).toBe('call_log');
    expect(call.meta?.call).toEqual({ video: true, outcome: 'missed', durationSec: null });
  });

  it('maps revoked messages', () => {
    const m = mapMessage(base({ id: id(false, 'a@c.us', 'R'), type: 'revoked', subtype: 'sender' }));
    expect(m.revoked).toBe(true);
    expect(m.revokedBy).toBe('sender');
    const a = mapMessage(base({ id: id(false, 'g@g.us', 'R2'), type: 'revoked', subtype: 'admin' }));
    expect(a.revokedBy).toBe('admin');
  });

  it('extracts edit keys', () => {
    const m = mapMessage(
      base({ id: id(false, 'a@c.us', 'E'), type: 'chat', body: 'v2', latestEditMsgKey: { _serialized: 'false_a@c.us_EDIT1' }, latestEditSenderTimestampMs: 1_700_000_100_000 }),
    );
    expect(m.editKey).toBe('false_a@c.us_EDIT1');
    expect(m.editTs).toBe(1_700_000_100_000);
  });

  it('maps system notifications with structured info and skips protocol noise', () => {
    const s = mapMessage(base({ id: id(false, 'g@g.us', 'S'), type: 'gp2', subtype: 'add', author: 'x@c.us', recipients: ['y@c.us', { _serialized: 'z@c.us' }] }));
    expect(s.type).toBe('system');
    expect(s.meta?.system).toMatchObject({ subtype: 'add', author: 'x@c.us', recipients: ['y@c.us', 'z@c.us'] });
    for (const t of ['protocol', 'e2e_notification', 'reaction', 'debug']) {
      expect(mapMessage(base({ id: id(false, 'a@c.us', t), type: t })).skip).toBe(true);
    }
  });

  it('keeps unknown types with their raw type and text', () => {
    const m = mapMessage(base({ id: id(false, 'a@c.us', 'U'), type: 'interactive', body: 'Pick one' }));
    expect(m.type).toBe('unknown');
    expect(m.body).toBe('Pick one');
    expect(m.meta?.rawType).toBe('interactive');
  });

  it('marks status updates', () => {
    const m = mapMessage(base({ id: id(false, 'status@broadcast', 'ST', 'p@c.us'), type: 'image', author: 'p@c.us', isStatusV3: true, directPath: '/x' }));
    expect(m.isStatus).toBe(true);
    expect(m.chatId).toBe('status@broadcast');
    expect(m.senderId).toBe('p@c.us');
  });
});

describe('renderSystemText', () => {
  const names: Record<string, string> = { 'x@c.us': 'Xena', 'y@c.us': 'Yusuf' };
  const nameOf = (id: string | null) => (id ? (names[id] ?? id) : 'Someone');
  it('renders common group events', () => {
    expect(renderSystemText({ subtype: 'add', author: 'x@c.us', recipients: ['y@c.us'], text: null }, nameOf)).toBe('Xena added Yusuf');
    expect(renderSystemText({ subtype: 'leave', author: null, recipients: ['y@c.us'], text: null }, nameOf)).toBe('Yusuf left');
    expect(renderSystemText({ subtype: 'subject', author: 'x@c.us', recipients: [], text: 'Family' }, nameOf)).toBe('Xena changed the group name to "Family"');
    expect(renderSystemText({ subtype: 'weird', author: null, recipients: [], text: null }, nameOf, 'gp2')).toBe('System notification (gp2/weird)');
  });
});
