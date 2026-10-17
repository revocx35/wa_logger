import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CallEndReason, CallInfo } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { eventHub, useServerEvents } from '../api/events';
import { CallAudio, Tone, type CallAudioEnd } from '../lib/callAudio';
import { useAppState } from '../state/AppState';
import { Icon } from './Icon';
import { Avatar } from './ui';

const END_TEXT: Record<CallEndReason, string> = {
  completed: 'Call ended',
  declined: 'Declined',
  busy: 'Busy',
  missed: 'Missed call',
  unavailable: 'Unavailable',
  canceled: 'Canceled',
  elsewhere: 'Answered on another device',
  failed: 'Call failed',
};
/** How long an ended call stays on screen. */
const ENDED_SHOW_MS = 4000;

type AudioState = 'off' | 'starting' | 'live';

interface Calls {
  call: CallInfo | null;
  /** Calls can be placed right now (WhatsApp connected, call code installed). */
  available: boolean;
  audio: AudioState;
  muted: boolean;
  /** A message about the last action or the audio (shown in the call panel). */
  note: string | null;
  start(chatId: string, name?: string): void;
}

const Ctx = createContext<Calls>({ call: null, available: false, audio: 'off', muted: false, note: null, start: () => undefined });

export function useCalls(): Calls {
  return useContext(Ctx);
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const live = (c: CallInfo | null): c is CallInfo => !!c && c.state !== 'ended';

/**
 * Voice calls of the linked account: follows the current call (SSE `call` events), rings for incoming calls, and
 * runs the browser end of the audio (CallAudio). Renders the call panel above the page.
 */
export function CallProvider({ children }: { children: ReactNode }) {
  const { wa } = useAppState();
  const [call, setCall] = useState<CallInfo | null>(null);
  const [available, setAvailable] = useState(false);
  const [audioState, setAudioState] = useState<AudioState>('off');
  const [muted, setMuted] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const audio = useRef<CallAudio | null>(null);
  const tone = useRef(new Tone());
  const callRef = useRef<CallInfo | null>(null);
  callRef.current = call;
  /** Hang up was pressed before the server answered the start request. */
  const hangupPending = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api.currentCall();
      setAvailable(r.available);
      setCall((prev) => (r.call ? r.call : prev && prev.state === 'ended' ? prev : null));
    } catch {
      /* keep what we have */
    }
  }, []);

  useEffect(() => {
    void refresh();
    return eventHub.onStatus((connected) => connected && void refresh());
  }, [refresh]);
  useEffect(() => {
    void refresh();
  }, [wa?.state, refresh]);

  useServerEvents((ev) => {
    if (ev.type !== 'call') return;
    const next = ev.call;
    setCall((prev) => (prev && prev.id === next.id ? { ...next, name: prev.name, avatarUrl: prev.avatarUrl } : next));
    // SSE carries no names: fetch them for a call we haven't seen yet.
    if (callRef.current?.id !== next.id) void refresh();
  });

  const stopAudio = useCallback(() => {
    audio.current?.stop();
    audio.current = null;
    setAudioState('off');
    setMuted(false);
  }, []);

  const onAudioEnd = useCallback((why: CallAudioEnd, detail?: string) => {
    audio.current = null;
    setAudioState('off');
    setMuted(false);
    if (why === 'replaced') setNote('The call audio moved to another window or device.');
    else if (why === 'session') setNote('Your session ended.');
    else if (why === 'error') setNote(detail ?? 'The call audio stopped.');
  }, []);

  /** Must run inside the click (user gesture) so the browser lets the audio start. */
  const beginAudio = useCallback((): CallAudio | null => {
    audio.current?.stop();
    try {
      const a = new CallAudio(onAudioEnd);
      audio.current = a;
      setAudioState('starting');
      a.whenReady().catch((e: Error) => {
        if (audio.current !== a) return;
        a.stop();
        audio.current = null;
        setAudioState('off');
        setNote(e.message);
      });
      return a;
    } catch (e) {
      setNote((e as Error).message);
      return null;
    }
  }, [onAudioEnd]);

  const connectAudio = useCallback(async (a: CallAudio) => {
    try {
      await a.connect();
      if (audio.current === a) setAudioState('live');
    } catch {
      /* whenReady() reported it */
    }
  }, []);

  const start = useCallback(
    (chatId: string, name?: string) => {
      if (live(callRef.current) || busy) return;
      setNote(null);
      const a = beginAudio();
      if (!a) return;
      setBusy(true);
      hangupPending.current = false;
      setCall({
        id: '',
        direction: 'outgoing',
        state: 'calling',
        video: false,
        group: false,
        chatId,
        name: name ?? null,
        startedAt: Date.now(),
        connectedAt: null,
        endedAt: null,
        endReason: null,
        audio: false,
      });
      void api
        .startCall(chatId)
        .then((c) => {
          if (hangupPending.current) {
            hangupPending.current = false;
            void api.hangupCall(c.id).catch(() => undefined);
            return;
          }
          setCall((prev) => (prev && prev.id === c.id && prev.state !== c.state ? { ...prev, name: c.name, avatarUrl: c.avatarUrl } : c));
          void connectAudio(a);
        })
        .catch((e) => {
          stopAudio();
          setCall(null);
          setNote(errorMessage(e));
        })
        .finally(() => setBusy(false));
    },
    [busy, beginAudio, connectAudio, stopAudio],
  );

  const accept = () => {
    const c = callRef.current;
    if (!c || busy) return;
    setNote(null);
    const a = beginAudio();
    if (!a) return;
    setBusy(true);
    void api
      .acceptCall(c.id)
      .then(() => connectAudio(a))
      .catch((e) => {
        stopAudio();
        setNote(errorMessage(e));
      })
      .finally(() => setBusy(false));
  };

  const decline = () => {
    const c = callRef.current;
    if (!c || busy) return;
    setBusy(true);
    void api
      .rejectCall(c.id)
      .catch((e) => setNote(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  const hangup = () => {
    const c = callRef.current;
    if (!c) return;
    stopAudio();
    if (!c.id) {
      hangupPending.current = true;
      setCall({ ...c, state: 'ended', endedAt: Date.now(), endReason: 'canceled' });
      return;
    }
    void api.hangupCall(c.id).catch((e) => setNote(errorMessage(e)));
  };

  const joinAudio = () => {
    setNote(null);
    const a = beginAudio();
    if (a) void connectAudio(a);
  };

  const toggleMute = () => {
    const a = audio.current;
    if (!a) return;
    a.setMuted(!a.isMuted);
    setMuted(a.isMuted);
  };

  // Ringing, ringback, the tab title, ending.
  const state = call?.state;
  const direction = call?.direction;
  useEffect(() => {
    if (state === 'incoming' && direction === 'incoming') tone.current.start('ring');
    else if (state === 'ringing' && direction === 'outgoing') tone.current.start('ringback');
    else tone.current.stop();
  }, [state, direction]);
  useEffect(() => () => tone.current.stop(), []);
  useEffect(() => {
    if (state !== 'incoming') return;
    const title = document.title;
    document.title = `📞 ${call?.name ?? 'Incoming call'}`;
    return () => {
      document.title = title;
    };
  }, [state, call?.name]);
  useEffect(() => {
    if (state !== 'ended') return;
    stopAudio();
    const id = call?.id;
    const t = window.setTimeout(() => {
      setCall((c) => (c && c.id === id && c.state === 'ended' ? null : c));
      setNote(null);
    }, ENDED_SHOW_MS);
    return () => window.clearTimeout(t);
  }, [state, call?.id, stopAudio]);
  useEffect(() => () => audio.current?.stop(), []);

  // Repaint the call timer every second.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (state !== 'active') return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [state]);

  const value = useMemo<Calls>(() => ({ call, available, audio: audioState, muted, note, start }), [call, available, audioState, muted, note, start]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {call || note ? (
        <CallPanel
          call={call}
          audio={audioState}
          muted={muted}
          note={note}
          busy={busy}
          onAccept={accept}
          onDecline={decline}
          onHangup={hangup}
          onJoin={joinAudio}
          onMute={toggleMute}
          onDismiss={() => setNote(null)}
        />
      ) : null}
    </Ctx.Provider>
  );
}

function statusText(c: CallInfo): string {
  switch (c.state) {
    case 'incoming':
      return c.video ? 'Incoming video call · answer as voice' : c.group ? 'Incoming group call' : 'Incoming voice call';
    case 'calling':
      return 'Calling…';
    case 'ringing':
      return 'Ringing…';
    case 'connecting':
      return 'Connecting…';
    case 'active':
      return formatDuration(Date.now() - (c.connectedAt ?? Date.now()));
    case 'ended': {
      const text = END_TEXT[c.endReason ?? 'completed'];
      return c.connectedAt && c.endedAt ? `${text} · ${formatDuration(c.endedAt - c.connectedAt)}` : text;
    }
  }
}

function CallPanel(p: {
  call: CallInfo | null;
  audio: AudioState;
  muted: boolean;
  note: string | null;
  busy: boolean;
  onAccept(): void;
  onDecline(): void;
  onHangup(): void;
  onJoin(): void;
  onMute(): void;
  onDismiss(): void;
}) {
  const c = p.call;
  if (!c) {
    return (
      <div className="call-panel" role="status">
        <div className="call-row">
          <Icon name="warning" size={20} />
          <div className="call-info">
            <div className="small">{p.note}</div>
          </div>
          <button className="icon-btn small" onClick={p.onDismiss} aria-label="Dismiss">
            <Icon name="close" size={18} />
          </button>
        </div>
      </div>
    );
  }
  const name = c.name ?? (c.chatId ? c.chatId.replace(/@.*/, '') : 'Unknown');
  const ringing = c.state === 'incoming';
  const ours = p.audio !== 'off';
  const needsAudio = !ringing && c.state !== 'ended' && !ours && (c.state === 'active' || c.state === 'connecting');
  return (
    <div className={`call-panel ${c.state}`} role={ringing ? 'alertdialog' : 'status'} aria-label={`Call with ${name}`}>
      <div className="call-row">
        <Avatar id={c.chatId ?? c.id} name={name} url={c.avatarUrl} kind={c.group ? 'group' : 'user'} size={44} />
        <div className="call-info">
          <div className="call-name">{name}</div>
          <div className="muted small" aria-live="polite">
            {statusText(c)}
            {p.audio === 'starting' && c.state !== 'ended' ? ' · starting microphone' : ''}
          </div>
        </div>
        {ringing ? (
          <div className="call-actions">
            <button className="call-btn decline" onClick={p.onDecline} disabled={p.busy} aria-label="Decline" title="Decline">
              <Icon name="callEnd" size={22} />
            </button>
            <button className="call-btn accept" onClick={p.onAccept} disabled={p.busy} aria-label="Answer" title="Answer">
              <Icon name="phone" size={22} />
            </button>
          </div>
        ) : c.state !== 'ended' ? (
          <div className="call-actions">
            {ours ? (
              <button
                className={p.muted ? 'call-btn mute on' : 'call-btn mute'}
                onClick={p.onMute}
                aria-pressed={p.muted}
                aria-label={p.muted ? 'Unmute' : 'Mute'}
                title={p.muted ? 'Unmute' : 'Mute'}
              >
                <Icon name={p.muted ? 'micOff' : 'mic'} size={22} />
              </button>
            ) : null}
            <button className="call-btn decline" onClick={p.onHangup} aria-label="Hang up" title="Hang up">
              <Icon name="callEnd" size={22} />
            </button>
          </div>
        ) : null}
      </div>
      {needsAudio ? (
        <div className="call-note">
          <span>{c.audio ? 'The audio is in another window or device.' : 'This call has no audio here.'}</span>
          <button className="btn tiny primary" onClick={p.onJoin}>
            <Icon name="mic" size={16} /> {c.audio ? 'Move audio here' : 'Join audio'}
          </button>
        </div>
      ) : null}
      {p.note ? <div className="call-note warn small">{p.note}</div> : null}
    </div>
  );
}

/** The phone button in a chat header. */
export function CallButton({ chatId, name }: { chatId: string; name: string }) {
  const { call, available, start } = useCalls();
  const { wa } = useAppState();
  const connected = wa?.state === 'ready' || wa?.state === 'syncing';
  const disabled = !connected || !available || live(call);
  const title = !connected
    ? 'WhatsApp is not connected'
    : !available
      ? 'Calling is not ready yet'
      : live(call)
        ? 'There is already a call'
        : 'Voice call';
  return (
    <button className="icon-btn" onClick={() => start(chatId, name)} disabled={disabled} aria-label="Voice call" title={title}>
      <Icon name="phone" />
    </button>
  );
}
