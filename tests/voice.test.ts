import { describe, expect, it } from 'vitest';
import { insertTranscript } from '../src/domain/voice';

describe('voice transcription draft insertion', () => {
  it('inserts at the captured caret, without sending or altering the rest of the text', () => {
    expect(insertTranscript('明天复习', { text: '明天复习', start: 2, end: 2 }, ' 下午 ')).toBe(
      '明天下午复习',
    );
    expect(
      insertTranscript('明天下午复习', { text: '明天下午复习', start: 2, end: 4 }, '晚上'),
    ).toBe('明天晚上复习');
  });
  it('preserves newer typing instead of replacing it with the recording-time snapshot', () => {
    expect(insertTranscript('新的手动文字', { text: '旧文字', start: 0, end: 3 }, '语音内容')).toBe(
      '新的手动文字\n语音内容',
    );
    expect(insertTranscript('', { text: '已经清空的旧文字', start: 0, end: 5 }, '语音内容')).toBe(
      '语音内容',
    );
  });
  it('ignores empty recognition and bounds the selection', () => {
    expect(insertTranscript('保留', { text: '保留', start: -2, end: 99 }, '')).toBe('保留');
    expect(insertTranscript('保留', { text: '保留', start: 99, end: -1 }, '新内容')).toBe(
      '保留新内容',
    );
  });
});
