import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Audio I/O via ffmpeg child processes.
 *
 * No native compilation required — ffmpeg handles device access through DirectShow (Windows),
 * ALSA/PulseAudio (Linux), or AVFoundation (macOS). Audio flows as raw PCM over stdin/stdout
 * pipes, which is exactly what sherpa-onnx expects.
 */

// ── Microphone capture ────────────────────────────────────────────────────────

export interface MicCapture {
  /** Start capturing audio. Calls `onData` with Float32Array chunks (16 kHz mono, [-1,1]). */
  start(onData: (samples: Float32Array) => void): void;
  /** Stop capturing. */
  stop(): void;
  /** Release all resources. */
  destroy(): void;
}

export function createMicCapture(deviceName?: string): MicCapture {
  let proc: ChildProcess | null = null;
  let onData: ((samples: Float32Array) => void) | null = null;

  return {
    start(callback: (samples: Float32Array) => void): void {
      if (proc !== null) return;
      onData = callback;

      const inputArgs = buildInputArgs(deviceName);
      // Output: 16 kHz, mono, 16-bit signed little-endian PCM to stdout.
      proc = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        ...inputArgs,
        '-ar', '16000',
        '-ac', '1',
        '-f', 's16le',
        'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      proc.stdout!.on('data', (chunk: Buffer) => {
        // Convert 16-bit signed LE PCM to Float32Array in [-1, 1].
        const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i]! / 32768;
        }
        onData?.(float32);
      });

      proc.stderr!.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg.length > 0) console.error(`[mic] ${msg}`);
      });

      proc.on('error', (err) => {
        console.error(`[mic] ffmpeg error: ${err.message}`);
        console.error('[mic] is ffmpeg installed? install with: winget install Gyan.FFmpeg');
      });

      proc.on('close', () => {
        proc = null;
      });
    },

    stop(): void {
      if (proc === null) return;
      onData = null;
      // Send 'q' to ffmpeg stdin to gracefully stop, but since stdin is 'ignore',
      // we kill the process instead.
      proc.kill('SIGTERM');
      proc = null;
    },

    destroy(): void {
      if (proc !== null) {
        proc.kill('SIGKILL');
        proc = null;
      }
      onData = null;
    },
  };
}

// ── Speaker playback ──────────────────────────────────────────────────────────

export interface Speaker {
  /** Play raw PCM audio (Float32Array, any sample rate, mono). */
  play(samples: Float32Array, sampleRate: number): Promise<void>;
  /** Stop any currently playing audio immediately. */
  stop(): void;
  /** Release all resources. */
  destroy(): void;
}

export function createSpeaker(): Speaker {
  let proc: ChildProcess | null = null;
  let resolvePlay: (() => void) | null = null;

  return {
    play(samples: Float32Array, sampleRate: number): Promise<void> {
      // Stop any existing playback first.
      this.stop();

      return new Promise<void>((resolve) => {
        resolvePlay = resolve;

        // Convert Float32Array [-1,1] to 16-bit signed LE PCM.
        const int16 = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
          const s = Math.max(-1, Math.min(1, samples[i]!));
          int16[i] = s < 0 ? s * 32768 : s * 32767;
        }
        const buffer = Buffer.from(int16.buffer);

        proc = spawn('ffplay', [
          '-hide_banner', '-loglevel', 'error',
          '-f', 's16le',
          '-ar', String(sampleRate),
          '-ac', '1',
          '-nodisp',
          '-autoexit',
          '-i', 'pipe:0',
        ], { stdio: ['pipe', 'ignore', 'pipe'] });

        proc.stderr!.on('data', (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg.length > 0 && !msg.includes('size=')) console.error(`[speaker] ${msg}`);
        });

        proc.on('error', (err) => {
          console.error(`[speaker] ffplay error: ${err.message}`);
          resolvePlay?.();
          resolvePlay = null;
        });

        proc.on('close', () => {
          proc = null;
          resolvePlay?.();
          resolvePlay = null;
        });

        proc.stdin!.write(buffer);
        proc.stdin!.end();
      });
    },

    stop(): void {
      if (proc !== null) {
        proc.kill('SIGTERM');
        proc = null;
      }
      resolvePlay?.();
      resolvePlay = null;
    },

    destroy(): void {
      this.stop();
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildInputArgs(deviceName?: string): string[] {
  if (process.platform === 'win32') {
    // DirectShow on Windows.
    const device = deviceName ?? 'default';
    return ['-f', 'dshow', '-i', `audio=${device}`];
  }
  if (process.platform === 'darwin') {
    // AVFoundation on macOS.
    const device = deviceName ?? ':default';
    return ['-f', 'avfoundation', '-i', device];
  }
  // ALSA / PulseAudio on Linux.
  const device = deviceName ?? 'default';
  return ['-f', 'pulse', '-i', device];
}
