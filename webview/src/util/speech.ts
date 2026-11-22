// Reading messages aloud (Crew Phase 9 "voice"): the webview's own speech synthesis, a voice per bot. Nothing leaves
// the machine. Where the system has no voices (some Linux setups) the buttons do not show.
import { createSignal } from 'solid-js';

const synth = (): SpeechSynthesis | null => (typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null);

const [voices, setVoices] = createSignal<SpeechSynthesisVoice[]>([]);
/** The message being read now (its id), null = none. */
const [speaking, setSpeaking] = createSignal<string | null>(null);
export { speaking, voices };

const load = () => {
  const s = synth();
  if (s) setVoices(s.getVoices());
};
load();
synth()?.addEventListener?.('voiceschanged', load);

/** Speech works here (the browser has it and at least one voice). */
export const canSpeak = () => !!synth() && voices().length > 0;

/** Text a voice can read: no code blocks, links as their words, no markdown marks. */
function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' (code) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' (link) ')
    .replace(/[*_#>|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

/**
 * Reads [text] in [voice] (a voice name; null = the default): at once (reading [id] again stops it), or after what is
 * being read now (`queue`: new room messages read one after another).
 */
export function speak(id: string, text: string, voice: string | null, queue = false) {
  const s = synth();
  if (!s) return;
  if (!queue) {
    const again = speaking() === id;
    s.cancel();
    setSpeaking(null);
    if (again) return;
  }
  const u = new SpeechSynthesisUtterance(speakable(text));
  const v = voice ? voices().find((x) => x.name === voice) : null;
  if (v) {
    u.voice = v;
    u.lang = v.lang;
  }
  u.onstart = () => setSpeaking(id);
  u.onend = u.onerror = () => setSpeaking((cur) => (cur === id ? null : cur));
  if (!queue) setSpeaking(id);
  s.speak(u);
}

export function stopSpeaking() {
  synth()?.cancel();
  setSpeaking(null);
}
