<script lang="ts">
  import { api, type ContainerAction, type ContainerLive } from './api';
  import { visible } from './visible';

  let { vm, c, onerror }: { vm: string; c: ContainerLive; onerror: (message: string | null) => void } = $props();
  let busy = $state(false);
  const name = $derived(visible(c.name));
  const running = $derived(c.state === 'running');

  async function act(action: ContainerAction) {
    if (action === 'remove' && !confirm(`Remove container '${name}'?`)) return;
    busy = true;
    onerror(null);
    try {
      await api.containerAction(vm, c.id, action);
    } catch (e) {
      onerror(String(e));
    } finally {
      busy = false;
    }
  }
</script>

<!-- Each button named for its container too, its own word first: a list has many a Stop. Two
     buttons whose words follow the container (Stop and Restart, or Start and Remove), so the focus
     stays on one as the container stops or starts. While one works both stay Tab stops, marked
     unavailable and ignoring presses: disabled, the one pressed would drop the keyboard's focus.
     Written out, not as a snippet given its words: WebKit's page grew by tens of MB per 1000 polls
     with the snippet (e2e-ui/leak.mjs on /containers), and doesn't without. -->
<button aria-disabled={busy ? true : undefined} aria-label={`${running ? 'Stop' : 'Start'} ${name}`} onclick={() => !busy && act(running ? 'stop' : 'start')}>{running ? 'Stop' : 'Start'}</button>
<button class:danger={!running} aria-disabled={busy ? true : undefined} aria-label={`${running ? 'Restart' : 'Remove'} ${name}`} onclick={() => !busy && act(running ? 'restart' : 'remove')}>{running ? 'Restart' : 'Remove'}</button>
