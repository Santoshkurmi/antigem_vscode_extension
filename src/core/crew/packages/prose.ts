// The prose half of a Crew package (docs/crew/PLAN.md §14): the Markdown body under the frontmatter, written so any
// agent (not only AntiGem) can run the crew from the file alone. Used when exporting and when importing OpenMausBot JSON.
import type { CrewPackage } from './format';

/** A prose playbook for the body: how any agent runs this crew (the frontmatter has the full souls and playbooks). */
export function describeCrew(pkg: CrewPackage, intro = ''): string {
  const out: string[] = [`# ${pkg.name}`, ''];
  if (pkg.tagline) out.push(pkg.tagline, '');
  if (intro.trim()) out.push(intro.trim(), '');
  out.push(
    '> Give this file to any agent: it is the whole crew. AntiGem imports it directly (automations arrive paused, MCP servers arrive off).',
    '',
    '## How to run it',
    '',
    `Read the whole file first; the frontmatter above holds each bot's full standing instructions (\`soul\`) and the playbooks. ${pkg.chief ? `You act as ${pkg.chief}, the Chief: you hand work to the others, settle conflicts and give the user the final answer.` : 'Hand each part of the work to the bot whose role fits it best.'} If you cannot start separate agents, play the roles one at a time and keep their work apart. Ask before sending messages, publishing, spending money, deleting anything or turning on an automation. Never ask for pasted passwords or keys.`,
    '',
  );
  const section = (title: string, lines: string[]) => lines.length && out.push(`## ${title}`, '', ...lines, '');
  section('Outcomes', pkg.outcomes.map((o) => `- ${o}`));
  section('Needs', pkg.requirements.mcp.map((r) => `- **${r.name}**${r.reason ? `: ${r.reason}` : ''}${r.url ? ` (${r.url})` : r.command ? ` (\`${r.command}\`)` : ''}`));
  section('Team', pkg.bots.flatMap((b) => [`### ${b.emoji} ${b.name}${b.title ? ` — ${b.title}` : ''}`, '', ...(b.description ? [b.description, ''] : [])]));
  section('Rooms', pkg.rooms.flatMap((r) => [`### ${r.name}`, '', `Members: ${r.members.join(', ')}${r.lead ? ` · lead: ${r.lead}` : ''}`, '', ...(r.bulletin ? [r.bulletin, ''] : [])]));
  section('Automations (paused until the user turns them on)', pkg.automations.flatMap((a) => [`### ${a.name}`, '', `${a.bot} · ${a.when}${a.room ? ` · in ${a.room}` : ''}`, '', a.instructions, '']));
  section('Playbooks', pkg.playbooks.map((p) => `- ${p.name}`));
  out.push('## Done when', '', 'Return one clear result to the user, say what was checked and how, and list what still needs their approval or a connection.', '');
  return out.join('\n');
}
