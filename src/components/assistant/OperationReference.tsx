import { ArrowDownRight, Check } from 'lucide-react';
import {
  replacementTarget,
  type AgentOperation,
  type OperationPresentation,
} from '../../domain/agent';

/** Past placements are references, never a second editor or confirmation entry. */
export function OperationReference({
  operation,
  latest,
  operations,
}: {
  operation: AgentOperation;
  latest: OperationPresentation;
  operations: AgentOperation[];
}) {
  function showLatest(event: React.MouseEvent<HTMLButtonElement>) {
    const route =
      event.currentTarget.closest('.page-transition[data-present="true"]') ??
      event.currentTarget.closest('.assistant-layout');
    const target = route?.querySelector<HTMLElement>(
      `[data-operation-id="${replacementTarget(operation, operations)}"]`,
    );
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      target.focus({ preventScroll: true });
    }
  }
  return (
    <div className="agent-operation-reference" data-operation-reference={operation.id}>
      <Check size={14} />
      <span>
        {operation.superseded_by
          ? '此方案已被新方案替换'
          : latest.reason === 'present'
            ? '此预览已在后续消息重新展示'
            : '此预览已在后续消息更新'}
      </span>
      <button type="button" className="text-button" onClick={showLatest}>
        <ArrowDownRight size={13} />
        {operation.superseded_by ? '查看新方案' : '查看最新版'}
      </button>
    </div>
  );
}
