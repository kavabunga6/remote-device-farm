#!/usr/bin/env bash
set -Eeuo pipefail

# The GPU and X server belong only to this emulator container. No host X
# socket is mounted and Xorg never listens on TCP.
export DISPLAY=:99
export XAUTHORITY=/run/rdf/xauth
# The Stretch base links glxinfo to Mesa's legacy libGL. Use the pinned,
# vendor-neutral loader for the NVIDIA GLX server and its host-matched driver.
if [[ -d /opt/rdf-glvnd/lib ]]; then
  export LD_LIBRARY_PATH=/opt/rdf-glvnd/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
fi
export __GLX_VENDOR_LIBRARY_NAME=nvidia
install -d -m 0700 /run/rdf /run/rdf/xorg-modules
install -d -m 0700 /run/rdf/xorg-modules/drivers /run/rdf/xorg-modules/extensions
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock

if ! command -v nvidia-smi >/dev/null || ! nvidia-smi -L >/dev/null; then
  echo "NVIDIA GPU is not available inside this container" >&2
  exit 1
fi

# Prefer the optional read-only bind mount from the host. Some NVIDIA
# Container Toolkit versions inject GL libraries but not the Xorg modules.
# Match the server-side GLX module to the active host driver exactly.
nvidia_version=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | sed -n '1p' | tr -d '[:space:]')
if [[ ! "$nvidia_version" =~ ^[0-9]+(\.[0-9]+){1,3}$ ]]; then
  echo "Could not determine the NVIDIA host driver version" >&2
  exit 1
fi
if [[ -d /opt/nvidia-xorg ]]; then
  nvidia_drv=/opt/nvidia-xorg/nvidia_drv.so
  nvidia_glx=/opt/nvidia-xorg/libglxserver_nvidia.so.$nvidia_version
else
  nvidia_drv=$(find /usr/lib /lib -name nvidia_drv.so -print -quit 2>/dev/null || true)
  nvidia_glx=$(find /usr/lib /lib -name "libglxserver_nvidia.so.$nvidia_version" -print -quit 2>/dev/null || true)
fi
if [[ ! -r "$nvidia_drv" || ! -r "$nvidia_glx" ]]; then
  echo "NVIDIA Xorg modules for driver $nvidia_version are missing; set AGENT_NVIDIA_XORG_MODULE_DIR to their host directory" >&2
  exit 1
fi
ln -s "$nvidia_drv" /run/rdf/xorg-modules/drivers/nvidia_drv.so
ln -s "$nvidia_glx" /run/rdf/xorg-modules/extensions/libglxserver_nvidia.so
ln -s "$nvidia_glx" /run/rdf/xorg-modules/extensions/libglx.so

umask 077
touch "$XAUTHORITY"
cookie=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
xauth -f "$XAUTHORITY" add "$DISPLAY" . "$cookie" >/dev/null
unset cookie

# Xorg 1.19 expects a Linux VT even for a headless display. Give it a
# container-local PTY alias and keep it from switching the host console.
# Never bind host /dev/tty0 or another host virtual terminal.
if [[ ! -c /dev/ptmx || -e /dev/tty7 || -L /dev/tty7 ]]; then
  echo "A private /dev/ptmx and unused /dev/tty7 are required for NVIDIA Xorg" >&2
  exit 1
fi
ln -s /dev/ptmx /dev/tty7

xorg_log=/var/log/rdf-Xorg.log
Xorg :99 vt7 -novtswitch -sharevts -keeptty \
  -config /etc/X11/xorg-rdf.conf \
  -modulepath /run/rdf/xorg-modules,/usr/lib/xorg/modules \
  -auth "$XAUTHORITY" \
  -nolisten tcp -noreset \
  -logfile "$xorg_log" &
xorg_pid=$!
launcher_pid=

cleanup() {
  status=$?
  trap - EXIT TERM INT
  if [[ -n "$launcher_pid" ]]; then
    kill -TERM "$launcher_pid" 2>/dev/null || true
    wait "$launcher_pid" 2>/dev/null || true
  fi
  kill -TERM "$xorg_pid" 2>/dev/null || true
  wait "$xorg_pid" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM INT

for ((attempt = 0; attempt < 100; attempt++)); do
  if [[ -S /tmp/.X11-unix/X99 ]]; then
    break
  fi
  if ! kill -0 "$xorg_pid" 2>/dev/null; then
    echo "NVIDIA Xorg exited before its private X socket was ready" >&2
    tail -n 80 "$xorg_log" >&2 || true
    exit 1
  fi
  sleep 0.1
done
if [[ ! -S /tmp/.X11-unix/X99 ]]; then
  echo "NVIDIA Xorg did not create its private X socket" >&2
  tail -n 80 "$xorg_log" >&2 || true
  exit 1
fi

# Fail closed if the X server selected a software renderer. The Docker GPU
# request and nvidia-smi alone do not establish that OpenGL uses the GPU.
if ! glx_info=$(glxinfo -B 2>&1); then
  echo "NVIDIA Xorg did not provide a working GLX renderer" >&2
  printf '%s\n' "$glx_info" >&2
  tail -n 80 "$xorg_log" >&2 || true
  exit 1
fi
renderer=$(printf '%s\n' "$glx_info" | sed -n 's/^OpenGL renderer string: //p' | head -n 1)
if [[ "$renderer" != *NVIDIA* ]]; then
  echo "Expected an NVIDIA GLX renderer, got: ${renderer:-unknown}" >&2
  exit 1
fi
printf 'GPU renderer: %s\n' "$renderer"

# Google's launcher clears /tmp/* before starting Android. Normal Bash
# globbing leaves hidden .X11-unix and .X99-lock in place.
env -u BASHOPTS -u GLOBIGNORE /android/sdk/launch-emulator.sh &
launcher_pid=$!

set +e
wait -n "$launcher_pid" "$xorg_pid"
status=$?
set -e
if kill -0 "$launcher_pid" 2>/dev/null; then
  echo "NVIDIA Xorg exited while the Android emulator was running" >&2
  tail -n 80 "$xorg_log" >&2 || true
  status=1
fi
exit "$status"
