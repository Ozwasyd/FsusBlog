export const canonicalTestDeclarationProducer = 'tools/frontend/generate-canonical-test-declarations.mjs';
export const canonicalTestDeclarationBindingFile = 'artifacts/change-contract/canonical-test-declarations.json';
export const canonicalTestDeclarationModules = Object.freeze([
    'tests/frontend/checks/static/check-canonical-viewport-safe-area.mjs',
    'tests/frontend/checks/static/check-document-viewport-source.mjs',
    'tests/frontend/support/aeds-envelope.mjs',
    'tests/frontend/support/playwright/browser-capability-contract.mjs',
    'tests/frontend/support/playwright/readiness.mjs',
    'tests/frontend/support/playwright/screenshotPathTemplate.mjs',
    'tests/frontend/support/playwright/uxViewportPlan.mjs',
    'tests/frontend/support/public-fixtures.mjs',
    'tests/frontend/support/publicBootstrapCausalEvidence.mjs',
    'tests/frontend/support/runtime-browser-timeout.mjs',
    'tests/frontend/support/system-chromium.mjs',
    'tools/docs/public-preview-quality.mjs',
    'tools/docs/public-preview-registry.mjs',
    'tools/test-fixtures/receipt/canonical.mjs',
    'tools/test/playwright-browser-identity.mjs',
    'tools/test/random-streams.mjs'
]);
export const canonicalTestDeclarationReadOnlyInputs = Object.freeze([
    'src/frontend/package-lock.json',
    'src/frontend/scripts/fsusui-root.mjs',
    'src/frontend/scripts/run-local-fsusui-typecheck.mjs',
    'src/frontend/tsconfig.playwright.json',
    'tests/frontend/support/playwright/acceptance-shared.ts',
    'tools/docs/public-preview-quality-contract.mjs',
    'tools/docs/public-preview-quality-dom.mjs',
    'tools/docs/public-preview-quality-runtime.mjs',
    'tools/release/public-preview-quality-receipt-contract.mjs'
]);
export const canonicalTestDeclarationOutputs = Object.freeze(canonicalTestDeclarationModules.map((file) => file.replace(/\.mjs$/u, '.d.mts')));
