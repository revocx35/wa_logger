import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CallEndReason, CallInfo } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { eventHub, useServerEvents } from '../api/events';
import { CallAudio, Tone, type CallAudioEnd } from '../lib/callAudio';
import { CallVideo, videoSupported, type CallVideoEnd } from '../lib/callVideo';
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
  start(chatId: string, name?: string, video?: boolean): void;
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
  // Video: the CallVideo of this tab, our camera, the call screen minimized to the panel.
  const vid = useRef<CallVideo | null>(null);
  const [videoLive, setVideoLive] = useState(false);
  const [camera, setCamera] = useState<'off' | 'starting' | 'on'>('off');
  const [minimized, setMinimized] = useState(false);
  const [remoteSize, setRemoteSize] = useState<{ w: number; h: number } | null>(null);
  const remoteCanvas = useRef<HTMLCanvasElement | null>(null);
  const setCanvas = useCallback((c: HTMLCanvasElement | null) => {
    remoteCanvas.current = c;
    vid.current?.setCanvas(c);
  }, []);

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

  const stopVideo = useCallback(() => {
    vid.current?.stop();
    vid.current = null;
    setVideoLive(false);
    setCamera('off');
    setRemoteSize(null);
  }, []);

  const onVideoEnd = useCallback((why: CallVideoEnd, detail?: string) => {
    vid.current = null;
    setVideoLive(false);
    setCamera('off');
    setRemoteSize(null);
    if (why === 'replaced') setNote('The call video moved to another window or device.');
    else if (why === 'error') setNote(detail ?? 'The call video stopped.');
  }, []);

  /** The video connection (and, with [withCamera], the camera) for the current call. */
  const beginVideo = useCallback(
    async (withCamera: boolean) => {
      if (!videoSupported()) {
        if (withCamera) setNote('This browser can’t do video calls (it needs WebCodecs and HTTPS). The call continues as a voice call.');
        return;
      }
      let v = vid.current;
      if (!v) {
        v = new CallVideo(onVideoEnd, setRemoteSize);
        v.setCanvas(remoteCanvas.current);
        vid.current = v;
      }
      try {
        await v.connect();
        if (vid.current === v) setVideoLive(true);
        if (withCamera && !v.cameraStream) {
          setCamera('starting');
          await v.startCamera();
          if (vid.current === v) setCamera('on');
        }
      } catch (e) {
        if (vid.current === v) setCamera('off');
        setNote((e as Error).message);
      }
    },
    [onVideoEnd],
  );

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
    (chatId: string, name?: string, video = false) => {
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
        video,
        selfVideo: video,
        peerVideo: false,
        group: false,
        chatId,
        name: name ?? null,
        startedAt: Date.now(),
        connectedAt: null,
        endedAt: null,
        endReason: null,
        audio: false,
        videoClient: false,
        recording: false,
      });
      setMinimized(false);
      void api
        .startCall(chatId, video)
        .then((c) => {
          if (hangupPending.current) {
            hangupPending.current = false;
            void api.hangupCall(c.id).catch(() => undefined);
            return;
          }
          setCall((prev) => (prev && prev.id === c.id && prev.state !== c.state ? { ...prev, name: c.name, avatarUrl: c.avatarUrl } : c));
          void connectAudio(a);
          if (video) void beginVideo(true);
        })
        .catch((e) => {
          stopAudio();
          stopVideo();
          setCall(null);
          setNote(errorMessage(e));
        })
        .finally(() => setBusy(false));
    },
    [busy, beginAudio, connectAudio, stopAudio, beginVideo, stopVideo],
  );

  const accept = (video: boolean) => {
    const c = callRef.current;
    if (!c || busy) return;
    setNote(null);
    const a = beginAudio();
    if (!a) return;
    setBusy(true);
    setMinimized(false);
    const withVideo = video && videoSupported();
    void api
      .acceptCall(c.id, withVideo)
      .then(() => {
        void connectAudio(a);
        // A video call shows the other side even when answered without the camera.
        if (withVideo || c.video) void beginVideo(withVideo);
      })
      .catch((e) => {
        stopAudio();
        setNote(errorMessage(e));
      })
      .finally(() => setBusy(false));
  };

  const toggleRecording = () => {
    const c = callRef.current;
    if (!c || !c.id || c.state !== 'active') return;
    const on = !c.recording;
    setCall((prev) => (prev && prev.id === c.id ? { ...prev, recording: on } : prev));
    void api
      .setCallRecording(c.id, on)
      .then((r) => setCall((prev) => (prev && prev.id === r.id ? { ...prev, recording: r.recording } : prev)))
      .catch((e) => {
        setNote(errorMessage(e));
        setCall((prev) => (prev && prev.id === c.id ? { ...prev, recording: !on } : prev));
      });
  };

  const toggleCamera = () => {
    const c = callRef.current;
    if (!c || !c.id) return;
    const on = camera === 'off';
    if (!on) vid.current?.stopCamera();
    setCamera(on ? 'starting' : 'off');
    if (on) void beginVideo(true);
    void api
      .setCallVideo(c.id, on)
      .then((r) => setCall((prev) => (prev && prev.id === r.id ? { ...prev, selfVideo: r.selfVideo, video: r.video } : prev)))
      .catch((e) => {
        setNote(errorMessage(e));
        if (on) {
          vid.current?.stopCamera();
          setCamera('off');
        }
      });
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
    stopVideo();
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
    const c = callRef.current;
    if (c && (c.video || c.peerVideo)) void beginVideo(false);
  };

  // The other side switched video on (or the call is a video call): show it once our audio runs here.
  const peerVideo = !!call?.peerVideo;
  const callLive = !!call && call.state !== 'ended' && call.state !== 'incoming';
  useEffect(() => {
    if (callLive && peerVideo && audioState !== 'off' && !vid.current) void beginVideo(false);
  }, [callLive, peerVideo, audioState, beginVideo]);

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
    stopVideo();
    setMinimized(false);
    const id = call?.id;
    const t = window.setTimeout(() => {
      setCall((c) => (c && c.id === id && c.state === 'ended' ? null : c));
      setNote(null);
    }, ENDED_SHOW_MS);
    return () => window.clearTimeout(t);
  }, [state, call?.id, stopAudio, stopVideo]);
  useEffect(
    () => () => {
      audio.current?.stop();
      vid.current?.stop();
    },
    [],
  );

  // Repaint the call timer every second.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (state !== 'active') return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [state]);

  const value = useMemo<Calls>(() => ({ call, available, audio: audioState, muted, note, start }), [call, available, audioState, muted, note, start]);

  const showStage = !!call && callLive && !minimized && (call.video || call.peerVideo || call.selfVideo || camera !== 'off');
  const panelProps = {
    call,
    audio: audioState,
    muted,
    note,
    busy,
    onAccept: accept,
    onDecline: decline,
    onHangup: hangup,
    onJoin: joinAudio,
    onMute: toggleMute,
    onRecord: toggleRecording,
    onDismiss: () => setNote(null),
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {showStage && call ? (
        <VideoStage
          {...panelProps}
          call={call}
          camera={camera}
          videoLive={videoLive}
          remoteSize={remoteSize}
          cameraStream={vid.current?.cameraStream ?? null}
          setCanvas={setCanvas}
          onCamera={toggleCamera}
          onMinimize={() => setMinimized(true)}
        />
      ) : call || note ? (
        <CallPanel {...panelProps} onExpand={callLive && call && (call.video || call.peerVideo || call.selfVideo) ? () => setMinimized(false) : undefined} />
      ) : null}
    </Ctx.Provider>
  );
}

