import { useContentEntrance } from '../components/motion';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import {
  Download,
  Upload,
  Monitor,
  Moon,
  Sun,
  ShieldCheck,
  Database,
  FileJson,
  FolderArchive,
  KeyRound,
  ChevronRight,
} from 'lucide-react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { getVersion } from '@tauri-apps/api/app';
import { useStore, errorMessage } from '../state';
import { repository } from '../data/repository';
import { parseSnapshot, type Snapshot } from '../domain/model';
import { localDate } from '../domain/dates';
import { Confirm } from '../components/Modal';
import example from '../../examples/generic.json';
import { accents } from '../domain/preferences';
import { Check } from 'lucide-react';

export function Settings({ onAssistantSettings }: { onAssistantSettings: () => void }) {
  const entrance = useContentEntrance();
  const {
    data,
    theme,
    setTheme,
    fontScale,
    setFontScale,
    accent,
    setAccent,
    restore,
    notify,
    report,
    busy,
  } = useStore();
  const [directory, setDirectory] = useState('正在读取…'),
    [version, setVersion] = useState('0.1.0');
  const [pending, setPending] = useState<Snapshot | null>(null),
    [working, setWorking] = useState(false),
    [result, setResult] = useState('');
  useEffect(() => {
    repository.directory().then(setDirectory).catch(report);
    getVersion().then(setVersion).catch(report);
  }, []);
  async function exportFile(backup: boolean) {
    setWorking(true);
    try {
      const path = await save({
        title: backup ? '备份工作台' : '导出 JSON',
        defaultPath: `local-workbench-${backup ? 'backup-' : ''}${localDate()}.json`,
        filters: [{ name: 'Local Workbench JSON', extensions: ['json'] }],
      });
      if (!path) return;
      await writeTextFile(path, JSON.stringify(await repository.snapshot(), null, 2));
      setResult(`已${backup ? '备份' : '导出'}：${path}`);
      notify(backup ? '备份已保存' : 'JSON 已导出');
    } catch (e) {
      report(e);
      setResult(errorMessage(e));
    } finally {
      setWorking(false);
    }
  }
  async function importFile() {
    setWorking(true);
    try {
      const path = await open({
        title: '导入或恢复工作台',
        multiple: false,
        directory: false,
        filters: [{ name: 'Local Workbench JSON', extensions: ['json'] }],
      });
      if (!path) return;
      setPending(parseSnapshot(await readTextFile(path)));
    } catch (e) {
      report(e);
      setResult(`导入未执行：${errorMessage(e)}`);
    } finally {
      setWorking(false);
    }
  }
  const total =
    data.projects.length +
    data.stages.length +
    data.tasks.length +
    data.schedules.length +
    data.events.length;
  return (
    <div className="settings-page">
      <motion.div variants={entrance} className="page-heading">
        <div>
          <h1>设置</h1>
        </div>
      </motion.div>
      <div className="settings-layout">
        <motion.section variants={entrance} className="panel settings-section">
          <h2>外观</h2>
          <p>选择适合当下环境的界面。</p>
          <div className="theme-options">
            {[
              { value: 'light', title: '浅色', icon: Sun },
              { value: 'dark', title: '深色', icon: Moon },
              { value: 'system', title: '跟随系统', icon: Monitor },
            ].map(({ value, title, icon: Icon }) => (
              <button
                key={value}
                aria-pressed={theme === value}
                className={`theme-option ${theme === value ? 'selected' : ''}`}
                onClick={() => void setTheme(value).catch(() => {})}
                disabled={busy}
              >
                <span className={`theme-preview ${value}`}>
                  <span />
                  <span />
                  <span />
                </span>
                <span>
                  <Icon size={16} />
                  {title}
                </span>
              </button>
            ))}
          </div>
          <p className="field-hint">页面、侧栏与弹窗使用轻柔过渡，并遵循系统减少动态效果设置。</p>
          <div className="accent-setting">
            <h3>个性化颜色</h3>
            <p>为导航、按钮和焦点选择强调色。截止状态与项目色保留原意。</p>
            <div className="accent-options" role="group" aria-label="个性化颜色">
              {accents.map((color) => (
                <button
                  type="button"
                  key={color.id}
                  aria-label={color.label}
                  aria-pressed={accent === color.id}
                  className="accent-option"
                  disabled={busy}
                  onClick={() => void setAccent(color.id).catch(() => {})}
                >
                  <span style={{ background: `var(--accent-${color.id})` }}>
                    {accent === color.id && <Check size={14} />}
                  </span>
                  {color.label}
                </button>
              ))}
            </div>
          </div>
          <div className="font-size-setting">
            <div>
              <h3>字体大小</h3>
              <p>随窗口宽度自适应，也可以选择更适合你的阅读大小。</p>
            </div>
            <div className="segmented" role="group" aria-label="字体大小">
              {[
                ['compact', '紧凑'],
                ['standard', '标准'],
                ['large', '大号'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={fontScale === value ? 'selected' : ''}
                  aria-pressed={fontScale === value}
                  onClick={() => void setFontScale(value).catch(report)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </motion.section>
        <motion.section
          variants={entrance}
          className="panel settings-section assistant-settings-entry"
        >
          <button className="setting-row" onClick={onAssistantSettings}>
            <span className="setting-icon">
              <KeyRound size={19} />
            </span>
            <span>
              <strong>工作台助手 API 设置</strong>
              <span>配置 DeepSeek 密钥、连接与隐私</span>
            </span>
            <ChevronRight size={17} />
          </button>
        </motion.section>
        <motion.section variants={entrance} className="panel settings-section">
          <h2>数据与备份</h2>
          <p>完整 JSON 包含项目、阶段、任务、日程和特殊日期。外观设置留在当前设备。</p>
          <div className="setting-row">
            <span className="setting-icon">
              <Download size={19} />
            </span>
            <div>
              <h3>JSON 导出</h3>
              <p>可阅读、可迁移的完整数据文件</p>
            </div>
            <button disabled={working || busy} onClick={() => void exportFile(false)}>
              导出 JSON
            </button>
          </div>
          <div className="setting-row">
            <span className="setting-icon">
              <Upload size={19} />
            </span>
            <div>
              <h3>JSON 导入</h3>
              <p>校验格式、UUID、日期和关联关系后覆盖</p>
            </div>
            <button disabled={working || busy} onClick={() => void importFile()}>
              导入 JSON
            </button>
          </div>
          <div className="setting-row">
            <span className="setting-icon">
              <FolderArchive size={19} />
            </span>
            <div>
              <h3>数据备份与恢复</h3>
              <p>备份为完整 JSON；恢复前会自动保存原数据</p>
            </div>
            <div className="button-group">
              <button disabled={working || busy} onClick={() => void exportFile(true)}>
                创建备份
              </button>
              <button disabled={working || busy} onClick={() => void importFile()}>
                恢复备份
              </button>
            </div>
          </div>
          <div className="setting-row">
            <span className="setting-icon">
              <FileJson size={19} />
            </span>
            <div>
              <h3>通用示例</h3>
              <p>不含个人资料的示例，用于熟悉工作流</p>
            </div>
            <button
              disabled={working || busy}
              onClick={() => {
                try {
                  setPending(parseSnapshot(JSON.stringify(example)));
                } catch (e) {
                  report(e);
                }
              }}
            >
              导入示例
            </button>
          </div>
          {result && (
            <p className="file-result" role="status">
              {result}
            </p>
          )}
        </motion.section>
        <motion.section variants={entrance} className="panel settings-section">
          <h2>本地存储</h2>
          <div className="storage-summary">
            <Database size={24} />
            <div>
              <strong>SQLite · {total} 条记录</strong>
              <p>
                {data.projects.length} 项目 · {data.stages.length} 阶段 · {data.tasks.length} 任务 ·{' '}
                {data.schedules.length} 日程 · {data.events.length} 事件
              </p>
            </div>
          </div>
          <label className="field">
            <span>应用数据目录（数据库与自动恢复备份）</span>
            <input aria-label="应用数据目录" readOnly value={directory} />
          </label>
          <p className="field-hint">
            数据库文件：workbench.db。恢复前的自动备份位于 backups
            子目录，需自行定期清理。卸载前请导出备份。
          </p>
        </motion.section>
        <motion.section variants={entrance} className="about-workbench">
          <ShieldCheck size={22} />
          <div>
            <h2>
              Local Workbench <span>v{version}</span>
            </h2>
            <p>本地优先 · 完全离线 · MIT 开源</p>
            <p>核心功能无需账号、网络连接或在线服务。</p>
          </div>
        </motion.section>
      </div>

      <AnimatePresence>
        {pending && (
          <Confirm
            title="确认导入数据"
            message={`将导入 ${pending.projects.length} 个项目、${pending.stages.length} 个阶段、${pending.tasks.length} 个任务、${pending.schedules.length} 条日程、${pending.events.length} 个事件。当前工作台数据将被完整替换，恢复前会在应用数据目录自动备份。外观设置保留。`}
            label="备份当前数据并导入"
            danger={false}
            close={() => setPending(null)}
            action={async () => {
              const path = await restore(pending);
              setResult(`导入完成。原数据备份：${path}`);
              notify('数据已导入并保存到 SQLite');
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
