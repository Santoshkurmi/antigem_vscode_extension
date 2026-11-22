// Commands that reach outside the machine, as prefixes the engines can match themselves (docs/crew/PLAN.md §11). At
// Auto / Full an engine may run a command without asking (Claude's auto mode, OpenCode's allow-all agent); these make
// it ask, so the access broker (policy.ts) decides: an outward one goes to the Inbox, anything else (a curl GET) runs.
export const OUTWARD_PREFIXES = [
  'git push',
  'gh pr create',
  'gh pr merge',
  'gh pr comment',
  'gh pr review',
  'gh issue create',
  'gh issue comment',
  'gh release create',
  'gh repo create',
  'gh gist create',
  'npm publish',
  'pnpm publish',
  'yarn publish',
  'cargo publish',
  'twine upload',
  'docker push',
  'kubectl apply',
  'kubectl delete',
  'kubectl create',
  'terraform apply',
  'terraform destroy',
  'scp',
  'ssh',
  'rsync',
  'curl',
  'wget',
  'sendmail',
  'mail',
];

/** Claude Code permission rules ("Bash(git push:*)") for settings permissions.ask. */
export const CLAUDE_ASK_RULES = OUTWARD_PREFIXES.map((p) => `Bash(${p}:*)`);
