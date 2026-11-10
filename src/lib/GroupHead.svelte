<script lang="ts" module>
  /** What the group's clean-up last did. */
  export interface Said {
    text: string;
    error?: boolean;
  }
</script>

<script lang="ts">
  // A VM's group on the Images and Volumes views: its name and a sentence about what it holds; its
  // disk, where images and volumes live (past three quarters in the warning colour); the clean-up
  // for the whole VM, and what that last did; then the column heads of its lines.
  import type { Snippet } from 'svelte';
  import type { VmLive } from './api';
  import { gauges } from './almanac';
  import { bytes } from './format';
  import Bar from './Bar.svelte';

  let { vm, live, sentence, actions, said = null, heads = true }: {
    vm: string; live?: VmLive | null; sentence: string; actions?: Snippet; said?: Said | null; heads?: boolean;
  } = $props();

  const disk = $derived(live ? gauges(live).disk : null);
</script>

<div class="group-head">
  <h2 class="head"><a href={`/vm/${encodeURIComponent(vm)}`}>{vm}</a> {sentence}</h2>
  {#if disk?.used != null && disk.size}
    <div class="disk num">
      <p><strong class:hot={disk.hot}>{bytes(disk.used)}</strong> <span class="muted">of {bytes(disk.size)} disk</span></p>
      <Bar pct={disk.pct} label={`${vm}'s disk: ${disk.pct.toFixed(0)} % in use`} />
    </div>
  {/if}
  {#if actions}<div class="acts">{@render actions()}</div>{/if}
</div>
{#if said}<p class={said.error ? 'error' : 'note'}>{said.text}</p>{/if}
{#if heads}
  <div class="heads label" aria-hidden="true"><span></span><span>Size</span><span></span><span>Used by</span><span></span></div>
{/if}

<style>
  .group-head { display: grid; grid-template-columns: minmax(0, 1fr) minmax(9rem, 13rem) auto; column-gap: 2rem; row-gap: 0.8rem; align-items: end; }
  .head a { color: var(--fg); font-weight: 600; }
  .disk { display: grid; gap: 0.35rem; padding-bottom: 0.45rem; }
  .disk p { margin: 0; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .disk strong { font-size: 1.05rem; font-weight: 600; }
  .acts { display: flex; gap: 0.4rem; padding-bottom: 0.2rem; }
  .acts :global(button) { height: 1.9rem; padding: 0 0.8rem; font-size: 0.82rem; }
  p.note, p.error { margin-top: 0.5rem; }
  .heads { display: grid; grid-template-columns: var(--item-columns); column-gap: 1.4rem; padding: 0.9rem 0 0.4rem; }
  @media (max-width: 860px) {
    .group-head { grid-template-columns: minmax(0, 1fr) auto; }
    .head { grid-column: 1 / -1; }
    .heads { display: none; }
  }
</style>
