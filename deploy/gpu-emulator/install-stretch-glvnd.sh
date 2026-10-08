#!/bin/sh
set -eu

if [ "$(dpkg --print-architecture)" != amd64 ]; then
  echo "The pinned Stretch GLVND packages are available only for amd64" >&2
  exit 1
fi

# Native Stretch Backports GLVND client libraries. Extracting them into an
# isolated prefix avoids replacing the base image's Mesa packages. NVIDIA's
# vendor implementation still comes from the container toolkit at runtime.
version='1.1.0-1~bpo9+1'
archive='https://archive.debian.org/debian/pool/main/libg/libglvnd'
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT HUP INT TERM

while read -r package sha256; do
  file=$(printf '%s_%s_amd64.deb' "$package" "$version")
  curl --fail --show-error --silent --location --retry 3 --connect-timeout 15 --max-time 120 \
    "$archive/$file" --output "$workdir/$file"
  printf '%s  %s\n' "$sha256" "$workdir/$file" | sha256sum --check --quiet
  dpkg-deb --extract "$workdir/$file" "$workdir/stage"
done <<'PACKAGES'
libgl1 cf8621c36fd94a411a7faf380067f6d57ef466fd03607cd6a08247728c496b94
libglx0 8fbbc10b712144eb4499b3a681e484deb9bbe279a60252ee1538936594dba3a1
libglvnd0 2310aebfea1b3fba5bf17f730e082191e10726076f98683e7719f27c1a9896d5
PACKAGES

mkdir -p /opt/rdf-glvnd/lib
cp -a "$workdir/stage/usr/lib/x86_64-linux-gnu/." /opt/rdf-glvnd/lib/
for library in libGL.so.1 libGLX.so.0 libGLdispatch.so.0; do
  test -r "/opt/rdf-glvnd/lib/$library"
done