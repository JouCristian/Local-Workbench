export type VoiceAnchor = { text: string; start: number; end: number };

// Insert at the recorded caret only if the text is unchanged. Concurrent typing
// is never replaced: append a separate sentence to the latest draft instead.
export function insertTranscript(current: string, anchor: VoiceAnchor, transcript: string) {
  const text = transcript.trim();
  if (!text) return current;
  if (current !== anchor.text)
    return `${current}${current && !/\s$/.test(current) ? '\n' : ''}${text}`;
  const start = Math.max(0, Math.min(anchor.start, current.length));
  const end = Math.max(start, Math.min(anchor.end, current.length));
  return current.slice(0, start) + text + current.slice(end);
}
