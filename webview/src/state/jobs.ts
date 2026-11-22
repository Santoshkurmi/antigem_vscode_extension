// Mission Control (src/core/crew/jobs): every job tree the crew is working on or finished, while the screen is open.
import { createEffect, createRoot, createSignal, on } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { JobsStateView } from '@shared/protocol';
import { host } from '../host';
import { groupsOpen } from './groups';

/** Mission Control is shown (inside the Crew screen). */
export const [mcOpen, setMcOpen] = createSignal(false);
export const [jobs, setJobs] = createStore<JobsStateView & { loaded: boolean }>({ trees: [], counts: { working: 0, waiting: 0, needsYou: 0, today: 0 }, loaded: false });

host.onMessage((m) => {
  if (m.type === 'jobsState') setJobs(reconcile({ ...m.jobs, loaded: true }, { key: 'id' }));
});

// the host sends the trees while Mission Control is on screen
createRoot(() =>
  createEffect(
    on([groupsOpen, mcOpen], ([g, open]) => {
      host.send({ type: 'jobsWatch', open: g && open });
    }),
  ),
);

export function jobAction(action: 'stop' | 'retry' | 'answer' | 'openThread' | 'openArtifact' | 'resumeGoal', jobId: string, data: Record<string, unknown> | null = null) {
  host.send({ type: 'jobAction', action, jobId, data });
}
