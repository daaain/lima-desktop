<script lang="ts">
  // What's in a folder of podman's in the guest — a volume, or what one image layer added — a
  // directory at a time, and the start of a file. Read-only, over Lima's ssh (guest_files.rs):
  // nothing here can change what's there. Inset, it sits inside another detail (a layer's, under
  // its step) and leaves closing to it.
  import { onMount } from 'svelte';
  import { api, type FileListing, type FilePeek, type FileSource } from './api';
  import { age, bytes } from './format';

  let { vm, source, label, onclose, inset = false }: {
    vm: string; source: FileSource;
    /** The folder's name, at the head of the path. */
    label: string;
    onclose?: () => void; inset?: boolean;
  } = $props();

  let listing = $state<FileListing | null>(null);
  let peek = $state<FilePeek | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);
  // The latest request wins: a slow answer for a directory already left is dropped.
  let asked = 0;

  /** How much of a file is fetched, at most (guest_files.rs `MAX_PEEK`). */
  const SHOWN = 64 * 1024;
  // What a folder holds, said up top: folders are listed first, so its files may be below the fold.
  function counted(entries: FileListing['entries']): string {
    const n = (kind: string) => entries.filter((e) => e.kind === kind).length;
    const say = (k: number, one: string, many: string) => (k ? `${k} ${k === 1 ? one : many}` : '');
    return [
      say(n('dir'), 'folder', 'folders'), say(n('file'), 'file', 'files'), say(n('link'), 'link', 'links'),
      say(n('removed'), 'removed', 'removed'), say(n('other'), 'other', 'others'),
    ].filter(Boolean).join(', ');
  }

  const join = (dir: string, entry: string) => (dir ? `${dir}/${entry}` : entry);
  const crumbs = $derived.by(() => {
    const parts = (peek?.path ?? listing?.path ?? '').split('/').filter(Boolean);
    return parts.map((part, i) => ({ part, path: parts.slice(0, i + 1).join('/') }));
  });

  /** Ask, keeping only the latest answer; the error is said, unless `quiet` (the caller handles it). */
  async function ask<T>(call: () => Promise<T>, done: (value: T) => void, quiet = false): Promise<boolean> {
    const n = ++asked;
    busy = true;
    error = null;
    try {
      const value = await call();
      if (n === asked) done(value);
      return true;
    } catch (e) {
      if (n === asked && !quiet) error = String(e);
      return false;
    } finally {
      if (n === asked) busy = false;
    }
  }
  const showList = (l: FileListing) => ((listing = l), (peek = null));
  const open = (path: string) => ask(() => api.files(vm, source, path), showList);
  const read = (path: string) => ask(() => api.file(vm, source, path), (p) => (peek = p));
  // A link may lead to a directory or a file: try it as a directory, else read it.
  async function follow(path: string) {
    if (!(await ask(() => api.files(vm, source, path), showList, true))) read(path);
  }

  // Once, as it opens: not an effect, which would rerun (and go back to the top) whenever the
  // page's list refreshes and hands this a new row with the same names in it.
  onMount(() => {
    open('');
  });
</script>

