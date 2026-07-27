// Generated from config/contracts/behavior-contracts.json; digest 0b510ccbf365371ed8ab9f176057163a4c48373626ac0dbdd145be513b201e29; do not edit by hand.

export const BEHAVIOR_CONTRACT_CATALOG_DIGEST = '0b510ccbf365371ed8ab9f176057163a4c48373626ac0dbdd145be513b201e29' as const
export const BEHAVIOR_CONTRACTS = [
  {
    "id": "test-asset-audit-reconciliation",
    "domain": "testing",
    "risk": "high",
    "status": "active",
    "implementationOwnerCardinality": "one",
    "implementationOwners": [
      "tools/test/run-test-asset-audit.mjs"
    ],
    "factExtractorId": "test-asset-audit-fact-extractor",
    "requiredTestKinds": [
      "positive",
      "negative"
    ],
    "documentationPolicy": "required",
    "documentationRationale": "Current testing documentation states the executable coverage-evidence contract.",
    "allowedClaimTypes": [
      "behavioral",
      "safety"
    ],
    "releaseQualification": true,
    "coverageIds": [
      "test-asset-audit-reconciliation"
    ],
    "documents": [
      "docs/testing.md"
    ]
  },
  {
    "id": "code-intent-governance",
    "domain": "governance",
    "risk": "high",
    "status": "active",
    "implementationOwnerCardinality": "one",
    "implementationOwners": [
      "tools/governance/check-code-intent.mjs"
    ],
    "factExtractorId": "code-intent-fact-extractor",
    "requiredTestKinds": [
      "positive",
      "negative"
    ],
    "documentationPolicy": "required",
    "documentationRationale": "Current governance documentation states the code-intent contract.",
    "allowedClaimTypes": [
      "behavioral",
      "safety"
    ],
    "releaseQualification": true,
    "coverageIds": [
      "code-intent-governance"
    ],
    "documents": [
      "docs/development/code-intent-governance.md"
    ]
  },
  {
    "id": "document-lifecycle-governance",
    "domain": "documentation",
    "risk": "high",
    "status": "active",
    "implementationOwnerCardinality": "one",
    "implementationOwners": [
      "tools/docs/document-lifecycle.mjs"
    ],
    "factExtractorId": "document-lifecycle-fact-extractor",
    "requiredTestKinds": [
      "positive",
      "negative",
      "migration"
    ],
    "documentationPolicy": "rationale-only",
    "documentationRationale": "Lifecycle policy is explanatory; exact lifecycle metadata remains executable.",
    "allowedClaimTypes": [
      "operational",
      "safety"
    ],
    "releaseQualification": true,
    "coverageIds": [
      "document-lifecycle-governance"
    ],
    "documents": [
      "docs/development/document-lifecycle.md"
    ]
  },
  {
    "id": "browserless-production-correctness",
    "domain": "testing",
    "risk": "critical",
    "status": "active",
    "implementationOwnerCardinality": "one",
    "implementationOwners": [
      "tools/run-test-matrix.mjs"
    ],
    "factExtractorId": "test-matrix-fact-extractor",
    "requiredTestKinds": [
      "positive",
      "negative",
      "concurrency"
    ],
    "documentationPolicy": "required",
    "documentationRationale": "Current testing documentation states the executable test-topology contract.",
    "allowedClaimTypes": [
      "behavioral",
      "operational",
      "safety"
    ],
    "releaseQualification": true,
    "coverageIds": [
      "browserless-production-correctness"
    ],
    "documents": [
      "docs/testing.md"
    ]
  }
] as const
export type BehaviorId = typeof BEHAVIOR_CONTRACTS[number]['id']
export type BehaviorContract = typeof BEHAVIOR_CONTRACTS[number]
export const behaviorContractById: ReadonlyMap<BehaviorId, BehaviorContract> = new Map(BEHAVIOR_CONTRACTS.map((contract) => [contract.id, contract]))
