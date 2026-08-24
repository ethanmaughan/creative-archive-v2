import * as readline from 'node:readline';

/**
 * Push-to-talk via spacebar toggle on raw stdin.
 *
 * On Windows, Node.js cannot reliably distinguish keydown from keyup, so this uses a toggle
 * model: press space once to start recording, press again to stop. This works reliably across
 * all platforms.
 */

export interface PttListener {
  /** Called when recording should start (first press). */
  onStart: () => void;
  /** Called when recording should stop (second press). */
  onStop: () => void;
}

export interface PttHandle {
  /** Whether currently in the "recording" state. */
  isRecording(): boolean;
  /** Stop listening for keypresses and restore the terminal. */
  destroy(): void;
}

export function startPtt(listener: PttListener): PttHandle {
  let recording = false;

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  readline.emitKeypressEvents(process.stdin);

  const onKeypress = (_char: string | undefined, key: readline.Key | undefined): void => {
    if (key === undefined) return;

    // Ctrl+C — always exit.
    if (key.ctrl && key.name === 'c') {
      process.emit('SIGINT');
      return;
    }

    // Spacebar toggles recording.
    if (key.name === 'space') {
      if (recording) {
        recording = false;
        listener.onStop();
      } else {
        recording = true;
        listener.onStart();
      }
    }
  };

  process.stdin.on('keypress', onKeypress);

  return {
    isRecording(): boolean {
      return recording;
    },

    destroy(): void {
      process.stdin.off('keypress', onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    },
  };
}
