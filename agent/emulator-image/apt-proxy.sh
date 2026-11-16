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
# awk is available in the base image before Python is installed. Compare IPv6
# numerically, including IPv4-mapped forms, without DNS or network access.
exec awk -v host="$host" '
function ipv6(value, parts, octets, count, occupied, expanded, i, part, result) {
  if (index(value, ".")) {
    part = value; sub(/^.*:/, "", part)
    split(part, octets, ".")
    sub(/[^:]+$/, sprintf("%x:%x", octets[1] * 256 + octets[2], octets[3] * 256 + octets[4]), value)
  }
  count = split(value, parts, ":")
  for (i = 1; i <= count; i++) if (parts[i] != "") occupied++
  for (i = 1; i <= count; i++) {
    if (parts[i] == "") {
      if (!expanded++) for (; occupied < 8; occupied++) result = result ":0"
    } else {
      part = parts[i]; sub(/^0+/, "", part)
      result = result ":" (part == "" ? "0" : part)
    }
  }
  return result
}
BEGIN {
  host = tolower(host); sub(/\.$/, "", host)
  if (index(host, ":")) hostIP = ipv6(host)
  count = split(ENVIRON["RDF_NO_PROXY"], entries, ",")
  for (i = 1; i <= count; i++) {
    entry = entries[i]
    if (entry == "*") { print "DIRECT"; exit }
    if (index(entry, ":")) matches = hostIP != "" && ipv6(entry) == hostIP
    else matches = host == entry || (entry ~ /[^0-9.]/ && length(host) > length(entry) && substr(host, length(host) - length(entry)) == "." entry)
    if (matches) { print "DIRECT"; exit }
  }
  # No output lets APT use the full generic proxy URL from its environment.
  # Emitting that URL here would truncate long credentials in APT autodetect.
  exit
}'
