import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { appleEase } from '../motion';

// Keep the old form's measured height while it fades out, then resize in normal
// document flow. A layout/scale animation would squash the text and snap siblings.
export function OperationBodyTransition({
  state,
  reduced,
  children,
}: {
  state: 'preview' | 'applied' | 'cancelled';
  reduced: boolean;
  children: ReactNode;
}) {
  const [height, setHeight] = useState<number>();
  const closed = state !== 'preview';
  return (
    <motion.div
      className="agent-operation-body"
      data-operation-view={state}
      initial={false}
      animate={{ height: closed && height !== undefined ? height : 'auto' }}
      transition={{ duration: reduced ? 0 : 0.54, ease: appleEase }}
      style={{ overflow: closed ? 'hidden' : 'visible' }}
    >
      <AnimatePresence initial={false} mode="wait">
        <MeasuredContent key={state} measure={setHeight} reduced={reduced} closed={closed}>
          {children}
        </MeasuredContent>
      </AnimatePresence>
    </motion.div>
  );
}

function MeasuredContent({
  measure,
  reduced,
  closed,
  children,
}: {
  measure: (height: number) => void;
  reduced: boolean;
  closed: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  useLayoutEffect(() => {
    const el = ref.current!;
    const update = () => measure(el.getBoundingClientRect().height);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  return (
    <motion.div
      ref={ref}
      className="agent-operation-body-content"
      data-operation-content={closed ? 'result' : 'preview'}
      inert={!present}
      aria-hidden={!present || undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{
        duration: reduced ? 0 : 0.32,
        ease: appleEase,
        delay: !reduced && closed ? 0.08 : 0,
      }}
    >
      {children}
    </motion.div>
  );
}
