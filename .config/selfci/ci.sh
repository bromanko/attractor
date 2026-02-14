#!/usr/bin/env bash
set -eou pipefail

function job_lint() {
  selfci step start "typecheck"
  if ! npm run lint; then
    selfci step fail
  fi
}

function job_test() {
  # Integration tests execute dist/cli.js, so build before running vitest.
  selfci step start "tsc (for tests)"
  if ! npm run build; then
    selfci step fail
  fi

  selfci step start "vitest"
  if ! npm test; then
    selfci step fail
  fi
}

function job_build() {
  selfci step start "tsc"
  npm run build
}

function job_validate_workflows() {
  selfci step start "tsc (for validate)"
  if ! npm run build; then
    selfci step fail
  fi

  selfci step start "validate workflows"
  local failed=0
  for f in .attractor/workflows/*.awf.kdl examples/*.awf.kdl; do
    if [ ! -f "$f" ]; then
      continue
    fi
    echo "  validating $f"
    if ! node dist/cli.js validate "$f"; then
      failed=1
    fi
  done

  if [ "$failed" -ne 0 ]; then
    selfci step fail
  fi
}

function job_nix_build() {
  selfci step start "nix build"
  nix build
}

function ensure_deps() {
  # Avoid concurrent `npm ci` races when jobs share a working copy.
  if [ -d node_modules ]; then
    return
  fi

  local lock_dir=".selfci-npm-ci.lock"
  while ! mkdir "$lock_dir" 2>/dev/null; do
    if [ -d node_modules ]; then
      return
    fi
    sleep 0.2
  done

  (
    trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT
    if [ ! -d node_modules ]; then
      npm ci --ignore-scripts
    fi
  )
}

case "$SELFCI_JOB_NAME" in
  main)
    # install dependencies first (shared by all jobs)
    npm ci --ignore-scripts

    selfci job start "lint"
    selfci job start "test"
    selfci job start "build"
    selfci job start "validate-workflows"
    selfci job start "nix-build"

    selfci job wait "lint"
    selfci job wait "test"
    selfci job wait "build"
    selfci job wait "validate-workflows"
    selfci job wait "nix-build"
    ;;

  lint)
    nix develop -c bash -c "set -euo pipefail; $(declare -f ensure_deps); $(declare -f job_lint); ensure_deps; job_lint"
    ;;

  test)
    nix develop -c bash -c "set -euo pipefail; $(declare -f ensure_deps); $(declare -f job_test); ensure_deps; job_test"
    ;;

  build)
    nix develop -c bash -c "set -euo pipefail; $(declare -f ensure_deps); $(declare -f job_build); ensure_deps; job_build"
    ;;

  validate-workflows)
    nix develop -c bash -c "set -euo pipefail; $(declare -f ensure_deps); $(declare -f job_validate_workflows); ensure_deps; job_validate_workflows"
    ;;

  nix-build)
    job_nix_build
    ;;

  *)
    echo "Unknown job: $SELFCI_JOB_NAME"
    exit 1
    ;;
esac