<section class="detail" class:wash={!inset} class:inset>
  <div class="head">
    <nav class="path serif" aria-label="Where in the folder">
      <button class="crumb" onclick={() => open('')} disabled={!crumbs.length && !peek}>{label}</button>
      {#each crumbs as c, i (c.path)}
        <span class="sep">/</span>
        {#if i < crumbs.length - 1 || peek}
          <button class="crumb" onclick={() => (peek && i === crumbs.length - 1 ? read(c.path) : open(c.path))}
            disabled={!!peek && i === crumbs.length - 1}>{c.part}</button>
        {:else}
          <span class="here">{c.part}</span>
        {/if}
      {/each}
    </nav>
    <span class="spacer"></span>
    {#if busy}<span class="muted">…</span>{/if}
    {#if peek}<button onclick={() => open(crumbs.slice(0, -1).map((c) => c.part).join('/'))}>Back to the folder</button>{/if}
    {#if onclose}<button onclick={onclose} aria-label="Close">✕</button>{/if}
  </div>
  {#if error}<p class="error">{error}</p>{/if}

  {#if peek}
    <!-- What it is said first: a file, and how big, so a binary one isn't taken for a folder that won't open. -->
    {#if peek.text == null}
      <p class="note num">A binary file of {bytes(peek.size)}. It isn't text, so there's nothing to show here.</p>
    {:else if peek.size === 0}
      <p class="note">An empty file.</p>
    {:else}
      <p class="muted num">
        A text file of {bytes(peek.size)}{#if peek.truncated}; only the first {bytes(SHOWN)} is shown{/if}.
      </p>
      <pre>{peek.text}</pre>
    {/if}
  {:else if listing}
    {#if listing.entries.length}
      <p class="muted num">{counted(listing.entries)}{#if listing.truncated} (only the first {listing.entries.length} listed){/if}</p>
    {/if}
    {#if listing.entries.length === 0}
      <p class="note">Empty.</p>
    {:else}
      <ul class="entries num">
        {#each listing.entries as e (e.name)}
          {@const path = join(listing.path, e.name)}
          <li>
            {#if e.kind === 'dir'}
              <button class="entry" onclick={() => open(path)}><span class="name">{e.name}/</span></button>
            {:else if e.kind === 'file'}
              <button class="entry" onclick={() => read(path)}><span class="name">{e.name}</span></button>
            {:else if e.kind === 'link'}
              <button class="entry" onclick={() => follow(path)} title="A symbolic link"><span class="name">{e.name}</span> <span class="muted">→</span></button>
            {:else if e.kind === 'removed'}
              <span class="entry removed" title="This layer deletes what a lower one had here"><span class="name">{e.name}</span></span>
            {:else}
              <span class="entry other" title="A socket, device or pipe: nothing to read"><span class="name">{e.name}</span></span>
            {/if}
            <span class="size" class:label={e.kind === 'removed'}>{e.kind === 'file' ? bytes(e.size) : e.kind === 'removed' ? 'removed' : ''}</span>
            <span class="when label" title={new Date(e.modified * 1000).toLocaleString('en-GB')}>{age(e.modified)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {:else if !error}
    <p class="muted">…</p>
  {/if}
</section>

<style>
  .detail { display: grid; gap: 0.75rem; }
  .head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .head > button { height: 1.9rem; padding: 0 0.8rem; font-size: 0.82rem; }
  .spacer { flex: 1; }
  .muted { color: var(--muted); font-size: 0.8rem; }
  .path { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.25rem; font-size: 1.35rem; font-weight: 600; min-width: 0; }
  .crumb { all: unset; cursor: pointer; color: var(--accent); overflow-wrap: anywhere; }
  .crumb:hover:not(:disabled) { text-decoration: underline; }
  .crumb:disabled { color: var(--fg); cursor: default; }
  .crumb:focus-visible { outline: 2px solid var(--accent); }
  .sep { color: var(--muted); font-weight: 400; }
  .here { overflow-wrap: anywhere; }
  .entries { list-style: none; margin: 0; padding: 0; max-height: 26rem; overflow: auto; background: var(--bg); }
  li { display: grid; grid-template-columns: minmax(0, 1fr) 6rem 6.5rem; column-gap: 1rem; align-items: baseline; padding: 0.3rem 0.75rem; border-top: 1px solid var(--border); }
  li:first-child { border-top: 0; }
  .entry { all: unset; cursor: pointer; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 0.82rem; }
  .entry:focus-visible { outline: 2px solid var(--accent); }
  button.entry:hover .name { color: var(--accent); text-decoration: underline; }
  .entry.other, .entry.removed { cursor: default; color: var(--muted); }
  .entry.removed .name { text-decoration: line-through; }
  .inset { gap: 0.5rem; }
  .inset .path { font-size: 1.05rem; }
  .size, .when { text-align: right; white-space: nowrap; font-size: 0.82rem; }
  pre { margin: 0; max-height: 26rem; overflow: auto; font-size: 0.8rem; background: var(--bg); padding: 0.75rem; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
