# Pass the inspected upstream digest for reproducible builds.
ARG EMULATOR_BASE_IMAGE=halimqarroum/docker-android@sha256:0804f0c30234db0fb711910c569f13312bc3cfa354cb66c8e0db6a4e66edfb95
FROM ${EMULATOR_BASE_IMAGE}
ARG EMULATOR_BASE_IMAGE
USER root

# Published upstream tags and current source have different Linux bases.
# Keep the adapter independent of that detail, and add no Android downloads.
RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache python3 bash coreutils socat iproute2 lz4; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends python3 bash coreutils socat iproute2 lz4 \
      && rm -rf /var/lib/apt/lists/*; \
    else echo 'Unsupported upstream Linux base' >&2; exit 1; fi \
    && test -x /opt/android/emulator/emulator \
    && test -x /opt/android/emulator/mksdcard \
    && mkdir -p /android /android-home \
    && ln -s /opt/android /android/sdk

ENV RDF_EMULATOR_BASE_IMAGE=${EMULATOR_BASE_IMAGE} \
    HOME=/android-home/home \
    ANDROID_SDK_ROOT=/opt/android \
    ANDROID_HOME=/opt/android \
    ANDROID_AVD_HOME=/android-home/avd \
    ANDROID_USER_HOME=/android-home/home/.android \
    ANDROID_EMULATOR_HOME=/android-home/home/.android \
    ANDROID_SDK_HOME=/android-home/home
COPY launcher.py policy-api31.json policy-api31.cil.gz /usr/local/lib/rdf-hqarroum/
RUN python3 /usr/local/lib/rdf-hqarroum/launcher.py --prepare-image \
    && mv /opt/android/platform-tools/adb /opt/android/platform-tools/adb.rdf-real
COPY adb-guard.sh /opt/android/platform-tools/adb
RUN chmod 0755 /opt/android/platform-tools/adb

LABEL org.opencontainers.image.source="https://github.com/HQarroum/docker-android" \
      remote-device-farm.emulator-adapter="hqarroum-v1"
WORKDIR /android-home
# These are container-network endpoints. The farm does not publish host ports.
EXPOSE 5555 8554
HEALTHCHECK NONE
ENTRYPOINT ["python3", "/usr/local/lib/rdf-hqarroum/launcher.py"]
CMD []
