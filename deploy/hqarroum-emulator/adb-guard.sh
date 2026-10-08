#!/bin/sh
# The emulator's SDK-local ADB helper is not the farm ADB client. It must never
# start a second daemon or introduce another key into an authenticated guest.
if [ "$#" -eq 1 ]; then
    case "$1" in
        version|--version)
            exec "$(dirname "$0")/adb.rdf-real" "$1"
            ;;
    esac
fi
printf '%s\n' 'SDK-local ADB is disabled; use the farm ADB connection.' >&2
exit 69
