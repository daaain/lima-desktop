# lima-desktop guest probe, v1. READ-ONLY: prints one block per interval until its stdout closes
# (the ssh session ends), then dies of SIGPIPE. Sent on stdin to `sh -s`; nothing is installed.
# The app puts `interval=<seconds>` on the second line (probe::script); without it, one second.
# POSIX sh (dash, bash, busybox ash); builtins only on the per-block path except df and sleep.
#   U <uptime s>                      C cpu <user> <nice> <system> <idle> <iowait> <irq> <softirq> <steal> ...
#   M <MemTotal:|MemAvailable:|SwapTotal:|SwapFree:|AnonPages:|Shmem:> <kB>
#     AnonPages + Shmem: the guest's processes' own memory, as G's is a container's.
#   P <memory|cpu> <some|full> total=<us>         O <oom_kill count>
#   D <size kB> <used kB>   (first /, then the rootless container store)
#   G <container id> <memory.peak|-> <oom_kill|-> <anon+shmem|->  (cgroup v2 only, per podman container)
#     anon+shmem from memory.stat: its processes' own memory, which only swap could take away.
#     podman's figure is memory.current less inactive_file, so it counts active file cache and
#     reclaimable slab too. shmem is in because postgres' shared_buffers and tmpfs live there.
#   .                                             (end of block)
store="${XDG_DATA_HOME:-$HOME/.local/share}/containers/storage"
[ -d "$store" ] || store="$HOME"
interval=${interval:-1}
# Containers' cgroups are looked for again about every 5 seconds, at least once a block.
rescan=$((5 / interval))
[ "$rescan" -ge 1 ] || rescan=1
i=0
scopes=
while :; do
  read -r up _ < /proc/uptime
  echo "U $up"
  read -r line < /proc/stat
  echo "C $line"
  while read -r k v _; do
    case $k in MemTotal:|MemAvailable:|SwapTotal:|SwapFree:|AnonPages:|Shmem:) echo "M $k $v" ;; esac
  done < /proc/meminfo
  for r in memory cpu; do
    if [ -r "/proc/pressure/$r" ]; then
      while read -r kind _ _ _ total; do echo "P $r $kind $total"; done < "/proc/pressure/$r"
    fi
  done
  while read -r k v; do
    if [ "$k" = oom_kill ]; then echo "O $v"; break; fi
  done < /proc/vmstat
  df -kP / "$store" 2>/dev/null | { read -r _; while read -r _ size used _; do echo "D $size $used"; done; }
  if [ $((i % rescan)) -eq 0 ] && [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    scopes=$(find /sys/fs/cgroup -maxdepth 9 -type d -name 'libpod-*' ! -name 'libpod-conmon-*' 2>/dev/null)
  fi
  for s in $scopes; do
    id=${s##*/libpod-}
    id=${id%.scope}
    [ ${#id} -eq 64 ] || continue
    pk=-
    ok=-
    if [ -r "$s/memory.peak" ]; then read -r pk < "$s/memory.peak"; fi
    if [ -r "$s/memory.events" ]; then
      while read -r k v; do
        if [ "$k" = oom_kill ]; then ok=$v; fi
      done < "$s/memory.events"
    fi
    own=-
    if [ -r "$s/memory.stat" ]; then
      # Both near the top (anon first, as a rule, but the kernel doesn't promise the order): stop
      # once both are read, not at the end of the file.
      an=
      sh=
      while read -r k v; do
        case $k in
          anon) an=$v ;;
          shmem) sh=$v ;;
          *) continue ;;
        esac
        if [ -n "$an" ] && [ -n "$sh" ]; then own=$((an + sh)); break; fi
      done < "$s/memory.stat"
    fi
    echo "G $id $pk $ok $own"
  done
  echo "."
  i=$((i + 1))
  sleep "$interval"
done
