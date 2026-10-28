ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY --from=rdf_ui_messages / /shared/
RUN npm run build

FROM ${NODE_IMAGE} AS agent-bundle
ARG AGENT_BUNDLE_VERSION=0.1.0
WORKDIR /bundle
COPY --from=rdf_agent_sources /package.json /package-lock.json /Dockerfile /.dockerignore /compose.bundle.yaml /INSTALL.txt ./
COPY --from=rdf_agent_sources /src ./src
COPY --from=rdf_agent_sources /scripts ./scripts
COPY --from=rdf_agent_sources /licenses ./licenses
COPY --from=rdf_agent_sources /emulator-image ./emulator-image
RUN mkdir /out && \
    case "$AGENT_BUNDLE_VERSION" in *[!A-Za-z0-9._-]*|'') exit 1;; esac && \
    mv compose.bundle.yaml compose.agent.yaml && \
    tar -czf "/out/rdf-linux-agent-${AGENT_BUNDLE_VERSION}.tar.gz" . && \
    sha256sum "/out/rdf-linux-agent-${AGENT_BUNDLE_VERSION}.tar.gz" | cut -d' ' -f1 > /out/sha256.txt && \
    printf '%s' "$AGENT_BUNDLE_VERSION" > /out/version.txt

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=rdf_ui_messages / /shared/
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node licenses /usr/share/doc/remote-device-farm
COPY --chown=node:node --from=agent-bundle /out ./agent-bundle
RUN mkdir -p /data/apps && chown node:node /data/apps
USER node
RUN test -r package.json && test -x migrations && \
    for file in migrations/*.sql; do test -r "$file" || exit 1; done && \
    test -r agent-bundle/sha256.txt && test -r agent-bundle/version.txt && \
    node --input-type=module -e "await import('pg'); await import('./dist/http-common.js')"
EXPOSE 8080
CMD ["node", "dist/index.js"]
