#!/bin/sh
# Tests rule ordering without touching the host firewall. Run with: sh test-policy.sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp=$(mktemp -d /tmp/rdf-firewall-test.XXXXXXXX)
cleanup() {
  rm -f "$tmp/id" "$tmp/iptables" "$tmp/conf" "$tmp/log" "$tmp/bridge-filter"
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
  -A) if [ "${RDF_TEST_FAIL_MANAGEMENT:-0}" = 1 ] && [ "$2" = RDF-MANAGEMENT ]; then exit 1; fi ;;
esac
IPTABLES
cat > "$tmp/conf" <<'CONF'
ALLOW_DNS="192.168.1.1"
ALLOW_DEST="10.0.0.0/8 172.16.0.0/12"
CONF
chmod 700 "$tmp/id" "$tmp/iptables"
echo 1 > "$tmp/bridge-filter"
: > "$tmp/log"

PATH="$tmp:$PATH" IPTABLES="$tmp/iptables" RDF_TEST_LOG="$tmp/log" RDF_TEST_NO_HOOK=0 RDF_BRIDGE_FILTER="$tmp/bridge-filter" \
  RDF_FIREWALL_CONF="$tmp/conf" sh "$here/rdf-egress-firewall.sh" apply >/dev/null

# Even a broad allowlist cannot reach another session or any Docker bridge.
awk '
  $0 == "-A RDF-EGRESS -o br-+ -j DROP" { br = NR }
  $0 == "-A RDF-EGRESS -o rdfe+ -j DROP" { peer = NR }
  $0 == "-A RDF-EGRESS -o rdfm+ -j DROP" { management = NR }
  $0 == "-A RDF-EGRESS -o docker0 -j DROP" { default_bridge = NR }
  $0 == "-A RDF-EGRESS -d 10.0.0.0/8 -j RETURN" { allow = NR }
  END { if (!br || !peer || !management || !default_bridge || !allow ||
            br >= allow || peer >= allow || management >= allow || default_bridge >= allow) exit 1 }
' "$tmp/log"
grep -Fq -- '-A RDF-EGRESS-INPUT -j DROP' "$tmp/log"
if grep -Fq -- '-A RDF-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN' "$tmp/log"; then
  echo "conntrack bypasses a deny rule" >&2
  exit 1
fi

# Only agent-originated management traffic and replies to it may pass.
mac=$(awk -F '"' '$2 == "managementAgentMac" { print $4 }' "$here/../../agent/src/network-policy.json")
grep -Fq -- "-A RDF-MANAGEMENT -o rdfm+ -m mac --mac-source $mac -j ACCEPT" "$tmp/log"
grep -Fq -- '-A RDF-MANAGEMENT -o rdfm+ -m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j ACCEPT' "$tmp/log"
grep -Fq -- '-A RDF-MANAGEMENT -j DROP' "$tmp/log"
grep -Fq -- '-I DOCKER-USER 1 -i rdfm+ -j RDF-MANAGEMENT' "$tmp/log"
grep -Fq -- '-I INPUT 1 -i rdfm+ -j RDF-EGRESS-INPUT' "$tmp/log"
awk '
  /-I DOCKER-USER 1 -i rdfm\+ .*RDF-EGRESS-APPLY-GUARD/ { guard = NR }
  $0 == "-F RDF-MANAGEMENT" { flush = NR }
  $0 == "-A RDF-MANAGEMENT -j DROP" { deny = NR }
  END { if (!guard || !flush || !deny || guard >= flush || flush >= deny) exit 1 }
' "$tmp/log"

# An unhooked DOCKER-USER chain must be rejected before changing any rule.
: > "$tmp/log"
if PATH="$tmp:$PATH" IPTABLES="$tmp/iptables" RDF_TEST_LOG="$tmp/log" RDF_TEST_NO_HOOK=1 RDF_BRIDGE_FILTER="$tmp/bridge-filter" \
    RDF_FIREWALL_CONF="$tmp/conf" sh "$here/rdf-egress-firewall.sh" apply >/dev/null 2>&1; then
  echo "missing Docker hook was accepted" >&2
  exit 1
fi

if grep -Fq -- '-I DOCKER-USER' "$tmp/log"; then
  echo "firewall changed rules despite failed preflight" >&2
  exit 1
fi

# Bridge filtering disabled must fail before installing any rules.
echo 0 > "$tmp/bridge-filter"
: > "$tmp/log"
if PATH="$tmp:$PATH" IPTABLES="$tmp/iptables" RDF_TEST_LOG="$tmp/log" RDF_TEST_NO_HOOK=0 RDF_BRIDGE_FILTER="$tmp/bridge-filter" \
    RDF_FIREWALL_CONF="$tmp/conf" sh "$here/rdf-egress-firewall.sh" apply >/dev/null 2>&1; then
  echo "disabled bridge filtering was accepted" >&2; exit 1
fi
if grep -Eq -- '^-(I|A|N|F) ' "$tmp/log"; then
  echo "firewall changed rules despite disabled bridge filtering" >&2; exit 1
fi

# A failed update keeps guards on the management bridge.
echo 1 > "$tmp/bridge-filter"
: > "$tmp/log"
if PATH="$tmp:$PATH" IPTABLES="$tmp/iptables" RDF_TEST_LOG="$tmp/log" RDF_TEST_NO_HOOK=0 RDF_BRIDGE_FILTER="$tmp/bridge-filter" \
    RDF_TEST_FAIL_MANAGEMENT=1 RDF_FIREWALL_CONF="$tmp/conf" sh "$here/rdf-egress-firewall.sh" apply >/dev/null 2>&1; then
  echo "failed management update was accepted" >&2; exit 1
fi
grep -Fq -- '-I DOCKER-USER 1 -i rdfm+ -m comment --comment RDF-EGRESS-APPLY-GUARD -j DROP' "$tmp/log"
if grep -Fq -- '-D DOCKER-USER -i rdfm+ -m comment --comment RDF-EGRESS-APPLY-GUARD -j DROP' "$tmp/log"; then
  echo "failed update removed management guard" >&2; exit 1
fi
echo "firewall policy order OK"
