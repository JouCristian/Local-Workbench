import { Channel, invoke } from '@tauri-apps/api/core';

export type VoiceEvent =
  | { type: 'level'; level: number; elapsed_ms: number }
  | { type: 'limit' }
  | { type: 'error'; message: string };
export const voiceRepository = {
  start(id: string, onEvent: (event: VoiceEvent) => void) {
    const events = new Channel<VoiceEvent>();
    events.onmessage = onEvent;
    return invoke<void>('assistant_voice_start', { id, events });
  },
  finish: (id: string) =>
    invoke<{ text: string; duration_ms: number }>('assistant_voice_finish', { id }),
  cancel: (id: string) => invoke<void>('assistant_voice_cancel', { id }),
};
