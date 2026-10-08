#!/bin/sh
# Keeps emulators from reaching the local network, the Docker host and other sessions.
#
# The agent names the bridge of every session's egress network "rdfe<11 hex>" (see agent/src/docker.mjs),
# so one static rule set covers every present and future session. Management networks are internal and are
# not touched. Run as root on each farm node, after Docker has started:
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

need_root() { [ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }; }

flush_chain() {
  "$IPT" -N "$1" 2>/dev/null || true
  "$IPT" -F "$1"
}

unhook() {
  while "$IPT" -D DOCKER-USER -i 'rdfe+' -j "$FWD" 2>/dev/null; do :; done
  while "$IPT" -D INPUT -i 'rdfe+' -j "$INP" 2>/dev/null; do :; done
}

remove() {
  unhook
  # An interrupted apply may have left temporary fail-closed guards.
  while "$IPT" -D DOCKER-USER -i 'rdfe+' -m comment --comment RDF-EGRESS-APPLY-GUARD -j DROP 2>/dev/null; do :; done
  while "$IPT" -D INPUT -i 'rdfe+' -m comment --comment RDF-EGRESS-APPLY-GUARD -j DROP 2>/dev/null; do :; done
  for chain in "$FWD" "$INP"; do
    "$IPT" -F "$chain" 2>/dev/null || true
    "$IPT" -X "$chain" 2>/dev/null || true
  done
}

apply() {
  # A hand-made DOCKER-USER chain is useless unless Docker calls it.
  "$IPT" -S DOCKER-USER >/dev/null 2>&1 &&
    "$IPT" -C FORWARD -j DOCKER-USER >/dev/null 2>&1 || {
      echo "Docker's DOCKER-USER hook is unavailable; refusing to install an ineffective firewall" >&2
      exit 1
    }

  # Fail closed while managed chains are rebuilt. A failed apply leaves these
  # guards in place rather than exposing existing emulator networks.
  "$IPT" -I DOCKER-USER 1 -i 'rdfe+' -m comment --comment RDF-EGRESS-APPLY-GUARD -j DROP
  "$IPT" -I INPUT 1 -i 'rdfe+' -m comment --comment RDF-EGRESS-APPLY-GUARD -j DROP
  flush_chain "$FWD"
  flush_chain "$INP"

  # Peer Docker bridges are always blocked, even when ALLOW_DEST is broad or
  # a connection was established before the firewall was applied.
  "$IPT" -A "$FWD" -o 'br-+' -j DROP
  "$IPT" -A "$FWD" -o 'rdfe+' -j DROP
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
  "$IPT" -I INPUT 1 -i 'rdfe+' -j "$INP"
  # Clear guards left by an interrupted earlier apply as well.
  while "$IPT" -D DOCKER-USER -i 'rdfe+' -m comment --comment RDF-EGRESS-APPLY-GUARD -j DROP 2>/dev/null; do :; done
  while "$IPT" -D INPUT -i 'rdfe+' -m comment --comment RDF-EGRESS-APPLY-GUARD -j DROP 2>/dev/null; do :; done
}

status() {
  "$IPT" -L DOCKER-USER -n -v --line-numbers | sed -n '1,6p'
  echo
  "$IPT" -L "$FWD" -n -v --line-numbers 2>/dev/null || echo "$FWD is not installed"
  echo
  "$IPT" -L "$INP" -n -v --line-numbers 2>/dev/null || echo "$INP is not installed"
}

case "${1:-}" in
  apply) need_root; apply; echo "egress firewall installed" ;;
  remove) need_root; remove; echo "egress firewall removed" ;;
  status) need_root; status ;;
  *) echo "usage: $0 apply|status|remove" >&2; exit 2 ;;
esac
