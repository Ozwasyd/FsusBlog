// Generated from config/contracts/behavior-contracts.json; digest 05c3c7b07e2f4682a53905a383ad4b713f9bc98d5a72b30410c29ce251f1945e; do not edit by hand.

export const BEHAVIOR_CONTRACT_CATALOG_DIGEST = '05c3c7b07e2f4682a53905a383ad4b713f9bc98d5a72b30410c29ce251f1945e' as const
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
    "evidenceStage": "pre-runtime",
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
    "evidenceStage": "pre-runtime",
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
    "evidenceStage": "pre-runtime",
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
    "evidenceStage": "pre-runtime",
    "coverageIds": [
      "binary-api-aeds-contract"
    ],
    "documents": [
      "docs/api.md",
      "docs/api/aeds-only-policy.md",
      "docs/api/contracts.md",
      "docs/api/quick-reference.md",
      "docs/api/schemas-and-errors.md",
      "docs/api/stability.md"
    ],
    "mutationPolicy": {
      "mutationRequired": true,
      "minimumMutationScore": 70,
      "requireExecutedMutants": true,
      "allowedEquivalentMutantPolicy": "none"
    }
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
    "evidenceStage": "pre-runtime",
    "coverageIds": [
      "browserless-production-correctness"
    ],
    "documents": [
      "docs/testing.md",
      "docs/releases/release-identity.md",
      "docs/releases/blue-green-deployment-runbook.md",
      "docs/architecture/monolithic-distributed-boundary.md",
      "docs/architecture.md",
      "docs/architecture/overview.md"
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
    "evidenceStage": "pre-runtime",
    "coverageIds": [
      "authentication-session-permission"
    ],
    "documents": [
      "docs/anonymous-identity-smoke-flow.md",
      "docs/architecture/decisions/ADR-Anonymous-Credential-Blind-Issuance.md",
      "docs/security/user-session-authentication-context.md",
      "docs/security.md"
    ],
    "mutationPolicy": {
      "mutationRequired": true,
      "minimumMutationScore": 70,
      "requireExecutedMutants": true,
      "allowedEquivalentMutantPolicy": "none"
    }
  },
  {
    "id": "configuration-error-security-policy",
    "domain": "security",
    "risk": "critical",
    "status": "active",
    "implementationOwnerCardinality": "one",
    "allowedImplementationOwnerRoles": [],
    "factExtractorId": "config-error-security-policy-fact-extractor",
    "requiredTestKinds": [
      "positive",
      "negative",
      "boundary"
    ],
    "documentationPolicy": "required",
    "documentationRationale": "Current security and configuration documentation states public error codes, challenge/rate/cache policy and configuration default contracts.",
    "allowedClaimTypes": [
      "behavioral",
      "safety",
      "operational"
    ],
    "releaseQualification": true,
    "evidenceStage": "pre-runtime",
    "coverageIds": [
      "configuration-error-security-policy"
    ],
    "documents": [
      "docs/security.md",
      "docs/configuration-layout.md",
      "docs/configuration/appsettings-authority.md",
      "docs/api/schemas-and-errors.md",
      "docs/api/contracts.md"
    ],
    "mutationPolicy": {
      "mutationRequired": true,
      "minimumMutationScore": 70,
      "requireExecutedMutants": true,
      "allowedEquivalentMutantPolicy": "none"
    }
  },
  {
    "id": "article-comment-lifecycle-outbox",
    "domain": "content",
    "risk": "critical",
    "status": "active",
    "implementationOwnerCardinality": "one",
    "allowedImplementationOwnerRoles": [],
    "factExtractorId": "content-lifecycle-fact-extractor",
    "requiredTestKinds": [
      "positive",
      "negative"
    ],
    "documentationPolicy": "required",
    "documentationRationale": "Current article/comment documentation states lifecycle, visibility and outbox edge contracts.",
    "allowedClaimTypes": [
      "behavioral",
      "safety"
    ],
    "releaseQualification": true,
    "evidenceStage": "pre-runtime",
    "coverageIds": [
      "article-comment-lifecycle-outbox"
    ],
    "documents": [
      "docs/api/design.md",
      "docs/api/contracts.md",
      "docs/api/article-publication-revisions.md",
      "docs/moderation.md",
      "docs/architecture/article-asset-reference-lifecycle.md",
      "docs/architecture/article-deletion-lifecycle.md",
      "docs/architecture/article-mutation-outbox-claim-lease.md",
      "docs/architecture/article-mutation-outbox-versioning.md",
      "docs/architecture/article-mutation-side-effect-boundaries.md",
      "docs/architecture/article-revision-concurrency.md",
      "docs/architecture/comment-attribution-privacy-boundary.md",
      "docs/architecture/comment-command-boundary.md",
      "docs/architecture/comment-moderation-visibility-boundary.md",
      "docs/architecture/comment-mutation-outbox.md",
      "docs/architecture/comment-notification-boundary.md",
      "docs/architecture/comment-query-boundary.md"
    ],
    "mutationPolicy": {
      "mutationRequired": true,
      "minimumMutationScore": 70,
      "requireExecutedMutants": true,
      "allowedEquivalentMutantPolicy": "none"
    }
  },
  {
    "id": "application-runtime-semantic-coherence",
    "domain": "runtime",
    "risk": "critical",
    "status": "active",
    "implementationOwnerCardinality": "one",
    "allowedImplementationOwnerRoles": [],
    "factExtractorId": "application-runtime-observation-producer",
    "requiredTestKinds": [
      "positive",
      "negative",
      "boundary"
    ],
    "documentationPolicy": "required",
    "documentationRationale": "Current runtime, API, security, and content claims define the semantic application candidate contract.",
    "allowedClaimTypes": [
      "behavioral",
      "safety",
      "operational"
    ],
    "releaseQualification": true,
    "evidenceStage": "post-runtime",
    "coverageIds": [
      "browserless-production-correctness"
    ],
    "documents": [
      "docs/testing.md",
      "docs/security.md",
      "docs/api/article-publication-revisions.md"
    ]
  },
  {
    "id": "release-deployment-runtime-containment",
    "domain": "deployment",
    "risk": "critical",
    "status": "active",
    "implementationOwnerCardinality": "one",
    "allowedImplementationOwnerRoles": [],
    "factExtractorId": "release-deployment-observation-producer",
    "requiredTestKinds": [
      "positive",
      "negative",
      "boundary"
    ],
    "documentationPolicy": "required",
    "documentationRationale": "Current release and deployment claims define release readiness and blue-green containment.",
    "allowedClaimTypes": [
      "behavioral",
      "safety",
      "operational"
    ],
    "releaseQualification": true,
    "evidenceStage": "post-runtime",
    "coverageIds": [
      "blue-green-slot-orchestration"
    ],
    "documents": [
      "docs/testing.md",
      "docs/releases/blue-green-deployment-runbook.md",
      "docs/architecture/monolithic-distributed-boundary.md"
    ]
  }
] as const
export type BehaviorId = typeof BEHAVIOR_CONTRACTS[number]['id']
export type BehaviorContract = typeof BEHAVIOR_CONTRACTS[number]
export const behaviorContractById: ReadonlyMap<BehaviorId, BehaviorContract> = new Map(BEHAVIOR_CONTRACTS.map((contract) => [contract.id, contract]))
