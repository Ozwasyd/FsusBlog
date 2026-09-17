#!/usr/bin/env node

console.log('[rebuild-public-hydration] delegating to public GET warmup/backfill.');
await import('./warm-public-aot-cache.mjs');
