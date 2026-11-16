import { appleEaseCss, useMotionPreference } from './motion';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from 'react';
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Search,
  X,
} from 'lucide-react';
import { localDate } from '../domain/dates';
import { validDate } from '../domain/model';
import { formatDate, parseDateInput } from '../presentation/view';

type PopoverProps = {
  label: string;
  open: boolean;
  close: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  animation?: 'fade' | 'card';
};

/** Keep the manual top layer and its measured geometry until opacity exit completes. */
export function Popover({
  label,
  open,
  close,
  anchor,
  children,
  className = '',
  animation: recipe = 'fade',
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null),
    closeRef = useRef(close);
  const reduced = useMotionPreference();
  closeRef.current = close;
  useLayoutEffect(
    () => () => {
      const panel = ref.current;
      if (panel?.matches(':popover-open')) panel.hidePopover();
    },
    [],
  );
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const showing = panel.matches(':popover-open');
    const opacity = showing ? getComputedStyle(panel).opacity : '0';
    panel.getAnimations().forEach((animation) => animation.cancel());
    panel.inert = !open;
    if (!open) {
      if (!showing) return;
      if (reduced) {
        panel.hidePopover();
        panel.style.opacity = '1';
        return;
      }
      const animation = panel.animate(
        recipe === 'card'
          ? [
              { opacity, transform: getComputedStyle(panel).transform },
              { opacity: 0, transform: 'translateY(6px) scale(.97)' },
            ]
          : [{ opacity }, { opacity: 0 }],
        {
          duration: recipe === 'card' ? 320 : 140,
          easing: appleEaseCss,
          fill: 'forwards',
        },
      );
      animation.finished
        .then(() => {
          if (panel.matches(':popover-open')) panel.hidePopover();
          panel.style.opacity = '1';
        })
        .catch(() => {});
      return () => {
        panel.style.opacity = getComputedStyle(panel).opacity;
        animation.cancel();
      };
    }
    if (!showing) panel.showPopover();
    const place = () => {
      const trigger = anchor.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect(),
        edge = 8,
        gap = 8,
        available = Math.max(100, innerHeight - edge * 2);
      panel.style.maxHeight = `${available}px`;
      if (!className.includes('calendar-popover') && !className.includes('time-popover'))
        panel.style.width = `${Math.min(Math.max(rect.width, 200), innerWidth - edge * 2)}px`;
      const width = panel.offsetWidth,
        height = panel.offsetHeight,
        below = innerHeight - rect.bottom - gap - edge,
        above = rect.top - gap - edge,
        useAbove = below < height && above > below;
      const limit = Math.max(100, useAbove ? above : below),
        shownHeight = Math.min(height, limit);
      panel.style.maxHeight = `${Math.min(available, limit)}px`;
      panel.dataset.side = useAbove ? 'top' : 'bottom';
      panel.style.left = `${Math.max(edge, Math.min(rect.left, innerWidth - width - edge))}px`;
      panel.style.top = `${Math.max(edge, Math.min(useAbove ? rect.top - gap - shownHeight : rect.bottom + gap, innerHeight - shownHeight - edge))}px`;
    };
    place();
    const animation = reduced
      ? undefined
      : panel.animate(
          recipe === 'card'
            ? [
                {
                  opacity,
                  transform: showing
                    ? getComputedStyle(panel).transform
                    : 'translateY(8px) scale(.96)',
                },
                { opacity: 1, transform: 'translateY(0) scale(1)' },
              ]
            : [{ opacity }, { opacity: 1 }],
          { duration: recipe === 'card' ? 320 : 160, easing: appleEaseCss },
        );
    panel.style.opacity = '1';
    const observer = new ResizeObserver(place);
    if (anchor.current) observer.observe(anchor.current);
    const workspace = document.querySelector('.workspace-scroll');
    if (workspace) observer.observe(workspace);
    let frame = 0;
    const follow = () => {
      place();
      let node: HTMLElement | null = anchor.current,
        moving = false;
      while (node) {
        if (node.getAnimations().some((a) => a.playState === 'running')) moving = true;
        node = node.parentElement;
      }
      if (moving) frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !panel.contains(event.target) &&
        !anchor.current?.contains(event.target)
      )
        closeRef.current();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        const trigger = anchor.current;
        if (trigger?.matches('input,button')) trigger.focus({ preventScroll: true });
        else trigger?.querySelector<HTMLElement>('button,input')?.focus({ preventScroll: true });
      }
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !panel.contains(event.target)) place();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', scroll, true);
    return () => {
      panel.style.opacity = getComputedStyle(panel).opacity;
      animation?.cancel();
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open, anchor, className, reduced, recipe]);
  return (
    <div
      ref={ref}
      popover="manual"
      className={`control-popover ${className}`}
      aria-label={label}
      data-closing={!open || undefined}
    >
      {children}
    </div>
  );
}

