<script lang="ts">
  // One of the host's resources as a single bar: the full width is what the host has, the pale
  // stretch what the running VMs are allocated, and the solid segments what each is using now.
  import { segments } from './almanac';

  let { name, items, allocated, host, format, hot = [] }: {
    name: string;
    /** What each running VM is using now. */
    items: { name: string; value: number }[];
    /** The running VMs' allocations, summed. */
    allocated: number;
    /** What the host has; unknown on an older backend, when the allocation is the scale. */
    host?: number;
    format: (n: number) => string;
    /** VMs to draw in the warning colour. */
    hot?: string[];
  } = $props();

  const used = $derived(items.reduce((n, i) => n + i.value, 0));
  const scale = $derived(Math.max(host ?? 0, allocated, used) || 1);
  const parts = $derived(segments(items).map((s) => ({ ...s, x: (s.x * used) / scale, w: (s.w * used) / scale })));
  const text = $derived(
    `${name}: ${parts.map((p) => `${p.name} ${format(p.value)}`).join(', ') || 'nothing in use'}; ` +
      `${format(allocated)} allocated${host ? ` of the host's ${format(host)}` : ''}`,
  );
</script>

<div class="capacity num" title={text}>
  <p><span class="serif name">{name}</span> <strong>{format(used)}</strong> <span class="muted">in use · {format(allocated)} allocated{host ? ` · ${format(host)} on this computer` : ''}</span></p>
  <div class="bar" role="img" aria-label={text}>
    <span class="allocated" style:width={`${(allocated / scale) * 100}%`}></span>
    {#each parts as p, i (p.name)}
      <span class="seg" class:hot={hot.includes(p.name)} style:left={`${p.x}%`} style:width={`max(1px, calc(${p.w}% - 1px))`} style:opacity={hot.includes(p.name) ? 1 : Math.max(0.3, 1 - i * 0.2)}></span>
    {/each}
  </div>
</div>

<style>
  .capacity { display: grid; gap: 0.35rem; min-width: 0; }
  p { margin: 0; font-size: 0.9rem; line-height: 1.3; }
  .name { font-size: 1.2rem; font-weight: 500; margin-right: 0.2rem; }
  .bar { position: relative; height: 10px; background: var(--track); }
  .allocated { position: absolute; inset: 0 auto 0 0; background: var(--soft); opacity: 0.6; }
  .seg { position: absolute; top: 0; bottom: 0; background: var(--bar); }
  .seg.hot { background: var(--warn); }
</style>
