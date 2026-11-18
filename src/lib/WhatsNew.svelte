<script lang="ts">
  // What a newer version brings, under the masthead when asked for from the update notice (here, or
  // from the menu bar's popover, which opens this window for it): each release since the one
  // running, newest first. A release is its summary when it has one, else the lead of each entry,
  // so a few releases still fit on a glance; the rest is under More, for whoever wants it.
  import type { Notes } from './api';
  import { day, release } from './releaseNotes';
  import Runs from './Runs.svelte';
  import { update } from './update.svelte';

  let { notes }: { notes: Notes[] } = $props();
  const releases = $derived(notes.map(release));
</script>

<section class="whats-new" aria-labelledby="whats-new-head">
  <div class="top">
    <h2 id="whats-new-head" class="serif">What's new</h2>
    <button class="close" aria-label="Close What's new" title="Close" onclick={() => update.closeNotes()}>×</button>
  </div>
  {#each releases as r (r.version)}
    <article>
      <h3 class="num">{r.version} · {day(r.date)}</h3>
      {#if r.summary.length}
        <div class="glance">{#each r.summary as p, i (i)}<p><Runs runs={p} /></p>{/each}</div>
      {:else}
        <ul class="glance">
          {#each r.sections.flatMap((s) => s.entries) as e, i (i)}<li><Runs runs={e.lead ?? e.rest} /></li>{/each}
        </ul>
      {/if}
      {#if r.sections.length}
        <details>
          <summary>More</summary>
          {#each r.sections as s (s.name)}
            <h4>{s.name}</h4>
            <ul>
              {#each s.entries as e, i (i)}
                <li>{#if e.lead}<strong><Runs runs={e.lead} /></strong>{' '}{/if}<Runs runs={e.rest} /></li>
              {/each}
            </ul>
          {/each}
        </details>
      {/if}
    </article>
  {/each}
</section>

<style>
  .whats-new { margin-top: 0.9rem; padding: 0.9rem 0 0.2rem; border-top: 1px solid var(--border); max-width: 46rem; }
  .top { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  h2 { margin: 0; font-size: 1.35rem; font-weight: 500; }
  .close { height: auto; padding: 0 0.3rem; border: none; background: none; color: var(--muted); font-size: 1.1rem; line-height: 1; }
  .close:hover { color: var(--fg); }
  article { padding: 0.6rem 0; }
  article + article { border-top: 1px solid var(--border); }
  h3 { margin: 0 0 0.3rem; font-size: 0.95rem; font-weight: 600; }
  .glance { margin: 0; font-size: 0.95rem; line-height: 1.5; }
  .glance p { margin: 0 0 0.3rem; }
  ul.glance { padding-left: 1.2rem; }
  details { margin-top: 0.35rem; font-size: 0.9rem; line-height: 1.5; }
  summary { cursor: pointer; color: var(--accent); width: fit-content; }
  h4 { margin: 0.6rem 0 0.2rem; font-size: 0.85rem; font-weight: 600; color: var(--muted); }
  details ul { margin: 0; padding-left: 1.2rem; }
  details li + li { margin-top: 0.3rem; }
</style>
