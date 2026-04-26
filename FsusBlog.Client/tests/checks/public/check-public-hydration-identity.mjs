#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readUtf8(path) {
  return await readFile(path, 'utf8');
}

async function main() {
  const clientRoot = process.cwd();
  const hydratePath = resolve(clientRoot, 'src/public-renderers/clientHydrate.ts');
  const guardPath = resolve(clientRoot, 'src/public-renderers/hydrationIdentityGuard.ts');
  const perfPath = resolve(clientRoot, 'src/public-renderers/hydrationPerf.ts');
  const normalizerPath = resolve(clientRoot, 'src/public-renderers/publicPayloadNormalizer.ts');
  const homePath = resolve(clientRoot, 'src/public-renderers/PublicHomePage.vue');
  const articlePath = resolve(clientRoot, 'src/public-renderers/PublicArticleDetailPage.vue');
  const shellPath = resolve(clientRoot, 'src/bootstrap/publicShell.ts');

  const hydrateSource = await readUtf8(hydratePath);
  assert(hydrateSource.includes('SHELL_SELECTOR = \'#fsus-aot-shell\''), 'missing shell selector constant in clientHydrate.ts');
  assert(hydrateSource.includes('APP_SELECTOR = \'#app\''), 'missing app selector constant in clientHydrate.ts');
  assert(hydrateSource.includes('captureHydrationIdentity'), 'clientHydrate.ts must capture hydration identity before mount');
  assert(hydrateSource.includes('verifyHydrationIdentity'), 'clientHydrate.ts must verify hydration identity after mount');
  assert(hydrateSource.includes('beginHydrationMetrics'), 'clientHydrate.ts must start hydration metrics');
  assert(hydrateSource.includes('finishHydrationMetrics'), 'clientHydrate.ts must finish hydration metrics');
  assert(hydrateSource.includes('normalizePublicHydrationPayload'), 'clientHydrate.ts must normalize payload before hydration');
  assert(hydrateSource.includes('shallowReadonly('), 'clientHydrate.ts must wrap payload with shallowReadonly');
  assert(hydrateSource.includes('shallowRef('), 'clientHydrate.ts must hold payload in shallowRef');

  const guardSource = await readUtf8(guardPath);
  assert(guardSource.includes('SHELL_IDENTITY_DATASET_KEY = \'publicShellIdentity\''), 'hydrationIdentityGuard must preserve shell marker key');
  assert(guardSource.includes('shell remount detected'), 'hydrationIdentityGuard must throw shell remount detected');
  assert(guardSource.includes('#app subtree rebuilt'), 'hydrationIdentityGuard must throw #app subtree rebuilt');

  const perfSource = await readUtf8(perfPath);
  assert(perfSource.includes('__FSUS_PUBLIC_HYDRATION_METRICS__'), 'hydrationPerf must publish hydration metrics snapshot');
  assert(perfSource.includes('public-hydrate-total'), 'hydrationPerf must measure public-hydrate-total');
  assert(perfSource.includes('public-hydrate-mount'), 'hydrationPerf must measure public-hydrate-mount');

  const normalizerSource = await readUtf8(normalizerPath);
  assert(normalizerSource.includes('normalizePublicHydrationPayload'), 'publicPayloadNormalizer must export normalizePublicHydrationPayload');
  assert(normalizerSource.includes('routeKey'), 'publicPayloadNormalizer must normalize routeKey');

  const homeSource = await readUtf8(homePath);
  assert(homeSource.includes('id="fsus-aot-shell"'), 'PublicHomePage must keep #fsus-aot-shell root');
  assert(homeSource.includes('data-public-hydration-kind="Home"'), 'PublicHomePage must expose Home hydration kind');

  const articleSource = await readUtf8(articlePath);
  assert(articleSource.includes('id="fsus-aot-shell"'), 'PublicArticleDetailPage must keep #fsus-aot-shell root');
  assert(articleSource.includes('data-public-hydration-kind="ArticleDetail"'), 'PublicArticleDetailPage must expose ArticleDetail hydration kind');
  assert(articleSource.includes('id="fsus-comments-island"'), 'PublicArticleDetailPage must preserve comments slot host');
  assert(articleSource.includes('id="fsus-comments-island-content"'), 'PublicArticleDetailPage must preserve comments slot mount target');
  assert(!articleSource.includes('第一条评论会在这里出现。'), 'PublicArticleDetailPage must not render comment placeholder copy');
  assert(!articleSource.includes('data-aot-action="activate-comments"'), 'PublicArticleDetailPage must not require comments click activator');

  const shellSource = await readUtf8(shellPath);
  assert(shellSource.includes("'X-Fsus-Public-Navigation': '1'"), 'publicShell must mark internal public navigation fetches');
  assert(shellSource.includes('history.pushState'), 'publicShell must use History API pushState');
  assert(shellSource.includes('window.addEventListener(\'popstate\''), 'publicShell must handle popstate for micro routing');
  assert(!shellSource.includes('bootstrapFullApp('), 'publicShell must not bootstrap full app on public routes');
  assert(!shellSource.includes('enableFullAppRuntime('), 'publicShell must not enable full app runtime on public routes');

  console.log('[check-public-hydration-identity] ok');
}

main().catch((error) => {
  console.error('[check-public-hydration-identity] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
