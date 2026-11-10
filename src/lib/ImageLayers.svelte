<script lang="ts">
  // An image's history under its line: the steps that built it, newest first, each layer's size
  // drawn against the largest. Steps that only changed the config (ENV, CMD, …) add nothing to the
  // disk, so they're folded away until asked for. A layer opens what it added, under its step.
  import { onMount } from 'svelte';
  import { api, type Layer } from './api';
  import { share } from './almanac';
  import { age, bytes, shortId } from './format';
  import { instruction } from './images';
  import Bar from './Bar.svelte';
  import Files from './Files.svelte';
  import { unfold } from './motion';

  let { vm, id, title, onclose }: { vm: string; id: string; title: string; onclose: () => void } = $props();

  let layers = $state<Layer[] | null>(null);
  let error = $state<string | null>(null);
  let configToo = $state(false);
  // Layers whose files are open, by their number (newest first, as the backend counts them).
  let open = $state<Record<number, true>>({});
  function toggle(n: number) {
    const { [n]: was, ...rest } = open;
    open = was ? rest : { ...open, [n]: true };
  }

  // Once, as it opens: an effect would fetch again whenever the page's list refreshes.
  onMount(() => {
    api.imageHistory(vm, id).then((h) => (layers = h), (e) => (error = String(e)));
  });

  // Each step with its layer's number: the n-th with a size is the n-th layer, newest first.
  const steps = $derived.by(() => {
    let n = 0;
    return (layers ?? []).map((l, at) => ({ l, at, layer: l.size > 0 ? n++ : null }));
  });
  const sized = $derived((layers ?? []).filter((l) => l.size > 0));
  const shown = $derived(configToo ? steps : steps.filter((s) => s.layer != null));
  const configSteps = $derived((layers?.length ?? 0) - sized.length);
  const total = $derived(sized.reduce((n, l) => n + l.size, 0));
  const scale = $derived(Math.max(1, ...sized.map((l) => l.size)));
</script>

<section class="wash detail">
  <div class="head">
    <h3 class="serif" {title}>{title}</h3>
    {#if layers}
      <span class="muted num">{sized.length} {sized.length === 1 ? 'layer' : 'layers'}, {bytes(total)}</span>
    {/if}
    <span class="spacer"></span>
    {#if configSteps > 0}
      <button class:active={configToo} onclick={() => (configToo = !configToo)}
        title="Steps that changed only the image's config (ENV, CMD, LABEL, …): they add nothing to the disk">
        {configToo ? 'Hide' : 'Show'} {configSteps} config {configSteps === 1 ? 'step' : 'steps'}
      </button>
    {/if}
    <button onclick={onclose} aria-label="Close">✕</button>
  </div>
  {#if error}
    <p class="error">{error}</p>
  {:else if layers == null}
    <p class="muted">…</p>
  {:else if shown.length === 0}
    <p class="muted">No history recorded for this image.</p>
  {:else}
    <ol class="steps num">
      {#each shown as { l, at, layer } (at)}
        <li class:config={layer == null}>
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -->
          <div class="step" class:openable={layer != null} role={layer != null ? 'button' : undefined} tabindex={layer != null ? 0 : undefined}
            aria-expanded={layer != null ? !!open[layer] : undefined}
            title={layer != null ? 'What this layer added' : undefined}
            onclick={() => layer != null && toggle(layer)}
            onkeydown={(e) => { if (layer != null && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(layer); } }}>
          <span class="size">
            {#if l.size > 0}
              <strong>{bytes(l.size)}</strong>
              <Bar pct={share(l.size, scale)} plain label={`${bytes(l.size)}; full width ${bytes(scale)}`} />
            {:else}
              <span class="label">config</span>
            {/if}
          </span>
          <code title={l.createdBy}>{instruction(l.createdBy) || '(not recorded)'}</code>
          <span class="when label" title={l.created ? new Date(l.created * 1000).toLocaleString('en-GB') : "The image doesn't record when"}>
            {l.created ? age(l.created) : '–'}{#if l.id}<br /><span title={l.id}>{shortId(l.id)}</span>{/if}
          </span>
          {#if l.comment || l.tags.length}
            <span class="aside label">{[l.tags.join(', '), l.comment].filter(Boolean).join(' · ')}</span>
          {/if}
          </div>
          {#if layer != null && open[layer]}
            <div class="files" transition:unfold>
              <Files {vm} source={{ kind: 'layer', image: id, layer }} label={`layer ${sized.length - layer}`} inset />
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .detail { display: grid; gap: 0.75rem; }
  .head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  h3 { margin: 0; font-size: 1.5rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .spacer { flex: 1; }
  .muted { color: var(--muted); font-size: 0.8rem; }
  .head button { height: 1.9rem; padding: 0 0.8rem; font-size: 0.82rem; }
  .steps { list-style: none; margin: 0; padding: 0; display: grid; }
  li { border-top: 1px solid var(--border); }
  li:first-child { border-top: 0; }
  .step {
    display: grid; grid-template-columns: 8rem minmax(0, 1fr) 6rem; column-gap: 1.2rem; align-items: start;
    padding: 0.55rem 0;
  }
  .openable { cursor: pointer; }
  .openable:hover code { color: var(--accent); }
  .openable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .files { padding: 0 0 0.9rem 9.2rem; }
  .size { display: grid; gap: 0.3rem; --bar-height: 5px; }
  .size strong { font-weight: 600; }
  code {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 0.8rem; line-height: 1.45;
    white-space: pre-wrap; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
  }
  .config code { color: var(--muted); }
  .when { text-align: right; }
  .aside { grid-column: 2 / -1; }
  @media (max-width: 640px) {
    .step { grid-template-columns: minmax(0, 1fr) auto; row-gap: 0.4rem; }
    .files { padding-left: 0; }
    code, .aside { grid-column: 1 / -1; }
  }
</style>
