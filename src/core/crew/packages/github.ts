// Crew packages from GitHub (docs/crew/PLAN.md §14): a repo, folder (tree) or file (blob) link becomes the raw file
// addresses to try, in order (a file: just it; a repo or folder: the usual package names, README.md last).
// fetchPackageText tries them with the fetch it is given (the editor's, or a fake in tests) and keeps the first one
// that is a package (AntiGem, BotMRR or openmaus.package JSON) of at most 4 MB.
import { PACKAGE_LIMITS } from './format';
import { detectFormat } from './openmaus';

/** Tried in this order in a repo or folder. bot.md / team.md: OpenMausBot's template folders. */
export const PACKAGE_FILE_NAMES = ['crew.md', 'CREW.md', 'package.md', 'botmrr.md', 'team.md', 'bot.md', 'openmaus.package.json', 'README.md'];

export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** raw.githubusercontent.com addresses for a GitHub link ([] when it is not a link we can read). */
export function githubCandidates(link: string): string[] {
  const raw = link.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return [];
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return [];
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'raw.githubusercontent.com') return parts.length >= 4 ? [`https://raw.githubusercontent.com/${parts.join('/')}`] : [];
  if (host === 'gist.githubusercontent.com') return parts.length >= 2 ? [`https://gist.githubusercontent.com/${parts.join('/')}`] : [];
  if (host === 'gist.github.com') return parts.length >= 2 ? [`https://gist.githubusercontent.com/${parts[0]}/${parts[1]}/raw`] : [];
  if (host !== 'github.com' && host !== 'www.github.com') return [];
  if (parts.length < 2) return [];
  const [owner, repoPart, kind, ref, ...path] = parts;
  const base = `https://raw.githubusercontent.com/${owner}/${repoPart.replace(/\.git$/, '')}`;
  // a file: github.com/o/r/blob/<ref>/<path> (or /raw/)
  if (kind === 'blob' || kind === 'raw') return ref && path.length ? [`${base}/${ref}/${path.join('/')}`] : [];
  // a folder: github.com/o/r/tree/<ref>/<path>; the repo itself: its default branch (HEAD)
  if (kind && kind !== 'tree') return [];
  const dir = kind === 'tree' && ref ? [base, ref, ...path].join('/') : `${base}/HEAD`;
  return PACKAGE_FILE_NAMES.map((name) => `${dir}/${name}`);
}

/** The first candidate that is a crew package. The error lists every address tried and why it was passed over. */
export async function fetchPackageText(link: string, fetchFn: FetchFn): Promise<{ url: string; text: string }> {
  const candidates = githubCandidates(link);
  if (!candidates.length) throw new Error(`This is not a GitHub link to a repository, folder or file: ${link}`);
  const tried: string[] = [];
  for (const url of candidates) {
    let text: string;
    try {
      const res = await fetchFn(url);
      if (!res.ok) {
        tried.push(`${url}: ${res.status === 404 ? 'not found' : `HTTP ${res.status}`}`);
        continue;
      }
      text = await res.text();
    } catch (e) {
      tried.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (Buffer.byteLength(text, 'utf8') > PACKAGE_LIMITS.bytes) {
      tried.push(`${url}: larger than 4 MB`);
      continue;
    }
    if (!detectFormat(text)) {
      tried.push(`${url}: not a crew package`);
      continue;
    }
    return { url, text };
  }
  throw new Error(`No crew package found at ${link}. Tried:\n${tried.map((t) => `- ${t}`).join('\n')}`);
}
