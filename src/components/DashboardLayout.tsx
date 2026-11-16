import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent,
} from 'react';
import { motion, useMotionValue, useTransform, animate } from 'motion/react';
import { useStore } from '../state';
import { clampSplit, defaultLayout, type DashboardLayout as Layout } from '../domain/preferences';
import { appleEase, useMotionPreference } from './motion';

/** Two splitters form one stable tiling: today/deadlines above project progress. */
export function DashboardLayout({
  today,
  deadlines,
  projects,
}: {
  today: ReactNode;
  deadlines: ReactNode;
  projects: ReactNode;
}) {
  const { dashboardLayout: layout, setDashboardLayout } = useStore();
  const reduced = useMotionPreference(),
    root = useRef<HTMLDivElement>(null),
    columnsRef = useRef<HTMLDivElement>(null);
  const columns = useMotionValue(layout.columns),
    rows = useMotionValue(layout.rows);
  const templateColumns = useTransform(
    columns,
    (value) => `minmax(0, ${value}fr) 12px minmax(0, ${1 - value}fr)`,
  );
  const templateRows = useTransform(
    rows,
    (value) => `minmax(0, ${value}fr) 12px minmax(0, ${1 - value}fr)`,
  );
  const dragging = useRef<'columns' | 'rows' | null>(null),
    [active, setActive] = useState<string | null>(null);
  const [, refreshAria] = useState(0);
  const animations = useRef<ReturnType<typeof animate>[]>([]);
  const stop = () => {
    animations.current.forEach((animation) => animation.stop());
    animations.current = [];
  };
  function moveTo(value: Layout) {
    stop();
    animations.current = [
      animate(columns, value.columns, {
        duration: reduced ? 0 : 0.76,
        ease: appleEase,
        onComplete: () => refreshAria((value) => value + 1),
      }),
      animate(rows, value.rows, {
        duration: reduced ? 0 : 0.76,
        ease: appleEase,
        onComplete: () => refreshAria((value) => value + 1),
      }),
    ];
  }
  useEffect(() => {
    if (!dragging.current) moveTo(layout);
    return stop;
  }, [layout.columns, layout.rows, reduced]);
  useLayoutEffect(() => {
    const el = root.current,
      dashboard = el?.closest<HTMLElement>('.dashboard-page'),
      workspace = el?.closest('.workspace-scroll'),
      content = el?.closest('.content');
    if (!el || !dashboard || !workspace || !content) return;
    const fit = () => {
      if (innerWidth <= 980) {
        el.style.removeProperty('height');
        return;
      }
      const style = getComputedStyle(content),
        fixed = dashboard.offsetHeight - el.offsetHeight;
      const available =
        workspace.clientHeight -
        fixed -
        parseFloat(style.paddingTop) -
        parseFloat(style.paddingBottom);
      const height = `${Math.max(400, Math.floor(available))}px`;
      if (el.style.height !== height) el.style.height = height;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(dashboard);
    observer.observe(workspace);
    window.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, []);
  async function commit(value: Layout) {
    try {
      await setDashboardLayout(value);
    } catch {
      moveTo(layout);
    }
  }
  function pointer(event: PointerEvent<HTMLDivElement>, axis: 'columns' | 'rows') {
    if (dragging.current !== axis) return;
    const rect = (axis === 'columns' ? columnsRef : root).current?.getBoundingClientRect();
    if (!rect) return;
    const value =
      axis === 'columns'
        ? (event.clientX - rect.left - 6) / (rect.width - 12)
        : (event.clientY - rect.top - 6) / (rect.height - 12);
    (axis === 'columns' ? columns : rows).set(clampSplit(value, axis));
    refreshAria((value) => value + 1);
  }
  function splitter(axis: 'columns' | 'rows') {
    const value = axis === 'columns' ? columns : rows;
    return (
      <div
        className={`dashboard-splitter splitter-${axis}`}
        role="separator"
        tabIndex={0}
        aria-label={axis === 'columns' ? '调整今天与截止倒计时宽度' : '调整日程与项目进展高度'}
        aria-orientation={axis === 'columns' ? 'vertical' : 'horizontal'}
        aria-valuemin={axis === 'columns' ? 32 : 40}
        aria-valuemax={axis === 'columns' ? 72 : 82}
        aria-valuenow={Math.round(value.get() * 100)}
        onDoubleClick={() => void commit({ ...layout, [axis]: defaultLayout[axis] })}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          stop();
          dragging.current = axis;
          setActive(axis);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => pointer(event, axis)}
        onPointerUp={(event) => {
          if (dragging.current !== axis) return;
          pointer(event, axis);
          dragging.current = null;
          setActive(null);
          event.currentTarget.releasePointerCapture(event.pointerId);
          void commit({ columns: columns.get(), rows: rows.get() });
        }}
        onPointerCancel={() => {
          dragging.current = null;
          setActive(null);
          moveTo(layout);
        }}
        onLostPointerCapture={() => {
          if (dragging.current === axis) {
            dragging.current = null;
            setActive(null);
            moveTo(layout);
          }
        }}
        onKeyDown={(event) => {
          const backwards = axis === 'columns' ? 'ArrowLeft' : 'ArrowUp',
            forwards = axis === 'columns' ? 'ArrowRight' : 'ArrowDown';
          if (![backwards, forwards, 'Home'].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? defaultLayout[axis]
              : clampSplit(layout[axis] + (event.key === forwards ? 0.025 : -0.025), axis);
          void commit({ ...layout, [axis]: next });
        }}
      >
        <span />
      </div>
    );
  }
  return (
    <motion.div
      ref={root}
      className="dashboard-workbench"
      data-resizing={active ?? undefined}
      style={{ gridTemplateRows: templateRows }}
    >
      <motion.div
        ref={columnsRef}
        className="dashboard-columns"
        style={{ gridTemplateColumns: templateColumns }}
      >
        {today}
        {splitter('columns')}
        {deadlines}
      </motion.div>
      {splitter('rows')}
      {projects}
    </motion.div>
  );
}
