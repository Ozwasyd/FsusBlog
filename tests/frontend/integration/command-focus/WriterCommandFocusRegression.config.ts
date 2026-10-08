import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import applicationViteConfig from '../../../../src/frontend/vite.config';

const frontend = fileURLToPath(new URL('../../../../src/frontend/', import.meta.url));
const evidence = process.env.COMMAND_FOCUS_EVIDENCE_ROOT ?? '/tmp/command-focus-qa/current';

const browserConfig = defineConfig({
    testDir: '.',
    testMatch: 'WriterCommandFocusRegression.spec.ts',
    workers: 1,
    retries: 0,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    outputDir: `${evidence}/artifacts`,
    reporter: [['list'], ['json', { outputFile: `${evidence}/results.json` }]],
    use: {
        baseURL: 'http://127.0.0.1:4317',
        viewport: { width: 1440, height: 900 },
        reducedMotion: 'reduce',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        launchOptions: {
            executablePath: process.env.COMMAND_FOCUS_CHROMIUM ?? '/usr/bin/chromium',
            args: ['--no-sandbox']
        }
    },
    webServer: {
        command: 'node node_modules/vite/bin/vite.js --config ../../tests/frontend/integration/command-focus/WriterCommandFocusRegression.config.ts --host 127.0.0.1 --port 4317 --strictPort',
        cwd: frontend,
        url: 'http://127.0.0.1:4317',
        reuseExistingServer: false,
        timeout: 90_000,
        env: {
            COMMAND_FOCUS_VITE: '1',
            FSUSBLOG_USE_LOCAL_FSUSUI: '1',
            FSUSBLOG_LOCAL_FSUSUI_ROOT: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT ?? '/workspace/FsusUI',
            FSUSBLOG_FRONTEND_CACHE_ROOT: `${evidence}/vite-cache`
        }
    }
});

// A real server response gives Chromium the actual loopback address space. A
// fulfilled navigation response can trigger local-network blocking on imports.
export default process.env.COMMAND_FOCUS_VITE === '1'
    ? async (environment: Parameters<typeof applicationViteConfig>[0]) => mergeConfig(
        await applicationViteConfig(environment), {
            plugins: [{
                name: 'writer-command-focus-regression-entry',
                configureServer(server: import('vite').ViteDevServer)
                {
                    server.middlewares.use((request, response, next) =>
                    {
                        if (request.url !== '/__writer-command-focus-regression') return next();
                        response.setHeader('Content-Type', 'text/html');
                        response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
                            <meta name="viewport" content="width=device-width, initial-scale=1">
                            <title>Writer command focus integration</title></head><body class="account-shell">
                            <div id="writer-command-focus-regression"></div>
                            <script type="module" src="/@fs/${fileURLToPath(new URL('./WriterCommandFocusRegression.fixture.ts', import.meta.url))}"></script>
                            </body></html>`);
                    });
                }
            }]
        }
    ) : browserConfig;
