#!/usr/bin/env bash
# Compatibility entry point for the Jenkins resource names.
exec bash "$(dirname "$0")/managed-cleanup.sh" "$@"
