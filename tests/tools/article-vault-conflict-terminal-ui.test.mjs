import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
    articleVaultConflictUiFiles,
    articleVaultConflictPaginationAdapter,
    checkArticleVaultConflictUiSources,
    readArticleVaultConflictUiSources
} = await import(new URL('../../tools/governance/article-vault-conflict-terminal-ui.mjs', import.meta.url));

const [presentation, component, statusPresentation, statusComponent] = articleVaultConflictUiFiles;

test('stored review consumers cannot acquire transports or turn a response into local command authority', () =>
{
    const [storedPresentation, storedComponent] = articleVaultConflictUiFiles.slice(4);
    assert.match(diagnostics(storedPresentation, source => `${source}\nconst read = fetch; read("/proposal/latest");\n`), /authority/u);
    assert.match(diagnostics(storedPresentation, source => `${source}\nsnapshot.proposal.state = "complete";\n`), /canonical machine/u);
    assert.match(diagnostics(storedComponent, source => source.replace('</template>', '<button @click="recoverLatest()">Recover</button></template>')),
        /writer/u);
});

function diagnostics(file, mutation)
{
    const sources = readArticleVaultConflictUiSources();
    sources.set(file, mutation(sources.get(file)));
    return checkArticleVaultConflictUiSources(sources).join('\n');
}

test('actual Vue script, render AST and presentation retain the read-only authority boundary', () =>
{
    assert.equal(articleVaultConflictUiFiles.length, 6);
    assert.deepEqual(checkArticleVaultConflictUiSources(readArticleVaultConflictUiSources()), []);
});

test('plan/checkpoint presentation owners cannot acquire recovery writers or mutate canonical truth', () =>
{
    for (const fixture of [
        'journal.state = "complete";',
        'const recovery = await import("@/services/articleVault/recovery");',
        'recoverLatest();',
        'const debug = console.log; debug(journal);'
    ])
    {
        assert.match(diagnostics(statusPresentation, source => `${source}\n${fixture}\n`),
            /canonical machine|dependency|writer|privacy/u);
    }
});

test('checkpoint render expressions cannot write, choose latest recovery or expose raw backup HTML', () =>
{
    for (const fixture of [
        '<button @click="journal.state = \'complete\'">Finish</button>',
        '<button @click="recoverLatest()">Recover</button>',
        '<div v-html="journal.privateBackupBytes" />'
    ])
    {
        assert.match(diagnostics(statusComponent, source => source.replace('</template>', `${fixture}\n</template>`)),
            /canonical machine|writer|raw HTML/u);
    }
});

test('comments and ordinary display strings do not become executable authority', () =>
{
    assert.equal(diagnostics(presentation, source => `${source}\n// fetch localStorage acceptAllServer\nconst notice = "Winner AI mtime";\n`), '');
});

test('writer imports, aliases, re-exports and dynamic imports cannot enter the presentation owners', () =>
{
    for (const fixture of [
        'import { writeFile as innocent } from "node:fs"; innocent("path", "body");',
        'export { executeGroupAsync as ordinary } from "@/services/articleVault/writer";',
        'const writer = await import("@/services/articleVault/writer");',
        'import git = require("simple-git");'
    ])
    {
        assert.match(diagnostics(presentation, source => `${source}\n${fixture}\n`), /dependency|import/u);
    }
});

test('network, storage and computed global aliases are rejected without executing fixtures', () =>
{
    for (const fixture of [
        'const transport = fetch; transport("/api/write");',
        'const transport = globalThis["fetch"]; transport("/api/write");',
        'const { fetch: innocent } = globalThis; innocent("/api/write");',
        'window["localStorage"].setItem("status", "synced");',
        'const key = "fetch"; const capability = globalThis[key];',
        'navigator.sendBeacon("/api/write", "body");',
        'const execute = Function("return true");'
    ])
    {
        assert.match(diagnostics(presentation, source => `${source}\n${fixture}\n`), /authority|capability/u);
    }
});

test('machine status, decision and verification mutations do not become UI authority', () =>
{
    for (const fixture of [
        'evidence.status = "synced";',
        'evidence["state"] = "synced";',
        'item.decision ||= "accept-all-local";',
        'receipt.verified = true;',
        'evidence.status++;',
        'delete evidence.status;'
    ])
    {
        assert.match(diagnostics(presentation, source => `${source}\n${fixture}\n`), /canonical machine/u);
    }
});

