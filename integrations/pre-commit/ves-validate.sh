#!/usr/bin/env bash
# Entry of the ves-validate pre-commit hook: runs the harness this script ships with against the repo in $PWD.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/../../src/cli.ts" validate --strict "$@"
