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
  const homePath = resolve(clientRoot, 'src/public-renderers/PublicHomePage.vue');
  const articlePath = resolve(clientRoot, 'src/public-renderers/PublicArticleDetailPage.vue');

  const hydrateSource = await readUtf8(hydratePath);
  assert(hydrateSource.includes('SHELL_SELECTOR = \'#fsus-aot-shell\''), 'missing shell selector constant in clientHydrate.ts');
  assert(hydrateSource.includes('SHELL_IDENTITY_DATASET_KEY = \'publicShellIdentity\''), 'missing shell identity dataset key in clientHydrate.ts');
  assert(hydrateSource.includes('const shellRefBeforeHydration = shell;'), 'missing pre-hydration shell reference capture');
  assert(hydrateSource.includes('shellAfterHydration !== shellRefBeforeHydration'), 'missing shell node identity check after hydration');
  assert(hydrateSource.includes('shell identity marker mismatch'), 'missing shell identity marker mismatch guard');
  assert(hydrateSource.includes('shell remount detected'), 'missing shell remount guard');

  const homeSource = await readUtf8(homePath);
  assert(homeSource.includes('id="fsus-aot-shell"'), 'PublicHomePage must keep #fsus-aot-shell root');
  assert(homeSource.includes('data-public-hydration-kind="Home"'), 'PublicHomePage must expose Home hydration kind');

  const articleSource = await readUtf8(articlePath);
  assert(articleSource.includes('id="fsus-aot-shell"'), 'PublicArticleDetailPage must keep #fsus-aot-shell root');
  assert(articleSource.includes('data-public-hydration-kind="ArticleDetail"'), 'PublicArticleDetailPage must expose ArticleDetail hydration kind');

  console.log('[check-public-hydration-identity] ok');
}

main().catch((error) => {
  console.error('[check-public-hydration-identity] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
