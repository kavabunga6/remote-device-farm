# One-time builder-side migration of previously published packed farm images.
# SOURCE_IMAGE must be a trusted, digest-pinned farm image. No Android session
# or user data is copied; --check-image only prepares the bundled SDK trees.
ARG SOURCE_IMAGE
FROM ${SOURCE_IMAGE}
RUN /usr/local/bin/rdf-emulator --check-image \
    && rm -f /opt/android/emulator.tar.gz /opt/android/emulator.tar.gz.sha256 \
             /opt/android/system-images.tar.gz /opt/android/system-images.tar.gz.sha256
COPY rdf-emulator.sh /usr/local/bin/rdf-emulator
RUN chmod 0755 /usr/local/bin/rdf-emulator \
    && /usr/local/bin/rdf-emulator --check-image
