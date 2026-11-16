import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { MoreHorizontal, Trash2, Pencil, Pin, PinOff } from 'lucide-react';
import { errorMessage } from '../../state';
import { Popover } from '../Controls';
import { appleEase, useMotionPreference } from '../motion';
import type { Conversation } from '../../domain/assistant';

export function ConversationMenu({
  conversation,
  busy,
  remove,
  rename,
  pin,
}: {
  conversation: Conversation;
  busy: boolean;
  remove: () => Promise<void>;
  rename: (title: string) => Promise<void>;
  pin: (pinned: boolean) => Promise<void>;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false),
    [confirm, setConfirm] = useState(false),
    [renaming, setRenaming] = useState(false),
    [title, setTitle] = useState(conversation.title),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  return (
    <>
      <button
        ref={anchor}
        className="icon-button assistant-history-more"
        aria-label={`对话选项 ${conversation.title}`}
        aria-expanded={open}
        onClick={() => {
          setConfirm(false);
          setRenaming(false);
          setError('');
          setTitle(conversation.title);
          setOpen((v) => !v);
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      <Popover
        label={`对话选项 ${conversation.title}`}
        open={open}
        close={() => setOpen(false)}
        anchor={anchor}
        animation="card"
        className="assistant-history-menu"
      >
        {renaming ? (
          <form
            className="assistant-menu-confirm"
            aria-label="重命名对话"
            onSubmit={async (e) => {
              e.preventDefault();
              if (saving) return;
              setSaving(true);
              setError('');
              try {
                await rename(title);
                setOpen(false);
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setSaving(false);
              }
            }}
          >
            <label>
              对话名称
              <input
                aria-label="对话名称"
                value={title}
                maxLength={40}
                onChange={(e) => setTitle(e.target.value)}
                disabled={saving}
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <footer>
              <button type="button" className="text-button" onClick={() => setOpen(false)}>
                取消
              </button>
              <button type="submit" className="secondary-button" disabled={saving || !title.trim()}>
                保存名称
              </button>
            </footer>
          </form>
        ) : confirm ? (
          <div className="assistant-menu-confirm" role="alertdialog" aria-label="确认删除对话">
            <p>删除这段本地对话？</p>
            <span>已创建的任务和日程会保留。</span>
            <footer>
              <button className="text-button" onClick={() => setOpen(false)}>
                取消
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  void remove();
                }}
              >
                确认删除
              </button>
            </footer>
          </div>
        ) : (
          <div role="menu">
            <button
              role="menuitem"
              disabled={busy || saving}
              onClick={() => {
                setTitle(conversation.title);
                setRenaming(true);
              }}
            >
              <Pencil size={15} />
              重命名
            </button>
            <button
              role="menuitem"
              disabled={busy || saving}
              onClick={async () => {
                setSaving(true);
                setError('');
                try {
                  await pin(!conversation.pinned_at);
                  setOpen(false);
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setSaving(false);
                }
              }}
            >
              {conversation.pinned_at ? <PinOff size={15} /> : <Pin size={15} />}{' '}
              {conversation.pinned_at ? '取消置顶' : '置顶对话'}
            </button>
            <button role="menuitem" disabled={busy} onClick={() => setConfirm(true)}>
              <Trash2 size={15} />
              删除对话
            </button>
            {error && <p role="alert">{error}</p>}
          </div>
        )}
      </Popover>
    </>
  );
}

export function ContextCaption({ readLocal }: { readLocal: boolean }) {
  const reduced = useMotionPreference();
  const [face, setFace] = useState({ value: readLocal, sequence: 0 });
  if (face.value !== readLocal) {
    // A returning boolean key would revive an exiting face and rotate it back.
    // Each change gets a fresh face, so interrupted turns always move forward.
    setFace({ value: readLocal, sequence: face.sequence + 1 });
  }
  return (
    <div className="assistant-caption-cube" aria-live="polite">
      <AnimatePresence initial={false}>
        <motion.p
          key={face.sequence}
          data-caption-sequence={face.sequence}
          className="assistant-composer-caption"
          initial={{ rotateX: -90, opacity: 0, y: 8 }}
          animate={{ rotateX: 0, opacity: 1, y: 0 }}
          exit={{ rotateX: 90, opacity: 0, y: -8 }}
          transition={{ duration: reduced ? 0 : 0.54, ease: appleEase }}
          style={{ transformOrigin: '50% 50% -12px', backfaceVisibility: 'hidden' }}
        >
          {face.value
            ? '按需查询工作台，相关结果及对话将发送至 DeepSeek'
            : '不查询工作台，仅使用对话、附件及已准备的预览'}{' '}
          · 所有改动需你确认 <span>Enter 发送 · Shift Enter 换行</span>
        </motion.p>
      </AnimatePresence>
    </div>
  );
}
