import assert from 'node:assert/strict';
import test from 'node:test';

const {
    articleVaultConflictUiFiles,
    checkArticleVaultConflictUiSources,
    readArticleVaultConflictUiSources
} = await import(new URL('../../tools/governance/article-vault-conflict-terminal-ui.mjs', import.meta.url));

const [presentation, component, statusPresentation, statusComponent] = articleVaultConflictUiFiles;

function diagnostics(file, mutation)
{
    const sources = readArticleVaultConflictUiSources();
    sources.set(file, mutation(sources.get(file)));
    return checkArticleVaultConflictUiSources(sources).join('\n');
}

test('actual Vue script, render AST and presentation retain the read-only authority boundary', () =>
{
    assert.equal(articleVaultConflictUiFiles.length, 4);
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
