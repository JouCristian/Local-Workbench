import { menuIntent, dateIntent, zoomIntent, type MotionIntent } from './presentation/navigation';
import { activeData } from './domain/records';
import { ViewSwitch } from './components/PageTransition';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Titlebar } from './components/Titlebar';
import { ScheduleCompletion } from './components/ScheduleCompletion';
import { projectStyle } from './presentation/view';
import {
  LayoutDashboard,
  ListTodo,
  CalendarDays,
  Settings as SettingsIcon,
  PanelLeft,
  ArrowUpRight,
  Plus,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  HardDrive,
  Command,
  Sparkles,
} from 'lucide-react';
import { useStore } from './state';
import { localDate } from './domain/dates';
import { Dashboard } from './pages/Dashboard';
import { Tasks } from './pages/Tasks';
import { SchedulePage } from './pages/Schedule';
import { Settings } from './pages/Settings';
import { CalendarPage } from './pages/Calendar';
import { Editor, type EditorSpec } from './components/Editor';
import { appleEase, useMotionPreference } from './components/motion';
import {
  Assistant,
  AssistantArtwork,
  useAssistantController,
} from './components/assistant/Assistant';

const pages = [
  { id: 'dashboard', label: '总览', icon: LayoutDashboard },
  { id: 'tasks', label: '任务与项目', icon: ListTodo },
  { id: 'schedule', label: '日程', icon: CalendarDays },
  { id: 'assistant', label: '工作台助手', icon: Sparkles },
  { id: 'settings', label: '设置', icon: SettingsIcon },
];
export default function App() {
  const { data, loading, error, toast, reload, report } = useStore();
  const [page, setPage] = useState('dashboard'),
    [editor, setEditor] = useState<EditorSpec | null>(null),
    [collapsed, setCollapsed] = useState(() => window.innerWidth <= 980);
  const [compact, setCompact] = useState(() => window.innerWidth <= 760);
  const assistant = useAssistantController(page === 'assistant');
  const sidebar = useRef<HTMLElement>(null),
    sidebarToggle = useRef<HTMLButtonElement>(null);
  const [today, setToday] = useState(localDate());
  const [selectedProject, setSelectedProject] = useState('independent');
  const [scheduleDate, setScheduleDate] = useState(localDate());
  const [calendarDate, setCalendarDate] = useState(localDate());
  const [calendarVisit, setCalendarVisit] = useState(0);
  const navigationPage = page === 'calendar' ? 'dashboard' : page;
  const [routeMotion, setRouteMotion] = useState<MotionIntent>({ axis: 'y', direction: 1 });
  const navigate = (destination: string, intent?: MotionIntent) => {
    setRouteMotion(
      intent ??
        (page === 'calendar' && destination === 'dashboard'
          ? zoomIntent(1)
          : menuIntent(
              pages.findIndex((item) => item.id === navigationPage),
              pages.findIndex((item) => item.id === destination),
            )),
    );
    setPage(destination);
    if (compact) setCollapsed(true);
    if (destination === 'tasks') setSelectedProject('independent');
  };
  const openCalendar = (date: string) => {
    setCalendarDate(date);
    setCalendarVisit((value) => value + 1);
    navigate('calendar', zoomIntent(-1));
  };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'j' &&
        !event.repeat &&
        !document.querySelector('dialog[open]')
      ) {
        event.preventDefault();
        assistant.setSettings(false);
        navigate('assistant');
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [page, compact]);
  const reduced = useMotionPreference();
  useEffect(() => {
    if (reduced) document.getAnimations().forEach((animation) => animation.finish());
  }, [reduced]);
  useEffect(() => {
    if (!compact || collapsed) return;
    sidebar.current?.querySelector<HTMLButtonElement>('nav button')?.focus({ preventScroll: true });
    return () => sidebarToggle.current?.focus({ preventScroll: true });
  }, [compact, collapsed]);
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)');
    const update = () => {
      setCompact(media.matches);
      if (media.matches) setCollapsed(true);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const update = () => setToday(localDate());
    const timer = setInterval(update, 30000);
    window.addEventListener('focus', update);
    const shortcut = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === 'n' &&
        !document.querySelector('dialog[open]')
      ) {
        e.preventDefault();
        setEditor({ table: 'tasks' });
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', update);
      window.removeEventListener('keydown', shortcut);
    };
  }, []);
  const active = activeData(data);
  const unfinished = active.tasks.filter((t) => t.status !== 'done').length;
  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
      <div className="desktop-shell">
        <Titlebar />
        <div
          className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} ${compact ? 'compact-shell' : ''}`}
        >
          <AnimatePresence>
            {compact && !collapsed && (
              <motion.button
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, pointerEvents: 'none' }}
                transition={{ duration: reduced ? 0 : 0.2, ease: appleEase }}
                className="sidebar-scrim"
                tabIndex={-1}
                aria-label="关闭导航侧栏"
                onClick={() => setCollapsed(true)}
              />
            )}
          </AnimatePresence>
          <aside
            ref={sidebar}
            id="workspace-sidebar"
            className="sidebar"
            aria-label="工作空间导航"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && compact) setCollapsed(true);
            }}
          >
            <div className="brand">
              <span className="brand-mark">
                <Command size={22} />
              </span>
              <div>
                <strong>Local Workbench</strong>
                <span>个人工作台</span>
              </div>
            </div>
            <div className="workspace-label" aria-hidden={collapsed} inert={collapsed}>
              我的空间
              {compact && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="收起导航侧栏"
                  onClick={() => setCollapsed(true)}
                >
                  <PanelLeft size={15} />
                </button>
              )}
            </div>
            <nav aria-label="主要导航">
              {pages.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={`nav-item ${navigationPage === id ? 'active' : ''}`}
                  aria-label={label}
                  aria-current={navigationPage === id ? 'page' : undefined}
                  title={label}
                  onClick={() => {
                    if (id === 'assistant') assistant.setSettings(false);
                    navigate(id);
                  }}
                >
                  {navigationPage === id && (
                    <motion.i
                      aria-hidden="true"
                      className="nav-active-indicator"
                      layoutId="active-navigation"
                      transition={
                        reduced ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 38 }
                      }
                    />
                  )}
                  <Icon size={19} />
                  <span>{label}</span>
                  {id === 'tasks' && unfinished > 0 && (
                    <span className="nav-count">{unfinished}</span>
                  )}
                </button>
              ))}
            </nav>
            <div className="sidebar-projects" inert={collapsed} aria-hidden={collapsed}>
              <div className="sidebar-section-label">
                项目{' '}
                <button
                  className="icon-button"
                  aria-label="新建项目"
                  onClick={() => setEditor({ table: 'projects' })}
                >
                  <Plus size={15} />
                </button>
              </div>
              {active.projects.slice(0, 8).map((p) => (
                <button
                  key={p.id}
                  className="sidebar-project"
                  style={projectStyle(data.projects, p.id)}
                  title={p.title}
                  onClick={() => {
                    setRouteMotion(
                      menuIntent(
                        pages.findIndex((item) => item.id === page),
                        pages.length + active.projects.findIndex((project) => project.id === p.id),
                      ),
                    );
                    setPage('tasks');
                    setSelectedProject(p.id);
                    if (compact) setCollapsed(true);
                  }}
                >
                  <span className="project-dot" />
                  <span>{p.title}</span>
                  <ArrowUpRight size={12} />
                </button>
              ))}
              {!active.projects.length && <span className="sidebar-empty">还没有项目</span>}
            </div>
            <div className="sidebar-bottom" aria-hidden={collapsed}>
              <div className="local-status">
                <span />
                <span>本地空间</span>
                <HardDrive size={14} />
              </div>
              <p>无需联网，随时开始。</p>
            </div>
          </aside>
          <main inert={compact && !collapsed}>
            <header className="topbar">
              <div>
                <button
                  className="icon-button"
                  ref={sidebarToggle}
                  aria-controls="workspace-sidebar"
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
                  onClick={() => setCollapsed(!collapsed)}
                >
                  <PanelLeft size={18} />
                </button>
                <span className="breadcrumb">
                  我的工作台 <span>/</span>{' '}
                  <strong>
                    {page === 'calendar' ? '日历' : pages.find((p) => p.id === page)?.label}
                  </strong>
                </span>
              </div>
              <div className="topbar-actions">
                <button
                  className="icon-button assistant-entry"
                  aria-label="打开 AI 助手"
                  title="AI 助手 · Ctrl J"
                  onClick={() => {
                    assistant.setSettings(false);
                    navigate('assistant');
                  }}
                >
                  <Sparkles size={18} />
                </button>
                <button
                  className="text-button quick-trigger"
                  onClick={() => setEditor({ table: 'tasks' })}
                >
                  <Plus size={15} />
                  快速新建 <kbd>Ctrl N</kbd>
                </button>
              </div>
            </header>
            <div className={`workspace-scroll ${page === 'assistant' ? 'assistant-route' : ''}`}>
              <div className="content route-host">
                {error && (
                  <div className="error-banner" role="alert">
                    <AlertCircle size={18} />
                    <span>{error}</span>
                    <button onClick={() => void reload().catch(report)}>
                      <RefreshCw size={14} />
                      重试读取
                    </button>
                  </div>
                )}
                {loading ? (
                  <div className="loading-state" role="status" aria-label="正在读取本地数据">
                    <div className="skeleton skeleton-heading" />
                    <div className="skeleton-grid">
                      <div className="skeleton" />
                      <div className="skeleton" />
                      <div className="skeleton" />
                      <div className="skeleton" />
                    </div>
                    <p>正在读取本地工作台…</p>
                  </div>
                ) : (
                  <ViewSwitch
                    className="route-switch"
                    viewKey={
                      page === 'calendar'
                        ? `calendar:${calendarVisit}`
                        : page === 'tasks'
                          ? `${page}:${selectedProject}`
                          : page
                    }
                    page={page}
                    axis={routeMotion.axis}
                    direction={routeMotion.direction}
                    origin={routeMotion.origin}
                    order={pages.findIndex((item) => item.id === navigationPage)}
                  >
                    <div
                      className={`route-scroll ${page === 'assistant' ? 'route-scroll-assistant' : ''}`}
                    >
                      <div
                        className={`route-content ${page === 'assistant' ? 'route-content-assistant' : ''}`}
                      >
                        {page === 'dashboard' && (
                          <Dashboard
                            today={today}
                            edit={setEditor}
                            onCalendar={() => openCalendar(today)}
                            onDateSelect={(date) => {
                              setScheduleDate(date);
                              navigate('schedule', dateIntent(today, date));
                            }}
                            onProjectSelect={(id) => {
                              setRouteMotion({ axis: 'x', direction: 1 });
                              setSelectedProject(id);
                              setPage('tasks');
                            }}
                          />
                        )}{' '}
                        {page === 'calendar' && (
                          <CalendarPage
                            key={calendarDate}
                            today={today}
                            initialDate={calendarDate}
                            onBack={() => navigate('dashboard', zoomIntent(1))}
                            onDateSelect={(date, origin) => {
                              setScheduleDate(date);
                              navigate('schedule', zoomIntent(1, origin));
                            }}
                          />
                        )}
                        {page === 'tasks' && (
                          <Tasks
                            key={selectedProject}
                            initialProject={selectedProject}
                            edit={setEditor}
                          />
                        )}{' '}
                        {page === 'schedule' && (
                          <SchedulePage
                            today={today}
                            date={scheduleDate}
                            setDate={setScheduleDate}
                            edit={setEditor}
                            onCalendar={() => openCalendar(scheduleDate)}
                          />
                        )}{' '}
                        {page === 'assistant' && <Assistant controller={assistant} />}
                        {page === 'settings' && (
                          <Settings
                            onAssistantSettings={() => {
                              assistant.setSettings(true);
                              navigate('assistant');
                            }}
                          />
                        )}
                        {!['assistant', 'dashboard', 'calendar'].includes(page) && (
                          <footer className="workspace-footer">
                            <span>Local Workbench</span>
                            <span>你的计划，只属于你。</span>
                          </footer>
                        )}
                      </div>
                    </div>
                  </ViewSwitch>
                )}
              </div>
            </div>
          </main>

          <AnimatePresence>
            {editor && (
              <Editor
                key={`${editor.table}-${editor.record?.id ?? 'new'}`}
                spec={editor}
                close={() => setEditor(null)}
              />
            )}
          </AnimatePresence>
          <div className="toast-position">
            <AnimatePresence mode="wait">
              {toast && (
                <motion.div
                  key={toast}
                  role="status"
                  className="toast"
                  initial={{ opacity: 0, y: reduced ? 0 : 10, scale: reduced ? 1 : 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: reduced ? 0 : 6 }}
                  transition={{ duration: reduced ? 0 : 0.24, ease: appleEase }}
                >
                  <CheckCircle2 size={17} />
                  {toast}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        <AssistantArtwork
          controller={assistant}
          active={page === 'assistant' && !(compact && !collapsed)}
        />
        <ScheduleCompletion />
      </div>
    </MotionConfig>
  );
}
