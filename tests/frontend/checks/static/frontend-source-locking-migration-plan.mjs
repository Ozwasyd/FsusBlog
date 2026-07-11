export const replacementOwners = Object.freeze({
  aboutContract: [
    'vitest:tests/frontend/unit/view-contracts/aboutPage.test.ts#creates-the-correct-view-contract-structure-d9a0beab32',
    'vitest:tests/frontend/unit/view-contracts/aboutPage.test.ts#allows-static-pages-to-override-the-title-86bca43f1f'
  ],
  adminPrincipal: [
    'node-script:tests/frontend/checks/static/check-admin-user-manage-governance.mjs',
    'vitest:tests/frontend/unit/api/admin.test.ts#adminchangestatus-sends-binary-status-request-for-accoun-9392b98c6a',
    'vitest:tests/frontend/e2e/acceptance/admin-console.spec.ts#visible-admin-routes-render-cleanly-c3e6ee4f99'
  ],
  adminComments: [
    'node-script:tests/frontend/checks/static/check-comment-thread-view-contract-identity.mjs',
    'node-script:tests/frontend/checks/static/check-admin-dashboard-panel-identity.mjs',
    'vitest:tests/frontend/e2e/acceptance/admin-console.spec.ts#dashboard-article-write-and-admin-workbench-actions-stay-b1a6a0529b'
  ],
  adminConsistency: [
    'node-script:tests/frontend/checks/static/check-admin-task-feedback.mjs',
    'vitest:tests/frontend/e2e/acceptance/admin-console.spec.ts#visible-admin-routes-render-cleanly-c3e6ee4f99'
  ],
  adminContent: [
    'node-script:tests/frontend/checks/static/check-article-editor-workspace-governance.mjs',
    'vitest:tests/frontend/e2e/acceptance/admin-console.spec.ts#dashboard-article-write-and-admin-workbench-actions-stay-b1a6a0529b'
  ],
  adminSettings: [
    'node-script:tests/frontend/checks/static/check-admin-user-manage-governance.mjs',
    'vitest:tests/frontend/e2e/acceptance/admin-console.spec.ts#category-tag-settings-users-and-admin-message-center-sup-82a6b25819'
  ],
  adminOperations: [
    'node-script:tests/frontend/checks/static/check-admin-system-tabs-governance.mjs',
    'vitest:tests/frontend/e2e/acceptance/admin-console.spec.ts#visible-admin-routes-render-cleanly-c3e6ee4f99'
  ],
  adminSecurity: [
    'node-script:tests/frontend/checks/static/check-security-consistency.mjs',
    'vitest:tests/frontend/e2e/security/risk-control-console.spec.ts#normal-read-uses-binary-aeds-data-for-active-policy-even-c3825ce18b'
  ],
  adminUx: [
    'node-script:tests/frontend/checks/static/check-admin-a11y-governance.mjs',
    'node-script:tests/frontend/checks/static/check-admin-empty-state-governance.mjs',
    'node-script:tests/frontend/checks/static/check-admin-task-feedback.mjs',
    'vitest:tests/frontend/e2e/acceptance/admin-console.spec.ts#mobile-drawer-write-draft-and-quick-taxonomy-actions-sta-27a23f27fe'
  ],
  markdownEditor: [
    'node-script:tests/frontend/checks/static/check-markdown-editor-state-governance.mjs',
    'vitest:tests/frontend/e2e/resilience/markdown-extreme.spec.ts#500k-markdown-latex-mermaid-draft-preview-and-restore-st-96b1ffa3fe'
  ],
  navigationPerformance: [
    'node-script:tests/frontend/checks/perf/check-route-render-pressure.mjs',
    'shell:tools/test/lanes/browser-performance-regression.sh',
    'vitest:tests/frontend/unit/router/index.test.ts#public-route-does-not-probe-account-or-admin-session-d6b6e851b0'
  ],
  frontendAlgorithms: [
    'vitest:tests/frontend/unit/services/searchRanking.test.ts#prioritizes-title-hits-over-repeated-long-body-hits-4932fe6182',
    'vitest:tests/frontend/unit/services/notificationStreamRenderScheduler.test.ts#merges-created-updated-into-created-with-the-latest-prev-0732ea1385',
    'vitest:tests/frontend/unit/utils/contentFilter.test.ts#normalizes-moderation-text-with-nfkc-zero-width-strippin-d2f62ffdbb'
  ],
  frontendPerformance: [
    'vitest:tests/frontend/benchmarks/frontendPerfRegression.test.ts#keeps-algorithm-hot-paths-inside-lightweight-budgets-72259223ec',
    'node-script:tests/frontend/checks/perf/check-aeds-decode-budget.mjs',
    'node-script:tests/frontend/checks/perf/check-dom-budget.mjs',
    'node-script:tests/frontend/checks/perf/check-markdown-render-budget.mjs',
    'node-script:tests/frontend/checks/perf/check-route-render-pressure.mjs',
    'node-script:tests/frontend/checks/static/check-asset-size-budget.mjs',
    'shell:tools/test/lanes/browser-performance-regression.sh',
    'vitest:tests/frontend/unit/services/telemetryService.test.ts#sends-only-anonymous-public-page-performance-fields-28630a2dbd'
  ],
  commentMarkdown: [
    'node-script:tests/frontend/checks/static/check-markdown-editor-state-governance.mjs',
    'vitest:tests/frontend/unit/utils/contentFilter.test.ts#accepts-safe-text-markdown-and-extracts-review-text-with-4332dd05ff'
  ],
  perceptionChallenge: [
    'vitest:tests/frontend/unit/security/perceptionChallengeFlow.test.ts#renders-through-the-worker-and-verifies-with-sealed-prov-f06600e8d2',
    'vitest:tests/frontend/e2e/security/perception-v2-worker.spec.ts#renders-through-a-module-worker-and-uses-offscreencanvas-756a5114a3'
  ],
  articleRightsEditor: [
    'node-script:tests/frontend/checks/static/check-article-editor-workspace-governance.mjs',
    'vitest:tests/frontend/unit/api/authoring.test.ts#saveserverdraft-posts-an-aeds-author-draft-request-frame-80bb5f40aa',
    'vitest:tests/frontend/unit/view-contracts/articleDetailRights.test.ts#maps-articledetail-rights-into-the-page-view-contract-76840f5577'
  ],
  articleRightsPublic: [
    'vitest:tests/frontend/unit/view-contracts/articleDetailRights.test.ts#maps-articledetail-rights-into-the-page-view-contract-76840f5577',
    'vitest:tests/frontend/unit/view-contracts/articleDetailRights.test.ts#provides-explicit-disabled-rights-for-the-empty-detail-v-cb05ec2a33',
    'vitest:tests/frontend/e2e/acceptance/public-routes.spec.ts#article-detail-and-search-page-stay-clean-340f1f91c7'
  ],
  publicTakeover: [
    'node-script:tests/frontend/checks/static/check-public-atomic-takeover-governance.mjs',
    'vitest:tests/frontend/unit/bootstrap/publicNavigationIntent.test.ts#classifies-supported-public-aot-links-for-atomic-takeove-7c2b02675c',
    'vitest:tests/frontend/unit/bootstrap/fullAppBootstrap.test.ts#commits-a-prepared-public-takeover-and-replays-a-capture-300bc6b2a5',
    'vitest:tests/frontend/e2e/acceptance/spa-routes.spec.ts#public-aot-silently-takes-over-full-app-after-first-inte-394354e37c'
  ],
  hydrationReadiness: [
    'node-script:tests/frontend/checks/static/check-public-atomic-takeover-governance.mjs',
    'vitest:tests/frontend/unit/bootstrap/fullAppBootstrap.test.ts#prepares-the-app-without-clearing-or-mounting-over-the-p-53bf9b0626',
    'vitest:tests/frontend/unit/bootstrap/routeReadiness.test.ts#resolves-ready-when-route-content-marks-the-active-navig-c6aaf681b0',
    'vitest:tests/frontend/e2e/acceptance/spa-routes.spec.ts#public-aot-route-can-return-home-without-remount-or-hydr-aee9b5dccb'
  ],
  preHydrationSafety: [
    'node-script:tests/frontend/checks/static/check-public-atomic-takeover-governance.mjs',
    'vitest:tests/frontend/e2e/acceptance/cross-browser-smoke.spec.ts#public-shell-auth-entry-passkey-capability-pwa-cache-and-51fe04687b'
  ],
  publicMotion: [
    'node-script:tests/frontend/checks/static/check-motion-governance.mjs',
    'node-script:tests/frontend/checks/static/check-public-reading-motion.mjs',
    'vitest:tests/frontend/e2e/visual/public-visual.spec.ts#key-public-pages-keep-visual-contract-13c24e5998'
  ],
  publicShell: [
    'node-script:tests/frontend/checks/static/check-shell-material-governance.mjs',
    'node-script:tests/frontend/checks/static/check-public-editorial-governance.mjs',
    'vitest:tests/frontend/e2e/visual/public-visual.spec.ts#key-public-pages-keep-visual-contract-13c24e5998',
    'vitest:tests/frontend/e2e/acceptance/public-routes.spec.ts#visible-public-routes-stay-clean-and-aligned-c63684c410'
  ],
  accountShell: [
    'node-script:tests/frontend/checks/static/check-shell-material-governance.mjs',
    'vitest:tests/frontend/e2e/visual/console-visual.spec.ts#user-profile-and-inbox-stay-aligned-3fffc3e4e0',
    'vitest:tests/frontend/e2e/acceptance/user-console.spec.ts#visible-user-routes-load-without-runtime-noise-db512e9f8c'
  ],
  dashboardIdentity: [
    'node-script:tests/frontend/checks/static/check-admin-dashboard-panel-identity.mjs',
    'vitest:tests/frontend/unit/view-contracts/adminStatsRecentComments.test.ts#renders-recent-comment-authors-from-anonymous-safe-autho-6cf14eede3'
  ],
  composableSimplification: [
    'node-script:tests/frontend/checks/static/check-composable-wrapper-simplification.mjs',
    'vitest:tests/frontend/unit/composables/frontendDerivedStateWatch.test.ts#keeps-inbox-split-pane-behavior-while-deriving-pane-stat-a030e338f0',
    'vitest:tests/frontend/unit/composables/frontendDerivedStateWatch.test.ts#preserves-inbox-split-pane-timing-across-breakpoint-chan-bb588d5106'
  ],
  homeBehavior: [
    'vitest:tests/frontend/unit/services/searchRanking.test.ts#keeps-scores-deterministic-for-offline-fixtures-71bc592b86',
    'vitest:tests/frontend/e2e/acceptance/spa-routes.spec.ts#search-flow-renders-and-allows-sort-switching-without-ru-55d7144778',
    'vitest:tests/frontend/e2e/visual/public-visual.spec.ts#key-public-pages-keep-visual-contract-13c24e5998'
  ],
  apiParity: [
    'node-script:tests/frontend/checks/static/check-frontend-backend-api-parity.mjs',
    'node-script:tests/frontend/checks/static/check-generated-frame-schema-sync.mjs',
    'vitest:tests/frontend/unit/api/authoring.test.ts#getserverdraft-reads-nullable-draft-responses-through-ae-cb10daae2e'
  ],
  taxonomyBehavior: [
    'vitest:tests/frontend/unit/api/tagAndCategory.test.ts#createtag-sends-binary-mutation-frame-55f70101a4',
    'vitest:tests/frontend/unit/api/tagAndCategory.test.ts#getcategories-calls-get-category-f797e4de92',
    'vitest:tests/frontend/e2e/acceptance/admin-console.spec.ts#category-tag-settings-users-and-admin-message-center-sup-82a6b25819'
  ],
  notificationRecovery: [
    'vitest:tests/frontend/unit/services/notificationStreamRuntime.test.ts#preserves-riskcontrol-handshake-failure-codes-from-prefl-389cb2d0b6',
    'vitest:tests/frontend/unit/services/notificationStreamRuntime.test.ts#skips-handshake-preflight-for-authenticated-reconnect-af-43f3f0d7fc',
    'vitest:tests/frontend/unit/services/notificationStreamRenderScheduler.test.ts#lets-reconnect-patches-dominate-article-coalescing-808a9fbf1a'
  ],
  acceptanceRuntime: [
    'vitest:tests/frontend/unit/playwright/acceptanceShared.test.ts#loads-shared-viewport-helpers-through-the-frontend-toolc-1738c0d314',
    'vitest:tests/frontend/e2e/acceptance/cross-browser-smoke.spec.ts#public-shell-auth-entry-passkey-capability-pwa-cache-and-51fe04687b',
    'playwright-dynamic:tests/frontend/e2e/ux/viewport-boundaries.spec.ts'
  ],
  routerAuthorization: [
    'node-script:tests/frontend/checks/static/check-security-consistency.mjs',
    'vitest:tests/frontend/unit/router/index.test.ts#keeps-user-authenticated-without-legacy-role-meta-e42551a7d7',
    'vitest:tests/frontend/unit/router/index.test.ts#manage-route-checks-required-permissions-after-admin-pro-4bb39b769e'
  ],
  publicReadHydration: [
    'node-script:tests/frontend/checks/static/check-public-atomic-takeover-governance.mjs',
    'vitest:tests/frontend/unit/services/publicReadHydrationGuard.test.ts#suppresses-optional-public-read-hydration-when-acceptanc-b24eaddff0',
    'vitest:tests/frontend/unit/services/publicReadHydrationGuard.test.ts#suppresses-optional-public-read-hydration-from-the-expli-49889629aa'
  ],
  telemetryPrivacy: [
    'node-script:tests/frontend/checks/static/check-telemetry-privacy.mjs',
    'vitest:tests/frontend/unit/services/telemetryService.test.ts#sends-only-anonymous-public-page-performance-fields-28630a2dbd',
    'vitest:tests/frontend/unit/services/telemetryService.test.ts#does-not-send-rum-from-private-routes-1bd0c60aae'
  ],
  userComments: [
    'node-script:tests/frontend/checks/static/check-user-comments-page-governance.mjs',
    'vitest:tests/frontend/unit/view-contracts/userCommentModerationStatus.test.ts#maps-backend-visibility-fields-to-user-facing-badge-copy-f9f83ecd82'
  ],
  deprecatedCommentField: [
    'node-script:tests/frontend/checks/static/check-comment-thread-view-contract-identity.mjs',
    'vitest:tests/frontend/unit/adapters/binary/commentAdapter.test.ts#keeps-replytouserid-out-of-the-support-encoder-pod-paylo-50a279d2d3'
  ],
  authRecovery: [
    'vitest:tests/frontend/unit/api/auth.test.ts#passkey-methods-use-binary-frames-fc6ccb9ae0',
    'vitest:tests/frontend/unit/api/auth.test.ts#recovery-key-methods-use-binary-identity-frames-439ce4e2f4',
    'vitest:tests/frontend/unit/api/auth.test.ts#recovery-key-create-and-rotate-send-step-up-proof-header-4fbc548829',
    'vitest:tests/frontend/e2e/acceptance/auth-flows.spec.ts#register-entry-enables-only-after-agreement-and-keeps-st-85e29ffd90',
    'vitest:tests/frontend/e2e/acceptance/auth-flows.spec.ts#login-and-register-failures-stay-inline-and-explicit-7761569693'
  ],
  identityCenter: [
    'node-script:tests/frontend/checks/static/check-security-consistency.mjs',
    'vitest:tests/frontend/e2e/acceptance/user-console.spec.ts#visible-user-routes-load-without-runtime-noise-db512e9f8c',
    'vitest:tests/frontend/e2e/acceptance/user-console.spec.ts#profile-session-actions-and-delete-guard-stay-aligned-9113d42b9d',
    'vitest:tests/frontend/e2e/acceptance/user-console.spec.ts#passkey-section-is-accessible-and-opens-registration-mod-be56f40ffe'
  ],
  userFacing: [
    'node-script:tests/frontend/checks/ux/check-ux-semantics.mjs',
    'vitest:tests/frontend/e2e/acceptance/public-routes.spec.ts#visible-public-routes-stay-clean-and-aligned-c63684c410',
    'vitest:tests/frontend/e2e/acceptance/user-console.spec.ts#visible-user-routes-load-without-runtime-noise-db512e9f8c',
    'vitest:tests/frontend/unit/view-contracts/archive.test.ts#groups-articles-by-year-and-month-62ef416fd1'
  ],
  passkeyAdapter: [
    'node-script:tests/frontend/checks/static/check-generated-frame-schema-sync.mjs',
    'vitest:tests/frontend/unit/adapters/binary/passkeyAdapter.test.ts#maps-register-begin-payload-into-webauthn-creation-optio-81f2fb2a80',
    'vitest:tests/frontend/unit/adapters/binary/passkeyAdapter.test.ts#maps-login-begin-payload-into-webauthn-request-options-de650f89cc'
  ],
  readProofTransport: [
    'node-script:tests/frontend/checks/static/check-frontend-backend-api-parity.mjs',
    'vitest:tests/frontend/unit/api/readProof.test.ts#requests-challenge-with-an-aeds-request-frame-and-device-a7041a809b',
    'vitest:tests/frontend/unit/api/readProof.test.ts#submits-proof-with-an-aeds-request-frame-and-device-fing-1bc46276e8'
  ],
  securityBinary: [
    'node-script:tests/frontend/checks/static/check-frontend-backend-api-parity.mjs',
    'vitest:tests/frontend/unit/api/security.test.ts#reads-security-overview-through-aeds-8c097c1d36',
    'vitest:tests/frontend/unit/api/security.test.ts#uses-rule-and-pow-request-frames-for-security-mutations-2dd490ae6b'
  ],
  captchaBehavior: [
    'vitest:tests/frontend/unit/components/FsusCaptchaChallenge.test.ts#selects-the-captchav1-assignment-and-builds-the-provider-97629ab95d',
    'vitest:tests/frontend/unit/components/FsusCaptchaChallenge.test.ts#shows-a-recoverable-error-when-captcha-runtime-loading-f-205025a84d',
    'vitest:tests/frontend/unit/security/challengeClient.test.ts#keeps-proof-tokens-in-memory-and-evicts-them-after-expir-db5c706a5a',
    'vitest:tests/frontend/e2e/security/captcha-challenge.spec.ts#renders-locally-accepts-mobile-safe-input-and-solves-pow-9f665456f5'
  ]
})

