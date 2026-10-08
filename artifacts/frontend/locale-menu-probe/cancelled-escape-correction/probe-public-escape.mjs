import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [uiRoot, blogRoot, evidenceRoot] = process.argv.slice(2).map((v) => path.resolve(v));
const dependency = createRequire(path.join(uiRoot, 'package.json'));
const { chromium, expect } = dependency('@playwright/test');
const { createServer } = await import(pathToFileURL(dependency.resolve('vite')));
const { default: vue } = await import(pathToFileURL(dependency.resolve('@vitejs/plugin-vue')));
const { createFsusUiAliases } = await import(pathToFileURL(path.join(blogRoot, 'src/frontend/scripts/fsusui-local.ts')));
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dropdown-public-escape-'));
const git = (...args) => execFileSync('git', ['-C', uiRoot, ...args], { encoding: 'utf8' }).trim();
const report = { schema: 'fsusui.dropdown-public-escape-probe.v1', runId: `public-escape-${new Date().toISOString()}`, source: git('rev-parse', 'HEAD'), sourceStatus: git('status', '--short'), assertions: [], errors: [], qualification: false };
let server;
let browser;
try {
  await fs.mkdir(evidenceRoot, { recursive: true });
  const source = `<script setup>
import { ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu } from '@ozwasyd/element-plus';
import '@ozwasyd/element-plus/dist/index.css';
const params = new URLSearchParams(location.search);
const cancelled = params.get('cancelled') === 'true';
const nested = params.get('nested') === 'true';
</script>
<template>
  <main style="padding: 24px">
    <ElDropdown trigger="click" :hide-on-click="false" :teleported="false">
      <ElButton data-parent-trigger>Parent</ElButton>
      <template #dropdown>
        <ElDropdownMenu>
          <ElDropdownItem v-if="!nested && cancelled" :checked="true" data-item @keydown.esc.stop.prevent>English</ElDropdownItem>
          <ElDropdownItem v-else-if="!nested" :checked="true" data-item>English</ElDropdownItem>
          <ElDropdownItem v-else :checked="true" data-parent-item>
            <ElDropdown trigger="click" :hide-on-click="false" :teleported="false">
              <ElButton data-child-trigger>Child</ElButton>
              <template #dropdown>
                <ElDropdownMenu>
                  <ElDropdownItem v-if="cancelled" :checked="true" data-item @keydown.esc.stop.prevent>English</ElDropdownItem>
                  <ElDropdownItem v-else :checked="true" data-item>English</ElDropdownItem>
                </ElDropdownMenu>
              </template>
            </ElDropdown>
          </ElDropdownItem>
        </ElDropdownMenu>
      </template>
    </ElDropdown>
    <button data-outside>Outside</button>
  </main>
</template>`;
  report.fixtureSha256 = createHash('sha256').update(source).digest('hex');
  report.harnessSha256 = createHash('sha256').update(await fs.readFile(new URL(import.meta.url))).digest('hex');
  await fs.writeFile(path.join(temporaryRoot, 'App.vue'), source);
  await fs.writeFile(path.join(temporaryRoot, 'index.html'), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>');
  await fs.writeFile(path.join(temporaryRoot, 'main.js'), "import {createApp} from 'vue';import App from './App.vue';createApp(App).mount('#app');\n");
  server = await createServer({ configFile: false, root: temporaryRoot, plugins: [vue()], resolve: { dedupe: ['vue'], alias: [...createFsusUiAliases(uiRoot), { find: /^vue$/, replacement: path.join(uiRoot, 'node_modules/vue/dist/vue.runtime.esm-bundler.js') }] }, server: { host: '127.0.0.1', port: 0, fs: { allow: [temporaryRoot, uiRoot, blogRoot] } } });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', (e) => report.errors.push(e.message));
  for (const nested of [false, true]) {
    for (const cancelled of [true, false]) {
      await page.goto(`${server.resolvedUrls.local[0]}?nested=${nested}&cancelled=${cancelled}`);
      const parent = page.locator('[data-parent-trigger]');
      const outside = page.locator('[data-outside]');
      for (let cycle = 0; cycle < 3; cycle++) {
        await parent.focus();
        await parent.press('Enter');
        await expect(parent).toHaveAttribute('aria-expanded', 'true');
        let trigger = parent;
        if (nested) {
          trigger = page.locator('[data-child-trigger]');
          await trigger.focus();
          await trigger.press('Enter');
          await expect(trigger).toHaveAttribute('aria-expanded', 'true');
        }
        const item = page.locator('[data-item]');
        await expect(item).toBeFocused();
        await expect(item).toHaveAttribute('aria-checked', 'true');
        await item.press('Escape');
        if (cancelled) {
          await expect(trigger).toHaveAttribute('aria-expanded', 'true');
          await expect(item).toBeFocused();
          await expect(item).toHaveAttribute('aria-checked', 'true');
          await page.screenshot({ path: path.join(evidenceRoot, `open-nested${nested}-cycle${cycle}.png`) });
        } else {
          await expect(trigger).toHaveAttribute('aria-expanded', 'false');
          await expect(trigger).toBeFocused();
        }
        if (nested) await expect(parent).toHaveAttribute('aria-expanded', 'true');
        await outside.click();
        await expect(parent).toHaveAttribute('aria-expanded', 'false');
        await expect(outside).toBeFocused();
        await page.screenshot({ path: path.join(evidenceRoot, `dismissed-nested${nested}-cancelled${cancelled}-cycle${cycle}.png`) });
        report.assertions.push({ nested, cancelled, cycle, result: 'passed', checkedState: 'committed', dismissalFocus: 'outside' });
      }
    }
  }
  expect(report.errors).toEqual([]);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.errors.push(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
  await fs.writeFile(path.join(evidenceRoot, 'probe.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(temporaryRoot, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
