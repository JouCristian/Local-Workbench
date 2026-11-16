// Adapted from React Bits Voice Pill, David Haz, MIT + Commons Clause.
// Preserve the capsule, scrolling waveform and timer; native capture owns audio.
import { useEffect, useRef } from 'react';
import { LoaderCircle, Mic, Square, X } from 'lucide-react';
import { useMotionPreference } from '../../components/motion';
import type { VoicePhase } from '../../components/assistant/useVoiceInput';
import './VoicePill.css';

export default function VoicePill({
  phase,
  level,
  elapsed,
  disabled,
  onStart,
  onStop,
  onCancel,
}: {
  phase: VoicePhase;
  level: number;
  elapsed: number;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
}) {
  const wave = useRef<HTMLCanvasElement>(null);
  const sample = useRef(level);
  sample.current = level;
  const reduced = useMotionPreference();
  const recording = phase === 'recording',
    expanded = phase !== 'idle';
  useEffect(() => {
    if (!recording) return;
    const canvas = wave.current!;
    const history: number[] = [];
    let raf = 0,
      last = 0,
      env = 0;
    const frame = (now: number) => {
      if (now - last > 32) {
        last = now;
        env += (Math.max(0, Math.min(1, sample.current)) - env) * 0.35;
        history.push(env);
        if (history.length > 80) history.shift();
        const dpr = Math.min(2, devicePixelRatio || 1),
          rect = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width * dpr)),
          h = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, w, h);
          ctx.fillStyle = getComputedStyle(canvas).color;
          const bw = 2 * dpr,
            step = 3 * dpr;
          for (let i = 0; i < history.length; i++) {
            const value = reduced ? 0.25 : history[history.length - 1 - i];
            const x = w - (i + 1) * step;
            if (x + bw < 0) break;
            const bar = Math.max(bw, (0.1 + 0.9 * value) * h);
            const t = Math.min(1, Math.max(0, (x + bw / 2) / (w * 0.55)));
            ctx.globalAlpha = (0.35 + 0.65 * value) * t * t * (3 - 2 * t);
            ctx.beginPath();
            ctx.roundRect(x, (h - bar) / 2, bw, bar, bw / 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [recording, reduced]);
  const seconds = Math.floor(elapsed / 1000);
  const label = recording
    ? '停止录音并识别'
    : phase === 'recognizing'
      ? '正在识别语音'
      : phase === 'starting'
        ? '正在打开麦克风'
        : '开始语音输入';
  return (
    <div className="voice-pill-slot" data-expanded={expanded} data-voice-phase={phase}>
      <button
        type="button"
        className="voice-pill"
        data-state={phase}
        aria-label={label}
        aria-pressed={recording}
        aria-busy={phase === 'starting' || phase === 'recognizing'}
        disabled={disabled || phase === 'starting' || phase === 'recognizing'}
        title={
          disabled
            ? '配置 API 后可使用语音输入'
            : expanded
              ? '停止后转成文字，核对后再发送；Esc 取消'
              : '录音将发送至 DeepSeek 转成文字，最多两分钟'
        }
        onPointerDown={(e) => e.preventDefault()}
        onClick={recording ? onStop : onStart}
      >
        <span className="voice-pill__capsule" aria-hidden="true" />
        <canvas ref={wave} className="voice-pill__wave" aria-hidden="true" />
        <span className="voice-pill__time" aria-hidden="true">
          {phase === 'recognizing'
            ? '识别中'
            : phase === 'starting'
              ? '准备中'
              : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}
        </span>
        <span className="voice-pill__glyph" aria-hidden="true">
          <Mic className="voice-pill__mic" size={19} />
          <Square className="voice-pill__stop" size={12} fill="currentColor" />
          <LoaderCircle className="voice-pill__loader" size={18} />
        </span>
      </button>
      <button
        type="button"
        className="voice-pill__cancel"
        aria-label="取消语音输入"
        tabIndex={expanded ? 0 : -1}
        inert={!expanded}
        onPointerDown={(e) => e.preventDefault()}
        onClick={onCancel}
        title="取消语音输入（Esc）"
      >
        <X size={13} />
      </button>
      <span className="voice-pill__status" role="status" aria-live="polite">
        {expanded ? label : ''}
      </span>
    </div>
  );
}
