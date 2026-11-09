<script lang="ts">
  // "All VMs" or one of them; the choice lives in the URL as `?vm=`.
  let { vms, value, onchange }: { vms: string[]; value: string | null; onchange: (vm: string | null) => void } = $props();
</script>

<select aria-label="VM" value={value ?? ''} onchange={(e) => onchange(e.currentTarget.value || null)}>
  <option value="">All running VMs</option>
  {#each vms as vm (vm)}<option value={vm}>{vm}</option>{/each}
  {#if value && !vms.includes(value)}<option value={value}>{value} (not running)</option>{/if}
</select>
