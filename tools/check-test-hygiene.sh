#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$ROOT_DIR/tests/backend"
CLIENT_DIR="$ROOT_DIR/src/frontend"
CLIENT_TEST_DIR="$ROOT_DIR/tests/frontend"
CLIENT_SCRIPT_DIR="$CLIENT_DIR/scripts"

echo "[test-hygiene] checking root layout"

ROOT_FILES="$(
  find "$TEST_DIR" -maxdepth 1 -type f \
    ! -name 'FsusBlog.Server.Tests.csproj' \
    ! -name 'GlobalUsings.cs' \
    ! -name 'TESTING.md' \
    ! -name 'packages.lock.json' | sort
)"

if [[ -n "$ROOT_FILES" ]]; then
  echo "[test-hygiene] unexpected files in tests/backend root:"
  echo "$ROOT_FILES"
  exit 1
fi

ROOT_DIRS="$(
  find "$TEST_DIR" -maxdepth 1 -mindepth 1 -type d \
    ! -name 'Unit' \
    ! -name 'Integration' \
    ! -name 'Fixtures' \
    ! -name 'Helpers' \
    ! -name 'bin' \
    ! -name 'obj' \
    ! -name 'TestResults' \
    ! -name '.artifacts' \
    ! -name '.tmp' \
    ! -name '.migrated-root' | sort
)"

if [[ -n "$ROOT_DIRS" ]]; then
  echo "[test-hygiene] unexpected directories in tests/backend root:"
  echo "$ROOT_DIRS"
  exit 1
fi

echo "[test-hygiene] checking integration naming and traits"

BAD_INTEGRATION_NAMES="$(
  find "$TEST_DIR/Integration" -type f -name '*.cs' ! -name '*IntegrationTests.cs' | sort || true
)"

if [[ -n "$BAD_INTEGRATION_NAMES" ]]; then
  echo "[test-hygiene] integration tests must use *IntegrationTests.cs:"
  echo "$BAD_INTEGRATION_NAMES"
  exit 1
fi

MISSING_INTEGRATION_TRAIT="$(
  find "$TEST_DIR/Integration" -type f -name '*.cs' -print0 | while IFS= read -r -d '' file; do
    if ! rg -q '\[Trait\("Category", "Integration"\)\]' "$file"; then
      printf '%s\n' "$file"
    fi
  done
)"

if [[ -n "$MISSING_INTEGRATION_TRAIT" ]]; then
  echo "[test-hygiene] integration tests missing [Trait(\"Category\", \"Integration\")]:"
  echo "$MISSING_INTEGRATION_TRAIT"
  exit 1
fi

UNIT_WITH_INTEGRATION_TRAIT="$(
  rg -n '\[Trait\("Category", "Integration"\)\]' "$TEST_DIR/Unit" --glob '*.cs' || true
)"

if [[ -n "$UNIT_WITH_INTEGRATION_TRAIT" ]]; then
  echo "[test-hygiene] unit tests cannot carry Integration trait:"
  echo "$UNIT_WITH_INTEGRATION_TRAIT"
  exit 1
fi

echo "[test-hygiene] checking fixture/helper placement"

MISPLACED_FIXTURES="$(
  find "$TEST_DIR/Fixtures" -type f \
    ! -name '*Fixture.cs' \
    ! -name '*Collection.cs' \
    ! -name '*.sql' \
    ! -name '*.json' \
    ! -name '*.jsonc' \
    ! -name '*.txt' | sort || true
)"

if [[ -n "$MISPLACED_FIXTURES" ]]; then
  echo "[test-hygiene] fixtures directory contains unsupported files:"
  echo "$MISPLACED_FIXTURES"
  exit 1
fi

echo "[test-hygiene] checking test artifact residue"

RESIDUE="$(
  find "$TEST_DIR" \( \
      -path '*/bin/*' -o \
      -path '*/obj/*' -o \
      -path '*/.artifacts/*' -o \
      -path '*/.tmp/*' \
    \) -prune -o -type f \( \
      -name '*.trx' -o \
      -name '*.received.*' -o \
      -name '*.snap' -o \
      -name '*.db' -o \
      -name '*.sqlite' -o \
      -name '*.sqlite3' -o \
      -name '*.log' -o \
      -name '*.coverage' -o \
      -name '*.coveragexml' \
    \) -print | sort
)"

if [[ -n "$RESIDUE" ]]; then
  echo "[test-hygiene] test artifact residue detected:"
  echo "$RESIDUE"
  exit 1
fi

echo "[test-hygiene] checking frontend test layout"

if [[ ! -d "$CLIENT_TEST_DIR" ]]; then
  echo "[test-hygiene] missing tests/frontend directory"
  exit 1
fi

CLIENT_ROOT_TEST_FILES="$(
  find "$CLIENT_TEST_DIR" -maxdepth 1 -type f \
    ! -name 'README.md' \
    ! -name 'package.json' | sort
)"

if [[ -n "$CLIENT_ROOT_TEST_FILES" ]]; then
  echo "[test-hygiene] unexpected files in tests/frontend root:"
  echo "$CLIENT_ROOT_TEST_FILES"
  exit 1
fi

CLIENT_ROOT_TEST_DIRS="$(
  find "$CLIENT_TEST_DIR" -maxdepth 1 -mindepth 1 -type d \
    ! -name 'benchmarks' \
    ! -name 'checks' \
    ! -name 'e2e' \
    ! -name 'fixtures' \
    ! -name 'model' \
    ! -name 'property' \
    ! -name 'support' \
    ! -name 'unit' | sort
)"

if [[ -n "$CLIENT_ROOT_TEST_DIRS" ]]; then
  echo "[test-hygiene] unexpected directories in tests/frontend root:"
  echo "$CLIENT_ROOT_TEST_DIRS"
  exit 1
fi

MISPLACED_CLIENT_CHECKS="$(
  if [[ -d "$CLIENT_SCRIPT_DIR" ]]; then
    find "$CLIENT_SCRIPT_DIR" -maxdepth 1 -type f \( \
        -name 'check-*.mjs' -o \
        -name '*-smoke.mjs' -o \
        -name '*-regression.mjs' \
      \) | sort
  fi
)"

if [[ -n "$MISPLACED_CLIENT_CHECKS" ]]; then
  echo "[test-hygiene] frontend checks belong under tests/frontend/checks, not scripts/:"
  echo "$MISPLACED_CLIENT_CHECKS"
  exit 1
fi

echo "[test-hygiene] passed"
