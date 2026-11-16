import { useCallback, useEffect, useRef, useState } from 'react';
import { voiceRepository as api } from '../../data/voice';
import type { VoiceAnchor } from '../../domain/voice';
import { errorMessage } from '../../state';

export type VoicePhase = 'idle' | 'starting' | 'recording' | 'recognizing';
export function useVoiceInput({
  enabled,
  contextKey,
  onTranscript,
}: {
  enabled: boolean;
  contextKey: string;
  onTranscript: (text: string, anchor: VoiceAnchor) => void;
}) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [level, setLevel] = useState(0),
    [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const session = useRef<{
    id: string;
    phase: VoicePhase;
    anchor: VoiceAnchor;
    context: string;
  } | null>(null);
  const current = useRef({ enabled, contextKey, onTranscript });
  current.current = { enabled, contextKey, onTranscript };
  const stopRef = useRef<() => Promise<void>>(async () => {});
  const cancel = useCallback(() => {
    const old = session.current;
    session.current = null; // invalidate callbacks before cancelling native work
    setPhase('idle');
    setLevel(0);
    setElapsed(0);
    if (old) void api.cancel(old.id).catch(() => {});
  }, []);
  useEffect(() => {
    if (!enabled || session.current?.context !== contextKey) cancel();
  }, [enabled, contextKey, cancel]);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden) cancel();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && session.current) {
        e.preventDefault();
        cancel();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', cancel);
    window.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', cancel);
      window.removeEventListener('keydown', escape);
      const old = session.current;
      session.current = null;
      if (old) void api.cancel(old.id).catch(() => {});
    };
  }, [cancel]);
  async function start(anchor: VoiceAnchor) {
    if (!current.current.enabled || session.current) return;
    const s = {
      id: crypto.randomUUID(),
      phase: 'starting' as VoicePhase,
      anchor,
      context: current.current.contextKey,
    };
    session.current = s;
    setError('');
    setElapsed(0);
    setLevel(0);
    setPhase('starting');
    try {
      await api.start(s.id, (event) => {
        if (session.current !== s) return;
        if (event.type === 'level') {
          setLevel(event.level);
          setElapsed(event.elapsed_ms);
        } else if (event.type === 'limit') void stopRef.current();
        else if (event.type === 'error') {
          cancel();
          setError(event.message);
        }
      });
      if (session.current !== s) {
        void api.cancel(s.id).catch(() => {});
        return;
      }
      if (session.current === s && s.phase === 'starting') {
        s.phase = 'recording';
        setPhase('recording');
      }
    } catch (e) {
      if (session.current === s) {
        cancel();
        setError(errorMessage(e));
      }
    }
  }
  async function stop() {
    const s = session.current;
    if (!s || s.phase !== 'recording') return;
    s.phase = 'recognizing';
    setPhase('recognizing');
    setLevel(0);
    try {
      const result = await api.finish(s.id);
      if (
        session.current !== s ||
        !current.current.enabled ||
        current.current.contextKey !== s.context
      )
        return;
      current.current.onTranscript(result.text, s.anchor);
      session.current = null;
      setPhase('idle');
      setElapsed(0);
    } catch (e) {
      if (session.current === s) {
        cancel();
        setError(errorMessage(e));
      }
    }
  }
  stopRef.current = stop;
  return {
    phase,
    level,
    elapsed,
    error,
    dismissError: () => setError(''),
    start,
    stop,
    cancel,
    busy: phase !== 'idle',
  };
}
