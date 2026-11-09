<script lang="ts">
  // Which VMs a podman-wide view leaves out, and per-VM failures: nothing goes missing silently.
  import { unlistedText, type VmError, type VmScope } from './perVm';

  let { scope, what, failed = [] }: { scope: VmScope; what: string; failed?: VmError[] } = $props();
</script>

{#each unlistedText(scope, what) as line}
  <p class="note" title={scope.stopped.join(', ')}>{line}</p>
{/each}
{#each failed as f (f.vm)}
  <p class="error"><a href={`/vm/${encodeURIComponent(f.vm)}`}>{f.vm}</a>: {f.error}</p>
{/each}

<style>
  .note { margin: 0; color: var(--muted); font-size: 0.8rem; }
</style>