export const wholeFileMigrations = [
  ['tests/frontend/unit/view-contracts/adminPrincipalWorkspaceWorkflow.test.ts', 3, 'adminPrincipal'],
  ['tests/frontend/unit/view-contracts/markdownEditorWorkflow.test.ts', 10, 'markdownEditor'],
  ['tests/frontend/unit/view-contracts/adminCommentModerationWorkflow.test.ts', 5, 'adminComments'],
  ['tests/frontend/unit/view-contracts/navigationPerformanceWorkflow.test.ts', 2, 'navigationPerformance'],
  ['tests/frontend/unit/view-contracts/adminConsistencyWorkflow.test.ts', 5, 'adminConsistency'],
  ['tests/frontend/unit/view-contracts/adminContentWorkflow.test.ts', 21, 'adminContent'],
  ['tests/frontend/unit/view-contracts/adminSettingsUserWorkflow.test.ts', 12, 'adminSettings'],
  ['tests/frontend/unit/view-contracts/adminOpsHealthWorkflow.test.ts', 4, 'adminOperations'],
  ['tests/frontend/unit/view-contracts/adminSecuritySystemWorkflow.test.ts', 4, 'adminSecurity'],
  ['tests/frontend/unit/view-contracts/adminModerationSystemWorkflow.test.ts', 10, 'adminComments'],
  ['tests/frontend/unit/view-contracts/adminUxTaskFlow.test.ts', 9, 'adminUx'],
  ['tests/frontend/unit/view-contracts/frontendAlgorithmWorkflow.test.ts', 5, 'frontendAlgorithms'],
  ['tests/frontend/unit/view-contracts/frontendPerformanceWorkflow.test.ts', 13, 'frontendPerformance'],
  ['tests/frontend/unit/view-contracts/commentMarkdownWorkflow.test.ts', 4, 'commentMarkdown'],
  ['tests/frontend/unit/view-contracts/commentPerceptionChallengeFlow.test.ts', 2, 'perceptionChallenge'],
  ['tests/frontend/unit/view-contracts/articleRightsEditorWorkflow.test.ts', 6, 'articleRightsEditor'],
  ['tests/frontend/unit/view-contracts/articleRightsPublicWorkflow.test.ts', 9, 'articleRightsPublic'],
  ['tests/frontend/unit/bootstrap/publicAtomicTakeoverSource.test.ts', 2, 'publicTakeover'],
  ['tests/frontend/unit/bootstrap/hydrationInvariantGuards.test.ts', 15, 'hydrationReadiness'],
  ['tests/frontend/unit/bootstrap/publicShellOwnership.test.ts', 7, 'publicTakeover'],
  ['tests/frontend/unit/bootstrap/preHydrationBrowserSafety.test.ts', 4, 'preHydrationSafety'],
  ['tests/frontend/unit/bootstrap/publicRouteMotionGovernance.test.ts', 5, 'publicMotion'],
  ['tests/frontend/unit/components/SiteChromeHeaderAdapter.test.ts', 5, 'publicShell'],
  ['tests/frontend/unit/components/AccountLayoutDensity.test.ts', 6, 'accountShell'],
  ['tests/frontend/unit/components/AccountLayoutHeaderAdapter.test.ts', 3, 'accountShell'],
  ['tests/frontend/unit/components/AccountLayoutSidebar.test.ts', 7, 'accountShell'],
  ['tests/frontend/unit/components/LayoutHeaderConsistency.test.ts', 5, 'accountShell'],
  ['tests/frontend/unit/components/PublicBlogLayoutShell.test.ts', 17, 'publicShell'],
  ['tests/frontend/unit/components/admin/DashboardPanelIdentityFields.test.ts', 3, 'dashboardIdentity'],
  ['tests/frontend/unit/composables/frontendPatternSimplification.test.ts', 4, 'composableSimplification'],
  ['tests/frontend/unit/composables/frontendMapSetSimplification.test.ts', 3, 'composableSimplification'],
  ['tests/frontend/unit/composables/useHomeViewRuntime.test.ts', 4, 'homeBehavior'],
  ['tests/frontend/unit/composables/publicRouteReadinessComposables.test.ts', 2, 'hydrationReadiness'],
  ['tests/frontend/unit/runtime/apiContractMatrixSource.test.ts', 10, 'apiParity'],
  ['tests/frontend/unit/runtime/endpointDepthMatrixSource.test.ts', 2, 'apiParity'],
  ['tests/frontend/unit/runtime/eventualTaxonomy.test.ts', 14, 'taxonomyBehavior'],
  ['tests/frontend/unit/services/notificationRecoveryWorkflow.test.ts', 5, 'notificationRecovery'],
  ['tests/frontend/unit/session-fixtures-contract.test.ts', 4, 'acceptanceRuntime'],
  ['tests/frontend/unit/components/AuthRecoverySplit.test.ts', 3, 'authRecovery'],
  ['tests/frontend/unit/components/FsusSecurityChallenge.test.ts', 2, 'captchaBehavior'],
  ['tests/frontend/unit/components/PublicAuthLayout.test.ts', 4, 'authRecovery'],
  ['tests/frontend/unit/view-contracts/authAnonymousIdentityWorkflow.test.ts', 6, 'authRecovery'],
  ['tests/frontend/unit/view-contracts/identityCenterWorkflow.test.ts', 7, 'identityCenter'],
  ['tests/frontend/unit/view-contracts/userFacingWorkflow.test.ts', 10, 'userFacing']
].map(([path, expectedRecords, replacementOwner]) => ({
  path,
  expectedRecords,
  replacementOwner,
  reason: 'source-locked unit file replaced by direct behavior or single-owner static governance'
}))