export type SelectOption = { value: string; label: string };
export function Select({
  label,
  value,
  onChange,
  options,
  name,
  required = false,
  className = '',
  popoverClassName = '',
  displayLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  name?: string;
  required?: boolean;
  className?: string;
  popoverClassName?: string;
  displayLabel?: string;
}) {
  const id = useId(),
    trigger = useRef<HTMLButtonElement>(null),
    search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [active, setActive] = useState(0);
  const [keyboardHighlight, setKeyboardHighlight] = useState(false);
  const filtered = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const chosen = options.find((option) => option.value === value);
  const searchable = options.length > 7;
  function reveal() {
    setKeyboardHighlight(false);
    setQuery('');
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    setOpen(true);
  }
  function choose(option: SelectOption) {
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const option = document.getElementById(`${id}-${active}`),
      list = document.getElementById(`${id}-list`);
    if (!option || !list) return;
    const itemBounds = option.getBoundingClientRect(),
      listBounds = list.getBoundingClientRect();
    if (itemBounds.top < listBounds.top) list.scrollTop += itemBounds.top - listBounds.top;
    else if (itemBounds.bottom > listBounds.bottom)
      list.scrollTop += itemBounds.bottom - listBounds.bottom;
  }, [active, open, id]);
  function keys(e: KeyboardEvent) {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      if (!open) {
        reveal();
        setKeyboardHighlight(true);
        return;
      }
      setKeyboardHighlight(true);
      setActive((old) =>
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? Math.max(0, filtered.length - 1)
            : Math.max(0, Math.min(filtered.length - 1, old + (e.key === 'ArrowDown' ? 1 : -1))),
      );
    } else if (e.key === 'Enter' || (e.key === ' ' && e.target === trigger.current)) {
      e.preventDefault();
      if (!open) reveal();
      else if (filtered[active]) choose(filtered[active]);
    }
  }
  return (
    <div className={`select-control ${className}`} onKeyDown={keys}>
      {name && <input type="hidden" name={name} value={value} />}
      <button
        ref={trigger}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-label={label}
        aria-required={required}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open && filtered[active] ? `${id}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : reveal())}
      >
        <span>{displayLabel ?? chosen?.label ?? '请选择'}</span>
        <ChevronDown size={16} className={open ? 'rotated' : ''} />
      </button>
      <Popover
        className={popoverClassName}
        label={`${label}选项`}
        open={open}
        close={() => setOpen(false)}
        anchor={trigger}
      >
        {searchable && (
          <div className="select-search">
            <Search size={15} />
            <input
              ref={search}
              aria-label={`搜索${label}`}
              placeholder="搜索选项"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
            />
          </div>
        )}
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          className="select-options"
          tabIndex={-1}
        >
          {filtered.map((option, index) => (
            <button
              type="button"
              id={`${id}-${index}`}
              key={option.value}
              role="option"
              data-value={option.value}
              aria-selected={option.value === value}
              className={`select-option ${keyboardHighlight && index === active ? 'highlighted' : ''}`}
              tabIndex={-1}
              onPointerMove={() => {
                setKeyboardHighlight(false);
                setActive(index);
              }}
              onClick={() => choose(option)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={15} />}
            </button>
          ))}
          {!filtered.length && <p className="control-empty">没有匹配选项</p>}
        </div>
      </Popover>
    </div>
  );
}

export function DatePicker({
  label,
  value,
  onChange,
  name,
  required = false,
  clearable = !required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  name?: string;
  required?: boolean;
  clearable?: boolean;
}) {
  const anchor = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState(value ? formatDate(value) : '');
  const emitted = useRef(value);
  const [month, setMonth] = useState((validDate(value) ? value : localDate()).slice(0, 7));
  useEffect(() => {
    if (value !== emitted.current) {
      emitted.current = value;
      setDraft(value && validDate(value) ? formatDate(value) : value);
    }
  }, [value]);
  const invalid = !!draft && !parseDateInput(draft);
  const [year, monthNumber] = month.split('-').map(Number);
  const [yearDraft, setYearDraft] = useState(String(year));
  useEffect(() => setYearDraft(String(year)), [year]);
  function commitYear() {
    const y = Number(yearDraft);
    if (y >= 1900 && y <= 9999) setMonth(`${y}-${String(monthNumber).padStart(2, '0')}`);
    else setYearDraft(String(year));
  }
  const first = new Date(year, monthNumber - 1, 1, 12),
    offset = (first.getDay() + 6) % 7;
  const total = new Date(year, monthNumber, 0, 12).getDate();
  const cells = Array.from(
    { length: Math.ceil((offset + total) / 7) * 7 },
    (_, i) => i - offset + 1,
  );
  const today = localDate();
  function choose(date: string) {
    setDraft(date ? formatDate(date) : '');
    emitted.current = date;
    onChange(date);
    setOpen(false);
    input.current?.focus({ preventScroll: true });
  }
  function move(direction: number) {
    const date = new Date(year, monthNumber - 1 + direction, 1, 12);
    if (date.getFullYear() >= 1900 && date.getFullYear() <= 9999)
      setMonth(localDate(date).slice(0, 7));
  }
  function reveal() {
    if (!open) setMonth((validDate(value) ? value : today).slice(0, 7));
    setOpen(!open);
  }
  return (
    <div className="date-control-wrap">
      <div className={`date-control ${invalid ? 'invalid' : ''}`} ref={anchor}>
        <input
          ref={input}
          type="text"
          aria-label={label}
          aria-invalid={invalid}
          aria-required={required}
          name={name}
          value={draft}
          placeholder="月日，如 11月13日"
          inputMode="numeric"
          maxLength={16}
          autoComplete="off"
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            emitted.current = parseDateInput(next) ?? next;
            onChange(emitted.current);
          }}
          onBlur={() => {
            const date = parseDateInput(draft);
            if (date) setDraft(formatDate(date));
          }}
          onKeyDown={(e) => {
            if (e.altKey && e.key === 'ArrowDown') {
              e.preventDefault();
              reveal();
            }
          }}
        />
        <button
          type="button"
          className="field-accessory"
          aria-label={`打开${label}日历`}
          aria-expanded={open}
          onClick={reveal}
        >
          <CalendarDays size={16} />
        </button>
      </div>
      {invalid && <span className="control-validation">请输入有效日期，例如 11月13日</span>}
      <Popover
        label={`${label}日历`}
        open={open}
        close={() => setOpen(false)}
        anchor={anchor}
        className="calendar-popover"
      >
        <div className="calendar-picker" role="dialog" aria-label={`${label}日历`}>
          <div className="picker-heading">
            <button
              type="button"
              className="icon-button"
              aria-label="上个月"
              onClick={() => move(-1)}
              disabled={month === '1900-01'}
            >
              <ChevronLeft size={17} />
            </button>
            <div className="picker-month">
              <input
                aria-label="日历年份"
                className="picker-year"
                inputMode="numeric"
                value={yearDraft}
                maxLength={4}
                onChange={(e) => setYearDraft(e.target.value)}
                onBlur={commitYear}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitYear();
                  }
                }}
              />
              <span>年 {monthNumber} 月</span>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="下个月"
              onClick={() => move(1)}
              disabled={month === '9999-12'}
            >
              <ChevronRight size={17} />
            </button>
          </div>
          <div className="picker-weekdays" aria-hidden="true">
            {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="picker-days" role="group" aria-label="选择日期">
            {cells.map((day) => {
              if (day < 1 || day > total) return <span key={day} />;
              const date = `${month}-${String(day).padStart(2, '0')}`;
              return (
                <button
                  type="button"
                  key={day}
                  aria-label={formatDate(date)}
                  data-date={date}
                  aria-pressed={date === value}
                  className={`${date === value ? 'selected' : ''} ${date === today ? 'today' : ''}`}
                  onClick={() => choose(date)}
                >
                  {day}
                </button>
              );
            })}
          </div>
          <div className="picker-footer">
            {clearable && (
              <button type="button" className="text-button" onClick={() => choose('')}>
                <X size={13} />
                清除日期
              </button>
            )}
            <button type="button" className="text-button" onClick={() => choose(today)}>
              选择今天
            </button>
          </div>
        </div>
      </Popover>
    </div>
  );
}

export function TimePicker({
  label,
  value,
  onChange,
  name,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  name?: string;
  required?: boolean;
}) {
  const anchor = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false),
    [hour, setHour] = useState(''),
    [minute, setMinute] = useState('');
  const invalid = !!value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const values = (length: number) => Array.from({ length }, (_, i) => String(i).padStart(2, '0'));
  function reveal() {
    const parts = !invalid && value ? value.split(':') : ['', ''];
    setHour(parts[0]);
    setMinute(parts[1]);
    setOpen(!open);
  }
  function apply(time: string) {
    onChange(time);
    setOpen(false);
    input.current?.focus({ preventScroll: true });
  }
  return (
    <div>
      <div className={`date-control ${invalid ? 'invalid' : ''}`} ref={anchor}>
        <input
          ref={input}
          type="text"
          aria-label={label}
          aria-required={required}
          aria-invalid={invalid}
          name={name}
          placeholder="时:分"
          value={value}
          maxLength={5}
          inputMode="numeric"
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="field-accessory"
          aria-label={`打开${label}选择器`}
          aria-expanded={open}
          onClick={reveal}
        >
          <Clock3 size={16} />
        </button>
      </div>
      {invalid && <span className="control-validation">使用 24 小时制，例如 22:00</span>}
      <Popover
        label={`${label}选择器`}
        open={open}
        close={() => setOpen(false)}
        anchor={anchor}
        className="time-popover"
      >
        <div role="dialog" aria-label={`${label}选择器`} className="time-picker">
          <div className="time-picker-columns">
            {[
              { title: '小时', values: values(24), value: hour, change: setHour },
              { title: '分钟', values: values(60), value: minute, change: setMinute },
            ].map((column) => (
              <div key={column.title}>
                <h3>{column.title}</h3>
                <div className="time-options" role="group" aria-label={column.title}>
                  {column.values.map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={column.value === option}
                      className={column.value === option ? 'selected' : ''}
                      onClick={() => column.change(option)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="picker-footer">
            {!required && (
              <button type="button" className="text-button" onClick={() => apply('')}>
                清除时间
              </button>
            )}
            <button
              type="button"
              className="primary"
              disabled={!hour || !minute}
              onClick={() => apply(`${hour}:${minute}`)}
            >
              确认时间
            </button>
          </div>
        </div>
      </Popover>
    </div>
  );
}
