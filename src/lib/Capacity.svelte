<script lang="ts">
  // One of the host's resources as a single bar, a block per VM: the full width is what the host
  // has; a block is as wide as its VM's allocation, solid as far as the VM uses it. A VM that
  // isn't running holds only what it uses (its disk image), drawn quieter. Hover a block to read it.
  import { hostBar, type Block, type Holding } from './almanac';

  let { name, items, host, format, hot = [] }: {
    name: string;
    items: Holding[];
    /** What the host has; unknown on an older backend, when the holdings are the scale. */
    host?: number | null;
    format: (n: number) => string;
    /** VMs to draw in the warning colour. */
    hot?: string[];
  } = $props();

  const bar = $derived(hostBar(items, host));
  let over = $state<string | null>(null);
  const said = (b: Block) =>
    b.allocated == null ? `${b.name}, not running: ${format(b.used)}` : `${b.name}: ${format(b.used)} of ${format(b.allocated)}`;
  const overBlock = $derived(bar.blocks.find((b) => b.name === over));
  const text = $derived(
    `${name}: ${format(bar.used)} in use, ${format(bar.allocated)} allocated${host ? `, ${format(host)} on this computer` : ''}. ` +
      bar.blocks.map(said).join('; '),
  );
</script>

<div class="capacity num">
  <p>
    <span class="serif name">{name}</span>
    {#if overBlock}
      <strong>{overBlock.name}</strong> <span class="muted">{overBlock.allocated == null ? `not running · ${format(overBlock.used)}` : `${format(overBlock.used)} of ${format(overBlock.allocated)}`}</span>
    {:else}
      <strong>{format(bar.used)}</strong> <span class="muted">in use · {format(bar.allocated)} allocated{host ? ` · ${format(host)} on this computer` : ''}</span>
    {/if}
  </p>
  <div class="bar" role="img" aria-label={text} onmouseleave={() => (over = null)}>
    {#each bar.blocks as b (b.name)}
      <span class="block" class:hot={hot.includes(b.name)} class:off={b.allocated == null} class:over={over === b.name}
        style:left={`${b.x}%`} style:width={`max(2px, calc(${b.w}% - 1.5px))`} title={said(b)} onmouseenter={() => (over = b.name)} role="presentation">
        <span class="fill" style:width={b.used > 0 ? `max(1px, ${b.fill}%)` : '0'}></span>
      </span>
    {/each}
  </div>
</div>

<style>
  .capacity { display: grid; gap: 0.35rem; min-width: 0; }
  p { margin: 0; font-size: 0.9rem; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .name { font-size: 1.2rem; font-weight: 500; margin-right: 0.2rem; }
  .bar { position: relative; height: 12px; background: var(--track); }
  .block { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--soft) 60%, var(--track)); }
  .fill { position: absolute; inset: 0 auto 0 0; background: var(--bar); }
  .hot .fill { background: var(--warn); }
  .off .fill { background: var(--soft); }
  .block.over { outline: 1.5px solid var(--fg); outline-offset: 1px; z-index: 1; }
</style>
