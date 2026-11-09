<script lang="ts">
  // Lima itself is missing or broken: say what's wrong and what to try, on every page.
  import { openUrl } from '@tauri-apps/plugin-opener';
  import type { LimaProblem } from './api';
  import { limaAdvice } from './lima';

  let { problem, staleVms }: { problem: LimaProblem; staleVms: number } = $props();
  const advice = $derived(limaAdvice(problem));
  let copied = $state<string | null>(null);

  async function copy(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      copied = command;
      setTimeout(() => (copied = null), 1500);
    } catch {
      copied = null;
    }
  }
</script>

<section class="problem" role="alert">
  <h2>{advice.headline}</h2>
  {#if advice.detail}<p class="detail">{advice.detail}</p>{/if}
  {#each advice.steps as step}
    <p>
      {step.text}
      {#if step.command}
        <code>{step.command}</code>
        <button class="copy" onclick={() => copy(step.command!)}>{copied === step.command ? 'copied' : 'copy'}</button>
      {/if}
    </p>
  {/each}
  {#if advice.searched.length}
    <details>
      <summary>Where Lima Desktop looked</summary>
      <ul>{#each advice.searched as dir}<li><code>{dir}</code></li>{/each}</ul>
    </details>
  {/if}
  {#if advice.link}
    <p><button class="link" onclick={() => openUrl(advice.link!)}>Lima's installation guide</button></p>
  {/if}
  <p class="muted">
    Lima Desktop checks again every few seconds{staleVms ? `; the ${staleVms} VMs below are as last seen` : ''}.
  </p>
</section>

<style>
  .problem {
    margin: 0; padding: 0.9rem 1.2rem; display: grid; gap: 0.45rem; font-size: 0.85rem;
    background: color-mix(in srgb, var(--alert) 9%, var(--panel)); border-bottom: 1px solid var(--border);
  }
  h2 { margin: 0; font-size: 1rem; color: var(--alert); }
  p { margin: 0; }
  .detail { font-family: ui-monospace, monospace; font-size: 0.8rem; overflow-wrap: anywhere; }
  code { font-size: 0.8rem; padding: 0.05rem 0.35rem; border-radius: 4px; background: var(--bg); border: 1px solid var(--border); }
  .copy { margin-left: 0.3rem; padding: 0.05rem 0.45rem; font-size: 0.72rem; }
  button.link { border: none; background: none; padding: 0; color: var(--accent); font-size: inherit; }
  details summary { cursor: pointer; color: var(--muted); }
  ul { margin: 0.3rem 0 0; padding-left: 1.2rem; }
  .muted { color: var(--muted); font-size: 0.78rem; }
</style>
