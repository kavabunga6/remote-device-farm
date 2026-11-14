#!/bin/sh
# Keeps emulators from reaching the local network, the Docker host and other sessions.
#
# The agent names the bridge of every session's egress network "rdfe<11 hex>" (see agent/src/docker.mjs),
# so one static rule set covers every present and future session. Internal management bridges use
# "rdfm<11 hex>" and permit agent-initiated traffic plus replies only. Run as root after Docker starts:
#
#   sudo ./rdf-egress-firewall.sh apply     # install or refresh the rules (idempotent)
#   sudo ./rdf-egress-firewall.sh status    # show the rules and their packet counters
#   sudo ./rdf-egress-firewall.sh remove    # delete the rules
#
# Settings come from /etc/rdf-firewall.conf (shell syntax), for example:
#   ALLOW_DNS="192.0.2.53"                  # resolvers the emulators may query when Docker forwards DNS upstream
#   ALLOW_DEST="198.51.100.50/32 10.20.0.0/24" # internal test backends the emulators are allowed to reach
#   BLOCK_DEST="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10"
set -eu

CONF=${RDF_FIREWALL_CONF:-/etc/rdf-firewall.conf}
ALLOW_DNS=""
ALLOW_DEST=""
BLOCK_DEST="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8 224.0.0.0/4"
# shellcheck disable=SC1090
[ -r "$CONF" ] && . "$CONF"

IPT=${IPTABLES:-iptables}
FWD=RDF-EGRESS
INP=RDF-EGRESS-INPUT
MGMT=RDF-MANAGEMENT

need_root() { [ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }; }

flush_chain() {
  "$IPT" -N "$1" 2>/dev/null || true
  "$IPT" -F "$1"
}

unhook() {
  while "$IPT" -D DOCKER-USER -i 'rdfe+' -j "$FWD" 2>/dev/null; do :; done
  while "$IPT" -D DOCKER-USER -i 'rdfm+' -j "$MGMT" 2>/dev/null; do :; done
  for bridge in 'rdfe+' 'rdfm+'; do
    while "$IPT" -D INPUT -i "$bridge" -j "$INP" 2>/dev/null; do :; done
  done
}

clear_guards() {
  for bridge in 'rdfe+' 'rdfm+'; do
    while "$IPT" -D DOCKER-USER -i "$bridge" -m comment --comment RDF-EGRESS-APPLY-GUARD -j DROP 2>/dev/null; do :; done
    while "$IPT" -D INPUT -i "$bridge" -m comment --comment RDF-EGRESS-APPLY-GUARD -j DROP 2>/dev/null; do :; done
  done
}

remove() {
  unhook
  # An interrupted apply may have left temporary fail-closed guards.
  clear_guards
  for chain in "$FWD" "$INP" "$MGMT"; do
    "$IPT" -F "$chain" 2>/dev/null || true
    "$IPT" -X "$chain" 2>/dev/null || true
  done
}

