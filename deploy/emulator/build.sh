#!/usr/bin/env bash
# Builds farm emulator images from Google's SDK repository and writes a profile manifest for them.
# Requires Linux, Docker Engine 28+ and Node.js 24+ on the build host.
#
#   ./build.sh --list                          # what Google publishes for this host ABI
#   ./build.sh --filter 'android-3[3-6];'      # build Android 13-16 (all form factors)
#   ./build.sh --filter 'tv|automotive'        # TV and automotive only
#   ./build.sh --registry registry.corp/rdf-emulator --push      # build everything and push to your registry
#
# Output: images <registry>:<tag> (tag like 34-google_apis_playstore-x86_64) and out/profiles.json, a manifest to import
# under «Профили устройств → Импорт JSON». Imported profiles arrive disabled.
set -Eeuo pipefail
cd "$(dirname "$0")"
repo=$(cd ../.. && pwd)

registry=rdf-emulator
filter=
push=false
list_only=false
extensions=false
abi=$(case "$(uname -m)" in x86_64|amd64) echo x86_64 ;; aarch64|arm64) echo arm64-v8a ;; *) uname -m ;; esac)
while (( $# )); do
  case "$1" in
    --registry) registry=$2; shift 2 ;;
    --filter) filter=$2; shift 2 ;;
    --abi) abi=$2; shift 2 ;;
    --push) push=true; shift ;;
    --list) list_only=true; shift ;;
    --extensions) extensions=true; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

catalog() { node "$repo/agent/src/emulator-catalog.mjs" "$@"; }
mkdir -p out

echo "==> Google command-line tools"
node "$repo/deploy/emulator/build-local.mjs" rdf-emulator-tools:latest "" tools
echo "==> Listing system images"
docker run --rm --cpus 1 --memory 1g --memory-swap 1g --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges:true rdf-emulator-tools:latest sdkmanager --list --channel=0 > out/sdkmanager-list.txt
catalog parse < out/sdkmanager-list.txt > out/catalog.json

select_args=(--abi "$abi")
[[ -n "$filter" ]] && select_args+=(--filter "$filter")
$extensions && select_args+=(--extensions)
catalog select "${select_args[@]}" < out/catalog.json > out/selected.tsv
count=$(wc -l < out/selected.tsv | tr -d ' ')
echo "==> $count image(s) for $abi${filter:+ matching $filter}"
if $list_only; then cut -f2 out/selected.tsv; exit 0; fi
(( count > 0 )) || { echo "nothing to build" >&2; exit 1; }

failed=()
# This ledger is reset for every run. A previous successful manifest must not mask today's failed builds.
: > out/completed.tsv
printf '{"version":2,"profiles":[]}\n' > out/profiles.json
while IFS=$'\t' read -r package tag; do
  echo "==> $registry:$tag  ($package)"
  if ! node "$repo/deploy/emulator/build-local.mjs" "$registry:$tag" "$package"; then
    failed+=("$tag (build)")
    continue
  fi
  digest=
  if $push; then
    if ! docker push "$registry:$tag" > out/push.log 2>&1; then
      cat out/push.log >&2
      failed+=("$tag (push)")
      continue
    fi
    cat out/push.log
    digest=$(sed -n 's/.*digest: \(sha256:[a-f0-9]\{64\}\).*/\1/p' out/push.log | tail -n 1)
    if [[ ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      failed+=("$tag (missing registry digest)")
      continue
    fi
    # Pull by digest verifies that this immutable reference exists in the remote registry.
    if ! docker pull "$registry@$digest"; then
      failed+=("$tag (digest verification)")
      continue
    fi
  fi
  printf '%s\t%s\n' "$package" "$digest" >> out/completed.tsv
done < out/selected.tsv

mode=local
$push && mode=pushed
node "$repo/deploy/emulator/verified-manifest.mjs" out/catalog.json out/completed.tsv out/profiles.json "$registry" "$abi" "$mode"
echo "==> Manifest: $(pwd)/out/profiles.json"
echo "    Allow the images on the agent: AGENT_ALLOWED_IMAGE_PREFIXES=$registry"
if (( ${#failed[@]} )); then
  printf 'Failed: %s\n' "${failed[@]}" >&2
  exit 1
fi
