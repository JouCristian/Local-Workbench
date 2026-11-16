import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, animate, motion, useMotionValue } from 'motion/react';
import { ViewSwitch } from '../PageTransition';
import ThoughtLine from '../../vendor/thought-line/ThoughtLine';
import { ConversationMenu, ContextCaption } from './ConversationChrome';
import {
  Sparkles,
  X,
  Plus,
  MessageSquare,
  Settings2,
  ArrowUp,
  Square,
  PanelLeft,
  Paperclip,
  ShieldCheck,
  LoaderCircle,
  ArrowLeft,
  RotateCcw,
  Check,
  Pin,
} from 'lucide-react';
import { open as pickFile } from '@tauri-apps/plugin-dialog';
import Strands from '../../vendor/strands/Strands';
import { appleEase, useMotionPreference } from '../motion';
import { Select } from '../Controls';
import { assistantRepository as api } from '../../data/assistant';
import { acceptAgentDraft, partialMessage } from '../../data/assistantTurn';
import {
  assistantModels,
  draftSnapshots,
  sortConversations,
  wireMessages,
  type Attachment,
  type ChatMessage,
  type Conversation,
  type AgentEvent,
  type AgentPhase,
} from '../../domain/assistant';
import { errorMessage, useStore } from '../../state';
import { ApiSettings } from './ApiSettings';
import { DraftForms } from './DraftForms';
import { MarkdownMessage } from './MarkdownMessage';
import { AgentActivity } from './AgentActivity';
import { OperationCard } from './OperationCards';
import { OperationReference } from './OperationReference';
import {
  latestPresentation,
  operationPresentations,
  type AgentOperation,
  type AgentStep,
  type OperationPresentation,
} from '../../domain/agent';
import { formatDate, localDate } from '../../domain/dates';
import VoicePill from '../../vendor/voice-pill/VoicePill';
import { useVoiceInput } from './useVoiceInput';
import { insertTranscript } from '../../domain/voice';