function statusText(c: CallInfo): string {
  switch (c.state) {
    case 'incoming':
      return c.video ? 'Incoming video call' : c.group ? 'Incoming group call' : 'Incoming voice call';
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

interface PanelProps {
  call: CallInfo | null;
  audio: AudioState;
  muted: boolean;
  note: string | null;
  busy: boolean;
  onAccept(video: boolean): void;
  onDecline(): void;
  onHangup(): void;
  onJoin(): void;
  onMute(): void;
  onRecord(): void;
  onDismiss(): void;
}

const displayName = (c: CallInfo) => c.name ?? (c.chatId ? c.chatId.replace(/@.*/, '') : 'Unknown');

function MuteButton(p: { muted: boolean; onMute(): void }) {
  return (
    <button
      className={p.muted ? 'call-btn mute on' : 'call-btn mute'}
      onClick={p.onMute}
      aria-pressed={p.muted}
      aria-label={p.muted ? 'Unmute' : 'Mute'}
      title={p.muted ? 'Unmute' : 'Mute'}
    >
      <Icon name={p.muted ? 'micOff' : 'mic'} size={22} />
    </button>
  );
}

/** Record / stop recording (only while the call is connected); a red dot shows while it is being recorded. */
function RecordButton(p: { recording: boolean; onRecord(): void }) {
  return (
    <button
      className={p.recording ? 'call-btn rec on' : 'call-btn rec'}
      onClick={p.onRecord}
      aria-pressed={p.recording}
      aria-label={p.recording ? 'Stop recording' : 'Record call'}
      title={p.recording ? 'Stop recording' : 'Record call'}
    >
      <Icon name="record" size={22} />
    </button>
  );
}

function RecBadge() {
  return (
    <span className="rec-badge" role="status">
      <span className="rec-dot" /> REC
    </span>
  );
}

function CallPanel(p: PanelProps & { onExpand?: () => void }) {
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
  const name = displayName(c);
  const ringing = c.state === 'incoming';
  const ours = p.audio !== 'off';
  const needsAudio = !ringing && c.state !== 'ended' && !ours && (c.state === 'active' || c.state === 'connecting');
  const canVideo = videoSupported();
  return (
    <div className={`call-panel ${c.state}`} role={ringing ? 'alertdialog' : 'status'} aria-label={`Call with ${name}`}>
      <div className="call-row">
        <Avatar id={c.chatId ?? c.id} name={name} url={c.avatarUrl} kind={c.group ? 'group' : 'user'} size={44} />
        <div className="call-info">
          <div className="call-name">{name}</div>
          <div className="muted small" aria-live="polite">
            {c.recording ? <RecBadge /> : null}
            {statusText(c)}
            {p.audio === 'starting' && c.state !== 'ended' ? ' · starting microphone' : ''}
          </div>
        </div>
        {ringing ? (
          <div className="call-actions">
            <button className="call-btn decline" onClick={p.onDecline} disabled={p.busy} aria-label="Decline" title="Decline">
              <Icon name="callEnd" size={22} />
            </button>
            {c.video && canVideo ? (
              <button className="call-btn accept" onClick={() => p.onAccept(true)} disabled={p.busy} aria-label="Answer with video" title="Answer with video">
                <Icon name="video" size={22} />
              </button>
            ) : null}
            <button
              className="call-btn accept"
              onClick={() => p.onAccept(false)}
              disabled={p.busy}
              aria-label={c.video ? 'Answer without video' : 'Answer'}
              title={c.video ? 'Answer without video' : 'Answer'}
            >
              <Icon name="phone" size={22} />
            </button>
          </div>
        ) : c.state !== 'ended' ? (
          <div className="call-actions">
            {p.onExpand ? (
              <button className="call-btn mute" onClick={p.onExpand} aria-label="Show video" title="Show video">
                <Icon name="expand" size={20} />
              </button>
            ) : null}
            {c.state === 'active' ? <RecordButton recording={c.recording} onRecord={p.onRecord} /> : null}
            {ours ? <MuteButton muted={p.muted} onMute={p.onMute} /> : null}
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

/** The video call screen: the other side full size, our camera in a corner, the controls at the bottom. */
function VideoStage(
  p: PanelProps & {
    call: CallInfo;
    camera: 'off' | 'starting' | 'on';
    videoLive: boolean;
    remoteSize: { w: number; h: number } | null;
    cameraStream: MediaStream | null;
    setCanvas(c: HTMLCanvasElement | null): void;
    onCamera(): void;
    onMinimize(): void;
  },
) {
  const c = p.call;
  const name = displayName(c);
  const preview = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (preview.current) preview.current.srcObject = p.cameraStream;
  }, [p.cameraStream, p.camera]);
  const ours = p.audio !== 'off';
  const showRemote = c.peerVideo && p.videoLive && !!p.remoteSize;
  const needsAudio = !ours && (c.state === 'active' || c.state === 'connecting');
  return (
    <div className="call-stage" role="dialog" aria-label={`Video call with ${name}`}>
      <canvas ref={p.setCanvas} className={showRemote ? 'call-remote' : 'call-remote hidden'} aria-label={`${name}'s video`} />
      {!showRemote ? (
        <div className="call-stage-placeholder">
          <Avatar id={c.chatId ?? c.id} name={name} url={c.avatarUrl} kind="user" size={96} />
          <div className="muted">{c.peerVideo ? 'Waiting for video…' : c.state === 'active' ? 'Camera off' : statusText(c)}</div>
        </div>
      ) : null}
      <div className="call-stage-top">
        <div>
          <div className="call-name">{name}</div>
          <div className="small" aria-live="polite">
            {c.recording ? <RecBadge /> : null}
            {statusText(c)}
          </div>
        </div>
        <button className="call-btn mute" onClick={p.onMinimize} aria-label="Minimize" title="Minimize">
          <Icon name="minimize" size={20} />
        </button>
      </div>
      {p.camera !== 'off' ? <video ref={preview} className="call-preview" autoPlay muted playsInline aria-label="Your camera" /> : null}
      <div className="call-stage-bottom">
        {p.note ? <div className="call-note warn small">{p.note}</div> : null}
        {needsAudio ? (
          <button className="btn tiny primary" onClick={p.onJoin}>
            <Icon name="mic" size={16} /> {c.audio ? 'Move the call here' : 'Join the call here'}
          </button>
        ) : null}
        <div className="call-actions">
          <button
            className={p.camera === 'off' ? 'call-btn mute on' : 'call-btn mute'}
            onClick={p.onCamera}
            disabled={p.camera === 'starting' || !ours}
            aria-pressed={p.camera === 'off'}
            aria-label={p.camera === 'off' ? 'Turn camera on' : 'Turn camera off'}
            title={p.camera === 'off' ? 'Turn camera on' : 'Turn camera off'}
          >
            <Icon name={p.camera === 'off' ? 'videoOff' : 'video'} size={22} />
          </button>
          {c.state === 'active' ? <RecordButton recording={c.recording} onRecord={p.onRecord} /> : null}
          {ours ? <MuteButton muted={p.muted} onMute={p.onMute} /> : null}
          <button className="call-btn decline" onClick={p.onHangup} aria-label="Hang up" title="Hang up">
            <Icon name="callEnd" size={22} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** The phone (or camera) button in a chat header. */
export function CallButton({ chatId, name, video = false }: { chatId: string; name: string; video?: boolean }) {
  const { call, available, start } = useCalls();
  const { wa } = useAppState();
  const connected = wa?.state === 'ready' || wa?.state === 'syncing';
  const noVideo = video && !videoSupported();
  const disabled = !connected || !available || live(call) || noVideo;
  const label = video ? 'Video call' : 'Voice call';
  const title = !connected
    ? 'WhatsApp is not connected'
    : !available
      ? 'Calling is not ready yet'
      : live(call)
        ? 'There is already a call'
        : noVideo
          ? 'This browser can’t do video calls (needs WebCodecs and HTTPS)'
          : label;
  return (
    <button className="icon-btn" onClick={() => start(chatId, name, video)} disabled={disabled} aria-label={label} title={title}>
      <Icon name={video ? 'video' : 'phone'} />
    </button>
  );
}
