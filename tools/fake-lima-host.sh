#!/bin/sh
# Run the real app against test doubles, on a machine without Lima (CI, a cloud sandbox):
#   - a fake `limactl` that lists two instances: `devbox` (Running, its podman socket pointed at a
#     REAL local podman service) and `acme` (Stopped, with a foldyard managed-by marker);
#   - a fake `ssh` that runs the guest probe against THIS machine's /proc.
# Usage: tools/fake-lima-host.sh <podman.sock> [workdir]  → prints the PATH to launch the app with.
# Then: PATH=<that>:$PATH src-tauri/target/debug/lima-desktop
set -eu
sock=${1:?usage: $0 <podman.sock> [workdir]}
h=${2:-$(mktemp -d)}
mkdir -p "$h/bin" "$h/lima/devbox/sock" "$h/lima/acme"
ln -sf "$sock" "$h/lima/devbox/sock/podman.sock"
touch "$h/lima/devbox/ssh.config" "$h/lima/acme/ssh.config"
truncate -s 100G "$h/lima/devbox/diffdisk"   # sparse: the host-side "allocated" column reads ~0
pid=$(pgrep -f "podman system service" | head -1 || echo 0)
cat > "$h/lima/acme/managed-by.json" <<JSON
{"version": 1, "instance": "acme", "manager": "foldyard", "url": "https://github.com/twistco/foldyard", "group": "acme", "locked": ["delete", "edit"], "hint": "Created by foldyard for the 'acme' project. Remove it with \`fy machine rm\`."}
JSON
cat > "$h/bin/limactl" <<SH
#!/bin/sh
case "\$1" in
  list)
    echo '{"name":"devbox","status":"Running","dir":"$h/lima/devbox","vmType":"qemu","arch":"$(uname -m)","cpus":4,"memory":17179869184,"disk":107374182400,"sshConfigFile":"$h/lima/devbox/ssh.config","hostAgentPID":$pid,"driverPID":$pid,"protected":false,"limaVersion":"2.1.3","config":{"portForwards":[{"guestSocket":"/run/user/0/podman/podman.sock","hostSocket":"{{.Dir}}/sock/podman.sock"}]}}'
    echo '{"name":"acme","status":"Stopped","dir":"$h/lima/acme","vmType":"vz","arch":"aarch64","cpus":4,"memory":8589934592,"disk":64424509440,"sshConfigFile":"$h/lima/acme/ssh.config","protected":false,"limaVersion":"2.1.3"}'
    ;;
  *) echo "fake limactl: \$*" >&2 ;;
esac
SH
printf '#!/bin/sh\nexec /bin/sh -s\n' > "$h/bin/ssh"
chmod +x "$h/bin/limactl" "$h/bin/ssh"
echo "$h/bin"
