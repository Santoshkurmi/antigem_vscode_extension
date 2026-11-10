// ui/components/AgentWorkingSpinner.kt: the Claude Code-style "working" row — a pulsing star glyph and a playful verb
// "decoded" in with a running cursor. Same glyphs, verbs and timings. Ticks write straight to two text nodes: no
// re-render, no re-layout (the row has a fixed width, like the app's Canvas).
import { onCleanup, onMount, Show } from 'solid-js';

const BASE = ['·', '✢', '*', '✶', '✻', '✽'];
const GLYPHS = [...BASE, ...BASE.slice().reverse()];
const VERBS = [
  'Accomplishing', 'Actioning', 'Actualizing', 'Baking', 'Booping', 'Brewing', 'Calculating', 'Cerebrating',
  'Channeling', 'Churning', 'Clauding', 'Coalescing', 'Cogitating', 'Computing', 'Combobulating', 'Concocting',
  'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Deciphering', 'Deliberating',
  'Determining', 'Discombobulating', 'Doing', 'Effecting', 'Elucidating', 'Enchanting', 'Envisioning', 'Finagling',
  'Flibbertigibbeting', 'Forging', 'Forming', 'Frolicking', 'Generating', 'Germinating', 'Hatching', 'Herding',
  'Honking', 'Ideating', 'Imagining', 'Incubating', 'Inferring', 'Manifesting', 'Marinating', 'Meandering',
  'Moseying', 'Mulling', 'Mustering', 'Musing', 'Noodling', 'Percolating', 'Perusing', 'Philosophizing',
  'Pontificating', 'Pondering', 'Processing', 'Puttering', 'Puzzling', 'Reticulating', 'Ruminating', 'Schlepping',
  'Shimmying', 'Simmering', 'Smooshing', 'Spelunking', 'Spinning', 'Stewing', 'Sussing', 'Synthesizing', 'Thinking',
  'Tinkering', 'Transmuting', 'Unfurling', 'Unraveling', 'Vibing', 'Wandering', 'Whirring', 'Wibbling', 'Working',
  'Wrangling',
];
const TEXT_WIDTH = Math.max(...VERBS.map((v) => v.length)) + 3;
const GLYPH_STEP_MS = 120;
const DECODE_FRAME_MS = 40;
const WORD_DELAYS_MS = [2000, 3000];
const WORD_DELAY_MS = 5000;

const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export function WorkingSpinner(props: { color: string; compacting?: boolean; label?: string | null }) {
  let glyphEl!: HTMLSpanElement;
  let wordEl!: HTMLSpanElement;
  const timers: number[] = [];

  onMount(() => {
    let step = 0;
    glyphEl.textContent = GLYPHS[0];
    timers.push(
      window.setInterval(() => {
        step = (step + 1) % GLYPHS.length;
        glyphEl.textContent = GLYPHS[step];
      }, GLYPH_STEP_MS),
    );

    let shown = ' '.repeat(TEXT_WIDTH).split('');
    let decode: number | undefined;
    const decodeTo = (verb: string) => {
      clearInterval(decode);
      const target = (verb + '...').padEnd(TEXT_WIDTH);
      let cursor = 0;
      const frame = () => {
        if (cursor - 3 >= target.length) {
          clearInterval(decode);
          return;
        }
        for (let behind = 0; behind <= 3; behind++) {
          const k = cursor - behind;
          if (k < 0 || k >= target.length) continue;
          const want = target[k];
          shown[k] = want === ' ' ? ' ' : behind === 3 ? want : behind === 0 ? '▌' : pick(['.', '_', want]);
        }
        wordEl.textContent = shown.join('').trimEnd();
        cursor++;
      };
      frame();
      decode = window.setInterval(frame, DECODE_FRAME_MS);
    };
    const verbFor = () => (props.compacting ? 'Compacting' : pick(VERBS));
    decodeTo(verbFor());
    let changes = 0;
    const next = () => {
      const delay = WORD_DELAYS_MS[changes] ?? WORD_DELAY_MS;
      timers.push(
        window.setTimeout(() => {
          changes++;
          decodeTo(verbFor());
          next();
        }, delay),
      );
    };
    next();
    onCleanup(() => clearInterval(decode));
  });
  onCleanup(() => timers.forEach((t) => (clearInterval(t), clearTimeout(t))));

  return (
    <div class="working-row">
      <div class="working" style={{ '--glyph': props.color, '--chars': String(TEXT_WIDTH + 1) }}>
        <span class="working-glyph" ref={glyphEl} />
        <span class="working-word" ref={wordEl} />
      </div>
      <Show when={props.label}>
        <div class="working-label">{props.label}</div>
      </Show>
    </div>
  );
}
