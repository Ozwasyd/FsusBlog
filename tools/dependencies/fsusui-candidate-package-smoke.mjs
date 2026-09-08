import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

function installedVuePaths(nodeModules, visited = new Set()) {
    if (!fs.existsSync(nodeModules)) {
        return [];
    }
    const directory = fs.realpathSync(nodeModules);
    if (visited.has(directory)) {
        return [];
    }
    visited.add(directory);
    const packages = fs.readdirSync(directory).filter((name) => !name.startsWith('.')).flatMap((name) => {
        const item = path.join(directory, name);
        return name.startsWith('@') ? fs.readdirSync(item).map((child) => path.join(item, child)) : [item];
    });
    return packages.flatMap((item) => {
        const manifestPath = path.join(item, 'package.json');
        const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
        return [
            ...(manifest?.name === 'vue' ? [fs.realpathSync(item)] : []),
            ...installedVuePaths(path.join(item, 'node_modules'), visited)
        ];
    });
}

export function verifySingleVue(frontend) {
    const vuePaths = [...new Set(installedVuePaths(path.join(frontend, 'node_modules')))];
    assert.equal(vuePaths.length, 1, 'candidate dependency tree must contain exactly one Vue runtime');
    const appRequire = createRequire(path.join(frontend, 'package.json'));
    const candidateRequire = createRequire(path.join(frontend, 'node_modules/@ozwasyd/element-plus/package.json'));
    assert.equal(fs.realpathSync(appRequire.resolve('vue/package.json')), fs.realpathSync(candidateRequire.resolve('vue/package.json')), 'app and candidate resolve different Vue runtimes');
    assert.equal(path.dirname(fs.realpathSync(appRequire.resolve('vue/package.json'))), vuePaths[0]);
    return { vuePath: vuePaths[0] };
}

export async function verifyWorkerWasm(frontend) {
    return await new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { frontend } });
        const timeout = setTimeout(() => {
            void worker.terminate();
            reject(new Error('candidate worker/Wasm smoke timed out'));
        }, 60000);
        let observation;
        worker.on('message', (value) => { observation = value; });
        worker.on('error', (error) => { clearTimeout(timeout); reject(error); });
        worker.on('exit', (code) => {
            clearTimeout(timeout);
            if (code !== 0 || observation?.wasmReady !== true) {
                reject(new Error('candidate worker did not complete actual Wasm execution'));
            } else {
                resolve(observation);
            }
        });
    });
}

if (!isMainThread) {
    const consumerRequire = createRequire(path.join(workerData.frontend, 'package.json'));
    const entry = consumerRequire.resolve('@ozwasyd/element-plus/wasm');
    const packageRoot = fs.realpathSync(path.join(workerData.frontend, 'node_modules/@ozwasyd/element-plus'));
    assert.ok(fs.realpathSync(entry).startsWith(`${packageRoot}${path.sep}`), 'Wasm entry escaped installed candidate');
    const wasm = consumerRequire('@ozwasyd/element-plus/wasm');
    const ready = await wasm.ensureWasmReady();
    assert.equal(ready.ok, true, 'candidate Wasm initialization failed');
    assert.equal(wasm.isWasmReady(), true, 'candidate used a non-Wasm fallback');
    const sorted = await wasm.sortNumbers([3, -1, 2, 0], true);
    assert.deepEqual(sorted, { ok: true, value: [-1, 0, 2, 3] });
    parentPort.postMessage({ wasmReady: true, entry, sorted: sorted.value });
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const frontend = process.cwd();
    assert.equal(process.env.FSUSBLOG_USE_LOCAL_FSUSUI, '0', 'candidate smoke must disable local aliases');
    assert.equal(process.argv.length, 3);
    if (process.argv[2] === '--single-vue') {
        console.log(JSON.stringify(verifySingleVue(frontend)));
    } else {
        assert.equal(process.argv[2], '--worker-wasm');
        console.log(JSON.stringify(await verifyWorkerWasm(frontend)));
    }
}
