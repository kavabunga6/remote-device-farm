#!/bin/sh
# APT's native suffix matching differs between releases. Use explicit host boundaries.
set -efu
authority=${1#*://}
authority=${authority%%/*}
authority=${authority##*@}
case "$authority" in
  \[*\]*) host=${authority#\[}; host=${host%%\]*} ;;
  *) host=${authority%%:*} ;;
esac
host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')
host=${host%.}
IFS=,
for entry in ${RDF_NO_PROXY:-}; do
  if [ "$entry" = '*' ] || [ "$host" = "$entry" ]; then
    printf '%s\n' DIRECT
    exit 0
  fi
  case "$entry" in
    *:*) continue ;;
    *[!0-9.]*) case "$host" in *."$entry") printf '%s\n' DIRECT; exit 0 ;; esac ;;
  esac
done
printf '%s\n' "${HTTP_PROXY:-DIRECT}"