test('AI, mtime, two-way, accept-all and latest-receipt authority references are rejected', () =>
{
    for (const name of ['AiScore', 'mtime', 'Winner', 'TwoWayMerge', 'AcceptAllLocal', 'AcceptAllServer', 'LatestReceipt'])
    {
        assert.match(diagnostics(presentation, source => `${source}\nconst authority = candidate.${name};\n`), /winner\/AI\/mtime\/two-way\/latest/u);
        assert.match(diagnostics(presentation, source => `${source}\nconst authority = candidate["${name}"];\n`), /winner\/AI\/mtime\/two-way\/latest/u);
    }
});

test('reflection writers and console evidence leaks are rejected even through aliases', () =>
{
    for (const fixture of [
        'const write = Object.assign; write(evidence, { status: "synced" });',
        'Object.defineProperty(evidence, "state", { value: "synced" });',
        'Reflect.set(evidence, "status", "synced");',
        'const debug = console.log; debug(evidence);'
    ])
    {
        assert.match(diagnostics(presentation, source => `${source}\n${fixture}\n`), /reflection writer|privacy/u);
    }
});

test('Vue template expressions and raw HTML do not bypass script analysis', () =>
{
    for (const fixture of [
        '<button @click="fetch(\'/api/write\')">Write</button>',
        '<button @click="entry.status = \'synced\'">Sync</button>',
        '<div>{{ entry.AiScore }}</div>',
        '<div v-html="entry.sourceBody" />'
    ])
    {
        assert.match(diagnostics(component, source => source.replace('</template>', `${fixture}\n</template>`)),
            /authority|canonical machine|raw HTML/u);
    }
});

test('missing owners and malformed executable syntax fail closed', () =>
{
    const sources = readArticleVaultConflictUiSources();
    sources.delete(presentation);
    assert.match(checkArticleVaultConflictUiSources(sources).join('\n'), /missing canonical/u);
    assert.match(diagnostics(presentation, source => `${source}\nconst broken = (;\n`), /invalid TypeScript/u);
});

test('public Pagination admission parses the named re-export rather than its spelling or trivia', () =>
{
    const sources = readArticleVaultConflictUiSources();
    sources.set(articleVaultConflictPaginationAdapter,
        '// Public component, with no implementation.\nexport { ElPagination as FsusUiPagination } from "@ozwasyd/element-plus";\n');
    assert.deepEqual(checkArticleVaultConflictUiSources(sources), []);
});

test('a named local alias preserves the same public Pagination component dependency', () =>
{
    const sources = readArticleVaultConflictUiSources();
    sources.set(component, sources.get(component)
        .replace('import { FsusUiPagination }', 'import { FsusUiPagination as BoundPagination }')
        .replaceAll('<FsusUiPagination', '<BoundPagination')
        .replaceAll('</FsusUiPagination', '</BoundPagination'));
    assert.deepEqual(checkArticleVaultConflictUiSources(sources), []);
});

test('Pagination admission rejects private, substituted, erased and executable adapter implementations', () =>
{
    for (const source of [
        'export { ElPagination as FsusUiPagination } from "@ozwasyd/element-plus/es/components/pagination";',
        'export { ElPagination as FsusUiPagination } from "element-plus";',
        'export { ElButton as FsusUiPagination } from "@ozwasyd/element-plus";',
        'export { ElPagination as OtherPagination } from "@ozwasyd/element-plus";',
        'export { FsusUiPagination } from "@ozwasyd/element-plus";',
        'export type { ElPagination as FsusUiPagination } from "@ozwasyd/element-plus";',
        'export { type ElPagination as FsusUiPagination } from "@ozwasyd/element-plus";',
        'export * from "@ozwasyd/element-plus";',
        'export * as FsusUiPagination from "@ozwasyd/element-plus";',
        'export { ElPagination as FsusUiPagination, ElButton } from "@ozwasyd/element-plus";',
        'import { ElPagination } from "@ozwasyd/element-plus"; export { ElPagination as FsusUiPagination };',
        'export default {} as Component;',
        'export const FsusUiPagination = { setup() { return () => null; } };',
        'export { ElPagination as FsusUiPagination } from "@ozwasyd/element-plus" with { type: "json" };',
        'export { ElPagination as FsusUiPagination } from "@ozwasyd/element-plus"; fetch("/writer");',
        'export { ElPagination as FsusUiPagination } from "@ozwasyd/element-plus"; const extra = "implementation";'
    ])
    {
        const sources = readArticleVaultConflictUiSources();
        sources.set(articleVaultConflictPaginationAdapter, source);
        assert.match(checkArticleVaultConflictUiSources(sources).join('\n'), /pagination adapter/u, source);
    }
});

