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
#   S <runtime|system|ssh> <bytes>  S sessions <n>   (cgroup v2 only) the guest's own memory (anon +
#     shmem) by who holds it: runtime, the user's systemd instance less the containers inside it
#     (rootless podman: its API server, port forwarders, networking, conmon); system, system.slice
#     and init.scope less any containers under them (Lima's guest agent, systemd and its services); ssh, the login sessions, and
#     how many there are (Lima's own and the app's probe; more are left behind by clients that
#     didn't close them).
#   .                                             (end of block)
store="${XDG_DATA_HOME:-$HOME/.local/share}/containers/storage"
[ -d "$store" ] || store="$HOME"
interval=${interval:-1}
# Containers' cgroups are looked for again about every 5 seconds, at least once a block.
rescan=$((5 / interval))
[ "$rescan" -ge 1 ] || rescan=1
i=0
scopes=
nl='
'
# The container id in a podman scope's path, into `id`, or empty if it isn't one: exactly one part
# of the path is `libpod-<id>[.scope]` (conmon's and a pod's slice aside), it's the last, and the
# id is 64 lowercase hex digits. Call it with globbing off (set -f).
scope_id() {
  id=
  sc_n=0
  IFS=/
  for sc_part in $1; do
    case $sc_part in libpod-conmon-*|libpod-pod-*) ;; libpod-*) sc_n=$((sc_n + 1)) ;; esac
  done
  unset IFS
  [ "$sc_n" -eq 1 ] || return 0
  sc_id=${1##*/libpod-}
  sc_id=${sc_id%.scope}
  [ ${#sc_id} -eq 64 ] || return 0
  case $sc_id in *[!0123456789abcdef]*) return 0 ;; esac
  id=$sc_id
}
# The podman containers' cgroups under $1, into `scopes`: one `<id> <path>` per line. A container
# running systemd can make cgroups inside its own and name them as it likes, one named for another
# container's id included, whose readings would then be taken for that container's. Podman never
# puts one container's scope inside another's, so find doesn't look inside one (-prune), and a
# path naming two isn't taken either. Paths are split on newlines only, with globbing off, so a
# space or `*` in one is taken as it is.
find_scopes() {
  scopes=
  set -f
  IFS=$nl
  for fs_path in $(find "$1" -maxdepth 9 -type d -name 'libpod-*' ! -name 'libpod-conmon-*' ! -name 'libpod-pod-*' -prune -print 2>/dev/null); do
    unset IFS
    case $fs_path in "$1"/*) ;; *) continue ;; esac
    scope_id "$fs_path"
    [ -z "$id" ] || scopes="$scopes$id $fs_path$nl"
  done
  unset IFS
  set +f
}
# A cgroup's anon + shmem in bytes, into `own` (- if unreadable): builtins only, no subshell.
own_of() {
  own=-
  [ -r "$1/memory.stat" ] || return 0
  an=
  sh=
  while read -r k v; do
    case $k in
      anon) an=$v ;;
      shmem) sh=$v ;;
      *) continue ;;
    esac
    if [ -n "$an" ] && [ -n "$sh" ]; then own=$((an + sh)); return 0; fi
  done < "$1/memory.stat"
}
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
    find_scopes /sys/fs/cgroup
  fi
  incontainers=0
  insystem=0
  set -f
  IFS=$nl
  for line in $scopes; do
    unset IFS
    id=${line%% *}
    s=${line#* }
    pk=-
    ok=-
    if [ -r "$s/memory.peak" ]; then read -r pk < "$s/memory.peak"; fi
    if [ -r "$s/memory.events" ]; then
      while read -r k v; do
        if [ "$k" = oom_kill ]; then ok=$v; fi
      done < "$s/memory.events"
    fi
    # Both near the top of memory.stat (anon first, as a rule, but the kernel doesn't promise the
    # order): own_of stops once both are read, not at the end of the file.
    own_of "$s"
    echo "G $id $pk $ok $own"
    # Containers are counted as theirs, not again as what holds them: rootless ones under the
    # user's systemd instance (runtime), any rootful one placed under system.slice (system).
    case $s in
      */user@*.service/*) [ "$own" = - ] || incontainers=$((incontainers + own)) ;;
      */system.slice/*) [ "$own" = - ] || insystem=$((insystem + own)) ;;
    esac
  done
  unset IFS
  set +f
  if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    runtime=0
    for u in /sys/fs/cgroup/user.slice/user-*.slice/user@*.service; do
      own_of "$u"
      [ "$own" = - ] || runtime=$((runtime + own))
    done
    runtime=$((runtime - incontainers))
    [ "$runtime" -ge 0 ] || runtime=0
    system=0
    for g in /sys/fs/cgroup/system.slice /sys/fs/cgroup/init.scope; do
      own_of "$g"
      [ "$own" = - ] || system=$((system + own))
    done
    system=$((system - insystem))
    [ "$system" -ge 0 ] || system=0
    ssh=0
    sessions=0
    for g in /sys/fs/cgroup/user.slice/user-*.slice/session-*.scope; do
      [ -d "$g" ] || continue
      sessions=$((sessions + 1))
      own_of "$g"
      [ "$own" = - ] || ssh=$((ssh + own))
    done
    echo "S runtime $runtime"
    echo "S system $system"
    echo "S ssh $ssh"
    echo "S sessions $sessions"
  fi
  echo "."
  i=$((i + 1))
  sleep "$interval"
done
