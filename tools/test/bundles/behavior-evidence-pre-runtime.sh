#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"

if [[ -z "${FSUSBLOG_TEST_SOURCE_COMMIT:-}" || -z "${FSUSBLOG_TEST_SOURCE_FINGERPRINT:-}" || -z "${FSUSBLOG_TEST_RUN_ID:-}" ]]; then
    printf '%s\n' \
        "[behavior-evidence-pre-runtime] FSUSBLOG_TEST_SOURCE_COMMIT, FSUSBLOG_TEST_SOURCE_FINGERPRINT and FSUSBLOG_TEST_RUN_ID are required" >&2
    exit 1
fi

ADMISSION_RECEIPT="${FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT:-$ROOT_DIR/.tmp/behavior-doc-static-admission/receipt.json}"
ADMISSION_COMPONENTS="${FSUSBLOG_BEHAVIOR_DOC_ADMISSION_COMPONENTS:-$ROOT_DIR/.tmp/behavior-doc-static-admission/components}"
CATALOG="${FSUSBLOG_BEHAVIOR_CATALOG:-$ROOT_DIR/config/contracts/behavior-contracts.json}"
OWNER_RECEIPT="${FSUSBLOG_BEHAVIOR_OWNER_RECEIPT:-$ADMISSION_COMPONENTS/behavior-owner-binding.json}"
DOC_CLAIM_PARSE="${FSUSBLOG_DOC_CLAIM_PARSE:-$ADMISSION_COMPONENTS/doc-claim-parse.json}"
DOC_CLAIM_VERIFICATION="${FSUSBLOG_DOC_CLAIM_VERIFICATION:-$ADMISSION_COMPONENTS/doc-claim-verification.json}"
GENERATED_SECTION_CHECK="${FSUSBLOG_GENERATED_SECTION_CHECK:-$ADMISSION_COMPONENTS/generated-section-check.json}"
FACT_OBSERVATIONS_DIR="${FSUSBLOG_FACT_OBSERVATIONS_DIR:-$ADMISSION_COMPONENTS/fact-observations}"
MUTATION_EVIDENCE="${FSUSBLOG_MUTATION_EVIDENCE_RECEIPT:-$ROOT_DIR/.tmp/mutation/changed-critical/${FSUSBLOG_TEST_RUN_ID}/mutation-evidence.json}"
OUT_DIR="${FSUSBLOG_BEHAVIOR_EVIDENCE_PRE_RUNTIME_OUT:-$ROOT_DIR/.tmp/behavior-evidence-pre-runtime}"

for required in "$ADMISSION_RECEIPT" "$CATALOG" "$OWNER_RECEIPT" "$DOC_CLAIM_PARSE" "$DOC_CLAIM_VERIFICATION" "$GENERATED_SECTION_CHECK"; do
    if [[ ! -f "$required" ]]; then
        printf '%s\n' "[behavior-evidence-pre-runtime] required input missing: $required" >&2
        exit 1
    fi
done

TEST_EVIDENCE_ARGS=()
if [[ -n "${FSUSBLOG_BEHAVIOR_TEST_EVIDENCE:-}" ]]; then
    while IFS= read -r -d '' evidence; do
        TEST_EVIDENCE_ARGS+=(--test-evidence "$evidence")
    done < <(printf '%s\0' "$FSUSBLOG_BEHAVIOR_TEST_EVIDENCE")
elif [[ -f "$ROOT_DIR/.tmp/behavior-test-evidence/receipt.json" ]]; then
    TEST_EVIDENCE_ARGS+=(--test-evidence "$ROOT_DIR/.tmp/behavior-test-evidence/receipt.json")
else
    printf '%s\n' \
        "[behavior-evidence-pre-runtime] no behavior-test-evidence receipt found; set FSUSBLOG_BEHAVIOR_TEST_EVIDENCE or run the #2186 producer" >&2
    exit 1
fi

FACT_OBS_ARGS=()
if [[ -d "$FACT_OBSERVATIONS_DIR" ]]; then
    while IFS= read -r receipt; do
        FACT_OBS_ARGS+=(--fact-observation "$receipt")
    done < <(find "$FACT_OBSERVATIONS_DIR" -maxdepth 1 -type f -name '*.json' -print | sort)
fi
if [[ ${#FACT_OBS_ARGS[@]} -eq 0 ]]; then
    printf '%s\n' "[behavior-evidence-pre-runtime] no fact observation receipts found under $FACT_OBSERVATIONS_DIR" >&2
    exit 1
fi

MUTATION_ARGS=()
if [[ -f "$MUTATION_EVIDENCE" ]]; then
    MUTATION_ARGS+=(--mutation-evidence "$MUTATION_EVIDENCE")
fi

mkdir -p "$OUT_DIR"
"$NODE_BIN" "$ROOT_DIR/tools/test-matrix/behavior-evidence-pre-runtime.mjs" \
    --catalog "$CATALOG" \
    --owner "$OWNER_RECEIPT" \
    --static-admission "$ADMISSION_RECEIPT" \
    "${TEST_EVIDENCE_ARGS[@]}" \
    --doc-claim-parse "$DOC_CLAIM_PARSE" \
    --doc-claim-verification "$DOC_CLAIM_VERIFICATION" \
    --generated-section-check "$GENERATED_SECTION_CHECK" \
    "${FACT_OBS_ARGS[@]}" \
    "${MUTATION_ARGS[@]}" \
    --source-commit "$FSUSBLOG_TEST_SOURCE_COMMIT" \
    --worktree-fingerprint "$FSUSBLOG_TEST_SOURCE_FINGERPRINT" \
    --run-id "$FSUSBLOG_TEST_RUN_ID" \
    --out "$OUT_DIR/receipt.json" \
    --assert

"$NODE_BIN" "$ROOT_DIR/tools/docs/global-claim-exactness-final.mjs" \
    --receipts "$FACT_OBSERVATIONS_DIR" \
    --out "$OUT_DIR/global-claim-exactness.json"
