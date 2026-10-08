#!/bin/sh
# Tests rule ordering without touching the host firewall. Run with: sh test-policy.sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp=$(mktemp -d /tmp/rdf-firewall-test.XXXXXXXX)
cleanup() {
  rm -f "$tmp/id" "$tmp/iptables" "$tmp/conf" "$tmp/log"
  rmdir "$tmp"
}
trap cleanup EXIT

cat > "$tmp/id" <<'ID'
#!/bin/sh
if [ "$1" = "-u" ]; then echo 0; else /usr/bin/id "$@"; fi
ID
cat > "$tmp/iptables" <<'IPTABLES'
#!/bin/sh
printf '%s\n' "$*" >> "$RDF_TEST_LOG"
case "$1" in
  -D) exit 1 ;;
  -C) [ "$RDF_TEST_NO_HOOK" != "1" ] ;;
esac
IPTABLES
cat > "$tmp/conf" <<'CONF'
ALLOW_DNS="192.168.1.1"
ALLOW_DEST="10.0.0.0/8 172.16.0.0/12"
CONF
chmod 700 "$tmp/id" "$tmp/iptables"
: > "$tmp/log"

PATH="$tmp:$PATH" IPTABLES="$tmp/iptables" RDF_TEST_LOG="$tmp/log" RDF_TEST_NO_HOOK=0 \
  RDF_FIREWALL_CONF="$tmp/conf" sh "$here/rdf-egress-firewall.sh" apply >/dev/null

# Even a broad allowlist cannot reach another session or any Docker bridge.
awk '
  $0 == "-A RDF-EGRESS -o br-+ -j DROP" { br = NR }
  $0 == "-A RDF-EGRESS -o rdfe+ -j DROP" { peer = NR }
  $0 == "-A RDF-EGRESS -o docker0 -j DROP" { default_bridge = NR }
  $0 == "-A RDF-EGRESS -d 10.0.0.0/8 -j RETURN" { allow = NR }
  END { if (!br || !peer || !default_bridge || !allow ||
            br >= allow || peer >= allow || default_bridge >= allow) exit 1 }
' "$tmp/log"
grep -Fq -- '-A RDF-EGRESS-INPUT -j DROP' "$tmp/log"
if grep -Fq -- '--ctstate ESTABLISHED,RELATED -j RETURN' "$tmp/log"; then
  echo "conntrack bypasses a deny rule" >&2
  exit 1
fi

# An unhooked DOCKER-USER chain must be rejected before changing any rule.
: > "$tmp/log"
if PATH="$tmp:$PATH" IPTABLES="$tmp/iptables" RDF_TEST_LOG="$tmp/log" RDF_TEST_NO_HOOK=1 \
    RDF_FIREWALL_CONF="$tmp/conf" sh "$here/rdf-egress-firewall.sh" apply >/dev/null 2>&1; then
  echo "missing Docker hook was accepted" >&2
  exit 1
fi
if grep -Fq -- '-I DOCKER-USER' "$tmp/log"; then
  echo "firewall changed rules despite failed preflight" >&2
  exit 1
fi
echo "firewall policy order OK"