test('Pagination consumers cannot use defaults, namespaces, type-only bindings or re-exports', () =>
{
    const original = "import { FsusUiPagination } from '@/fsusui/pagination';";
    for (const replacement of [
        'import Pagination from "@/fsusui/pagination";',
        'import * as Pagination from "@/fsusui/pagination";',
        'import "@/fsusui/pagination";',
        'import type { FsusUiPagination } from "@/fsusui/pagination";',
        'import { type FsusUiPagination } from "@/fsusui/pagination";',
        'import { ElPagination as FsusUiPagination } from "@/fsusui/pagination";',
        'import { FsusUiPagination, Writer } from "@/fsusui/pagination";',
        'export { FsusUiPagination } from "@/fsusui/pagination";',
        'export * from "@/fsusui/pagination";'
    ])
    {
        assert.match(diagnostics(component, source =>
        {
            assert.ok(source.includes(original));
            return source.replace(original, replacement);
        }), /pagination dependency requires a single named runtime component import/u, replacement);
    }
});

test('missing, malformed and non-source Pagination adapters fail closed', () =>
{
    for (const source of [undefined, null, '', 'export {'])
    {
        const sources = readArticleVaultConflictUiSources();
        sources.set(articleVaultConflictPaginationAdapter, source);
        assert.match(checkArticleVaultConflictUiSources(sources).join('\n'), /pagination adapter/u);
    }
    const sources = readArticleVaultConflictUiSources();
    sources.delete(articleVaultConflictPaginationAdapter);
    assert.match(checkArticleVaultConflictUiSources(sources).join('\n'), /missing canonical pagination adapter/u);
});

function withPaginationSourceRepository(action)
{
    const directory = mkdtempSync(path.join(tmpdir(), 'vault-pagination-source-'));
    const root = path.join(directory, 'repository');
    const sources = readArticleVaultConflictUiSources();
    try
    {
        for (const [file, source] of sources)
        {
            mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            writeFileSync(path.join(root, file), source);
        }
        action(root, directory, sources);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
}

test('the actual source reader preserves the regular public adapter in its checked input map', () =>
{
    withPaginationSourceRepository((root, _directory, sources) =>
    {
        const read = readArticleVaultConflictUiSources(root);
        assert.equal(read.get(articleVaultConflictPaginationAdapter), sources.get(articleVaultConflictPaginationAdapter));
        assert.deepEqual(checkArticleVaultConflictUiSources(read), []);
    });
});

test('the actual source reader rejects nonregular and escaped Pagination adapter files', () =>
{
    withPaginationSourceRepository((root, directory, sources) =>
    {
        const adapter = path.join(root, articleVaultConflictPaginationAdapter);
        const outside = path.join(directory, 'outside.ts');
        writeFileSync(outside, sources.get(articleVaultConflictPaginationAdapter));
        rmSync(adapter);
        symlinkSync(outside, adapter);
        assert.throws(() => readArticleVaultConflictUiSources(root), /regular canonical source file/u);
        rmSync(adapter);
        mkdirSync(adapter);
        assert.throws(() => readArticleVaultConflictUiSources(root), /regular canonical source file/u);
        rmSync(adapter, { recursive: true });
        const folder = path.dirname(adapter);
        const externalFolder = path.join(directory, 'external');
        mkdirSync(externalFolder);
        writeFileSync(path.join(externalFolder, 'pagination.ts'), sources.get(articleVaultConflictPaginationAdapter));
        rmSync(folder, { recursive: true });
        symlinkSync(externalFolder, folder, 'dir');
        assert.throws(() => readArticleVaultConflictUiSources(root), /regular canonical source file/u);
    });
});

test('Pagination support does not admit an arbitrary adapter, private dependency or dynamic import', () =>
{
    for (const fixture of [
        'import { FsusUiPagination } from "@/fsusui/privatePagination";',
        'import { FsusUiPagination } from "@/fsusui/pagination/private";',
        'const component = await import("@/fsusui/pagination");'
    ])
    {
        assert.match(diagnostics(presentation, source => `${source}\n${fixture}\n`), /dependency/u, fixture);
    }
});
