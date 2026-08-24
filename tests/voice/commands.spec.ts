import { describe, expect, it } from 'vitest';

/**
 * Voice command pattern matching extracted from main.ts for testability.
 *
 * The voice adapter checks transcribed text for known command patterns before
 * sending it to the core. This is simple string matching — NOT Tier 0 keyword
 * spotting (which is step 6).
 */

type CommandMatch =
  | { command: 'end_session' }
  | { command: 'confirm'; value: boolean }
  | { command: 'abort' }
  | { command: 'footnote'; text: string }
  | { command: 'search'; query: string }
  | { command: 'switch_voice'; voiceId: string }
  | { command: 'quit' }
  | null;

function matchCommand(transcript: string, isConfirming: boolean): CommandMatch {
  const lower = transcript.toLowerCase().trim();

  if (isConfirming) {
    if (lower === 'yes' || lower === 'yeah' || lower === 'confirm') {
      return { command: 'confirm', value: true };
    }
    if (lower === 'no' || lower === 'nah' || lower === 'cancel') {
      return { command: 'confirm', value: false };
    }
  }

  if (lower === 'end session' || lower === 'end the session') {
    return { command: 'end_session' };
  }
  if (lower === 'abort' || lower === 'abort session') {
    return { command: 'abort' };
  }
  if (lower.startsWith('footnote ')) {
    const text = transcript.slice('footnote '.length).trim();
    return text.length > 0 ? { command: 'footnote', text } : null;
  }
  if (lower.startsWith('search for ')) {
    const query = transcript.slice('search for '.length).trim();
    return query.length > 0 ? { command: 'search', query } : null;
  }
  if (lower.startsWith('switch voice to ')) {
    const voiceId = lower.slice('switch voice to '.length).trim();
    return voiceId.length > 0 ? { command: 'switch_voice', voiceId } : null;
  }
  if (lower === 'quit' || lower === 'exit') {
    return { command: 'quit' };
  }

  return null;
}

describe('voice command matching', () => {
  it('matches "end session"', () => {
    expect(matchCommand('end session', false)).toEqual({ command: 'end_session' });
    expect(matchCommand('End The Session', false)).toEqual({ command: 'end_session' });
  });

  it('matches confirm/deny during confirmation', () => {
    expect(matchCommand('yes', true)).toEqual({ command: 'confirm', value: true });
    expect(matchCommand('Yeah', true)).toEqual({ command: 'confirm', value: true });
    expect(matchCommand('no', true)).toEqual({ command: 'confirm', value: false });
    expect(matchCommand('Cancel', true)).toEqual({ command: 'confirm', value: false });
  });

  it('does not match yes/no outside confirmation', () => {
    expect(matchCommand('yes', false)).toBeNull();
    expect(matchCommand('no', false)).toBeNull();
  });

  it('matches abort', () => {
    expect(matchCommand('abort', false)).toEqual({ command: 'abort' });
    expect(matchCommand('abort session', false)).toEqual({ command: 'abort' });
  });

  it('matches footnote with text', () => {
    expect(matchCommand('footnote this is important', false)).toEqual({
      command: 'footnote',
      text: 'this is important',
    });
  });

  it('rejects empty footnote', () => {
    expect(matchCommand('footnote ', false)).toBeNull();
  });

  it('matches search', () => {
    expect(matchCommand('search for pivot selection', false)).toEqual({
      command: 'search',
      query: 'pivot selection',
    });
  });

  it('matches voice switch', () => {
    expect(matchCommand('switch voice to amy', false)).toEqual({
      command: 'switch_voice',
      voiceId: 'amy',
    });
  });

  it('matches quit/exit', () => {
    expect(matchCommand('quit', false)).toEqual({ command: 'quit' });
    expect(matchCommand('exit', false)).toEqual({ command: 'quit' });
  });

  it('returns null for regular speech', () => {
    expect(matchCommand('tell me about linear algebra', false)).toBeNull();
    expect(matchCommand('what is a pivot', false)).toBeNull();
  });
});
