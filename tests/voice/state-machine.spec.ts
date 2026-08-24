import { describe, expect, it } from 'vitest';

/**
 * The voice adapter state machine. Extracted for testability.
 *
 * States: idle → listening → processing → playing → idle
 *         idle → listening → processing → confirming → idle
 *         playing → listening (barge-in)
 */

type AdapterState = 'idle' | 'listening' | 'processing' | 'playing' | 'confirming';

interface Transition {
  from: AdapterState;
  event: string;
  to: AdapterState;
}

const VALID_TRANSITIONS: Transition[] = [
  { from: 'idle', event: 'ptt_start', to: 'listening' },
  { from: 'listening', event: 'ptt_stop', to: 'processing' },
  { from: 'processing', event: 'reply_received', to: 'playing' },
  { from: 'processing', event: 'empty_transcript', to: 'idle' },
  { from: 'processing', event: 'command_handled', to: 'idle' },
  { from: 'processing', event: 'end_requested', to: 'confirming' },
  { from: 'playing', event: 'playback_done', to: 'idle' },
  { from: 'playing', event: 'ptt_start', to: 'listening' }, // barge-in
  { from: 'confirming', event: 'confirmed', to: 'idle' },
  { from: 'confirming', event: 'cancelled', to: 'idle' },
  { from: 'confirming', event: 'ptt_start', to: 'listening' },
];

function canTransition(from: AdapterState, event: string): AdapterState | null {
  const match = VALID_TRANSITIONS.find((t) => t.from === from && t.event === event);
  return match?.to ?? null;
}

describe('adapter state machine', () => {
  it('idle → listening on ptt_start', () => {
    expect(canTransition('idle', 'ptt_start')).toBe('listening');
  });

  it('listening → processing on ptt_stop', () => {
    expect(canTransition('listening', 'ptt_stop')).toBe('processing');
  });

  it('processing → playing on reply_received', () => {
    expect(canTransition('processing', 'reply_received')).toBe('playing');
  });

  it('processing → idle on empty transcript', () => {
    expect(canTransition('processing', 'empty_transcript')).toBe('idle');
  });

  it('playing → idle on playback_done', () => {
    expect(canTransition('playing', 'playback_done')).toBe('idle');
  });

  it('playing → listening on barge-in', () => {
    expect(canTransition('playing', 'ptt_start')).toBe('listening');
  });

  it('confirming → idle on confirmed or cancelled', () => {
    expect(canTransition('confirming', 'confirmed')).toBe('idle');
    expect(canTransition('confirming', 'cancelled')).toBe('idle');
  });

  it('rejects invalid transitions', () => {
    expect(canTransition('idle', 'ptt_stop')).toBeNull();
    expect(canTransition('listening', 'reply_received')).toBeNull();
    expect(canTransition('playing', 'confirmed')).toBeNull();
  });

  it('full conversation cycle: idle → listen → process → play → idle', () => {
    let state: AdapterState = 'idle';
    state = canTransition(state, 'ptt_start')!;
    expect(state).toBe('listening');
    state = canTransition(state, 'ptt_stop')!;
    expect(state).toBe('processing');
    state = canTransition(state, 'reply_received')!;
    expect(state).toBe('playing');
    state = canTransition(state, 'playback_done')!;
    expect(state).toBe('idle');
  });

  it('barge-in cycle: playing → listen → process → play → idle', () => {
    let state: AdapterState = 'playing';
    state = canTransition(state, 'ptt_start')!;
    expect(state).toBe('listening');
    state = canTransition(state, 'ptt_stop')!;
    expect(state).toBe('processing');
    state = canTransition(state, 'reply_received')!;
    expect(state).toBe('playing');
    state = canTransition(state, 'playback_done')!;
    expect(state).toBe('idle');
  });

  it('end session flow: processing → confirming → idle', () => {
    let state: AdapterState = 'processing';
    state = canTransition(state, 'end_requested')!;
    expect(state).toBe('confirming');
    state = canTransition(state, 'confirmed')!;
    expect(state).toBe('idle');
  });
});
