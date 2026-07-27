// Generated from config/contracts/behavior-contracts.json; digest 56a60d9801a686e96307c339a97b97507ea709dcaa0003315da50d96c02039fb; do not edit by hand.

export const BEHAVIOR_CONTRACT_CATALOG_DIGEST = '56a60d9801a686e96307c339a97b97507ea709dcaa0003315da50d96c02039fb' as const
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
  },
  {
    "id": "authentication-session-permission",
    "domain": "security",
    "risk": "critical",
    "status": "active",
    "implementationOwnerCardinality": "one",
    "allowedImplementationOwnerRoles": [],
    "factExtractorId": "auth-session-permission-fact-extractor",
    "requiredTestKinds": [
      "positive",
      "negative",
      "migration"
    ],
    "documentationPolicy": "required",
    "documentationRationale": "Current security documentation states authentication methods, session duration, step-up and admin permission contracts.",
    "allowedClaimTypes": [
      "behavioral",
      "safety"
    ],
    "releaseQualification": true,
    "coverageIds": [
      "authentication-session-permission"
    ],
    "documents": [
      "docs/security/user-session-authentication-context.md",
      "docs/security.md"
    ]
  }
] as const
export type BehaviorId = typeof BEHAVIOR_CONTRACTS[number]['id']
export type BehaviorContract = typeof BEHAVIOR_CONTRACTS[number]
export const behaviorContractById: ReadonlyMap<BehaviorId, BehaviorContract> = new Map(BEHAVIOR_CONTRACTS.map((contract) => [contract.id, contract]))
