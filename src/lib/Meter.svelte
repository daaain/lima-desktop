<script lang="ts">
  let { label, value, max, text, warn = 80, alert = 95 }: {
    label: string; value: number | undefined; max: number | undefined; text: string; warn?: number; alert?: number;
  } = $props();
  const pct = $derived(value == null || !max || value < 0 ? 0 : Math.min(100, (value / max) * 100));
  const level = $derived(pct >= alert ? 'alert' : pct >= warn ? 'warn' : 'ok');
</script>

<div class="meter" title={`${label}: ${text}`}>
  <div class="row"><span class="label">{label}</span><span class="text">{text}</span></div>
  <div class="track"><div class="fill {level}" style:width={`${pct}%`}></div></div>
</div>

<style>
  .meter { display: grid; gap: 3px; min-width: 0; }
  .row { display: flex; justify-content: space-between; gap: 0.5rem; font-size: 0.78rem; }
  .label { color: var(--muted); }
  .text { font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .track { height: 6px; background: var(--track); border-radius: 3px; overflow: hidden; }
  .fill { height: 100%; transition: width 0.4s; background: var(--ok); }
  .fill.warn { background: var(--warn); }
  .fill.alert { background: var(--alert); }
</style>
