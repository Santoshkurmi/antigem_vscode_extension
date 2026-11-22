// Keyword search over memory notes (docs/crew/PLAN.md §12 "Recall"). No index and no AI: one bot's notes are a few
// hundred lines. Words of 3+ letters, a small stopword list and light stemming ("deploys", "deployed" → "deploy");
// rare words count more than common ones, a word that only starts the same counts half, and so does a word in the
// note's topic name.
const STOP = new Set(
  (
    'the and for are but not you your yours our ours his her its they them their this that these those with without ' +
    'from into onto over under about above after before again also any all can could would should will shall may ' +
    'might must have has had having was were been being does did doing done just only very more most much many some ' +
    'such than then there here when where which while who whom whose why how what yes okay please thanks thank want ' +
    'need like make made get got let lets out off own same too via per etc now'
  ).split(' '),
);

export function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ing') && w.length >= 6) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length >= 5) return w.slice(0, -2);
  if (w.endsWith('es') && w.length >= 5 && /(?:s|x|z|ch|sh)$/.test(w.slice(0, -2))) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && w.length >= 4) return w.slice(0, -1);
  return w;
}

/** The text's search words: lowercase, 3+ letters, no stopwords, stemmed, each once. */
export function words(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length >= 3 && !STOP.has(w)) out.add(stem(w));
  return [...out];
}

/** The items that match the query, with their score (unsorted: the caller breaks ties). */
export function rank<T>(items: T[], textOf: (item: T) => string, query: string, topicOf?: (item: T) => string): { item: T; score: number }[] {
  const q = words(query);
  if (!q.length || !items.length) return [];
  const docs = items.map((it) => words(textOf(it)));
  const sets = docs.map((d) => new Set(d));
  const topics = items.map((it) => new Set(topicOf ? words(topicOf(it)) : []));
  const weight = new Map(q.map((t) => [t, Math.log(1 + items.length / (1 + sets.filter((s) => s.has(t)).length))]));
  const out: { item: T; score: number }[] = [];
  items.forEach((item, i) => {
    let score = 0;
    for (const t of q) {
      const w = weight.get(t)!;
      if (sets[i].has(t)) score += w;
      else if (t.length >= 4 && docs[i].some((d) => d.length >= 4 && (d.startsWith(t) || t.startsWith(d)))) score += w / 2;
      else if (topics[i].has(t)) score += w / 2;
    }
    if (score > 0) out.push({ item, score: Math.round(score * 1000) / 1000 });
  });
  return out;
}
