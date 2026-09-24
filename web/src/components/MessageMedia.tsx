import { useState } from 'react';
import type { Message } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { formatBytes, formatDuration } from '../lib/format';
import { Icon } from './Icon';
import { Modal, Spinner } from './ui';

const RETRYABLE = new Set(['failed', 'too_large', 'skipped', 'unavailable']);

const STATUS_TEXT: Record<string, string> = {
  pending: 'Downloading…',
  failed: 'Download failed',
  too_large: 'Larger than the size limit — not downloaded',
  skipped: 'History media not downloaded',
  unavailable: 'No longer available on WhatsApp',
  view_once: 'View-once media is not logged',
  none: '',
  downloaded: '',
};

function MediaPlaceholder({ msg, label }: { msg: Message; label: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const media = msg.media!;
  const retry = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.retryMedia(msg.id);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="media-placeholder">
      {media.thumbDataUrl ? <img src={media.thumbDataUrl} alt="" className="media-thumb blurred" /> : null}
      <div className="media-placeholder-info">
        {media.status === 'pending' ? <Spinner size={18} /> : <Icon name={media.status === 'view_once' ? 'eye' : 'warning'} size={18} />}
        <span>
          {label}
          {STATUS_TEXT[media.status] ? ` · ${STATUS_TEXT[media.status]}` : ''}
          {media.size ? ` · ${formatBytes(media.size)}` : ''}
        </span>
        {RETRYABLE.has(media.status) && !msg.deletedAt ? (
          <button className="btn tiny" onClick={retry} disabled={busy}>
            {busy ? <Spinner size={14} /> : 'Retry'}
          </button>
        ) : null}
      </div>
      {err ? <span className="error-note small">{err}</span> : null}
    </div>
  );
}

function Lightbox({ msg, onClose }: { msg: Message; onClose: () => void }) {
  const m = msg.media!;
  return (
    <Modal title={m.filename ?? (msg.type === 'image' ? 'Photo' : 'Video')} onClose={onClose} wide>
      <div className="lightbox">
        {msg.type === 'image' || msg.type === 'sticker' ? (
          <img src={m.url!} alt={msg.text ?? ''} />
        ) : (
          <video src={m.url!} controls autoPlay playsInline />
        )}
      </div>
      <div className="row gap end">
        <a className="btn" href={`${m.url}?download=1`} download>
          <Icon name="download" size={18} /> Download
        </a>
      </div>
    </Modal>
  );
}

export function MessageMedia({ msg }: { msg: Message }) {
  const [open, setOpen] = useState(false);
  const m = msg.media;
  if (!m) return null;

  if (msg.type === 'view_once' || m.status === 'view_once') {
    return (
      <div className="media-placeholder view-once">
        <div className="media-placeholder-info">
          <Icon name="eye" size={18} /> <span>View-once media · not logged by design</span>
        </div>
      </div>
    );
  }

  const aspect = m.width && m.height ? `${m.width} / ${m.height}` : undefined;

  if (!m.url) {
    const label =
      msg.type === 'image' ? 'Photo' : msg.type === 'video' || msg.type === 'gif' ? 'Video' : msg.type === 'ptt' ? 'Voice message' : msg.type === 'audio' ? 'Audio' : msg.type === 'sticker' ? 'Sticker' : m.filename ?? 'Document';
    return <MediaPlaceholder msg={msg} label={label} />;
  }

  switch (msg.type) {
    case 'image':
      return (
        <>
          <button className="media-btn" onClick={() => setOpen(true)} aria-label="Open photo">
            <img className="media-img" src={m.url} alt="" loading="lazy" decoding="async" style={aspect ? { aspectRatio: aspect } : undefined} />
          </button>
          {open ? <Lightbox msg={msg} onClose={() => setOpen(false)} /> : null}
        </>
      );
    case 'sticker':
      return <img className="media-sticker" src={m.url} alt="Sticker" loading="lazy" decoding="async" />;
    case 'gif':
      return <video className="media-video" src={m.url} autoPlay loop muted playsInline preload="metadata" style={aspect ? { aspectRatio: aspect } : undefined} />;
    case 'video':
      return (
        <>
          <video
            className="media-video"
            src={m.url}
            controls
            preload="metadata"
            playsInline
            poster={m.thumbDataUrl ?? undefined}
            style={aspect ? { aspectRatio: aspect } : undefined}
          />
          <div className="media-meta muted small">
            {formatDuration(m.durationSec)} {m.size ? `· ${formatBytes(m.size)}` : ''}{' '}
            <button className="link-btn" onClick={() => setOpen(true)}>
              enlarge
            </button>
          </div>
          {open ? <Lightbox msg={msg} onClose={() => setOpen(false)} /> : null}
        </>
      );
    case 'audio':
    case 'ptt':
      return (
        <div className="media-audio">
          <Icon name={msg.type === 'ptt' ? 'mic' : 'file'} size={20} />
          <audio src={m.url} controls preload="none" />
        </div>
      );
    default:
      return (
        <a className="media-doc" href={`${m.url}?download=1`} download>
          <Icon name="file" size={30} />
          <span className="media-doc-info">
            <span className="media-doc-name">{m.filename ?? 'Document'}</span>
            <span className="muted small">
              {(m.mime ?? '').split('/').pop()?.toUpperCase()} {m.size ? `· ${formatBytes(m.size)}` : ''}
            </span>
          </span>
          <Icon name="download" size={20} />
        </a>
      );
  }
}
