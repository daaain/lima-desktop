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
  // for the whole VM, and what that last did. As a VM's heading on Containers (VmHead), it stays at
  // the top of the window while its lines scroll under it, and a click on it, but for its name (a
  // link to its page) and its clean-up, folds its lines away; its chevron is the button.
  import type { Snippet } from 'svelte';
  import type { VmLive } from './api';
  import { gauges } from './almanac';
  import { bytes } from './format';
  import Bar from './Bar.svelte';
  import FoldMark from './FoldMark.svelte';

  let { vm, live, sentence, what, folded, ontoggle, actions, said = null }: {
    vm: string; live?: VmLive | null; sentence: string;
    /** What its lines are, for its chevron's label: "images", "volumes". */
    what: string;
    folded: boolean; ontoggle: () => void;
    actions?: Snippet; said?: Said | null;
  } = $props();

  // Its name opens its page and its clean-up acts; anywhere else, its chevron included, folds.
  function clicked(e: MouseEvent) {
    const on = (e.target as Element).closest('a, button');
    if (!on || on.classList.contains('fold')) ontoggle();
  }

  const disk = $derived(live ? gauges(live).disk : null);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<div class="group-head" class:folded role="group" aria-label={`VM ${vm}`} onclick={clicked}>
  <h2 class="head">
    <span class="title">
      <button class="fold" aria-expanded={!folded} aria-label={folded ? `Show ${vm}'s ${what}` : `Fold ${vm}'s ${what} away`}><FoldMark {folded} /></button>
      <a href={`/vm/${encodeURIComponent(vm)}`}>{vm}</a>
    </span>
    <span class="sentence">{sentence}</span>
  </h2>
  {#if disk?.used != null && disk.size}
    <div class="disk num">
      <p><strong class:hot={disk.hot}>{bytes(disk.used)}</strong> <span class="muted">of {bytes(disk.size)} disk</span></p>
      <Bar pct={disk.pct} label={`${vm}'s disk: ${disk.pct.toFixed(0)} % in use`} />
    </div>
  {/if}
  {#if actions}<div class="acts">{@render actions()}</div>{/if}
</div>
{#if said}<p class={said.error ? 'error' : 'note'}>{said.text}</p>{/if}

<style>
  /* Pinned as VmHead is, and for the same reasons: see there. */
  .group-head {
    position: sticky; top: 0; z-index: 3; background: var(--bg); cursor: pointer;
    display: grid; padding: 0.8rem 0 0.6rem; grid-template-columns: minmax(0, 1fr) minmax(9rem, 13rem) auto; column-gap: 2rem; row-gap: 0.8rem; align-items: end;
    border-bottom: 1px solid var(--border); box-shadow: -1.2rem 0 0 var(--bg);
  }
  .folded { border-bottom: 0; }
  .head { display: grid; gap: 0.15rem; min-width: 0; }
  .title { display: flex; align-items: baseline; gap: 0.35rem; min-width: 0; }
  .title a { color: var(--fg); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fold { all: unset; display: flex; align-self: center; cursor: pointer; padding: 0.1rem; }
  .fold:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
  .sentence { font-size: 1.05rem; line-height: 1.35; letter-spacing: 0; }
  .disk { display: grid; gap: 0.35rem; padding-bottom: 0.45rem; }
  .disk p { margin: 0; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .disk strong { font-size: 1.05rem; font-weight: 600; }
  .acts { display: flex; gap: 0.4rem; padding-bottom: 0.2rem; }
  .acts :global(button) { height: 1.9rem; padding: 0 0.8rem; font-size: 0.82rem; }
  p.note, p.error { margin-top: 0.5rem; }
  @media (max-width: 860px) {
    .group-head { position: static; grid-template-columns: minmax(0, 1fr) auto; }
    .head { grid-column: 1 / -1; }
  }
</style>