export const selectiveTestMigrations = [
  ['vitest:tests/frontend/unit/view-contracts/aboutPage.test.ts#passes-currentyear-through-correctly-7f698dbf7f', 'aboutContract'],
  ['vitest:tests/frontend/unit/view-contracts/aboutPage.test.ts#passes-empty-content-2c43109471', 'aboutContract'],
  ['vitest:tests/frontend/unit/api/admin.test.ts#adminchangestatusdto-uses-accountid-at-the-naming-layer-0f7a95bb07', 'adminPrincipal'],
  ['vitest:tests/frontend/unit/api/admin.test.ts#keeps-admin-status-dto-and-callers-on-accountid-naming-58855e1c7a', 'adminPrincipal'],
  ['vitest:tests/frontend/unit/api/admin.test.ts#does-not-export-or-encode-legacy-admin-password-reset-669f90808a', 'adminPrincipal'],
  ['vitest:tests/frontend/unit/adapters/binary/commentAdapter.test.ts#marks-legacy-replytouserid-dto-fields-deprecated-for-ano-6ce3146717', 'deprecatedCommentField'],
  ['vitest:tests/frontend/unit/api/authoring.test.ts#does-not-retain-the-deprecated-authoring-json-client-in--8ccb2d3e7c', 'apiParity'],
  ['vitest:tests/frontend/unit/composables/frontendDerivedStateWatch.test.ts#does-not-keep-derived-state-watches-in-inbox-split-view-a62c45977c', 'composableSimplification'],
  ['vitest:tests/frontend/unit/composables/frontendDerivedStateWatch.test.ts#watches-home-readiness-through-upstream-sources-instead--69db0b0e28', 'composableSimplification'],
  ['vitest:tests/frontend/unit/playwright/acceptanceShared.test.ts#treats-sandboxed-srcdoc-script-blocking-as-an-expected-p-55afe0332e', 'acceptanceRuntime'],
  ['vitest:tests/frontend/unit/playwright/acceptanceShared.test.ts#does-not-count-expected-mfa-step-up-challenge-responses--2990c076e5', 'acceptanceRuntime'],
  ['vitest:tests/frontend/unit/playwright/acceptanceShared.test.ts#pins-audited-browser-contexts-to-the-configured-frontend-53589ec0a4', 'acceptanceRuntime'],
  ['vitest:tests/frontend/unit/playwright/acceptanceShared.test.ts#keeps-mobile-landscape-chrome-checks-scoped-to-navigatio-4deb9d79bf', 'acceptanceRuntime'],
  ['vitest:tests/frontend/unit/router/index.test.ts#statically-blocks-legacy-router-role-meta-checks-from-re-822174ef3e', 'routerAuthorization'],
  ['vitest:tests/frontend/unit/services/publicReadHydrationGuard.test.ts#keeps-article-detail-related-and-comment-auto-load-behin-3254e5ce9c', 'publicReadHydration'],
  ['vitest:tests/frontend/unit/services/telemetryService.test.ts#does-not-retain-json-fallback-compatibility-in-the-telem-95912ca773', 'telemetryPrivacy'],
  ['vitest:tests/frontend/unit/view-contracts/adminStatsRecentComments.test.ts#keeps-admin-dashboard-panels-off-deprecated-username-and-38c33202b1', 'dashboardIdentity'],
  ['vitest:tests/frontend/unit/view-contracts/adminStatsRecentComments.test.ts#runs-the-admin-dashboard-identity-guard-from-frontend-st-a36c140ce5', 'dashboardIdentity'],
  ['vitest:tests/frontend/unit/view-contracts/userCommentModerationStatus.test.ts#renders-moderation-badges-without-mobile-content-compres-b97e57ce42', 'userComments'],
  ['vitest:tests/frontend/unit/bootstrap/publicTakeoverDeterminism.test.ts#keeps-first-paint-loader-neutral-while-static-manifest-u-0e13c10795', 'publicTakeover'],
  ['vitest:tests/frontend/unit/bootstrap/publicTakeoverDeterminism.test.ts#keeps-frontend-and-backend-default-seo-titles-aligned-364656fac9', 'publicShell'],
  ['vitest:tests/frontend/unit/bootstrap/publicTakeoverDeterminism.test.ts#renders-public-layout-from-an-immutable-takeover-seed-un-1651ee83c1', 'publicTakeover'],
  ['vitest:tests/frontend/unit/bootstrap/publicTakeoverDeterminism.test.ts#keeps-api-backed-site-store-props-out-of-the-first-publi-85a2d151d6', 'publicTakeover'],
  ['vitest:tests/frontend/unit/bootstrap/publicTakeoverDeterminism.test.ts#syncs-public-document-head-from-the-same-active-site-ide-428baf3d13', 'publicShell'],
  ['vitest:tests/frontend/unit/bootstrap/publicTakeoverDeterminism.test.ts#keeps-first-public-spa-route-render-on-aot-compatible-na-3ce34c34d9', 'publicTakeover'],
  ['vitest:tests/frontend/unit/bootstrap/publicTakeoverDeterminism.test.ts#wires-public-route-prewarm-to-low-risk-signals-without-r-89152b67ea', 'publicTakeover'],
  ['vitest:tests/frontend/unit/adapters/binary/passkeyAdapter.test.ts#does-not-expose-the-retired-admin-password-reset-frame-5053a6b37b', 'passkeyAdapter'],
  ['vitest:tests/frontend/unit/adapters/binary/passkeyAdapter.test.ts#keeps-register-begin-adapter-fields-named-as-account-han-2b9f16df4f', 'passkeyAdapter'],
  ['vitest:tests/frontend/unit/api/readProof.test.ts#does-not-retain-json-fetch-compatibility-in-the-api-modu-8e2ba09664', 'readProofTransport'],
  ['vitest:tests/frontend/unit/api/security.test.ts#does-not-retain-the-deprecated-security-json-client-in-p-7574156fe9', 'securityBinary'],
  ['vitest:tests/frontend/unit/components/FsusCaptchaChallenge.test.ts#keeps-the-sfc-wired-to-fsusui-controls-canvas-fallback-s-f540400312', 'captchaBehavior']
].map(([deletedTestId, replacementOwner]) => ({
  deletedTestId,
  replacementOwner,
  reason: 'source assertion removed while direct behavior tests remain in the file or its static owner'
}))

export const fixtureReaderOwners = [
  ['tests/frontend/unit/protocol/aeds-contract.test.ts', 'protocol hex fixtures'],
  ['tests/frontend/unit/services/binaryTransport.test.ts', 'binary transport hex fixtures'],
  ['tests/frontend/unit/view-contracts/coverArt.test.ts', 'checked-in cover artifact fixtures']
].map(([path, reason]) => ({ path, reason }))

// Collision-avoidance delegation is intentionally empty at final handoff.
// The five #1045 anonymous identity/comment source-lock files have been deleted
// and their exact replacement IDs now live in the merged retention manifest.
export const delegatedSourceLockOwners = []
