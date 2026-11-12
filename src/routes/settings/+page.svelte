<script lang="ts">
  // What can be chosen about the app itself: how often each running VM is measured (the backend
  // and the polls follow at once), and the theme. settings.rs keeps both beside the history.
  import { onMount } from 'svelte';
  import { api, INTERVALS, THEMES, type Settings, type Theme } from '$lib/api';
  import { live } from '$lib/live.svelte';
  import { intervalPhrase } from '$lib/almanac';
  import { theme } from '$lib/theme.svelte';

  const THEME_LABELS: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

  let settings = $state<Settings | null>(null);
  let saving = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      settings = await api.settings();
    } catch (e) {
      error = String(e);
    }
  });

  /** Saves `change`; each setting then takes effect where it shows. */
  async function save(change: Partial<Settings>) {
    if (!settings || saving) return;
    saving = true;
    error = null;
    try {
      settings = await api.setSettings({ ...settings, ...change });
      if (change.intervalSecs != null) live.poke();
      theme.apply(settings.theme);
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
    }
  }
</script>

{#if !settings}
  {#if error}<p class="error">{error}</p>{:else}<p class="muted">Loading…</p>{/if}
{:else}
  <h1 class="headline">Each running VM is measured {intervalPhrase(settings.intervalSecs)}.</h1>

  <section class="panel">
    <h2 class="head">How often</h2>
    <div class="choices" role="group" aria-label="Measure each running VM every">
      {#each INTERVALS as s}
        <button class="choice num" class:active={settings.intervalSecs === s} aria-pressed={settings.intervalSecs === s}
          disabled={saving} onclick={() => settings!.intervalSecs !== s && save({ intervalSecs: s })}>{s} s</button>
      {/each}
    </div>
    <p class="note">
      A measurement is a short read of the VM's own counters over ssh, and of podman's figures for its containers; the
      lists and charts here update at the same pace. Less often costs each VM and this computer less, and the history
      kept is coarser to match: a spike shorter than the interval can fall between two measurements. A container's own
      peak memory is still caught, whatever the interval: the kernel keeps it.
    </p>
  </section>

  <section class="panel">
    <h2 class="head">Theme</h2>
    <div class="choices" role="group" aria-label="Theme">
      {#each THEMES as t}
        <button class="choice" class:active={settings.theme === t} aria-pressed={settings.theme === t}
          disabled={saving} onclick={() => settings!.theme !== t && save({ theme: t })}>{THEME_LABELS[t]}</button>
      {/each}
    </div>
    <p class="note">System is light or dark as this computer is, and follows it when it changes.</p>
  </section>
  {#if error}<p class="error">{error}</p>{/if}
{/if}

<style>
  .panel { display: grid; gap: 0.9rem; justify-items: start; }
  .choices { display: flex; gap: 0.3rem; flex-wrap: wrap; }
  .choice { min-width: 3.4rem; }
  .note { max-width: 46rem; }
</style>