// The artwork stays outside thread transitions, inside its route's animation.
// Parking the same portal between routes retains a single WebGL context.
export function AssistantArtwork({
  controller,
  active,
}: {
  controller: ReturnType<typeof useAssistantController>;
  active: boolean;
}) {
  const {
    artwork,
    responsePhase,
    settings,
    viewSession,
    messages,
    sending,
    sidebar,
    composerFocused,
  } = controller;
  const reduced = useMotionPreference();
  const host = useRef<HTMLDivElement>(null);
  const positioned = useRef(false);
  const x = useMotionValue(-3000),
    y = useMotionValue(0),
    orbScale = useMotionValue(1);
  const [target, setTarget] = useState<{ x: number; y: number; size: number; base: number } | null>(
    null,
  );
  const { accent, theme } = useStore();
  const [palette, setPalette] = useState<{
    colors: string[];
    spectrum: string[];
    light: boolean;
  } | null>(null);
  const [warm, setWarm] = useState(false);
  const [welcome, setWelcome] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const update = () =>
      setPalette({
        colors: [getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()],
        spectrum: Array.from({ length: 7 }, (_, index) =>
          getComputedStyle(document.documentElement)
            .getPropertyValue(`--assistant-spectrum-${index + 1}`)
            .trim(),
        ),
        light: document.documentElement.dataset.theme !== 'dark',
      });
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent'],
    });
    return () => observer.disconnect();
  }, [accent, theme]);
  useLayoutEffect(() => {
    host.current?.appendChild(artwork.node);
    document.body.appendChild(artwork.parking);
    if (!artwork.layer.parentElement) artwork.parking.appendChild(artwork.layer);
    return () => artwork.parking.remove();
  }, [artwork]);
  useLayoutEffect(() => {
    if (!active || settings) return;
    const anchor = document.querySelector<HTMLElement>(
      '.page-transition[data-page="assistant"][data-present="true"] .assistant-view-switch > [data-present="true"] .assistant-orb-anchor',
    );
    if (!anchor) return;
    const update = () => {
      // offset geometry excludes all Motion transforms on incoming/outgoing pages.
      let left = 0,
        top = 0,
        el: HTMLElement | null = anchor;
      const layout = anchor.closest('.assistant-layout');
      while (el && el !== layout) {
        left += el.offsetLeft;
        top += el.offsetTop;
        el = el.offsetParent as HTMLElement | null;
        if (el) {
          left += el.clientLeft;
          top += el.clientTop;
        }
      }
      const size = parseFloat(getComputedStyle(anchor).width);
      const base = Math.min(260, Math.max(180, window.innerHeight * 0.26));
      const next = { x: left + size / 2 - base / 2, y: top + size / 2 - base / 2, size, base };
      if (!messages.length && !sending) {
        const width = Math.max(160, Math.min(700, (anchor.parentElement?.clientWidth ?? 700) - 24));
        const nextWelcome = { left: left + size / 2 - width / 2, top: top + size + 12, width };
        setWelcome((old) =>
          old && old.left === nextWelcome.left && old.top === nextWelcome.top && old.width === width
            ? old
            : nextWelcome,
        );
      }
      setTarget((old) =>
        old &&
        Object.keys(next).every((k) => old[k as keyof typeof old] === next[k as keyof typeof next])
          ? old
          : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    if (anchor.parentElement) observer.observe(anchor.parentElement);
    const main = anchor.closest('.assistant-main');
    if (main) observer.observe(main);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [active, settings, viewSession, messages.length, sending, sidebar]);
  useLayoutEffect(() => {
    if (!target) return;
    const values = [
      [x, target.x],
      [y, target.y],
      [orbScale, target.size / target.base],
    ] as const;
    if (!positioned.current || reduced) {
      values.forEach(([value, next]) => value.jump(next));
      positioned.current = true;
      return;
    }
    const controls = values.map(([value, next]) =>
      animate(value, next, { duration: 0.76, ease: appleEase }),
    );
    return () => controls.forEach((control) => control.stop());
  }, [target, reduced, x, y, orbScale]);
  useEffect(() => {
    const idle = requestIdleCallback(() => setWarm(true), { timeout: 1000 });
    return () => cancelIdleCallback(idle);
  }, []);
  const busy = responsePhase !== 'idle';
  const routeAttached = !!artwork.layer.closest('[data-page="assistant"]');
  const visible =
    (active || routeAttached) && !settings && !(window.innerWidth <= 760 && sidebar) && !!target;
  return (
    <>
      {createPortal(
        <motion.div
          className="assistant-visual assistant-orb-layer"
          data-phase={responsePhase}
          aria-hidden="true"
          initial={false}
          style={{ x, y, scale: orbScale, width: target?.base ?? 260, height: target?.base ?? 260 }}
          animate={{ opacity: visible ? 1 : 0 }}
          transition={{ duration: reduced ? 0 : 0.54, ease: appleEase }}
        >
          <div className="assistant-visual-host" ref={host} />
        </motion.div>,
        artwork.layer,
      )}
      {createPortal(
        <motion.div
          className="assistant-welcome-copy assistant-welcome-layer"
          aria-hidden={!visible || !!messages.length || sending}
          initial={false}
          animate={{ opacity: visible && !messages.length && !sending ? 1 : 0 }}
          transition={{ duration: reduced ? 0 : 0.54, ease: appleEase }}
          style={welcome ?? { left: -3000, top: 0, width: 700 }}
        >
          <h2>让想法，成为安排。</h2>
          <p>聊聊要做的事，或一起为忙碌留一点空白。</p>
        </motion.div>,
        artwork.layer,
      )}
      {warm && palette
        ? createPortal(
            <Strands
              colors={busy ? palette.spectrum : palette.colors}
              glass
              count={3}
              mode={busy ? 'output' : 'idle'}
              paused={!visible}
              speed={busy ? 0.65 : composerFocused ? 0.6 : 0.38}
              energy={busy ? 0.46 : composerFocused ? 0.4 : 0.26}
              waviness={busy ? 2.4 : 1.2}
              lightMode={palette.light}
              interactive={false}
              clickPulse={!reduced}
              pulseOnly
              pulseStrength={2.5}
              intro={false}
              maxDevicePixelRatio={1}
              maxFps={30}
              saturation={busy ? 1.2 : 0.85}
              intensity={busy ? 1.4 : 1.1}
              contrast={busy ? 1.14 : 1}
              listening={busy}
            />,
            artwork.node,
          )
        : null}
    </>
  );
}
export function useAssistantController(active: boolean) {
  const [artwork] = useState(() => ({
    node: document.createElement('div'),
    layer: document.createElement('div'),
    parking: document.createElement('div'),
  }));
  artwork.node.className = 'assistant-artwork-node';
  artwork.layer.className = 'assistant-artwork-layer';
  artwork.parking.className = 'assistant-artwork-parking';
  const [history, setHistory] = useState<Conversation[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [messages, setMessages] = useState<ChatMessage[]>([]);
  const [viewSession, setViewSession] = useState(0),
    [viewDirection, setViewDirection] = useState<1 | -1>(1);
  const [newMessageIds, setNewMessageIds] = useState<string[]>([]);
  const [pendingMessage, setPendingMessage] = useState<ChatMessage | null>(null);
  const [responsePhase, setResponsePhase] = useState<'idle' | 'thinking' | 'output'>('idle');
  const [agentPhase, setAgentPhase] = useState<AgentPhase>('understanding');
  const [operations, setOperations] = useState<AgentOperation[]>([]);
  const [presentations, setPresentations] = useState<OperationPresentation[]>([]);
  const activityEpoch = useRef(0);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const operationEditors = useRef(new Map<string, () => Promise<void>>());
  const registerOperationEditor = useCallback(
    (id: string, flush: (() => Promise<void>) | null, owner?: () => Promise<void>) => {
      if (flush) operationEditors.current.set(id, flush);
      else if (!owner || operationEditors.current.get(id) === owner)
        operationEditors.current.delete(id);
    },
    [],
  );
  const updateOperation = useCallback(
    (op: AgentOperation) =>
      setOperations((old) =>
        old.some((o) => o.id === op.id) ? old.map((o) => (o.id === op.id ? op : o)) : [...old, op],
      ),
    [],
  );
  async function activity(id: string) {
    return api.activity(id);
  }
  const [composerFocused, setComposerFocused] = useState(false);
  const [input, setInput] = useState(''),
    [attachments, setAttachments] = useState<Attachment[]>([]),
    [model, setModel] = useState('deepseek-flash'),
    [readLocal, setReadLocal] = useState(true);
  const [settings, setSettings] = useState(false),
    [sidebar, setSidebar] = useState(true),
    [configured, setConfigured] = useState<boolean | null>(null);
  const [sending, setSending] = useState(false),
    [loading, setLoading] = useState(false),
    [picking, setPicking] = useState(false),
    [error, setError] = useState(''),
    [stream, setStream] = useState('');
  const requestId = useRef<string | null>(null),
    sendingLock = useRef(false),
    loadId = useRef(0),
    generation = useRef(0);
  const voice = useVoiceInput({
    enabled: active && !settings && !loading && !sending && !picking && configured === true,
    contextKey: selected ?? 'new-conversation',
    onTranscript: (text, anchor) => setInput((current) => insertTranscript(current, anchor, text)),
  });
  // Conversations keep creation order. Streaming replies must not reorder the list.
  const refreshHistory = () =>
    api.conversations().then((rows) => setHistory(sortConversations(rows)));
  const refreshConfig = () => {
    void api
      .configured()
      .then(setConfigured)
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(() => {
    if (active) {
      void refreshHistory().catch((e) => setError(errorMessage(e)));
      refreshConfig();
    }
  }, [active]);
  useEffect(
    () => () => {
      if (requestId.current) void api.cancel(requestId.current);
    },
    [],
  );
  async function select(id: string | null) {
    if (sendingLock.current) return;
    if (id === selected && !settings) return;
    const version = ++loadId.current;
    activityEpoch.current++;
    setLoading(true);
    try {
      for (const flush of operationEditors.current.values()) await flush();
      const [rows, work] = await Promise.all([
        id ? api.messages(id) : [],
        id ? activity(id) : { ops: [], trace: [], views: [] },
      ]);
      if (version === loadId.current) {
        const oldIndex = history.findIndex((c) => c.id === selected),
          nextIndex = history.findIndex((c) => c.id === id);
        setViewDirection(nextIndex >= oldIndex ? 1 : -1);
        if (rows.length || messages.length) setViewSession((v) => v + 1);
        setSelected(id);
        setMessages(rows);
        setOperations(work.ops);
        setPresentations(work.views);
        setSteps(work.trace);
        setNewMessageIds([]);
        setSettings(false);
        setError('');
        setStream('');
        setInput('');
        setAttachments([]);
        if (window.innerWidth < 760) setSidebar(false);
      }
    } catch (e) {
      if (version === loadId.current) setError(errorMessage(e));
    } finally {
      if (version === loadId.current) setLoading(false);
    }
  }
  async function newConversation() {
    if (sendingLock.current || loading) return;
    const version = ++loadId.current;
    activityEpoch.current++;
    setLoading(true);
    try {
      for (const flush of operationEditors.current.values()) await flush();
      const stamp = new Date().toISOString(),
        c = {
          id: crypto.randomUUID(),
          title: '新的工作任务',
          created_at: stamp,
          updated_at: stamp,
        };
      await api.create(c);
      if (version !== loadId.current) return;
      setHistory((old) => sortConversations([c, ...old]));
      setSelected(c.id);
      setMessages([]);
      setOperations([]);
      setPresentations([]);
      setSteps([]);
      setNewMessageIds([]);
      setViewDirection(-1);
      if (messages.length) setViewSession((v) => v + 1);
      setSettings(false);
      setError('');
      setStream('');
      setInput('');
      setAttachments([]);
      if (window.innerWidth < 760) setSidebar(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      if (version === loadId.current) setLoading(false);
    }
  }
  async function removeConversation(id: string) {
    try {
      await api.remove(id);
      if (selected === id) await select(null);
      await refreshHistory();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function renameConversation(id: string, title: string) {
    await api.rename(id, title);
    await refreshHistory();
  }
  async function pinConversation(id: string, pinned: boolean) {
    await api.setPinned(id, pinned);
    await refreshHistory();
  }
  async function attach() {
    if (picking || sending) return;
    setPicking(true);
    setError('');
    try {
      const paths = await pickFile({
        title: '添加到 AI 对话',
        multiple: true,
        filters: [
          {
            name: '文本与图片',
            extensions: ['txt', 'md', 'csv', 'json', 'png', 'jpg', 'jpeg', 'gif', 'webp'],
          },
        ],
      });
      if (!paths) return;
      const list = Array.isArray(paths) ? paths : [paths];
      if (attachments.length + list.length > 4) throw new Error('每条消息最多添加 4 个附件');
      const next: Attachment[] = [];
      for (const path of list) next.push(await api.readAttachment(path));
      if ([...attachments, ...next].reduce((n, a) => n + a.bytes, 0) > 7 * 1024 * 1024)
        throw new Error('每条消息的附件总计最多 7 MB');
      setAttachments((old) => [...old, ...next]);
      if (next.some((a) => a.kind === 'image')) setModel('deepseek-flash');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPicking(false);
    }
  }
  async function send(
    retry = false,
    options?: { text?: string; event?: AgentEvent; draftId?: string; operationId?: string },
  ) {
    if (sendingLock.current || loading || picking) return;
    if (!configured) {
      if (options?.event || options?.operationId) return;
      setSettings(true);
      return;
    }
    const turnText = options?.text ?? input;
    const turnAttachments = options ? [] : attachments;
    if (
      !retry &&
      !options?.event &&
      !options?.operationId &&
      !turnText.trim() &&
      !turnAttachments.length
    )
      return;
    sendingLock.current = true;
    const turn = ++generation.current;
    setSending(true);
    setResponsePhase('thinking');
    setAgentPhase('understanding');
    setError('');
    setStream('');
    let conversationId = selected,
      working = messages;
    let received = '';
    let answerBase: ChatMessage | null = null;
    let answerStored = false;
    try {
      for (const flush of operationEditors.current.values()) await flush();
      if (!conversationId) {
        const now = new Date().toISOString();
        const c = {
          id: crypto.randomUUID(),
          title: (input.trim() || attachments[0]?.name || '新的工作任务').slice(0, 40),
          created_at: now,
          updated_at: now,
        };
        await api.create(c);
        conversationId = c.id;
        setHistory((old) => sortConversations([c, ...old]));
      }
      if (!retry && !options?.event && !options?.operationId) {
        const user: ChatMessage = {
          id: crypto.randomUUID(),
          conversation_id: conversationId,
          role: 'user',
          text: turnText.trim() || '请帮我理解附件里的内容，并整理相关任务。',
          attachments: turnAttachments,
          proposals: [],
          draft_state: 'none',
          created_at: new Date().toISOString(),
        };
        await api.save(user);
        if (!messages.length && !history.find((c) => c.id === conversationId)?.title_manual) {
          const title = user.text.slice(0, 40);
          await api.rename(conversationId, title, false);
          await refreshHistory();
        }
        working = [...messages, user];
        setSelected(conversationId);
        setNewMessageIds((old) => [...old, user.id]);
        setMessages((current) => [...current, user]);
        if (!options) {
          setInput('');
          setAttachments([]);
        }
      }
      // Includes the latest manual edits, pending writes and completed form actions.
      working = await api.messages(conversationId);
      if (generation.current !== turn) return;
      const wire = wireMessages(working);
      if (model !== 'deepseek-flash' && JSON.stringify(wire).includes('"type":"image_url"'))
        throw new Error('这段对话包含图片，请切换到 DeepSeek Flash。');
      const id = crypto.randomUUID();
      const answerId = crypto.randomUUID(),
        answerCreatedAt = new Date().toISOString();
      answerBase = {
        id: answerId,
        conversation_id: conversationId,
        role: 'assistant',
        text: '',
        attachments: [],
        proposals: [],
        draft_state: 'none',
        created_at: answerCreatedAt,
      };
      setPendingMessage(answerBase);
      setNewMessageIds((old) => [...old, answerId]);
      requestId.current = id;
      const reply = await api.chat(
        {
          id,
          model,
          messages: wire,
          context: {
            today: localDate(),
            now_time: new Date().toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            }),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            read_local: readLocal,
            conversation_id: conversationId,
            message_id: answerId,
            operation_event: options?.operationId,
          },
          drafts: draftSnapshots(working, options?.event?.message_id ?? options?.draftId),
          action_event: options?.event,
        },
        (chunk) => {
          if (generation.current !== turn) return;
          received += chunk;
          if (received) setResponsePhase('output');
          setStream(received);
        },
        setAgentPhase,
        (step) => {
          if (generation.current !== turn) return;
          if (step.state === 'running') setResponsePhase('thinking');
          setSteps((old) =>
            old.some((s) => s.id === step.id)
              ? old.map((s) => (s.id === step.id ? step : s))
              : [...old, step],
          );
          if (
            step.state === 'complete' &&
            [
              'prepare_operation',
              'revise_operation',
              'set_operation_state',
              'present_operation',
              'replace_operation',
            ].includes(step.tool)
          ) {
            const epoch = ++activityEpoch.current;
            void api
              .activity(conversationId!)
              .then(({ ops, views }) => {
                if (generation.current === turn && activityEpoch.current === epoch) {
                  setOperations(ops);
                  setPresentations(views);
                }
              })
              .catch(() => {});
          }
        },
      );
      // Closing/cancelling after the final chunk must still not publish a late reply.
      if (requestId.current !== id || generation.current !== turn) throw new Error('已停止生成');
      const draft = await acceptAgentDraft(
        reply,
        conversationId,
        () => generation.current === turn && requestId.current === id,
      );
      if (generation.current !== turn) throw new Error('已停止生成');
      const answer: ChatMessage = {
        id: answerId,
        conversation_id: conversationId,
        role: 'assistant',
        text: reply.answer,
        attachments: [],
        proposals: draft.proposals,
        draft_state: draft.proposals.length ? 'pending' : 'none',
        notice: draft.notice,
        related_draft_id: draft.related,
        created_at: answerCreatedAt,
      };
      await api.save(answer);
      answerStored = true;
      setNewMessageIds((old) => [...old, answer.id]);
      setMessages(await api.messages(conversationId));
      setPendingMessage(null);
      setStream('');
      await refreshHistory();
    } catch (e) {
      if (answerStored) {
        setError(`回答已保存，刷新对话时出错：${errorMessage(e)}`);
      } else if (received.trim() && answerBase && conversationId) {
        try {
          await api.save(partialMessage(answerBase, received, errorMessage(e)));
          setMessages(await api.messages(conversationId));
          setError('');
        } catch (saveError) {
          setError(`正文暂未保存：${errorMessage(saveError)}`);
        }
      } else
        setError(
          options?.event || options?.operationId
            ? `操作已在本地完成，助手暂未回复：${errorMessage(e)}`
            : errorMessage(e),
        );
      setStream('');
      await refreshHistory().catch(() => {});
    } finally {
      if (conversationId) {
        try {
          const epoch = ++activityEpoch.current;
          const work = await activity(conversationId);
          if (epoch === activityEpoch.current) {
            setOperations(work.ops);
            setPresentations(work.views);
            setSteps(work.trace);
          }
        } catch {
          /* Original response/save error remains visible. */
        }
      }
      requestId.current = null;
      sendingLock.current = false;
      setSending(false);
      setResponsePhase('idle');
      setPendingMessage(null);
    }
  }
  function stop() {
    generation.current++;
    const id = requestId.current;
    requestId.current = null;
    if (id) void api.cancel(id);
  }
  const updateMessage = (message: ChatMessage) =>
    setMessages((old) => old.map((m) => (m.id === message.id ? message : m)));
  const hasImages =
    attachments.some((a) => a.kind === 'image') ||
    messages.slice(-24).some((m) => m.attachments.some((a) => a.kind === 'image'));
  return {
    voice,
    artwork,
    responsePhase,
    agentPhase,
    composerFocused,
    setComposerFocused,
    history,
    selected,
    viewSession,
    viewDirection,
    newMessageIds,
    pendingMessage,
    newConversation,
    messages,
    input,
    setInput,
    attachments,
    setAttachments,
    model,
    setModel,
    readLocal,
    setReadLocal,
    settings,
    setSettings,
    sidebar,
    setSidebar,
    configured,
    sending,
    loading,
    picking,
    error,
    setError,
    stream,
    refreshConfig,
    select,
    removeConversation,
    renameConversation,
    pinConversation,
    attach,
    send,
    stop,
    updateMessage,
    operations,
    presentations,
    steps,
    updateOperation,
    registerOperationEditor,
    afterOperation: (id: string) => send(false, { operationId: id }),
    reviewDraft: (m: ChatMessage) =>
      send(false, {
        text: `请检查当前这组待确认草稿（ID ${m.id}），以最新表单字段为准，指出缺失信息或冲突，先不要另建草稿。`,
        draftId: m.id,
      }),
    afterDraftAction: (event: AgentEvent) => send(false, { event }),
    continueMessage: () =>
      send(false, { text: '请从上一条未完成回答的断点继续，不重复已输出的内容。' }),
    retryDraft: () =>
      send(false, {
        text: '请只重新整理上一条需求涉及的表单，保留已有手动修改；正文不需要重写，不要重复新建已有任务。',
      }),
    hasImages,
  };
}
export function Assistant({
  controller,
}: {
  controller: ReturnType<typeof useAssistantController>;
}) {
  const {
    history,
    selected,
    newConversation,
    settings,
    setSettings,
    sidebar,
    setSidebar,
    sending,
    loading,
    refreshConfig,
    select,
    removeConversation,
    renameConversation,
    pinConversation,
  } = controller;
  const layout = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = layout.current!;
    el.appendChild(controller.artwork.layer);
    return () => {
      if (controller.artwork.layer.parentElement === el)
        controller.artwork.parking.appendChild(controller.artwork.layer);
    };
  }, [controller.artwork]);
  const reduced = useMotionPreference();
  return (
    <div
      ref={layout}
      className={`assistant-layout ${sidebar ? '' : 'assistant-sidebar-collapsed'}`}
    >
      <aside className="assistant-sidebar" inert={!sidebar} aria-label="助手历史对话">
        <div className="assistant-brand">
          <Sparkles size={20} />
          <strong>工作台助手</strong>
        </div>
        <button
          className="assistant-new secondary-button"
          disabled={sending || loading}
          onClick={() => void newConversation()}
        >
          <Plus size={17} />
          新的工作任务
        </button>
        <p className="assistant-history-label">最近对话</p>
        <div className="assistant-history">
          {!history.length && (
            <p className="assistant-sidebar-empty">
              从一个想法开始。
              <br />
              对话会保留在这台电脑。
            </p>
          )}
          <AnimatePresence initial={false}>
            {history.map((c) => (
              <motion.div
                layout="position"
                initial={{ height: 0, opacity: 0, y: -8 }}
                animate={{ height: 'auto', opacity: 1, y: 0 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{
                  duration: reduced ? 0 : 0.65,
                  ease: appleEase,
                  layout: { duration: reduced ? 0 : 0.65, ease: appleEase },
                }}
                key={c.id}
                data-conversation-id={c.id}
                className={`assistant-history-item ${selected === c.id && !settings ? 'active' : ''}`}
              >
                <button
                  disabled={sending || loading}
                  onClick={() => void select(c.id)}
                  title={c.title}
                >
                  <MessageSquare size={15} />
                  <span>{c.title}</span>
                  {c.pinned_at && (
                    <Pin size={12} className="assistant-pin-mark" aria-label="已置顶" />
                  )}
                </button>
                <ConversationMenu
                  conversation={c}
                  busy={sending}
                  remove={() => removeConversation(c.id)}
                  rename={(title) => renameConversation(c.id, title)}
                  pin={(pinned) => pinConversation(c.id, pinned)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        <button
          className={`assistant-settings-link ${settings ? 'active' : ''}`}
          disabled={sending}
          onClick={() => {
            setSettings(true);
            if (window.innerWidth < 760) setSidebar(false);
          }}
        >
          <Settings2 size={17} />
          API 与隐私设置
        </button>
        <span className="assistant-local-note">
          <ShieldCheck size={13} />
          历史保存在本机
        </span>
      </aside>
      <section className="assistant-main" aria-label="助手工作区">
        <header className="assistant-topbar">
          <button
            className="icon-button"
            aria-label={sidebar ? '收起助手侧栏' : '展开助手侧栏'}
            onClick={() => setSidebar((v) => !v)}
          >
            <PanelLeft size={18} />
          </button>
          <span>
            {settings
              ? 'API 与隐私设置'
              : selected
                ? (history.find((h) => h.id === selected)?.title ?? '当前对话')
                : '新的工作任务'}
          </span>
          {settings && (
            <button className="text-button assistant-back" onClick={() => setSettings(false)}>
              <ArrowLeft size={15} />
              回到对话
            </button>
          )}
        </header>
        <ViewSwitch
          viewKey={settings ? 'assistant-api' : 'assistant-chat'}
          order={settings ? 1 : 0}
          axis="x"
          direction={settings ? 1 : -1}
          className="assistant-view-switch"
        >
          {settings ? (
            <div className="assistant-settings-scroll">
              <ApiSettings onConfigured={refreshConfig} />
            </div>
          ) : (
            <AssistantConversation controller={controller} />
          )}
        </ViewSwitch>
      </section>
    </div>
  );
}

function AssistantConversation({
  controller,
}: {
  controller: ReturnType<typeof useAssistantController>;
}) {
  const composer = useRef<HTMLTextAreaElement>(null);
  const {
    artwork,
    messages,
    input,
    setInput,
    attachments,
    setAttachments,
    model,
    setModel,
    readLocal,
    setReadLocal,
    setSettings,
    configured,
    sending,
    loading,
    picking,
    error,
    setError,
    attach,
    send,
    stop,
    hasImages,
  } = controller;
  const { voice } = controller;
  return (
    <div
      className={`assistant-conversation ${messages.length ? 'has-messages' : ''} ${sending ? 'is-busy' : ''}`}
    >
      <div className="assistant-middle">
        <div className="assistant-hero">
          <div className="assistant-orb-anchor" aria-hidden="true" />
        </div>
        <ViewSwitch
          viewKey={`assistant-thread:${controller.viewSession}`}
          direction={controller.viewDirection}
          axis="y"
          className="assistant-thread-switch"
        >
          <AssistantMessages controller={controller} />
        </ViewSwitch>
      </div>
      <div className="assistant-composer-area">
        {voice.error && (
          <div className="assistant-error" role="alert">
            <span>{voice.error}。原有文字已保留。</span>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭语音提示"
              onClick={voice.dismissError}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {configured === false && (
          <button className="assistant-setup-link text-button" onClick={() => setSettings(true)}>
            连接你的 DeepSeek，开始第一段对话 <ArrowUp size={13} />
          </button>
        )}
        {error && (
          <div className="assistant-error" role="alert">
            <span>{error}</span>
            {!sending && messages.at(-1)?.role === 'user' && (
              <button className="text-button" onClick={() => void send(true)}>
                <RotateCcw size={14} />
                重试本次
              </button>
            )}
            <button className="icon-button" aria-label="关闭助手提示" onClick={() => setError('')}>
              <X size={14} />
            </button>
          </div>
        )}
        <form
          className="assistant-composer"
          onSubmit={(e) => {
            e.preventDefault();
            composer.current?.focus({ preventScroll: true });
            if (!voice.busy) void send();
          }}
        >
          {attachments.length > 0 && (
            <div className="assistant-attachments">
              {attachments.map((a) => (
                <div key={a.id}>
                  {a.kind === 'image' ? <img src={a.content} alt="" /> : <Paperclip size={14} />}
                  <span title={a.name}>{a.name}</span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`移除附件 ${a.name}`}
                    disabled={sending}
                    onClick={() => setAttachments((old) => old.filter((x) => x.id !== a.id))}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={composer}
            aria-label="给 AI 助手的消息"
            placeholder="说说要做的事，截止时间，或你想留给自己的时间…"
            value={input}
            maxLength={20000}
            readOnly={sending || loading}
            aria-busy={sending}
            rows={3}
            onFocus={() => controller.setComposerFocused(true)}
            onBlur={() => controller.setComposerFocused(false)}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (!e.ctrlKey && !e.metaKey && !e.altKey)
                artwork.node
                  .querySelector('.strands-container')
                  ?.dispatchEvent(new Event('strands-input'));
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!voice.busy) void send();
              }
            }}
          />
          <div className="assistant-composer-toolbar">
            <button
              type="button"
              className="icon-button"
              aria-label="添加本地文件或图片"
              title="添加文本或图片 · 最多 4 份"
              disabled={picking || sending || attachments.length >= 4}
              onClick={() => void attach()}
            >
              {picking ? (
                <LoaderCircle className="assistant-spinner" size={18} />
              ) : (
                <Plus size={20} />
              )}
            </button>
            <button
              type="button"
              role="checkbox"
              aria-label="读取本地工作台数据"
              aria-checked={readLocal}
              disabled={sending}
              className="assistant-context-toggle"
              onClick={() => setReadLocal((value) => !value)}
            >
              <i className="assistant-context-check" aria-hidden="true">
                {readLocal && <Check size={10} />}
              </i>
              <ShieldCheck size={14} />
              <span>读取工作台</span>
            </button>
            <div className="assistant-toolbar-actions">
              <div className="assistant-model">
                <Select
                  label="助手模型"
                  className="assistant-model-select"
                  popoverClassName="assistant-model-popover"
                  displayLabel={model === 'deepseek-flash' ? 'DeepSeek Flash' : 'DeepSeek Pro'}
                  value={model}
                  onChange={(v) => {
                    if (!sending) {
                      if (v !== 'deepseek-flash' && hasImages) {
                        setError('当前对话包含图片，请使用 DeepSeek Flash。');
                        return;
                      }
                      setModel(v);
                    }
                  }}
                  options={assistantModels}
                />
              </div>
              {sending ? (
                <button
                  type="button"
                  className="assistant-send"
                  aria-label="停止生成"
                  onClick={stop}
                >
                  <Square size={14} />
                </button>
              ) : (
                <button
                  type="submit"
                  className="assistant-send"
                  onPointerDown={(e) => e.preventDefault()}
                  aria-label={configured ? '发送消息' : '配置 API 后开始'}
                  disabled={
                    voice.busy || loading || picking || (!input.trim() && !attachments.length)
                  }
                >
                  <ArrowUp size={19} />
                </button>
              )}
              <VoicePill
                phase={voice.phase}
                level={voice.level}
                elapsed={voice.elapsed}
                disabled={sending || loading || picking || configured !== true}
                onStart={() =>
                  void voice.start({
                    text: input,
                    start: composer.current?.selectionStart ?? input.length,
                    end: composer.current?.selectionEnd ?? input.length,
                  })
                }
                onStop={() => void voice.stop()}
                onCancel={voice.cancel}
              />
            </div>
          </div>
        </form>
        <ContextCaption readLocal={readLocal} />
      </div>
    </div>
  );
}

function AssistantMessages({
  controller,
}: {
  controller: ReturnType<typeof useAssistantController>;
}) {
  const {
    selected,
    newMessageIds,
    pendingMessage,
    messages,
    sending,
    stream,
    updateMessage,
    agentPhase,
  } = controller;
  const reduced = useMotionPreference(),
    scroll = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true);
  useLayoutEffect(() => {
    nearBottom.current = true;
  }, [selected, sending]);
  useLayoutEffect(() => {
    if (nearBottom.current && scroll.current)
      scroll.current.scrollTo({ top: scroll.current.scrollHeight, behavior: 'instant' });
  }, [
    messages,
    stream,
    sending,
    pendingMessage,
    controller.steps,
    controller.operations,
    controller.presentations,
  ]);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, []);
  const displayedMessages = pendingMessage
    ? [...messages, { ...pendingMessage, text: stream }]
    : messages;
  return (
    <div
      className={`assistant-chat-scroll ${messages.length ? 'has-messages' : ''}`}
      ref={scroll}
      onScroll={() => {
        const el = scroll.current;
        if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {
        <div className="assistant-messages">
          {displayedMessages.map((m) => (
            <motion.article
              key={m.id}
              data-message-id={m.id}
              initial={newMessageIds.includes(m.id) ? { opacity: 0, y: 16, scale: 0.985 } : false}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: reduced ? 0 : 0.65, ease: appleEase }}
              className={`assistant-message assistant-message-${m.role}`}
              aria-label={m.role === 'user' ? '我的消息' : '助手回复'}
            >
              {m.role === 'assistant' && (
                <span className="assistant-message-author">
                  <Sparkles size={14} />
                  工作台助手
                </span>
              )}
              {m.role === 'assistant' && (
                <AgentActivity steps={controller.steps.filter((s) => s.message_id === m.id)} />
              )}
              <div
                className={`assistant-message-text ${m.role === 'assistant' && m.text ? 'assistant-markdown' : ''}`}
              >
                {(m.text ? (
                  m.role === 'assistant' ? (
                    <MarkdownMessage text={m.text} />
                  ) : (
                    m.text
                  )
                ) : null) ||
                  (pendingMessage?.id === m.id ? (
                    <ThoughtLine
                      label={
                        controller.steps
                          .filter((s) => s.message_id === m.id && s.state === 'running')
                          .at(-1)?.label ??
                        (agentPhase === 'understanding'
                          ? '正在理解需求'
                          : agentPhase === 'drafting'
                            ? '正在整理表单'
                            : '正在回答')
                      }
                      glyph="none"
                      collapsible={false}
                      showTimer={false}
                      color="var(--primary)"
                      fontSize={13}
                      settleDuration={320}
                      style={
                        {
                          '--tl-ease-out': 'var(--motion-ease)',
                          '--tl-ease-in-out': 'var(--motion-ease)',
                        } as React.CSSProperties
                      }
                    />
                  ) : null)}
              </div>
              {controller.operations
                .filter((op) =>
                  operationPresentations(op, controller.presentations).some(
                    (p) => p.message_id === m.id,
                  ),
                )
                .map((op) => {
                  const latest = latestPresentation(op, controller.presentations);
                  return op.superseded_by || latest.message_id !== m.id ? (
                    <OperationReference
                      key={op.id}
                      operation={op}
                      latest={latest}
                      operations={controller.operations}
                    />
                  ) : (
                    <OperationCard
                      key={op.id}
                      operation={op}
                      disabled={sending}
                      update={controller.updateOperation}
                      feedback={controller.afterOperation}
                      register={controller.registerOperationEditor}
                    />
                  );
                })}
              {m.attachments.length > 0 && (
                <div className="assistant-message-files">
                  {m.attachments.map((a) => (
                    <div key={a.id}>
                      {a.kind === 'image' ? (
                        <img src={a.content} alt={a.name} />
                      ) : (
                        <Paperclip size={14} />
                      )}
                      <span>{a.name}</span>
                    </div>
                  ))}
                </div>
              )}
              {(m.proposals.length > 0 || m.draft_state !== 'none') && (
                <DraftForms
                  message={m}
                  update={updateMessage}
                  disabled={sending}
                  review={() => controller.reviewDraft(m)}
                  afterAction={controller.afterDraftAction}
                />
              )}
              {m.notice && (
                <div className="assistant-turn-notice" role="status">
                  <span>{m.notice}</span>
                  {m.response_status === 'partial' ? (
                    <button
                      className="text-button"
                      disabled={sending}
                      onClick={() => void controller.continueMessage()}
                    >
                      从这里继续
                    </button>
                  ) : m.related_draft_id ? (
                    <button
                      className="text-button"
                      onClick={() =>
                        document
                          .querySelector<HTMLElement>(
                            `.page-transition[data-page="assistant"][data-present="true"] .assistant-thread-switch > [data-present="true"] [data-message-id="${m.related_draft_id}"]`,
                          )
                          ?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
                      }
                    >
                      查看草稿
                    </button>
                  ) : m.notice.includes('意图') ? (
                    <button
                      className="text-button"
                      disabled={sending}
                      onClick={() =>
                        document
                          .querySelector<HTMLTextAreaElement>(
                            '.page-transition[data-page="assistant"][data-present="true"] .assistant-composer textarea',
                          )
                          ?.focus({ preventScroll: true })
                      }
                    >
                      继续说明
                    </button>
                  ) : (
                    <button
                      className="text-button"
                      disabled={sending}
                      onClick={() => void controller.retryDraft()}
                    >
                      重新整理表单
                    </button>
                  )}
                </div>
              )}
              {pendingMessage?.id !== m.id && (
                <time className="assistant-message-time" dateTime={m.created_at}>
                  {formatDate(localDate(new Date(m.created_at)))}{' '}
                  {new Date(m.created_at).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              )}
            </motion.article>
          ))}
          {controller.operations
            .filter(
              (op) =>
                !displayedMessages.some(
                  (m) => m.id === latestPresentation(op, controller.presentations).message_id,
                ),
            )
            .map((op) => (
              <div className="agent-recovery" key={op.id}>
                <p>保留的操作预览</p>
                {op.superseded_by ? (
                  <OperationReference
                    operation={op}
                    latest={latestPresentation(op, controller.presentations)}
                    operations={controller.operations}
                  />
                ) : (
                  <OperationCard
                    operation={op}
                    disabled={sending}
                    update={controller.updateOperation}
                    feedback={controller.afterOperation}
                    register={controller.registerOperationEditor}
                  />
                )}
              </div>
            ))}
          {controller.steps.some((s) => !displayedMessages.some((m) => m.id === s.message_id)) && (
            <AgentActivity
              steps={controller.steps.filter(
                (s) => !displayedMessages.some((m) => m.id === s.message_id),
              )}
            />
          )}
        </div>
      }
    </div>
  );
}
