import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import frozenConfiguration from './WriterCommandFocusRegression.config';

// Reuse the actual Writer entry, alias, server, diagnostics and browser settings.
// The historical suite is executed separately with its untouched configuration.
export default defineConfig({
    ...(frozenConfiguration as PlaywrightTestConfig),
    testMatch: 'WriterScopedShortcutProbe.spec.ts'
});
