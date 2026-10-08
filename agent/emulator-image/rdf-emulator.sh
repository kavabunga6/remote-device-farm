#!/usr/bin/env bash
# Remote Device Farm emulator launcher, contract "emulator-v1".
#
# The agent sets only these variables (all optional except ADBKEY_PUB):
#   ADBKEY_PUB       farm ADB public key (base64 RSA, as in adbkey.pub); the only key the device trusts
#   RDF_RAM_MB       guest RAM, MiB                         (default 2048)
#   RDF_CORES        guest CPU cores                        (default 2)
#   RDF_DATA_MB      /data partition size, MiB              (default 8192)
#   RDF_SDCARD_MB    SD card size, MiB; 0 = no card         (default 0)
#   RDF_DEVICE       phone | tablet | tv | automotive | wear | desktop   (default: from the system image tag)
#   RDF_SCREEN       WIDTHxHEIGHT, overrides the device preset size
#   RDF_DENSITY      screen density, dpi, overrides the preset
#   RDF_GPU          off | nvidia | dri                     (default off = SwiftShader software rendering)
#   RDF_EXTRA_ARGS   extra emulator flags, already checked by the farm
# Everything else (ports, AVD layout, rendering, ADB authentication) is fixed by this script.
set -Eeuo pipefail

SDK=${ANDROID_SDK_ROOT:-/opt/android}
EMULATOR=$SDK/emulator/emulator
AVD_HOME=${ANDROID_AVD_HOME:-/android-home/avd}
USER_HOME=${ANDROID_USER_HOME:-/android-home/.android}
SDCARD=/android-home/sdcard.img

fail() { echo "rdf-emulator: $*" >&2; exit 64; }
int_in() { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= $2 && $1 <= $3 )); }

# The single system image copied into this container: system-images/android-NN/TAG/ABI
system_image_dir() {
  local dirs=() dir
  while IFS= read -r dir; do dirs+=("$dir"); done < <(find "$SDK/system-images" -mindepth 3 -maxdepth 3 -type d | sort)
  (( ${#dirs[@]} == 1 )) || fail "expected exactly one system image, found ${#dirs[@]}"
  printf '%s\n' "${dirs[0]}"
}

if [[ "${1:-}" == --check-image ]]; then
  test -x "$EMULATOR" || fail "emulator binary is missing"
  test -x "$SDK/platform-tools/adb" || fail "SDK platform-tools/adb is missing"
  system_image_dir >/dev/null
  echo "rdf-emulator: image layout is valid"
  exit 0
fi

image_dir=$(system_image_dir)
rel=${image_dir#"$SDK/"}                     # system-images/android-34/google_apis/x86_64
IFS=/ read -r _ platform tag abi <<<"$rel"
case "$abi" in x86_64) arch=x86_64 ;; x86) arch=x86 ;; arm64-v8a) arch=arm64 ;; *) fail "unsupported ABI $abi" ;; esac

ram=${RDF_RAM_MB:-2048};    int_in "$ram" 1024 65536   || fail "RDF_RAM_MB must be 1024-65536"
cores=${RDF_CORES:-2};      int_in "$cores" 1 16       || fail "RDF_CORES must be 1-16"
data=${RDF_DATA_MB:-8192};  int_in "$data" 2048 131072 || fail "RDF_DATA_MB must be 2048-131072"
sdcard=${RDF_SDCARD_MB:-0}; [[ "$sdcard" == 0 ]] || int_in "$sdcard" 128 32768 || fail "RDF_SDCARD_MB must be 0 or 128-32768"

# Device presets. The tag decides the form factor of TV, automotive and Wear images; phone images can be shown as tablets.
default_device=phone
case "$tag" in
  *tv*) default_device=tv ;;
  *automotive*) default_device=automotive ;;
  *wear*) default_device=wear ;;
  *desktop*) default_device=desktop ;;
esac
device=${RDF_DEVICE:-$default_device}
case "$device" in
  phone)      width=1080 height=2400 density=420 orientation=portrait  dpad=no  ;;
  tablet)     width=2560 height=1600 density=320 orientation=landscape dpad=no  ;;
  tv)         width=1920 height=1080 density=320 orientation=landscape dpad=yes ;;
  automotive) width=1408 height=792  density=160 orientation=landscape dpad=no  ;;
  wear)       width=454  height=454  density=320 orientation=portrait  dpad=no  ;;
  desktop)    width=1920 height=1080 density=160 orientation=landscape dpad=no  ;;
  *) fail "RDF_DEVICE must be phone, tablet, tv, automotive, wear or desktop" ;;
