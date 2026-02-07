#!/usr/bin/env bash
set -eou pipefail

function job_lint() {
  selfci step start "typecheck"
  if ! npm run lint; then
    selfci step fail
  fi
}

function job_test() {
  selfci step start "vitest"
  if ! npm test; then
    selfci step fail
  fi
}

function job_build() {
  selfci step start "tsc"
  npm run build
}

case "$SELFCI_JOB_NAME" in
  main)
    # install dependencies first (shared by all jobs)
    npm ci --ignore-scripts

    selfci job start "lint"
    selfci job start "test"
    selfci job start "build"

    selfci job wait "lint"
    selfci job wait "test"
    selfci job wait "build"
    ;;

  lint)
    nix develop -c bash -c "npm ci --ignore-scripts && $(declare -f job_lint); job_lint"
    ;;

  test)
    nix develop -c bash -c "npm ci --ignore-scripts && $(declare -f job_test); job_test"
    ;;

  build)
    nix develop -c bash -c "npm ci --ignore-scripts && $(declare -f job_build); job_build"
    ;;

  *)
    echo "Unknown job: $SELFCI_JOB_NAME"
    exit 1
    ;;
esac
