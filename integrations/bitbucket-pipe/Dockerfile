FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates curl jq adb python3 coreutils openjdk-17-jdk-headless git unzip \
    && rm -rf /var/lib/apt/lists/*
COPY common/ /opt/rdf/common/
COPY node/ /opt/rdf/node/
COPY entrypoint.sh /opt/rdf/entrypoint.sh
COPY LICENSE NOTICE THIRD_PARTY.md /opt/rdf/
ENTRYPOINT ["bash", "/opt/rdf/entrypoint.sh"]
