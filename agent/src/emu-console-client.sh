# This script executes inside the emulator container, never on the Docker host.
# Google launch-emulator.sh requires bash and uses 5556 internally; 5554 is an
# optional forwarding port. No listening socket or external port is created here.
command -v bash >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1 || {
  printf '%s\n' 'Emulator console requires bash and timeout inside the image' >&2
  exit 69
}
exec timeout --signal=TERM --kill-after=1 "${EMU_TIMEOUT_SECONDS}s" bash -s -- "$EMU_CMD" "$EMU_CONSOLE_PORTS" "$EMU_TIMEOUT_SECONDS" <<'RDF_EMU_CONSOLE'
command_text=$1
ports=$2
budget=$3
[[ "$budget" =~ ^[0-9]+$ && "$budget" -ge 1 && "$budget" -le 18 ]] || exit 64
[[ "$ports" =~ ^[0-9]{1,5}\ [0-9]{1,5}$ ]] || exit 64
deadline=$((SECONDS + budget))
error='No emulator console answered on the internal ports'

# Consume exactly one protocol reply. Greeting and authentication text stay local;
# only the command response is returned. Tokens are never printed or returned.
read_reply() {
  local phase=$1 limit=$2 line status remaining count=0
  while :; do
    remaining=$((limit - SECONDS))
    if ((remaining <= 0)); then error="Emulator console timed out during $phase"; return 124; fi
    IFS= read -r -t "$remaining" -n 8193 line <&3
    status=$?
    if ((status != 0)); then
      if ((status > 128)); then error="Emulator console timed out during $phase"; return 124; fi
      error="Emulator console closed before confirming $phase"; return 1
    fi
    line=${line%$'\r'}
    count=$((count + ${#line} + 1))
    if ((${#line} > 8192 || count > 65536)); then error='Emulator console response exceeds limit'; return 1; fi
    if [[ "$phase" == greeting ]]; then
      [[ "$line" == 'Android Console:'* ]] && banner_seen=1
      [[ "$line" == *'Authentication required'* ]] && auth_needed=1
      if [[ "$line" =~ ^\'(/[^[:cntrl:]]*/\.emulator_console_auth_token)\'$ ]]; then token_path=${BASH_REMATCH[1]}; fi
    fi
    if [[ "$line" == OK ]]; then
      [[ "$phase" == command ]] && printf 'OK\n'
      return 0
    fi
    if [[ "$line" == KO || "$line" == KO:* || "$line" == KO\ * ]]; then
      if [[ "$phase" == command ]]; then printf '%s\n' "$line"; error='Emulator console rejected command'; else error="Emulator console rejected $phase"; fi
      return 1
    fi
    [[ "$phase" == command ]] && printf '%s\n' "$line"
  done
}

connected=''
for port in $ports; do
  ((port >= 1024 && port <= 65535)) || exit 64
  if { exec 3<>"/dev/tcp/127.0.0.1/$port"; } 2>/dev/null; then
    banner_seen=0; auth_needed=0; token_path=''
    greeting_deadline=$((SECONDS + 3))
    ((greeting_deadline > deadline)) && greeting_deadline=$deadline
    if read_reply greeting "$greeting_deadline" && ((banner_seen)); then connected=$port; break; fi
    exec 3<&-; exec 3>&-
  fi
done
if [[ -z "$connected" ]]; then printf '%s\n' "$error" >&2; exit 69; fi

if ((auth_needed)); then
  token=''
  # Prefer the path announced by this console. The fallback locations cover the
  # official Google launcher and the normal emulator user home.
  for token_file in "$token_path" "${HOME:-/root}/.emulator_console_auth_token" /root/.emulator_console_auth_token /run/secrets/token; do
    if [[ -n "$token_file" && -f "$token_file" && -r "$token_file" ]]; then
      token=$(head -c 4097 -- "$token_file")
      if [[ -n "$token" && ${#token} -le 4096 && "$token" != *[$'\r\n\t ']* ]]; then break; fi
      token=''
    fi
  done
  if [[ -z "$token" ]]; then printf '%s\n' 'Emulator console requires a readable local authentication token' >&2; exit 1; fi
  printf 'auth %s\r\n' "$token" >&3 || exit 1
  unset token
  if ! read_reply authentication "$deadline"; then printf '%s\n' "$error" >&2; exit 1; fi
fi

printf '%s\r\n' "$command_text" >&3 || { printf '%s\n' 'Emulator console closed before receiving the command' >&2; exit 1; }
read_reply command "$deadline"
status=$?
((status != 0)) && printf '%s\n' "$error" >&2
# Closing this connection is sufficient; waiting for quit would add no command
# confirmation and may block on older images.
exec 3<&-; exec 3>&-
exit "$status"
RDF_EMU_CONSOLE
