# Supply a compatible base image explicitly after runtime validation.
ARG EMULATOR_BASE_IMAGE
FROM ${EMULATOR_BASE_IMAGE}

RUN test -x /android/sdk/launch-emulator.sh \
    && if grep -Eq '^VERSION_ID="?9"?$' /etc/os-release; then \
         printf '%s\n' \
           'deb http://archive.debian.org/debian stretch main' \
           'deb http://archive.debian.org/debian-security stretch/updates main' \
           > /etc/apt/sources.list; \
         printf 'Acquire::Check-Valid-Until "false";\n' \
           > /etc/apt/apt.conf.d/99-rdf-archive; \
       fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends xserver-xorg-core xauth mesa-utils curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Stretch predates GLVND. Keep its Mesa packages intact and provide the
# vendor-neutral client loader only to this GPU image.
COPY install-stretch-glvnd.sh /usr/local/bin/rdf-install-stretch-glvnd
RUN if grep -Eq '^VERSION_ID="?9"?$' /etc/os-release; then \
      /bin/sh /usr/local/bin/rdf-install-stretch-glvnd; \
    fi \
    && rm /usr/local/bin/rdf-install-stretch-glvnd

# NVIDIA's matching Xorg driver and OpenGL libraries are injected by the
# container toolkit at runtime. Installing a distribution NVIDIA driver here
# would risk a mismatch with the host kernel driver.
COPY xorg.conf /etc/X11/xorg-rdf.conf
COPY start-with-xorg.sh /usr/local/bin/rdf-start-with-xorg
RUN chmod 0755 /usr/local/bin/rdf-start-with-xorg

ENV DISPLAY=:99
CMD ["/usr/local/bin/rdf-start-with-xorg"]
