# Remote Device Farm emulator image: one Android system image from Google's SDK repository per build.
# The image implements the farm contract "emulator-v1" (see README.md); the agent passes only RDF_* variables.
#
#   docker build --build-arg SYSTEM_IMAGE='system-images;android-34;google_apis;x86_64' \
#     -t rdf-emulator:34-google_apis-x86_64 agent/emulator-image
#
# Usually the agent builds it from the image catalog in the UI; deploy/emulator/build.sh does the same for CI.

ARG BASE_IMAGE=ubuntu:22.04

# ---- Stage 1: Google's command-line tools (Java stays in the build stages). build.sh runs `sdkmanager --list` here ----
FROM ${BASE_IMAGE} AS tools
ARG CMDLINE_TOOLS_URL=https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
ENV DEBIAN_FRONTEND=noninteractive ANDROID_SDK_ROOT=/opt/android
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jre-headless curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "$CMDLINE_TOOLS_URL" -o /tmp/tools.zip \
    && mkdir -p /opt/android/cmdline-tools \
    && unzip -q /tmp/tools.zip -d /opt/android/cmdline-tools \
    && mv /opt/android/cmdline-tools/cmdline-tools /opt/android/cmdline-tools/latest \
    && rm /tmp/tools.zip
ENV PATH=/opt/android/cmdline-tools/latest/bin:$PATH
RUN yes | sdkmanager --licenses >/dev/null

# ---- Stage 2: download the emulator and exactly one system image ----
FROM tools AS sdk
ARG SYSTEM_IMAGE
# 0 = stable channel. Previews of the next Android release need 1 (beta) or 3 (canary).
ARG SDK_CHANNEL=0
RUN test -n "$SYSTEM_IMAGE" || { echo 'Pass --build-arg SYSTEM_IMAGE=system-images;android-NN;TAG;ABI' >&2; exit 2; }
RUN sdkmanager --channel="$SDK_CHANNEL" emulator "$SYSTEM_IMAGE" \
    && test -x /opt/android/emulator/emulator \
    && test -n "$(find /opt/android/system-images -name system.img -o -name system.img.qcow2 | head -n 1)"
# The emulator requires the official platform-tools SDK package at runtime.
# Keep this after the large download above so adding it reuses that cached layer.
# Validate the same layout as rdf-emulator --check-image without copying launcher
# code into this stage and invalidating SDK downloads whenever it changes.
RUN sdkmanager --channel="$SDK_CHANNEL" platform-tools \
    && test -x /opt/android/platform-tools/adb \
    && test "$(find /opt/android/system-images -mindepth 3 -maxdepth 3 -type d | wc -l)" -eq 1

# Google userdebug system images may disable ADB authentication. Enable it
# in init's early ramdisk property override, before adbd starts. Keep tools
# and patching after SDK downloads so this change reuses their cached layers.
RUN apt-get update && apt-get install -y --no-install-recommends python3 lz4 \
    && rm -rf /var/lib/apt/lists/*
COPY secure-ramdisk.py ramdisk.py /tmp/
RUN python3 /tmp/secure-ramdisk.py "$(find /opt/android/system-images -name ramdisk.img -print -quit)" \
    && rm /tmp/secure-ramdisk.py /tmp/ramdisk.py

# ---- Stage 3: runtime. No Java or SDK manager; official emulator/platform-tools, system image and launcher ----
FROM ${BASE_IMAGE}
ARG SYSTEM_IMAGE
ENV DEBIAN_FRONTEND=noninteractive
# Libraries the headless emulator links against, socat for the two forwarded ports, Xorg for optional NVIDIA rendering.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash coreutils iproute2 socat tini ca-certificates python3 \
       libpulse0 libnss3 libxcomposite1 libxcursor1 libxi6 libxtst6 libxdamage1 libxrandr2 libxkbfile1 libxkbcommon0 \
       libasound2 libbsd0 libdrm2 libgbm1 libgl1 libegl1 libgles2 libglx0 libvulkan1 libx11-xcb1 libxcb1 \
       xserver-xorg-core xauth mesa-utils \
    && rm -rf /var/lib/apt/lists/*
COPY rdf-emulator.sh /usr/local/bin/rdf-emulator
COPY adb-auth-gate.sh /usr/local/bin/rdf-adb-auth-gate
COPY xorg.conf /etc/X11/xorg-rdf.conf
RUN chmod 0755 /usr/local/bin/rdf-emulator /usr/local/bin/rdf-adb-auth-gate

ENV ANDROID_SDK_ROOT=/opt/android \
    ANDROID_HOME=/opt/android \
    HOME=/android-home \
    ANDROID_USER_HOME=/android-home/.android \
    ANDROID_EMULATOR_HOME=/android-home/.android \
    ANDROID_AVD_HOME=/android-home/avd \
    RDF_SYSTEM_IMAGE=${SYSTEM_IMAGE}

LABEL remote-device-farm.contract="emulator-v1" \
      remote-device-farm.system-image="${SYSTEM_IMAGE}" \
      org.opencontainers.image.title="Remote Device Farm Android emulator"
WORKDIR /android-home
# Container-network endpoints only: ADB (5555) and emulator gRPC (8554). The farm never publishes host ports.
EXPOSE 5555 8554
HEALTHCHECK NONE
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/rdf-emulator"]

# Keep the largest layers last. Classic Engine builds otherwise create/commit
# intermediate containers with the entire SDK rootfs for every remaining step.
# The sdk stage above has already checked the executable and single-image layout.
COPY --from=sdk /opt/android/platform-tools /opt/android/platform-tools
COPY --from=sdk /opt/android/emulator /opt/android/emulator
COPY --from=sdk /opt/android/system-images /opt/android/system-images
