import {
  Check,
  ChevronDown,
  LoaderCircle,
  CircleAlert,
  CalendarDays,
  ClipboardList,
} from 'lucide-react';
import type { AgentStep, QueryRecord } from '../../domain/agent';
import { tableNames } from '../../domain/agent';
import { formatDate } from '../../domain/dates';

function failureLabel(error?: string) {
  if (error?.includes('未开启读取')) return '读取工作台尚未开启';
  if (error?.includes('上限')) return '已达到处理上限';
  if (error?.includes('已变化')) return '数据已变化，需要重新核对';
  if (error?.includes('已存在') || error?.includes('已有')) return '已有相关记录或预览，需要调整';
  return '本步骤未完成，助手可调整后重试';
}

function recordSummary(record: QueryRecord) {
  if (record.facts)
    return `${record.status === 'done' ? '已完成' : record.facts.overdue ? '已逾期' : record.status === 'doing' ? '进行中' : '待办'} · 待执行 ${record.facts.schedule_pending} 次 · 已执行 ${record.facts.schedule_completed} 次`;
  if (record.execution_state)
    return `${record.execution_state === 'completed' ? '已执行' : '待执行'}${record.period === 'exact' ? ` · ${record.start_time}${record.end_time ? `–${record.end_time}` : ''}` : record.period && record.period !== 'anytime' ? ` · ${{ morning: '上午', afternoon: '下午', evening: '晚上' }[record.period] ?? ''}` : ''}`;
  return record.kind === 'rest' ? '休息日' : record.kind === 'event' ? '重要事件' : '';
}
export function AgentActivity({ steps }: { steps: AgentStep[] }) {
  if (!steps.length) return null;
  const latest = steps.at(-1)!;
  const running = steps.some((s) => s.state === 'running');
  // Show only the latest successful result for each table; past evidence retains
  // its timestamp in the tool history and is never presented as live subscription.
  const queries = [...steps]
    .reverse()
    .filter(
      (s, i, all) =>
        s.state === 'complete' &&
        s.result.data?.records &&
        !all.slice(0, i).some((p) => p.result.data?.table === s.result.data?.table),
    )
    .reverse();
  return (
    <div className="agent-activity">
      <details className="agent-tool-history">
        <summary>
          {running ? <LoaderCircle size={14} className="agent-spinner" /> : <Check size={14} />}
          <span>{running ? latest.label : `已处理 ${steps.length} 个步骤`}</span>
          <ChevronDown size={13} />
        </summary>
        <ol>
          {steps.map((s) => (
            <li key={s.id} data-tool-state={s.state}>
              {s.state === 'running' ? (
                <LoaderCircle size={13} className="agent-spinner" />
              ) : s.state === 'complete' ? (
                <Check size={13} />
              ) : (
                <CircleAlert size={13} />
              )}
              <span>
                {s.label}
                {s.state === 'failed'
                  ? `：${failureLabel(s.result.error)}`
                  : s.state === 'interrupted'
                    ? '：已中断，可重试'
                    : ''}
              </span>
            </li>
          ))}
        </ol>
      </details>
      {queries.map((s) => {
        const result = s.result.data!;
        return (
          <details className="agent-query" key={s.id} open>
            <summary>
              <ClipboardList size={14} />
              <strong>
                {tableNames[result.table!] ?? '查询结果'} · {result.total ?? result.records!.length}{' '}
                项
              </strong>
              <span>
                {result.as_of
                  ? `查询于 ${new Date(result.as_of).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
                  : ''}
              </span>
              <ChevronDown size={13} />
            </summary>
            <div>
              {result.records!.slice(0, 8).map((r) => (
                <div className="agent-query-row" key={r.id}>
                  <span>
                    <strong>{r.title}</strong>
                    <small>{recordSummary(r)}</small>
                  </span>
                  {(r.due_date || r.date) && (
                    <span className="agent-query-date">
                      <CalendarDays size={12} />
                      {formatDate(r.due_date || r.date!)}
                      {r.due_time ? ` ${r.due_time}` : ''}
                    </span>
                  )}
                </div>
              ))}
              {!result.records!.length && (
                <p className="agent-query-empty">这个范围内没有符合条件的记录</p>
              )}
              {(result.has_more || result.records!.length > 8) && (
                <p className="agent-query-empty">
                  此处展示前 {Math.min(8, result.records!.length)} 项，可继续让助手查看其余内容
                </p>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}
