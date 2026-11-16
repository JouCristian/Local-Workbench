import { motion } from 'motion/react';
import {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { appleEase, useMotionPreference } from './motion';

type TransitionRun = {
  direction: number;
  sequence: number;
  axis: 'x' | 'y' | 'z';
  origin?: string;
  enterOpacity?: number;
};
const TransitionContext = createContext<TransitionRun>({ direction: 1, sequence: 0, axis: 'x' });
function Pane({
  viewKey,
  page,
  children,
  measure,
  present,
  finish,
}: {
  viewKey: string;
  page?: string;
  children: ReactNode;
  measure: (height: number) => void;
  present: boolean;
  finish: (sequence: number) => void;
}) {
  const reduced = useMotionPreference(),
    run = useContext(TransitionContext);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (present) return;
    const timer = setTimeout(() => finish(run.sequence), reduced ? 0 : 560);
    return () => clearTimeout(timer);
  }, [present, reduced, finish, run.sequence]);
  useLayoutEffect(() => {
    if (!present || !ref.current) return;
    const el = ref.current,
      update = () => measure(el.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [present, measure]);
  return (
    <motion.div
      ref={ref}
      className={page ? 'page-transition view-switch-pane' : 'view-switch-pane'}
      data-page={page}
      data-view={viewKey}
      data-present={present}
      data-axis={run.axis}
      data-direction={run.direction}
      inert={!present}
      aria-hidden={!present || undefined}
      initial={
        reduced || run.sequence === 0
          ? false
          : {
              x: run.axis === 'x' ? run.direction * 150 : 0,
              y: run.axis === 'y' ? run.direction * 90 : 0,
              scale: run.axis === 'z' ? (run.direction > 0 ? 0.88 : 1.1) : 1.008,
              clipPath:
                run.axis === 'z' ? 'inset(4% 4% 4% 4% round 10px)' : 'inset(0% 0% 0% 0% round 0px)',
              opacity: run.enterOpacity ?? 0,
            }
      }
      animate={
        present
          ? {
              x: 0,
              y: 0,
              scale: 1,
              opacity: 1,
              clipPath: 'inset(0% 0% 0% 0% round 0px)',
              transition: { duration: reduced ? 0 : 0.76, ease: appleEase },
            }
          : {
              x: run.axis === 'x' ? -run.direction * 90 : 0,
              y: run.axis === 'y' ? -run.direction * 60 : 0,
              scale: run.axis === 'z' ? (run.direction > 0 ? 1.12 : 0.82) : 0.985,
              clipPath:
                run.axis === 'z' ? 'inset(3% 3% 3% 3% round 10px)' : 'inset(0% 0% 0% 0% round 0px)',
              opacity: 0,
              transition: { duration: reduced ? 0 : 0.54, ease: appleEase },
            }
      }
      style={{
        position: present ? 'relative' : 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        zIndex: present ? 2 : 1,
        pointerEvents: present ? 'auto' : 'none',
        transformOrigin: run.axis === 'z' ? (run.origin ?? '50% 35%') : '50% 0',
      }}
    >
      {children}
    </motion.div>
  );
}

/** SWUST page recipe: incoming starts immediately; obsolete outgoing panes are cancelled. */
export function ViewSwitch({
  viewKey,
  order = 0,
  axis = 'x',
  direction,
  origin,
  page,
  children,
  className = '',
}: {
  viewKey: string;
  order?: number;
  axis?: 'x' | 'y' | 'z';
  direction?: 1 | -1;
  origin?: string;
  page?: string;
  children: ReactNode;
  className?: string;
}) {
  const reduced = useMotionPreference(),
    container = useRef<HTMLDivElement>(null),
    previous = useRef({
      key: viewKey,
      order,
      direction: 1,
      sequence: 0,
      axis,
      origin,
      enterOpacity: 0,
    }),
    current = useRef({ key: viewKey, children, page }),
    outgoing = useRef<typeof current.current | null>(null);
  if (previous.current.key !== viewKey) {
    // During a rapid reversal the newest pane can still be almost transparent.
    // Keep the more visible outgoing pane as the background, rather than dropping
    // it and exposing the canvas beneath two newly transparent views.
    const panes = Array.from(container.current?.children ?? []) as HTMLElement[];
    const prior = panes.find((el) => el.dataset.view === outgoing.current?.key);
    const active = panes.find((el) => el.dataset.view === current.current.key);
    const retain =
      prior &&
      active &&
      outgoing.current?.key !== viewKey &&
      Number(getComputedStyle(prior).opacity) > Number(getComputedStyle(active).opacity);
    // Carry the opacity of the discarded view into a fresh incoming pane. Otherwise
    // interrupting a 50/50 crossfade would suddenly remove half the visible image.
    const existing = panes.some((el) => el.dataset.view === viewKey);
    const discarded = retain ? active : prior;
    const enterOpacity = !existing && discarded ? Number(getComputedStyle(discarded).opacity) : 0;
    if (!retain) outgoing.current = current.current;
    previous.current = {
      key: viewKey,
      order,
      direction: direction ?? (order >= previous.current.order ? 1 : -1),
      axis,
      origin,
      enterOpacity,
      sequence: previous.current.sequence + 1,
    };
  }
  current.current = { key: viewKey, children, page };
  const [finished, setFinished] = useState(0),
    finish = useCallback((sequence: number) => setFinished((old) => Math.max(old, sequence)), []);
  const retained = finished !== previous.current.sequence ? outgoing.current : null;
  const [height, setHeight] = useState<number | null>(null),
    measure = useCallback((next: number) => setHeight((old) => (old === next ? old : next)), []);
  return (
    <TransitionContext.Provider
      value={{
        direction: previous.current.direction,
        sequence: previous.current.sequence,
        axis: previous.current.axis,
        origin: previous.current.origin,
        enterOpacity: previous.current.enterOpacity,
      }}
    >
      <motion.div
        ref={container}
        className={`view-switch ${className}`}
        data-switch={page ? 'route' : 'section'}
        initial={false}
        animate={{ height: height ?? 'auto' }}
        transition={{ duration: reduced ? 0 : 0.54, ease: appleEase }}
      >
        {[...(retained ? [retained] : []), current.current].map((view) => (
          <Pane
            key={view.key}
            viewKey={view.key}
            page={view.page}
            measure={measure}
            present={view.key === viewKey}
            finish={finish}
          >
            {view.children}
          </Pane>
        ))}
      </motion.div>
    </TransitionContext.Provider>
  );
}
