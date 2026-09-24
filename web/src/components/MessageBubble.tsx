import { memo, useEffect, useState } from 'react';
import type { Message, MessageEdit, MessageType } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { colorFor, dayKey, formatDateTime, formatDuration, formatTime } from '../lib/format';
import { WaText, stripWaFormatting } from '../lib/waText';
import { Icon } from './Icon';
import { MessageMedia } from './MessageMedia';
import { ErrorNote, Modal, Spinner } from './ui';

const QUOTE_LABEL: Partial<Record<MessageType, string>> = {
  image: '📷 Photo',
  video: '🎥 Video',
  gif: 'GIF',
  audio: '🎵 Audio',
  ptt: '🎤 Voice message',
  document: '📄 Document',
  sticker: 'Sticker',
  location: '📍 Location',
  vcard: '👤 Contact',
  poll: '📊 Poll',
};

function Ticks({ ack }: { ack: number | null }) {
  if (ack === null || ack < 0) return null;
  if (ack === 0) return <Icon name="clock" size={14} className="tick" title="Pending" />;
  if (ack === 1) return <Icon name="check" size={16} className="tick" title="Sent" />;
  return <Icon name="checks" size={16} className={ack >= 3 ? 'tick read' : 'tick'} title={ack >= 3 ? 'Read' : 'Delivered'} />;
}

function EditHistory({ msg, onClose }: { msg: Message; onClose: () => void }) {
  const [edits, setEdits] = useState<MessageEdit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.edits(msg.id).then(setEdits, (e) => setError(errorMessage(e)));
  }, [msg.id]);
  return (
    <Modal title="Edit history" onClose={onClose}>
      <ErrorNote error={error} />
      {!edits && !error ? <Spinner /> : null}
      <ol className="edit-list">
        {(edits ?? []).map((e, i) => (
          <li key={i}>
            <div className="muted small">Earlier version · captured {formatDateTime(e.capturedAt)}</div>
            <div className="edit-body">{e.body ? <WaText text={e.body} /> : <i className="muted">(no text)</i>}</div>
          </li>
        ))}
        <li>
          <div className="muted small">Current version{msg.editedAt ? ` · edited ${formatDateTime(msg.editedAt)}` : ''}</div>
          <div className="edit-body">{msg.text ? <WaText text={msg.text} mentions={msg.mentions} /> : <i className="muted">(no text)</i>}</div>
        </li>
      </ol>
      {edits && edits.length === 0 ? <p className="muted small">The previous text was not captured (the edit happened before this message was logged).</p> : null}
    </Modal>
  );
}

function Special({ msg }: { msg: Message }) {
  if (msg.location) {
    const { latitude, longitude, name, address } = msg.location;
    const osm = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
    return (
      <a className="card-link" href={osm} target="_blank" rel="noopener noreferrer nofollow">
        <Icon name="pin" size={28} />
        <span>
          <b>{name ?? (msg.type === 'live_location' ? 'Live location' : 'Location')}</b>
          {address ? <span className="block muted small">{address}</span> : null}
          <span className="block muted small">
            {latitude.toFixed(5)}, {longitude.toFixed(5)} · open map
          </span>
        </span>
      </a>
    );
  }
  if (msg.vcards?.length) {
    return (
      <div className="card-list">
        {msg.vcards.map((v, i) => (
          <details key={i} className="vcard">
            <summary>
              <Icon name="user" size={22} /> {v.displayName ?? 'Contact'}
            </summary>
            <pre className="wa-pre small">{v.vcard}</pre>
          </details>
        ))}
      </div>
    );
  }
  if (msg.poll) {
    return (
      <div className="poll">
        <div className="poll-q">
          <Icon name="poll" size={18} /> <b>{msg.poll.question}</b>
        </div>
        <ul>
          {msg.poll.options.map((o, i) => (
            <li key={i}>
              <span className="poll-dot" /> {o.name}
            </li>
          ))}
        </ul>
        <div className="muted small">{msg.poll.multiSelect ? 'Select one or more' : 'Select one'}</div>
      </div>
    );
  }
  return null;
}

export interface BubbleProps {
  msg: Message;
  isGroup: boolean;
  showSender: boolean;
  highlighted: boolean;
  onJump: (messageId: string) => void;
}

