// `/plu:<plugin>[:<skill>]` (port of the app's PromptExpansion.kt pluginGuide / pluginSuggestions / baseSlashItems):
// the note a `/plu:` token expands to, and the `/` picker rows. HostSettings.expand wraps the note in the
// `<antigem-expansion command="/plu:…">` block, so the chat still shows what the user typed.
import path from 'node:path';
import type { SlashCommandView } from '../../../shared/protocol';
import { pluginServerName, type Plugin } from './types';

/** The plugin's skills folder (from its first skill's path, as the app does). */
const skillsDirOf = (p: Plugin) => (p.skills[0]?.path ? path.dirname(p.skills[0].path) : null);

const enabledPlugin = (plugins: Plugin[], id: string) => plugins.find((p) => p.isEnabled && p.id.toLowerCase() === id.toLowerCase()) ?? null;

/**
 * A short note telling the model where the plugin's skill is and how to reach its tools; null when the plugin is not
 * an enabled one (the `/plu:` text then stays as typed).
 */
export function pluginGuide(plugins: Plugin[], pluginId: string, skillName: string | null): string | null {
  const plugin = enabledPlugin(plugins, pluginId);
  if (!plugin) return null;
  const server = pluginServerName(plugin.id);
  const lines: string[] = [];
  // skill paths come from the bridge's plugin list, i.e. as the agents see them
  const skill = skillName ? plugin.skills.find((s) => s.name === skillName) : undefined;
  if (skill) {
    const name = skill.name;
    lines.push(`The user wants you to use the custom AntiGem plugin "${plugin.name}" (id: ${plugin.id}) and its skill "${name}".`);
    lines.push(`- Read the skill file fully before acting: ${skill.path}`);
    if (skill.detailDir) lines.push(`- Its detail files are in ${skill.detailDir}/ — open them only when the skill refers to them.`);
    lines.push(`- If you cannot read that file but have the MCP server "${server}", call its get_skill tool with name "${name}" instead.`);
  } else {
    lines.push(`The user wants you to use the custom AntiGem plugin "${plugin.name}" (id: ${plugin.id})${plugin.description.trim() ? `: ${plugin.description}` : '.'}`);
    const skills = plugin.skills.map((s) => s.name);
    const dir = skillsDirOf(plugin);
    if (dir)
      lines.push(`- Its skills (guides) are in ${dir}/: ${skills.slice(0, 30).join(', ')}${skills.length > 30 ? ', …' : ''}. Read the one that matches the task before acting.`);
  }
  // the skill text arrives either way; only the plugin's own tools need its MCP server
  lines.push(
    plugin.toolCount > 0
      ? `- The plugin's own tools come from the MCP server "${server}". Check whether the task depends on them. If it does and you don't have that server's tools, stop and ask the user to enable it in MCP settings → Custom AntiGem Plugin MCP. If it doesn't, do the task with the tools you already have.`
      : '- This plugin has no tools of its own: follow its instructions with the tools you already have.',
  );
  // a plugin may build on another one (its skill or tools say so): point at the other plugins' skills
  const others = plugins.filter((o) => o.isEnabled && o.id !== plugin.id && o.skills.length);
  if (others.length) {
    const listed = others
      .slice(0, 10)
      .map((o) => `${o.id} (${skillsDirOf(o)}/)`)
      .join('; ');
    lines.push(
      `- If this plugin depends on another custom AntiGem plugin, also read that plugin's matching skill before using it. Other installed plugins with skills: ${listed}${others.length > 10 ? '; …' : ''}.`,
    );
  }
  return lines.join('\n');
}

/**
 * `/` picker rows: the `/plu:` entry, each enabled plugin (ending in ':' when it has skills, so picking it keeps the
 * picker open on its skills) and each of its skills (`/plu:<id>:<skill>`, with the plugin's name).
 */
export function pluginSlashItems(plugins: Plugin[]): SlashCommandView[] {
  const out: SlashCommandView[] = [{ command: '/plu:', description: 'Use a custom AntiGem plugin and its skills', kind: 'plugin' }];
  for (const p of plugins.filter((x) => x.isEnabled && (x.toolCount > 0 || x.skillCount > 0))) {
    const counts = [p.toolCount > 0 ? `${p.toolCount} tools` : '', p.skillCount > 0 ? `${p.skillCount} skills` : ''].filter(Boolean).join(' · ');
    out.push({
      command: p.skillCount > 0 ? `/plu:${p.id}:` : `/plu:${p.id}`,
      description: [p.name, counts, p.description].filter((s) => s.trim()).join(' · '),
      kind: 'plugin',
    });
  }
  for (const p of plugins.filter((x) => x.isEnabled && x.skillCount > 0)) {
    for (const s of p.skills) out.push({ command: `/plu:${p.id}:${s.name}`, description: s.description || s.title, kind: 'plugin', pluginName: p.name });
  }
  return out;
}

/** The app's two-level picker for `plu:<query>` (plugins) and `plu:<plugin>:<query>` (its skills), for UIs that ask. */
export function pluginSuggestions(plugins: Plugin[], afterPlu: string): SlashCommandView[] {
  const list = plugins.filter((p) => p.isEnabled && (p.toolCount > 0 || p.skillCount > 0));
  const colon = afterPlu.indexOf(':');
  const has = (s: string, q: string) => s.toLowerCase().includes(q.toLowerCase());
  if (colon < 0) {
    return list
      .filter((p) => !afterPlu.trim() || has(p.id, afterPlu) || has(p.name, afterPlu) || has(p.folderName, afterPlu))
      .map((p) => {
        const counts = [p.toolCount > 0 ? `${p.toolCount} tools` : '', p.skillCount > 0 ? `${p.skillCount} skills` : ''].filter(Boolean).join(' · ');
        return { command: p.skillCount > 0 ? `/plu:${p.id}:` : `/plu:${p.id}`, description: [p.name, counts, p.description].filter((s) => s.trim()).join(' · '), kind: 'plugin' as const };
      });
  }
  const plugin = list.find((p) => p.id.toLowerCase() === afterPlu.slice(0, colon).toLowerCase());
  if (!plugin) return [];
  const query = afterPlu.slice(colon + 1);
  const whole: SlashCommandView = { command: `/plu:${plugin.id}`, description: `Use ${plugin.name} without a specific skill`, kind: 'plugin' };
  const skills = plugin.skills
    .filter((s) => !query.trim() || has(s.name, query) || has(s.title, query) || has(s.description, query))
    .map((s) => ({ command: `/plu:${plugin.id}:${s.name}`, description: s.description || s.title, kind: 'plugin' as const, pluginName: plugin.name }));
  return query.trim() ? skills : [whole, ...skills];
}
