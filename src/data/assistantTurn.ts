import { assistantRepository as api } from './assistant';
import { repository } from './repository';
import {
  buildDraftInserts,
  draftRevision,
  type AgentReply,
  type ChatMessage,
  type Proposal,
} from '../domain/assistant';
import { errorMessage } from '../state';

/** Accept only complete, validated draft plans, independently of streamed prose. */
export async function acceptAgentDraft(
  reply: AgentReply,
  conversationId: string,
  current: () => boolean = () => true,
) {
  let proposals: Proposal[] = [],
    notice = reply.draft_error ?? '',
    related: string | null = null;
  const action = reply.draft_action ?? (reply.proposals.length ? 'create' : 'none');
  try {
    if (action === 'create' && reply.proposals.length) {
      buildDraftInserts(reply.proposals, await repository.load());
      if (!current()) throw new Error('已停止处理');
      proposals = reply.proposals;
    } else if (action === 'replace' || action === 'cancel') {
      const rows = await api.messages(conversationId);
      const target = rows.find((m) => m.id === reply.target_id);
      if (
        !target ||
        target.draft_state !== 'pending' ||
        reply.expected_revision !== draftRevision(target)
      )
        throw new Error('草稿已变化或已结束，原有内容已保留，请按最新表单继续说明');
      if (action === 'replace') {
        if (!reply.proposals.length) throw new Error('没有完整的更新表单，原草稿已保留');
        buildDraftInserts(reply.proposals, await repository.load());
        if (!current()) throw new Error('已停止处理');
        await api.updateDraft(target.id, reply.proposals, draftRevision(target));
        notice = '已更新原草稿，仍待你确认。';
      } else {
        if (!current()) throw new Error('已停止处理');
        await api.cancelDraft(target.id, draftRevision(target));
        notice = '这组草稿已取消，未创建工作台记录。';
      }
      related = target.id;
    }
  } catch (e) {
    notice = `表单未更新：${errorMessage(e)}。正文已保留。`;
  }
  return { proposals, notice, related };
}

export function partialMessage(base: ChatMessage, text: string, error: string): ChatMessage {
  return {
    ...base,
    text,
    proposals: [],
    draft_state: 'none',
    response_status: 'partial',
    notice: `输出未完成：${error}。已保留收到的正文，可继续或重试。`,
  };
}
