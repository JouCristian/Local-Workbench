import { usePresence } from 'motion/react';
import { appleEaseCss, useMotionPreference } from './motion';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { X, AlertTriangle } from 'lucide-react';

export function Modal({
  title,
  children,
  close,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    surface = useRef<HTMLDivElement>(null);
  const resumeFrom = useRef<{ opacity: string; transform: string } | null>(null);
  const reduced = useMotionPreference();
  const [present, safeToRemove] = usePresence();
  useLayoutEffect(() => {
    const el = ref.current!;
    el.showModal();
    el.querySelector<HTMLElement>('.modal-head h2')?.focus({ preventScroll: true });
    const animation = reduced
      ? undefined
      : surface.current!.animate(
          [
            { opacity: 0, transform: 'translateY(12px) scale(.985)' },
            { opacity: 1, transform: 'translateY(0) scale(1)' },
          ],
          { duration: 320, easing: appleEaseCss },
        );
    return () => {
      animation?.cancel();
      el.close();
    };
  }, []);
  useEffect(() => {
    if (reduced) surface.current?.getAnimations().forEach((animation) => animation.finish());
  }, [reduced]);
  useEffect(() => {
    if (present) {
      const from = resumeFrom.current;
      resumeFrom.current = null;
      if (!from || reduced) return;
      const animation = surface.current!.animate([from, { opacity: 1, transform: 'none' }], {
        duration: 240,
        easing: appleEaseCss,
      });
      return () => animation.cancel();
    }
    if (reduced) {
      safeToRemove?.();
      return;
    }
    const el = surface.current!;
    const current = getComputedStyle(el);
    const from = { opacity: current.opacity, transform: current.transform };
    el.getAnimations().forEach((animation) => animation.cancel());
    const animation = el.animate([from, { opacity: 0, transform: 'translateY(8px) scale(.99)' }], {
      duration: 180,
      easing: appleEaseCss,
      fill: 'forwards',
    });
    animation.finished.then(() => safeToRemove?.()).catch(() => {});
    return () => {
      const current = getComputedStyle(el);
      resumeFrom.current = { opacity: current.opacity, transform: current.transform };
      animation.cancel();
    };
  }, [present, reduced, safeToRemove]);
  return (
    <dialog
      ref={ref}
      className="modal"
      data-closing={!present || undefined}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <div ref={surface} className="modal-surface" inert={!present}>
        <header className="modal-head">
          <h2 tabIndex={-1}>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭弹窗"
            onClick={close}
            disabled={busy}
          >
            <X size={19} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

export function Confirm({
  title,
  message,
  label,
  action,
  close,
  danger = true,
}: {
  title: string;
  message: string;
  label: string;
  action: () => Promise<void>;
  close: () => void;
  danger?: boolean;
}) {
  const ref = useRef(false);
  const [state, setState] = useState({ busy: false, error: '' });
  async function confirm() {
    if (ref.current) return;
    ref.current = true;
    setState({ busy: true, error: '' });
    try {
      await action();
      close();
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      ref.current = false;
    }
  }
  return (
    <Modal title={title} close={close} busy={state.busy}>
      <div className="confirm-content modal-scroll">
        <AlertTriangle size={28} className={danger ? 'danger-text' : 'accent-text'} />
        <p>{message}</p>
        {state.error && (
          <p role="alert" className="form-error">
            {state.error}
          </p>
        )}
      </div>
      <footer className="modal-footer">
        <button onClick={close} disabled={state.busy}>
          取消
        </button>
        <button
          className={danger ? 'danger' : 'primary'}
          onClick={() => void confirm()}
          disabled={state.busy}
        >
          {state.busy ? '处理中…' : label}
        </button>
      </footer>
    </Modal>
  );
}
