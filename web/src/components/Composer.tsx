import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import type { Message } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { formatDuration } from '../lib/format';
import { webmToOgg } from '../lib/ogg';
import { stripWaFormatting } from '../lib/waText';
import { Icon } from './Icon';
import { Spinner } from './ui';

const MAX_FILE = 64 * 1024 * 1024;

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** One-line description of a message for the reply/edit bar. */
export function previewOf(m: Message): string {
  if (m.text) return stripWaFormatting(m.text).slice(0, 120);
  const labels: Partial<Record<Message['type'], string>> = { image: 'Photo', video: 'Video', gif: 'GIF', ptt: 'Voice message', audio: 'Audio', document: 'Document', sticker: 'Sticker' };
  return labels[m.type] ?? 'Message';
}

interface Recording {
  rec: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  started: number;
}

/**
 * Message composer: text (Enter sends, Shift+Enter is a new line), replies, edits of own messages, one file
 * at a time (photo/video/document, the text becomes its caption) and voice notes. Sending goes through the
 * linked WhatsApp account; what was sent shows up in the chat through the live updates like any other message.
 */
export function Composer({
  chatId,
  replyTo,
  editing,
  onDone,
  disabledReason,
}: {
  chatId: string;
  replyTo: Message | null;
  editing: Message | null;
  /** Clears the reply/edit state after sending or cancelling. */
  onDone: () => void;
  /** Set when sending is not possible right now (e.g. WhatsApp is not connected). */
  disabledReason: string | null;
}) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [asDocument, setAsDocument] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  // Switching chats discards drafts; starting an edit loads the message text.
  useEffect(() => {
    setText('');
    setFile(null);
    setError(null);
  }, [chatId]);
  useEffect(() => {
    if (editing) setText(editing.text ?? '');
    if (editing || replyTo) input.current?.focus();
  }, [editing, replyTo]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);
  useEffect(() => {
    if (!recording) return;
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - recording.started) / 1000)), 250);
    return () => window.clearInterval(t);
  }, [recording]);
  // Never leave the microphone on when the composer goes away.
  useEffect(() => () => recording?.stream.getTracks().forEach((t) => t.stop()), [recording]);

  const disabled = !!disabledReason || busy;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    if (disabled) return;
    const body = text;
    if (editing) {
      if (!body.trim() || body === editing.text) return onDone();
      return void run(async () => {
        await api.editMessage(editing.id, body);
        setText('');
        onDone();
      });
    }
    if (file) {
      const f = file;
      return void run(async () => {
        const up = await api.upload(f, f.name);
        const kind = asDocument ? 'document' : 'auto';
        await api.sendMedia(chatId, up.uploadId, kind, body.trim() ? body : null, replyTo?.id ?? null);
        setFile(null);
        setAsDocument(false);
        setText('');
        onDone();
      });
    }
    if (!body.trim()) return;
    void run(async () => {
      await api.sendText(chatId, body, replyTo?.id ?? null);
      setText('');
      onDone();
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && (editing || replyTo)) {
      if (editing) setText('');
      onDone();
    }
  };

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (!f) return;
    if (f.size > MAX_FILE) {
      setError('The file is too large (64 MB at most).');
      return;
    }
    setError(null);
    setFile(f);
    // Anything that isn't a photo or video goes as a file.
    setAsDocument(!/^(image\/(jpeg|png|webp|gif)|video\/(mp4|3gpp|quicktime))$/.test(f.type));
    input.current?.focus();
  };

  const startRecording = async () => {
    setError(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice messages need HTTPS and a browser that can record audio.');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      setError('Microphone access was refused.');
      return;
    }
    const type = MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus' : 'audio/webm;codecs=opus';
    const rec = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 32_000 });
    const r: Recording = { rec, stream, chunks: [], started: Date.now() };
    rec.ondataavailable = (ev) => ev.data.size && r.chunks.push(ev.data);
    rec.start(1000);
    setElapsed(0);
    setRecording(r);
  };

  const stopRecording = (sendIt: boolean) => {
    const r = recording;
    if (!r) return;
    setRecording(null);
    r.rec.onstop = () => {
      r.stream.getTracks().forEach((t) => t.stop());
      if (!sendIt) return;
      void run(async () => {
        const raw = new Blob(r.chunks, { type: r.rec.mimeType });
        if (Date.now() - r.started < 1000 || raw.size === 0) throw new Error('Too short');
        const ogg = r.rec.mimeType.startsWith('audio/ogg')
          ? raw
          : new Blob([webmToOgg(new Uint8Array(await raw.arrayBuffer())) as BlobPart], { type: 'audio/ogg; codecs=opus' });
        const up = await api.upload(new Blob([ogg], { type: 'audio/ogg; codecs=opus' }), 'voice.ogg');
        await api.sendMedia(chatId, up.uploadId, 'voice', null, replyTo?.id ?? null);
        onDone();
      });
    };
    r.rec.stop();
  };

  const bar = editing ? (
    <div className="compose-bar">
      <Icon name="edit" size={16} />
      <span className="compose-bar-text">
        <b>Edit message</b> {previewOf(editing)}
      </span>
      <button className="icon-btn small" onClick={() => (setText(''), onDone())} aria-label="Cancel editing">
        <Icon name="close" size={16} />
      </button>
    </div>
  ) : replyTo ? (
    <div className="compose-bar">
      <Icon name="reply" size={16} />
      <span className="compose-bar-text">
        <b>{replyTo.fromMe ? 'You' : replyTo.senderName ?? 'Reply'}</b> {previewOf(replyTo)}
      </span>
      <button className="icon-btn small" onClick={onDone} aria-label="Cancel reply">
        <Icon name="close" size={16} />
      </button>
    </div>
  ) : null;

  return (
    <footer className="composer">
      {bar}
      {file ? (
        <div className="compose-bar">
          <Icon name={file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file'} size={18} />
          <span className="compose-bar-text">
            <b>{file.name}</b> {formatSize(file.size)} · the text below becomes the caption
          </span>
          {file.type.startsWith('image/') || file.type.startsWith('video/') ? (
            <label className="check small">
              <input type="checkbox" checked={asDocument} onChange={(e) => setAsDocument(e.target.checked)} /> Send as file
            </label>
          ) : null}
          <button className="icon-btn small" onClick={() => setFile(null)} aria-label="Remove attachment">
            <Icon name="close" size={16} />
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="compose-error" role="alert">
          {error}
        </div>
      ) : null}
      {disabledReason ? <div className="compose-error muted">{disabledReason}</div> : null}
      {recording ? (
        <div className="compose-row recording">
          <button className="icon-btn" onClick={() => stopRecording(false)} aria-label="Discard recording">
            <Icon name="deleted" />
          </button>
          <span className="rec-dot" aria-hidden="true" />
          <span className="rec-time">{formatDuration(elapsed)}</span>
          <span className="grow muted small">Recording a voice message…</span>
          <button className="icon-btn send" onClick={() => stopRecording(true)} aria-label="Send voice message">
            <Icon name="send" />
          </button>
        </div>
      ) : (
        <div className="compose-row">
          {!editing ? (
            <>
              <button className="icon-btn" onClick={() => picker.current?.click()} disabled={disabled} aria-label="Attach a file" title="Attach a photo, video or file">
                <Icon name="attach" />
              </button>
              <input ref={picker} type="file" hidden onChange={pick} />
            </>
          ) : null}
          <textarea
            ref={input}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={editing ? 'Edit message' : file ? 'Add a caption' : 'Type a message'}
            aria-label="Message"
            maxLength={65_536}
            disabled={!!disabledReason}
          />
          {busy ? (
            <span className="icon-btn" aria-label="Sending">
              <Spinner size={18} />
            </span>
          ) : text.trim() || file || editing ? (
            <button className="icon-btn send" onClick={send} disabled={disabled} aria-label={editing ? 'Save edit' : 'Send'}>
              <Icon name={editing ? 'check' : 'send'} />
            </button>
          ) : (
            <button className="icon-btn" onClick={() => void startRecording()} disabled={disabled} aria-label="Record a voice message" title="Record a voice message">
              <Icon name="mic" />
            </button>
          )}
        </div>
      )}
    </footer>
  );
}
