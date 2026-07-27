import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const frontendRoot = process.cwd();
const repoRoot = path.resolve(frontendRoot, '../..');
const frontendRequire = createRequire(path.join(frontendRoot, 'package.json'));
const { build } = await import(pathToFileURL(frontendRequire.resolve('vite')).href);
const { renderStablePublicBootKernelAlias } = await import(
    pathToFileURL(path.join(repoRoot, 'tools/frontend/build.mjs')).href
);
const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-public-boot-production-'));

try
{
    await build({
        configFile: false,
        root: frontendRoot,
        logLevel: 'silent',
        resolve: {
            alias: {
                '@': path.join(frontendRoot, 'src')
            }
        },
        build: {
            target: 'es2022',
            minify: true,
            manifest: true,
            outDir: outputRoot,
            emptyOutDir: true,
            rolldownOptions: {
                input: {
                    publicBootKernel: path.join(frontendRoot, 'src/bootstrap/publicBootKernel.ts')
                }
            }
        }
    });

    const assetNames = await readdir(path.join(outputRoot, 'assets'));
    const hashedKernel = assetNames.find((name) => /^publicBootKernel-[A-Za-z0-9_-]+\.js$/u.test(name));
    assert.ok(hashedKernel, 'production output must contain a hashed publicBootKernel entry');
    const hashedSource = await readFile(path.join(outputRoot, 'assets', hashedKernel), 'utf8');
    assert.ok(hashedSource.length > 0, 'hashed BootKernel bundle must be non-empty');
    const retiredBootPattern = new RegExp(
        `${['BuildDeferred', 'SpaBootScript'].join('')}|${['fsus', 'spa', 'boot'].join('-')}|CustomEvent`,
        'u'
    );
    assert.doesNotMatch(hashedSource, retiredBootPattern);
    assert.doesNotMatch(hashedSource, /(?:vue-router|pinia|fullApp|publicShell|FsusUI)/u);

    const stableAlias = renderStablePublicBootKernelAlias(hashedKernel);
    await writeFile(path.join(outputRoot, 'assets', 'fsus-public-boot-kernel.js'), stableAlias, 'utf8');
    assert.equal(stableAlias, `import './${hashedKernel}';\n`);

    const config = {
        schema: 'fsusblog.public-boot-config.v1',
        frontendBuildIdentity: 'local-unversioned',
        entryUrl: '/assets/fsus-spa-entry.js',
        coreModulePreloads: ['/assets/entry-runtime.js'],
        takeoverStylesheets: ['/assets/full-app-core.css']
    };
    const html = `<main id="fsus-aot-shell">Readable AOT</main><script id="fsus-public-boot-config" type="application/json">${JSON.stringify(config)}</script><script type="module" src="/assets/fsus-public-boot-kernel.js" data-fsusblog-public-boot-kernel></script>`;
    await writeFile(path.join(outputRoot, 'public-aot-proof.html'), html, 'utf8');
    assert.match(html, /id="fsus-public-boot-config" type="application\/json"/u);
    assert.match(html, /src="\/assets\/fsus-public-boot-kernel\.js"/u);
    assert.doesNotMatch(
        html,
        new RegExp(`requestIdleCallback|pointerdown|createPolicy|warmPreload|${['fsus', 'spa', 'boot'].join('-')}`, 'u')
    );

    const manifest = JSON.parse(await readFile(path.join(outputRoot, '.vite', 'manifest.json'), 'utf8'));
    const kernelManifest = Object.values(manifest).find((entry) => entry.name === 'publicBootKernel');
    assert.equal(kernelManifest?.file, `assets/${hashedKernel}`);

    console.log(`[public-boot-production-output] bundle=${hashedKernel} alias=fsus-public-boot-kernel.js html=external-kernel`);
}
finally
{
    await rm(outputRoot, { recursive: true, force: true });
}
