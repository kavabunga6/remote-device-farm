# Pass the inspected upstream digest for reproducible builds.
ARG EMULATOR_BASE_IMAGE=halimqarroum/docker-android@sha256:0804f0c30234db0fb711910c569f13312bc3cfa354cb66c8e0db6a4e66edfb95
FROM ${EMULATOR_BASE_IMAGE} AS runtime-base
USER root

# Published upstream tags and current source have different Linux bases.
# Keep the adapter independent of that detail, and add no Android downloads.
RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache python3 bash coreutils socat iproute2; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends python3 bash coreutils socat iproute2 \
      && rm -rf /var/lib/apt/lists/*; \
    else echo 'Unsupported upstream Linux base' >&2; exit 1; fi \
    && test -x /opt/android/emulator/emulator \
    && test -x /opt/android/emulator/mksdcard \
    && mkdir -p /android /android-home \
    && ln -s /opt/android /android/sdk \
    && rm -f /root/.android/adbkey /root/.android/adbkey.pub

ENV HOME=/android-home/home \
    ANDROID_SDK_ROOT=/opt/android \
    ANDROID_HOME=/opt/android \
    ANDROID_AVD_HOME=/android-home/avd \
    ANDROID_USER_HOME=/android-home/home/.android \
    ANDROID_EMULATOR_HOME=/android-home/home/.android \
    ANDROID_SDK_HOME=/android-home/home

FROM runtime-base AS prepare
ARG EMULATOR_BASE_IMAGE
ENV RDF_EMULATOR_BASE_IMAGE=${EMULATOR_BASE_IMAGE}
RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache lz4; \
    else \
      apt-get update && apt-get install -y --no-install-recommends lz4 \
      && rm -rf /var/lib/apt/lists/*; \
    fi
COPY launcher.py prepare_image.py ramdisk.py policy-api31.json policy-api31.cil.gz /tmp/rdf-hqarroum-build/
RUN python3 -B /tmp/rdf-hqarroum-build/prepare_image.py

FROM runtime-base AS runtime
COPY --from=prepare /android-home/avd/rdf.ini /android-home/avd/rdf.ini
COPY --from=prepare /android-home/avd/rdf.avd/ /android-home/avd/rdf.avd/
COPY --from=prepare /rdf-prepared/ /usr/local/lib/rdf-hqarroum/
COPY launcher.py /usr/local/lib/rdf-hqarroum/
RUN mv /opt/android/platform-tools/adb /opt/android/platform-tools/adb.rdf-real
COPY adb-guard.sh /opt/android/platform-tools/adb
RUN chmod 0755 /opt/android/platform-tools/adb \
    && test -s /android-home/avd/rdf.ini \
    && test -s /android-home/avd/rdf.avd/config.ini \
    && test -s /usr/local/lib/rdf-hqarroum/config.ini \
    && test -s /usr/local/lib/rdf-hqarroum/secure-ramdisk.img

LABEL org.opencontainers.image.source="https://github.com/HQarroum/docker-android" \
      remote-device-farm.emulator-adapter="hqarroum-v1"
WORKDIR /android-home
# These are container-network endpoints. The farm does not publish host ports.
EXPOSE 5555 8554
HEALTHCHECK NONE
ENTRYPOINT ["python3", "/usr/local/lib/rdf-hqarroum/launcher.py"]
CMD []
