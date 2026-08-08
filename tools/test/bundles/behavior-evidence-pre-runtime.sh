#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"

# --- Gather inputs from matrix artifacts ---

ADMISSION_RECEIPT="${FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT:-${ROOT_DIR}/.tmp/behavior-doc-static-admission/receipt.json}"
CATALOG="${ROOT_DIR}/config/contracts/behavior-contracts.json"
OWNER_RECEIPT="${ROOT_DIR}/.tmp/behavior-owner-binding/receipt.json"
DOC_CLAIM_PARSE="${ROOT_DIR}/.tmp/doc-claim-parse/receipt.json"
DOC_CLAIM_VERIFICATION="${ROOT_DIR}/.tmp/doc-claim-verification/receipt.json"
GENERATED_SECTION_CHECK="${ROOT_DIR}/.tmp/generated-section-check/receipt.json"
MUTATION_EVIDENCE="${ROOT_DIR}/.tmp/mutation/backend-critical/authority.json"
OUT_DIR="${ROOT_DIR}/.tmp/behavior-evidence-pre-runtime"
mkdir -p "$OUT_DIR"

SOURCE_COMMIT="${FSUSBLOG_TEST_SOURCE_COMMIT:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
WORKTREE_FP="${FSUSBLOG_TEST_SOURCE_FINGERPRINT:-}"

# --- Build test evidence receipts from backend/frontend results ---
TEST_EVIDENCE_ARGS=()

# Backend test evidence
BACKEND_TRX_DIR="${ROOT_DIR}/.tmp/test-results/backend"
if [[ -d "$BACKEND_TRX_DIR" ]]; then
  BE_OBS_FILE="${ROOT_DIR}/.tmp/test-observations/backend-behavior-observations.json"
  # The test evidence receipt might be pre-built; accept existing path
  BACKEND_EVIDENCE="${ROOT_DIR}/.tmp/behavior-test-evidence/backend.json"
  if [[ -f "$BACKEND_EVIDENCE" ]]; then
    TEST_EVIDENCE_ARGS+=(--test-evidence "$BACKEND_EVIDENCE")
  fi
fi

# Frontend test evidence
FRONTEND_RESULTS_DIR="${ROOT_DIR}/.tmp/test-results/frontend"
if [[ -d "$FRONTEND_RESULTS_DIR" ]]; then
  FRONTEND_EVIDENCE="${ROOT_DIR}/.tmp/behavior-test-evidence/frontend.json"
  if [[ -f "$FRONTEND_EVIDENCE" ]]; then
    TEST_EVIDENCE_ARGS+=(--test-evidence "$FRONTEND_EVIDENCE")
  fi
fi

# Fallback: if no pre-built evidence files found, try a combined evidence path
if [[ ${#TEST_EVIDENCE_ARGS[@]} -eq 0 ]]; then
  COMBINED_EVIDENCE="${ROOT_DIR}/.tmp/behavior-test-evidence/receipt.json"
  if [[ -f "$COMBINED_EVIDENCE" ]]; then
    TEST_EVIDENCE_ARGS+=(--test-evidence "$COMBINED_EVIDENCE")
  fi
fi

# --- Build fact observation args ---
FACT_OBS_ARGS=()
FACT_DIR="${ROOT_DIR}/.tmp/fact-observations"
if [[ -d "$FACT_DIR" ]]; then
  for receipt in "$FACT_DIR"/*.json; do
    if [[ -f "$receipt" ]]; then
      FACT_OBS_ARGS+=(--fact-observation "$receipt")
    fi
  done
fi

# --- Build mutation evidence arg ---
MUTATION_ARGS=()
if [[ -f "$MUTATION_EVIDENCE" ]]; then
  MUTATION_ARGS+=(--mutation-evidence "$MUTATION_EVIDENCE")
fi

# --- Resolve worktree fingerprint ---
if [[ -z "$WORKTREE_FP" ]]; then
  WORKTREE_FP="sha256:$("$NODE_BIN" -e "
    const { createHash } = require('node:crypto');
    const { execSync } = require('node:child_process');
    const status = execSync('git status --porcelain', { cwd: '$ROOT_DIR', encoding: 'utf8' });
    console.log(createHash('sha256').update(status).digest('hex'));
  ")"
fi

# --- Execute the gate ---
GATE_ARGS=(
  --catalog "$CATALOG"
  --owner "$OWNER_RECEIPT"
  --static-admission "$ADMISSION_RECEIPT"
  "${TEST_EVIDENCE_ARGS[@]}"
  --doc-claim-parse "$DOC_CLAIM_PARSE"
  --doc-claim-verification "$DOC_CLAIM_VERIFICATION"
  --generated-section-check "$GENERATED_SECTION_CHECK"
  "${FACT_OBS_ARGS[@]}"
  "${MUTATION_ARGS[@]}"
  --source-commit "$SOURCE_COMMIT"
  --worktree-fingerprint "$WORKTREE_FP"
  --out "$OUT_DIR/receipt.json"
  --assert
)

exec "$NODE_BIN" "$ROOT_DIR/tools/test-matrix/behavior-evidence-pre-runtime.mjs" "${GATE_ARGS[@]}"
