import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playAttentionSound, resetAttentionSoundForTests } from './sound';

/** Records the oscillators a sound schedules; no audio device involved. */
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = 'running';
  currentTime = 10;
  destination = {};
  tones: Array<{ frequency: number; start: number }> = [];
  resume = vi.fn(async () => { this.state = 'running'; });
  suspend = vi.fn(async () => { this.state = 'suspended'; });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createOscillator() {
    const tone = { frequency: 0, start: 0 };
    this.tones.push(tone);
    return {
      type: 'sine',
      frequency: { setValueAtTime: (value: number) => { tone.frequency = value; } },
      connect: vi.fn(),
      start: (at: number) => { tone.start = at; },
      stop: vi.fn(),
    };
  }

  createGain() {
    return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
  }
}

/** Notes in the order they sound, as [frequency, seconds after the first]. */
function notes(context: FakeAudioContext): Array<[number, number]> {
  const first = Math.min(...context.tones.map((tone) => tone.start));
  return context.tones
    .map((tone): [number, number] => [tone.frequency, Math.round((tone.start - first) * 100) / 100])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetAttentionSoundForTests();
  FakeAudioContext.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('attention tones', () => {
  it('stays silent and does not throw without Web Audio', () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(() => playAttentionSound('needs_input')).not.toThrow();
  });

  it('rises for needs input, rings once for finished and falls for failed', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    playAttentionSound('needs_input');
    const context = FakeAudioContext.instances[0]!;
    const needsInput = notes(context);
    context.tones = [];
    playAttentionSound('finished');
    const finished = notes(context);
    context.tones = [];
    playAttentionSound('failed');
    const failed = notes(context);

    expect(needsInput).toHaveLength(2);
    expect(needsInput[1]![0]).toBeGreaterThan(needsInput[0]![0]);
    expect(needsInput[1]![1]).toBeGreaterThan(0);
    // One bell: its partials start together.
    expect(new Set(finished.map(([, at]) => at))).toEqual(new Set([0]));
    expect(failed[1]![0]).toBeLessThan(failed[0]![0]);
    expect(finished.map(([frequency]) => frequency)).not.toEqual(needsInput.map(([frequency]) => frequency));
    // One context, reused.
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('resumes a suspended context and lets the device go once the tones are over', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    expect(playAttentionSound('finished')).toBe(true);
    const context = FakeAudioContext.instances[0]!;
    expect(context.resume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(context.suspend).toHaveBeenCalledTimes(1);

    expect(playAttentionSound('needs_input'), 'it ran before: resuming needs no gesture').toBe(true);
    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it('says so, and schedules nothing, while autoplay rules hold a context that never ran', () => {
    class HeldAudioContext extends FakeAudioContext {
      state: AudioContextState = 'suspended';
    }
    vi.stubGlobal('AudioContext', HeldAudioContext);
    const activation = { hasBeenActive: false };
    vi.stubGlobal('navigator', { userActivation: activation });
    expect(playAttentionSound('needs_input')).toBe(false);
    const context = FakeAudioContext.instances[0]!;
    expect(context.tones, 'no late chime once the user clicks').toEqual([]);
    expect(context.resume).not.toHaveBeenCalled();

    activation.hasBeenActive = true;
    expect(playAttentionSound('needs_input')).toBe(true);
    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it('asks the autoplay policy where the browser has one', () => {
    class HeldAudioContext extends FakeAudioContext {
      state: AudioContextState = 'suspended';
    }
    vi.stubGlobal('AudioContext', HeldAudioContext);
    let policy = 'disallowed';
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: true }, getAutoplayPolicy: () => policy });
    expect(playAttentionSound('failed')).toBe(false);
    policy = 'allowed';
    expect(playAttentionSound('failed')).toBe(true);
  });
});
