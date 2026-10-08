FROM registry:2.8 AS distribution
FROM node:22-alpine
COPY --from=distribution /bin/registry /usr/local/bin/registry
COPY --from=distribution /etc/docker/registry/config.yml /etc/docker/registry/config.yml
COPY maintenance.mjs storage.mjs cleanup.mjs /opt/registry/
COPY licenses /usr/share/doc/remote-device-farm
ENV REGISTRY_STORAGE_DELETE_ENABLED=true REGISTRY_HTTP_ADDR=127.0.0.1:5002
EXPOSE 5000 5001
ENTRYPOINT ["node", "/opt/registry/maintenance.mjs"]