apply() {
  [ "$(cat "${RDF_BRIDGE_FILTER:-/proc/sys/net/bridge/bridge-nf-call-iptables}" 2>/dev/null)" = 1 ] || {
    echo "bridge-nf-call-iptables must be 1; refusing to install an ineffective management policy" >&2
    exit 1
  }
  here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  policy=${RDF_NETWORK_POLICY_FILE:-$here/network-policy.json}
  if [ ! -r "$policy" ] && [ -z "${RDF_NETWORK_POLICY_FILE:-}" ]; then
    policy="$here/../../agent/src/network-policy.json"
  fi
  agent_mac=$(awk -F '"' '$2 == "managementAgentMac" { print $4 }' "$policy")
  [ "${#agent_mac}" -eq 17 ] && printf '%s\n' "$agent_mac" | grep -Eq '^02(:[0-9a-f]{2}){5}$' || {
    echo "invalid or missing agent management identity in network-policy.json" >&2
    exit 1
  }
  # A hand-made DOCKER-USER chain is useless unless Docker calls it.
  "$IPT" -S DOCKER-USER >/dev/null 2>&1 &&
    "$IPT" -C FORWARD -j DOCKER-USER >/dev/null 2>&1 || {
      echo "Docker's DOCKER-USER hook is unavailable; refusing to install an ineffective firewall" >&2
      exit 1
    }

  # Fail closed while managed chains are rebuilt. A failed apply leaves these
  # guards in place rather than exposing existing emulator networks.
  for bridge in 'rdfe+' 'rdfm+'; do
    "$IPT" -I DOCKER-USER 1 -i "$bridge" -m comment --comment RDF-EGRESS-APPLY-GUARD -j DROP
    "$IPT" -I INPUT 1 -i "$bridge" -m comment --comment RDF-EGRESS-APPLY-GUARD -j DROP
  done
  flush_chain "$FWD"
  flush_chain "$INP"
  flush_chain "$MGMT"

  # Both endpoints share a bridge. Only the agent's endpoint may originate
  # connections. No established ORIGINAL flow from an emulator is grandfathered.
  # MAC identity relies on non-privileged emulator containers retaining CapDrop=ALL
  # and no-new-privileges; privileged containers are outside this boundary.
  "$IPT" -A "$MGMT" -m conntrack --ctstate INVALID -j DROP
  # Explicit ACCEPT is needed here: Docker's ICC=false otherwise denies even
  # agent-originated connections. Without this policy, new flows fail closed.
  "$IPT" -A "$MGMT" -o 'rdfm+' -m mac --mac-source "$agent_mac" -j ACCEPT
  "$IPT" -A "$MGMT" -o 'rdfm+' -m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j ACCEPT
  "$IPT" -A "$MGMT" -j DROP

  # Peer Docker bridges are always blocked, even when ALLOW_DEST is broad or
  # a connection was established before the firewall was applied.
  "$IPT" -A "$FWD" -o 'br-+' -j DROP
  "$IPT" -A "$FWD" -o 'rdfe+' -j DROP
  "$IPT" -A "$FWD" -o 'rdfm+' -j DROP
  "$IPT" -A "$FWD" -o docker0 -j DROP
  for resolver in $ALLOW_DNS; do
    "$IPT" -A "$FWD" -d "$resolver" -p udp --dport 53 -j RETURN
    "$IPT" -A "$FWD" -d "$resolver" -p tcp --dport 53 -j RETURN
  done
  for destination in $ALLOW_DEST; do "$IPT" -A "$FWD" -d "$destination" -j RETURN; done
  for destination in $BLOCK_DEST; do "$IPT" -A "$FWD" -d "$destination" -j DROP; done
  # Public destinations remain available. Conntrack never bypasses a new deny.
  "$IPT" -A "$FWD" -j RETURN

  # All traffic addressed to the node itself is refused, including connections
  # that were established before this policy was installed.
  "$IPT" -A "$INP" -j DROP

  unhook
  "$IPT" -I DOCKER-USER 1 -i 'rdfe+' -j "$FWD"
  "$IPT" -I DOCKER-USER 1 -i 'rdfm+' -j "$MGMT"
  "$IPT" -I INPUT 1 -i 'rdfe+' -j "$INP"
  "$IPT" -I INPUT 1 -i 'rdfm+' -j "$INP"
  # Clear guards left by an interrupted earlier apply as well.
  clear_guards
}

status() {
  "$IPT" -L DOCKER-USER -n -v --line-numbers | sed -n '1,6p'
  echo
  "$IPT" -L "$FWD" -n -v --line-numbers 2>/dev/null || echo "$FWD is not installed"
  echo
  "$IPT" -L "$INP" -n -v --line-numbers 2>/dev/null || echo "$INP is not installed"
  echo
  "$IPT" -L "$MGMT" -n -v --line-numbers 2>/dev/null || echo "$MGMT is not installed"
}

case "${1:-}" in
  apply) need_root; apply; echo "egress firewall installed" ;;
  remove) need_root; remove; echo "egress firewall removed" ;;
  status) need_root; status ;;
  *) echo "usage: $0 apply|status|remove" >&2; exit 2 ;;
esac
