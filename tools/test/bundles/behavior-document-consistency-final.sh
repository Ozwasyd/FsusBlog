#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
FACT_DIR="${FSUSBLOG_BEHAVIOR_STATIC_COMPONENTS:-$ROOT_DIR/.tmp/behavior-doc-static-admission/components}/fact-observations"
FACT_ARGS=()
while IFS= read -r fact; do
  FACT_ARGS+=(--fact "$fact")
done < <(find "$FACT_DIR" -maxdepth 1 -type f -name '*.json' -print | LC_ALL=C sort)

if [[ "${#FACT_ARGS[@]}" -eq 0 ]]; then
  printf '[behavior-document-consistency-final] exact static fact receipts are missing\n' >&2
  exit 2
fi

exec "$NODE_BIN" "$ROOT_DIR/tools/docs/behavior-document-consistency-final.mjs" \
    --run-id "${FSUSBLOG_TEST_RUN_ID:?current scheduler run identity is required}" \
    --scheduler-verification-context "${FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT:?canonical scheduler context is required}" \
    --scheduler-verification-context-digest "${FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT_DIGEST:?scheduler context digest is required}" \
    --candidate-identity-digest "${FSUSBLOG_SCHEDULER_CANDIDATE_IDENTITY_DIGEST:?scheduler candidate identity is required}" \
  --static-admission "${FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT:-$ROOT_DIR/.tmp/behavior-doc-static-admission/receipt.json}" \
  --pre-runtime "${FSUSBLOG_BEHAVIOR_PRE_RUNTIME_RECEIPT:-$ROOT_DIR/.tmp/behavior-evidence-pre-runtime/receipt.json}" \
  --post-runtime "${FSUSBLOG_BEHAVIOR_POST_RUNTIME_RECEIPT:-$ROOT_DIR/.tmp/behavior-evidence-post-runtime/receipt.json}" \
  --owner "${FSUSBLOG_BEHAVIOR_STATIC_COMPONENTS:-$ROOT_DIR/.tmp/behavior-doc-static-admission/components}/behavior-owner-binding.json" \
  "${FACT_ARGS[@]}" \
  --doc-claim-parse "${FSUSBLOG_BEHAVIOR_STATIC_COMPONENTS:-$ROOT_DIR/.tmp/behavior-doc-static-admission/components}/doc-claim-parse.json" \
  --doc-claim-verification "${FSUSBLOG_BEHAVIOR_STATIC_COMPONENTS:-$ROOT_DIR/.tmp/behavior-doc-static-admission/components}/doc-claim-verification.json" \
  --generated-section "${FSUSBLOG_BEHAVIOR_STATIC_COMPONENTS:-$ROOT_DIR/.tmp/behavior-doc-static-admission/components}/generated-section-check.json" \
  --catalog "$ROOT_DIR/config/contracts/behavior-contracts.json" \
  --migration-ledger "$ROOT_DIR/config/contracts/document-claim-migration-ledger.json" \
  --matrix "$ROOT_DIR/tests/matrix.yml" \
  --out "${FSUSBLOG_BEHAVIOR_CONSISTENCY_FINAL_REPORT:-$ROOT_DIR/.tmp/behavior-document-consistency-final/report.json}"
