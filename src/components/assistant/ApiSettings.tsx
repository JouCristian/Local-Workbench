import { useEffect, useState } from 'react';
import { KeyRound, Check, LoaderCircle } from 'lucide-react';
import { assistantRepository as api } from '../../data/assistant';
import { errorMessage } from '../../state';

export function ApiSettings({ onConfigured }: { onConfigured?: () => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null),
    [key, setKey] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState('');
  useEffect(() => {
    api
      .configured()
      .then(setConfigured)
      .catch((e) => setResult(errorMessage(e)));
  }, []);
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setResult('');
    try {
      await action();
      setResult(message);
      setKey('');
      setConfigured(await api.configured());
      onConfigured?.();
    } catch (e) {
      setResult(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="assistant-api-settings" aria-label="DeepSeek API 设置">
      <div className="assistant-settings-heading">
        <KeyRound size={19} />
        <h2>DeepSeek API</h2>
      </div>
      <p>使用你自己的 API Key。密钥由 Windows 凭据管理器保存，不包含在 JSON 导出中。</p>
      <span className="assistant-key-status">
        {configured === null ? (
          '正在检查配置…'
        ) : configured ? (
          <>
            <Check size={14} />
            已保存密钥
          </>
        ) : (
          '尚未配置密钥'
        )}
      </span>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.saveKey(key), '密钥已安全保存，可以开始对话。');
        }}
      >
        <label className="field">
          <span>{configured ? '更换 API Key' : 'API Key'}</span>
          <input
            type="password"
            aria-label="DeepSeek API Key"
            autoComplete="off"
            spellCheck={false}
            value={key}
            placeholder={configured ? '输入新密钥以替换' : '粘贴你的 DeepSeek API Key'}
            onChange={(e) => setKey(e.target.value)}
            disabled={busy}
          />
        </label>
        <div className="assistant-settings-actions">
          <button className="primary-button" disabled={busy || !key.trim()}>
            {busy && <LoaderCircle className="assistant-spinner" size={15} />}保存密钥
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !configured}
            onClick={() => void run(api.test, '连接成功，密钥有效。')}
          >
            测试连接
          </button>
          {configured && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void run(api.deleteKey, '本机密钥已移除。')}
            >
              移除密钥
            </button>
          )}
        </div>
      </form>
      {result && (
        <p className="assistant-inline-status" role="status">
          {result}
        </p>
      )}
      <div className="assistant-privacy-note">
        <strong>发送前，由你决定</strong>
        <p>
          对话将发送到 DeepSeek。开启“读取工作台”后，助手按需查询并发送相关记录，每次查询最多返回
          100
          项，更多内容可分页查看；明确要求时也可查询归档内容。关闭后不能查询工作台，但当前对话、附件和已经准备的操作预览仍会发送。
          每次携带最近 24 条消息，以及本对话已记录的目标和操作状态。历史对话和附件保存在本机，业务
          JSON 备份暂不包含助手历史；如需隔离此前分享的信息，请开启新对话。
        </p>
        <p>
          新增、修改、删除和批量操作都会先展示预览，点击确认后才保存。暂停或取消预览不会改动业务记录，已执行的操作会保留实际结果。
        </p>
        <p>
          Flash 支持图片；Pro 仅支持文本。附件支持 UTF-8 文本、Markdown、CSV、JSON
          及常用图片，每份最多 5 MB，文本最多 100 KB。语音将在后续版本开放。
        </p>
      </div>
    </section>
  );
}
