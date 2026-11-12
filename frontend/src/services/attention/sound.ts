import type { AttentionKind } from 'michi-shared';

/**
 * Short tones synthesized with Web Audio (no audio assets): "needs input"
 * rises, "finished" is one soft bell, "failed" falls. Quiet wherever Web
 * Audio is missing (jsdom, locked-down browsers) or refuses to start.
 */
interface Tone {
  /** Seconds after the sound starts. */
  at: number;
  frequency: number;
  /** Seconds until the tone has decayed. */
  length: number;
  /** Share of the peak gain. */
  level: number;
}

const TONES: Record<AttentionKind, readonly Tone[]> = {
  needs_input: [
    { at: 0, frequency: 659.25, length: 0.16, level: 1 }, // E5
    { at: 0.13, frequency: 987.77, length: 0.28, level: 1 }, // B5
  ],
  finished: [
    { at: 0, frequency: 783.99, length: 0.6, level: 1 }, // G5
    { at: 0, frequency: 1567.98, length: 0.32, level: 0.22 }, // its octave, for a bell
  ],
  failed: [
    { at: 0, frequency: 493.88, length: 0.16, level: 1 }, // B4
    { at: 0.13, frequency: 329.63, length: 0.32, level: 1 }, // E4
  ],
};

const PEAK_GAIN = 0.08;
const ATTACK_S = 0.012;
const SILENCE = 0.0001;
/** Release the audio device once the tones are over. */
const SUSPEND_AFTER_MS = 1500;

type AudioContextConstructor = new () => AudioContext;

interface AutoplayNavigator {
  /** Firefox: whether an AudioContext may start without a user gesture. */
  getAutoplayPolicy?: (type: 'audiocontext') => 'allowed' | 'allowed-muted' | 'disallowed';
  /** Whether the page has had a user gesture, which lets Chromium and Safari start audio. */
  userActivation?: { hasBeenActive: boolean };
}

let context: AudioContext | null = null;
let suspendTimer: ReturnType<typeof setTimeout> | null = null;
/** The context has run in this page: resuming it after our own suspend needs no gesture. */
let hasRun = false;

function audioContext(): AudioContext | null {
  if (context) return context;
  if (typeof window === 'undefined') return null;
  const Ctor = (window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext) as AudioContextConstructor | undefined;
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    return null;
  }
  return context;
}

/**
 * Whether a tone scheduled now is heard: the context runs, or it can resume
 * without a user gesture. Autoplay rules hold a context that never ran
 * suspended until the user interacts with the page; tones scheduled
 * meanwhile would play only then, late.
 */
function canSound(audio: AudioContext): boolean {
  if (audio.state === 'running') {
    hasRun = true;
    return true;
  }
  if (audio.state !== 'suspended') return false;
  if (hasRun) return true;
  const browser = (typeof navigator === 'undefined' ? undefined : navigator) as AutoplayNavigator | undefined;
  try {
    const policy = browser?.getAutoplayPolicy?.('audiocontext');
    if (policy !== undefined) return policy === 'allowed';
  } catch {
    // An engine that does not know the type: ask the activation instead.
  }
  if (browser?.userActivation) return browser.userActivation.hasBeenActive;
  return true;
}

/**
 * Play the tone for `kind`. Returns whether it is heard: false where Web Audio
 * is missing or autoplay rules keep it quiet, so an OS notification can make
 * its own sound instead. Never throws.
 */
export function playAttentionSound(kind: AttentionKind): boolean {
  const audio = audioContext();
  if (!audio) return false;
  try {
    if (!canSound(audio)) return false;
    if (suspendTimer !== null) clearTimeout(suspendTimer);
    suspendTimer = null;
    // A suspended context keeps its clock still, so tones scheduled now play once it resumes.
    if (audio.state === 'suspended') void audio.resume().then(() => { hasRun = true; }, () => {});
    const start = audio.currentTime + 0.02;
    let end = start;
    for (const tone of TONES[kind]) {
      const at = start + tone.at;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(tone.frequency, at);
      gain.gain.setValueAtTime(SILENCE, at);
      gain.gain.exponentialRampToValueAtTime(PEAK_GAIN * tone.level, at + ATTACK_S);
      gain.gain.exponentialRampToValueAtTime(SILENCE, at + tone.length);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + tone.length + 0.02);
      end = Math.max(end, at + tone.length);
    }
    suspendTimer = setTimeout(() => {
      suspendTimer = null;
      if (audio.state !== 'running') return;
      hasRun = true;
      void audio.suspend().catch(() => {});
    }, (end - audio.currentTime) * 1000 + SUSPEND_AFTER_MS);
    return true;
  } catch {
    // Sound is a nicety; the notification has been shown regardless.
    return false;
  }
}

/** @testonly */
export function resetAttentionSoundForTests(): void {
  if (suspendTimer !== null) clearTimeout(suspendTimer);
  suspendTimer = null;
  context = null;
  hasRun = false;
}
