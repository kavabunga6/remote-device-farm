ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

RUN apt-get update \
    && apt-get install -y --no-install-recommends adb ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ARG SCRCPY_VERSION=4.1
ARG SCRCPY_SHA256=deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae
RUN mkdir -p /opt/scrcpy \
    && curl --fail --location --silent --show-error \
      "https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}" \
      -o /opt/scrcpy/scrcpy-server \
    && echo "${SCRCPY_SHA256}  /opt/scrcpy/scrcpy-server" | sha256sum -c -

RUN groupadd --gid 10001 rdf \
    && useradd --uid 10001 --gid 10001 --home-dir /home/agent --create-home --shell /usr/sbin/nologin rdf \
    && mkdir -p /home/agent/.android /run/agent-control \
    && chown -R 10001:10001 /home/agent/.android \
    && chown 0:10001 /run/agent-control \
    && chmod 0770 /run/agent-control

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY licenses /usr/share/doc/remote-device-farm
# Fixed build context of farm emulator images (built on the image builder node, see deploy/emulator/README.md).
COPY emulator-image ./emulator-image
# Legacy maintenance tools; rental cleanup requires an explicit full reset/reprovision script.
COPY scripts /opt/rdf
RUN chown -R 0:0 /opt/rdf && chmod 0755 /opt/rdf /opt/rdf/reset-android.sh

# Archived release sources may be extracted with a restrictive umask. The I/O
# agent runs as UID 10001 and must be able to read Node package metadata and
# code without granting access to runtime keys or secrets.
RUN chmod 0644 /app/package.json /app/package-lock.json \
    && chmod -R a+rX /app/src /app/emulator-image
USER 10001:10001
RUN test -r /app/package.json \
    && test -r /app/package-lock.json \
    && node --input-type=module -e "await import('ws'); await import('./src/config.mjs')"
USER root

CMD ["node", "src/main.mjs"]