function BubbleImpl({ msg, isGroup, showSender, highlighted, onJump }: BubbleProps) {
  const [showEdits, setShowEdits] = useState(false);

  if (msg.type === 'system' || msg.type === 'call_log') {
    const text =
      msg.type === 'call_log'
        ? `${msg.call?.video ? '📹 Video' : '📞 Voice'} call${msg.call?.outcome ? ` · ${msg.call.outcome}` : ''}${msg.call?.durationSec ? ` · ${formatDuration(msg.call.durationSec)}` : ''}`
        : msg.text ?? 'System message';
    return (
      <div className="system-row" id={`m-${msg.id}`}>
        <span className="system-pill">
          {text} · {formatTime(msg.ts)}
        </span>
      </div>
    );
  }

  const deleted = msg.deletedAt !== null;
  const neverCaptured = msg.type === 'revoked';
  const classes = ['bubble', msg.fromMe ? 'out' : 'in', deleted ? 'deleted' : '', highlighted ? 'highlight' : '', msg.type === 'sticker' && msg.media?.url ? 'sticker' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={msg.fromMe ? 'msg-row out' : 'msg-row in'} id={`m-${msg.id}`}>
      <div className={classes}>
        {deleted ? (
          <div className="deleted-banner" title={`Deleted ${formatDateTime(msg.deletedAt!)}`}>
            <Icon name="ban" size={14} /> {msg.deletedBy === 'admin' ? 'Deleted by a group admin' : 'Deleted for everyone'} ·{' '}
            {dayKey(msg.deletedAt!) === dayKey(msg.ts) ? formatTime(msg.deletedAt!) : formatDateTime(msg.deletedAt!)}
            {neverCaptured ? '' : ' · logged copy'}
          </div>
        ) : msg.deletedForMeAt ? (
          <div className="deleted-banner soft">
            <Icon name="ban" size={14} /> Deleted on your devices · logged copy
          </div>
        ) : null}
        {isGroup && !msg.fromMe && showSender ? (
          <div className="sender" style={{ color: colorFor(msg.senderId ?? msg.senderName ?? '') }}>
            {msg.senderName ?? 'Unknown'}
          </div>
        ) : null}
        {msg.isStatus ? <div className="muted small">Status update</div> : null}
        {msg.forwarded ? (
          <div className="forwarded">
            <Icon name="forward" size={14} /> Forwarded
          </div>
        ) : null}
        {msg.quoted ? (
          <button className="quote" onClick={() => msg.quoted?.id && onJump(msg.quoted.id)} disabled={!msg.quoted.id}>
            <span className="quote-sender">{msg.quoted.fromMe ? 'You' : msg.quoted.senderName ?? 'Unknown'}</span>
            <span className="quote-text">{msg.quoted.text ? stripWaFormatting(msg.quoted.text) : QUOTE_LABEL[msg.quoted.type] ?? 'Message'}</span>
          </button>
        ) : null}
        {neverCaptured ? (
          <div className="muted italic">
            <Icon name="ban" size={14} /> This message was deleted before it could be logged.
          </div>
        ) : msg.type === 'ciphertext' ? (
          <div className="muted italic">
            <Icon name="clock" size={14} /> Waiting for this message…
          </div>
        ) : (
          <>
            <MessageMedia msg={msg} />
            <Special msg={msg} />
            {msg.text && msg.type !== 'poll' ? (
              <div className="text">
                <WaText text={msg.text} mentions={msg.mentions} />
              </div>
            ) : null}
            {msg.type === 'unknown' && !msg.text ? <div className="muted italic small">Unsupported message type</div> : null}
          </>
        )}
        <div className="meta">
          {msg.edited ? (
            <button className="link-btn edited" onClick={() => setShowEdits(true)} title="Show edit history">
              <Icon name="edit" size={12} /> Edited{msg.editCount > 1 ? ` ×${msg.editCount}` : ''}
            </button>
          ) : null}
          <span title={formatDateTime(msg.ts)}>{formatTime(msg.ts)}</span>
          {msg.fromMe ? <Ticks ack={msg.ack} /> : null}
        </div>
      </div>
      {msg.reactions.length ? (
        <div className="reactions" title={msg.reactions.map((r) => `${r.senderName ?? r.senderId}: ${r.emoji}`).join('\n')}>
          {[...new Set(msg.reactions.map((r) => r.emoji))].slice(0, 4).join('')}
          {msg.reactions.length > 1 ? <span className="small"> {msg.reactions.length}</span> : null}
        </div>
      ) : null}
      {showEdits ? <EditHistory msg={msg} onClose={() => setShowEdits(false)} /> : null}
    </div>
  );
}

export const MessageBubble = memo(BubbleImpl);
