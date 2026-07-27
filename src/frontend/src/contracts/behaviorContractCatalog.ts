// Generated from config/contracts/behavior-contracts.json; digest 47e308f89c12464ef9379baeaaf27a42f41cc29dc3d603579add9e8ef66715b8; do not edit by hand.

export const BEHAVIOR_CONTRACT_CATALOG_DIGEST = '47e308f89c12464ef9379baeaaf27a42f41cc29dc3d603579add9e8ef66715b8' as const
export const BEHAVIOR_CONTRACTS = [
  {
    "id": "test-asset-audit-reconciliation",
    "domain": "testing",
    "risk": "high",
    "status": "active",
    "implementationOwnerCardinality": "one",
    "allowedImplementationOwnerRoles": [],
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
    "allowedImplementationOwnerRoles": [],
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
    "allowedImplementationOwnerRoles": [],
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
    "id": "binary-api-aeds-contract",
    "domain": "api",
    "risk": "critical",
    "status": "active",
    "implementationOwnerCardinality": "one",
    "allowedImplementationOwnerRoles": [],
    "factExtractorId": "openapi-aeds-fact-extractor",
    "requiredTestKinds": [
      "positive",
      "negative"
    ],
    "documentationPolicy": "required",
    "documentationRationale": "Current API contract documents state binary OpenAPI and AEDS operation metadata.",
    "allowedClaimTypes": [
      "behavioral",
      "safety"
    ],
    "releaseQualification": true,
    "coverageIds": [
      "binary-api-aeds-contract"
    ],
    "documents": [
      "docs/api/contracts.md"
    ]
  },
  {
    "id": "browserless-production-correctness",
    "domain": "testing",
    "risk": "critical",
    "status": "active",
    "implementationOwnerCardinality": "one",
    "allowedImplementationOwnerRoles": [],
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