esac
if [[ -n "${RDF_SCREEN:-}" ]]; then
  [[ "$RDF_SCREEN" =~ ^([1-9][0-9]{2,4})x([1-9][0-9]{2,4})$ ]] || fail "RDF_SCREEN must look like 1080x2400"
  width=${BASH_REMATCH[1]} height=${BASH_REMATCH[2]}
  (( width > height )) && orientation=landscape || orientation=portrait
fi
if [[ -n "${RDF_DENSITY:-}" ]]; then int_in "$RDF_DENSITY" 120 640 || fail "RDF_DENSITY must be 120-640"; density=$RDF_DENSITY; fi

gpu=${RDF_GPU:-off}
case "$gpu" in off) gpu_mode=swiftshader_indirect ;; nvidia|dri) gpu_mode=host ;; *) fail "RDF_GPU must be off, nvidia or dri" ;; esac

# ---- ADB: trust only the farm key ----
key=$(printf '%s' "${ADBKEY_PUB:-}" | awk '{print $1}')
[[ -n "$key" && "$key" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || fail "ADBKEY_PUB with the farm public key is required"
install -d -m 0700 "$USER_HOME"
rm -f "$USER_HOME/adbkey" "$USER_HOME/adbkey.pub"
printf '%s rdf-agent\n' "$key" > "$USER_HOME/adbkey.pub"
chmod 0400 "$USER_HOME/adbkey.pub"
# Console authentication stays inside the container (docker exec); no console port is forwarded.
umask 077
od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > /android-home/.emulator_console_auth_token
umask 022

# ---- AVD: created fresh for every container; nothing survives a session ----
rm -rf "$AVD_HOME"
install -d "$AVD_HOME/rdf.avd"
playstore=no; [[ "$tag" == *playstore* || "$tag" == google-tv || "$tag" == *play* ]] && playstore=yes
cat > "$AVD_HOME/rdf.ini" <<EOF
avd.ini.encoding=UTF-8
path=$AVD_HOME/rdf.avd
path.rel=avd/rdf.avd
target=$platform
EOF
cat > "$AVD_HOME/rdf.avd/config.ini" <<EOF
avd.ini.encoding=UTF-8
AvdId=rdf
avd.ini.displayname=Remote Device Farm
PlayStore.enabled=$playstore
abi.type=$abi
hw.cpu.arch=$arch
hw.cpu.ncore=$cores
hw.ramSize=$ram
image.sysdir.1=$rel/
tag.id=$tag
disk.dataPartition.size=${data}M
hw.lcd.width=$width
hw.lcd.height=$height
hw.lcd.density=$density
hw.initialOrientation=$orientation
hw.dPad=$dpad
hw.keyboard=yes
hw.mainKeys=no
hw.audioInput=yes
hw.audioOutput=yes
hw.gpu.enabled=yes
hw.gpu.mode=$gpu_mode
hw.sdCard=$([[ "$sdcard" == 0 ]] && echo no || echo yes)
fastboot.forceColdBoot=yes
EOF
sd_args=()
if [[ "$sdcard" != 0 ]]; then
  rm -f "$SDCARD"
  "$SDK/emulator/mksdcard" "${sdcard}M" "$SDCARD"
  printf 'sdcard.size=%sM\nsdcard.path=%s\n' "$sdcard" "$SDCARD" >> "$AVD_HOME/rdf.avd/config.ini"
  sd_args=(-sdcard "$SDCARD")
fi

# ---- Extra flags: the farm validated them; split on whitespace, never through a shell ----
read -r -a extra <<<"${RDF_EXTRA_ARGS:-}"
for flag in "${extra[@]}"; do
  case "$flag" in -gpu|-memory|-cores|-partition-size|-sdcard|-avd|-ports|-port|-grpc|-skip-adb-auth|-ramdisk|-append-userspace-opt|-qemu) fail "flag $flag is set by the farm" ;; esac
done

# ---- Optional NVIDIA rendering: private Xorg on :99, never a host X socket ----
xorg_pid=
pids=()
cleanup() {
  trap - EXIT TERM INT
  for pid in "${pids[@]}" $xorg_pid; do kill -TERM "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM INT

start_nvidia_xorg() {
  export DISPLAY=:99 XAUTHORITY=/run/rdf/xauth __GLX_VENDOR_LIBRARY_NAME=nvidia
  command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null || fail "RDF_GPU=nvidia but no NVIDIA GPU is visible in the container"
  local version drv glx
  version=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | sed -n '1p' | tr -d '[:space:]')
  [[ "$version" =~ ^[0-9]+(\.[0-9]+){1,3}$ ]] || fail "cannot read the NVIDIA driver version"
  if [[ -d /opt/nvidia-xorg ]]; then drv=/opt/nvidia-xorg/nvidia_drv.so glx=/opt/nvidia-xorg/libglxserver_nvidia.so.$version
  else drv=$(find /usr/lib /lib -name nvidia_drv.so -print -quit 2>/dev/null || true)
       glx=$(find /usr/lib /lib -name "libglxserver_nvidia.so.$version" -print -quit 2>/dev/null || true); fi
  [[ -r "$drv" && -r "$glx" ]] || fail "NVIDIA Xorg modules for driver $version are missing; set AGENT_NVIDIA_XORG_MODULE_DIR on the agent"
  install -d -m 0700 /run/rdf /run/rdf/xorg-modules/drivers /run/rdf/xorg-modules/extensions
  ln -sf "$drv" /run/rdf/xorg-modules/drivers/nvidia_drv.so
  ln -sf "$glx" /run/rdf/xorg-modules/extensions/libglxserver_nvidia.so
  ln -sf "$glx" /run/rdf/xorg-modules/extensions/libglx.so
  install -d -m 1777 /tmp/.X11-unix; rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock
  umask 077; touch "$XAUTHORITY"
  xauth -f "$XAUTHORITY" add "$DISPLAY" . "$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')" >/dev/null
  umask 022
  [[ -c /dev/ptmx && ! -e /dev/tty7 ]] || fail "a private /dev/ptmx and an unused /dev/tty7 are required for Xorg"
  ln -s /dev/ptmx /dev/tty7
  Xorg :99 vt7 -novtswitch -sharevts -keeptty -config /etc/X11/xorg-rdf.conf \
    -modulepath /run/rdf/xorg-modules,/usr/lib/xorg/modules -auth "$XAUTHORITY" -nolisten tcp -noreset \
    -logfile /var/log/rdf-Xorg.log &
  xorg_pid=$!
  for _ in $(seq 100); do [[ -S /tmp/.X11-unix/X99 ]] && break; kill -0 "$xorg_pid" 2>/dev/null || break; sleep 0.1; done
  [[ -S /tmp/.X11-unix/X99 ]] || { tail -n 80 /var/log/rdf-Xorg.log >&2 || true; fail "Xorg did not start"; }
  local renderer
  renderer=$(glxinfo -B 2>/dev/null | sed -n 's/^OpenGL renderer string: //p' | head -n 1)
  [[ "$renderer" == *NVIDIA* ]] || fail "expected an NVIDIA renderer, got: ${renderer:-none}"
  echo "rdf-emulator: GPU renderer $renderer"
}
if [[ "$gpu" == nvidia ]]; then start_nvidia_xorg; fi
# RDF_GPU=dri: the agent passes the host render node; the emulator renders through Mesa EGL without a display.

# ---- Forward ADB and gRPC on the session's management network only ----
address=$(ip -4 -o addr show dev eth0 2>/dev/null | sed -n 's/.* inet \([0-9.]*\)\/.*/\1/p' | head -n 1)
[[ -n "$address" ]] || fail "the management interface eth0 has no IPv4 address"

# The gate remains a supervised child while Android starts; if the emulator or
# Xorg exits, wait -n below runs cleanup and cancels the probe immediately. After
# a valid AUTH challenge it execs socat, so the same PID owns the transport.
/usr/local/bin/rdf-adb-auth-gate 5557 300 -- \
  socat "TCP-LISTEN:5555,bind=$address,reuseaddr,fork" TCP:127.0.0.1:5557 & pids+=($!)
socat "TCP-LISTEN:8554,bind=$address,reuseaddr,fork" TCP:127.0.0.1:8555 & pids+=($!)

echo "rdf-emulator: $rel as $device ${width}x${height}@${density}, ${ram} MiB, ${cores} cores, GPU $gpu"
"$EMULATOR" -avd rdf -no-window -no-boot-anim -no-snapshot -no-metrics -no-direct-adb \
  -ports 5556,5557 -grpc 8555 -gpu "$gpu_mode" \
  -memory "$ram" -cores "$cores" -partition-size "$data" "${sd_args[@]}" \
  -append-userspace-opt androidboot.verifiedbootstate=orange \
  -append-userspace-opt "androidboot.qemu.adb.pubkey=$key" \
  "${extra[@]}" &
pids+=($!)

set +e
wait -n "${pids[@]}" ${xorg_pid:+"$xorg_pid"}
status=$?
set -e
echo "rdf-emulator: a component exited with status $status; stopping the session" >&2
exit $(( status == 0 ? 1 : status ))
