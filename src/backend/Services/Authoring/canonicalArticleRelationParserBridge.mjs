import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveLocalFsusUiRepositoryRoot } from '../../../frontend/scripts/fsusui-root.mjs';

const schema = 'fsusblog.canonical-article-relation-parse.v1';
const identityClosureSchema = 'fsusblog.canonical-article-relation-identity-closure.v1';
const searchSchema = 'fsusblog.canonical-article-search-parse.v1';
const searchIdentityClosureSchema = 'fsusblog.canonical-article-search-identity-closure.v1';
const publicModule = '@ozwasyd/element-plus/markdown-runtime';
const maxInputBytes = 1024 * 1024;
const maxOutputBytes = 2 * 1024 * 1024;
const maxNodes = 4096;
const maxSourceUtf16 = 200000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireFact = (condition) => {
    if (!condition) throw new Error('refused');
};

// This process has one stdin request and one stdout envelope. Never print exception
// messages: parser errors and import errors can contain the private source or paths.
try {
    requireFact(process.argv.length === 2);
    let inputBytes = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
        inputBytes += chunk.length;
        requireFact(inputBytes <= maxInputBytes);
        chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const operation = input.operation ?? 'parse';
    const searchPurpose = operation === 'search-parse' || operation === 'search-identity-closure';
    requireFact(searchPurpose || operation === 'parse' || operation === 'identity-closure');
    requireFact(input.schema === (searchPurpose ? searchSchema : schema) && typeof input.sourceBase64 === 'string');
    const bytes = Buffer.from(input.sourceBase64, 'base64');
    requireFact(bytes.toString('base64') === input.sourceBase64 && bytes.length <= 600000);
    requireFact(sha256(bytes) === input.sourceDigest);
    // ignoreBOM preserves U+FEFF in the raw JS string. Coordinates own normalization.
    const rawSource = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    requireFact(rawSource.length <= maxSourceUtf16);
    const documentId = searchPurpose ? input.parseLifetimeId : input.documentId;
    const documentEpoch = searchPurpose ? input.heldSourceSequence : input.documentEpoch;
    requireFact(typeof documentId === 'string' && documentId.length > 0 && documentId.length <= 128);
    requireFact(Number.isSafeInteger(documentEpoch) && documentEpoch > 0);

    const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const localRoot = input.localUiRoot === null ? null : resolveLocalFsusUiRepositoryRoot({
        override: input.localUiRoot,
        repositoryRoot,
    });
    // Reuse the original localUI public-entry alias. No UI internal import or parser.
    const entry = localRoot
        ? path.join(localRoot, 'vue/packages/element-plus/markdown-runtime.ts')
        : createRequire(path.join(repositoryRoot, 'src/frontend/package.json')).resolve(publicModule);
    requireFact(sha256(await readFile(entry)) === input.publicEntryDigest);
    const imported = await import(pathToFileURL(entry).href);
    const runtime = imported.default ?? imported;

    // Observe the bytes actually compiled by the public runtime through the standard
    // WebAssembly host API; do not locate/read a private WASM asset or generated glue.
    const compiledModules = [];
    const moduleConstructor = WebAssembly.Module;
    WebAssembly.Module = new Proxy(moduleConstructor, {
        construct(target, args) {
            const buffer = args[0];
            const view = ArrayBuffer.isView(buffer)
                ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
                : new Uint8Array(buffer);
            compiledModules.push(sha256(view));
            return Reflect.construct(target, args);
        },
    });
    const coordinates = runtime.createMarkdownSourceCoordinateMap(rawSource);
    const projection = runtime.createMarkdownEditorProjection(rawSource);
    WebAssembly.Module = moduleConstructor;
    requireFact(compiledModules.length === 1 && compiledModules[0] === input.wasmModuleDigest);
    requireFact(projection.identity.parser === runtime.MARKDOWN_EDITOR_PROJECTION_PARSER);
    requireFact(projection.identity.version === runtime.MARKDOWN_RENDERER_VERSION);
    requireFact(projection.identity.version === input.runtimeVersion);
    requireFact(projection.identity.rawSource === rawSource && projection.identity.normalizedSource === coordinates.normalizedSource);
    requireFact(projection.identity.sourceIdentity === runtime.resolveMarkdownSourceIdentity(rawSource));
    requireFact(projection.nodes.length <= maxNodes && projection.diagnostics.length <= maxNodes);
    const stable = runtime.stabilizeMarkdownEditorProjection(projection, {
        id: documentId,
        epoch: documentEpoch,
    });
    requireFact(stable.nodes.length === projection.nodes.length);
    const sameRange = (left, right) => left.start === right.start && left.end === right.end;
    const contains = (outer, inner) => outer.start <= inner.start && outer.end >= inner.end;
    const range = (normalized) => {
        const raw = coordinates.toRawRange(normalized);
        requireFact(sameRange(coordinates.toNormalizedRange(raw), normalized));
        // Both UTF-8 and line/column conversions must return the original raw offsets.
        for (const offset of [raw.start, raw.end]) {
            requireFact(coordinates.toRawOffsetFromUtf8(coordinates.toRawUtf8Offset(offset)) === offset);
            requireFact(coordinates.toRawOffsetFromLineColumn(coordinates.toRawLineColumn(offset)) === offset);
        }
        return { start: raw.start, end: raw.end };
    };
    let canonical;
    if (searchPurpose) {
        // Transport the original public stable structures. No Search tokenizer,
        // reconstructed AST, heading scanner or relation-target admission is used.
        const verifyRanges = (rawRanges, normalizedRanges) => {
            requireFact(rawRanges.length === normalizedRanges.length && rawRanges.length <= maxNodes);
            rawRanges.forEach((raw, index) => requireFact(sameRange(raw, range(normalizedRanges[index]))));
        };
        for (const node of stable.nodes) {
            requireFact(sameRange(node.rawRange, range(node.normalizedRange)));
            requireFact((node.parentRawRange === null) === (node.parentNormalizedRange === null));
            if (node.parentRawRange !== null) requireFact(sameRange(node.parentRawRange, range(node.parentNormalizedRange)));
            verifyRanges(node.rawContentRanges, node.normalizedContentRanges);
            verifyRanges(node.rawMarkerRanges, node.normalizedMarkerRanges);
            verifyRanges(node.childRawRanges, node.childNormalizedRanges);
            if (node.table !== undefined) {
                requireFact(node.table.rows.length <= maxNodes && node.table.alignments.length <= maxNodes);
                for (const row of node.table.rows) {
                    requireFact(sameRange(row.rawRange, range(row.normalizedRange)));
                    verifyRanges(row.rawCellRanges, row.normalizedCellRanges);
                }
            }
        }
        for (const diagnostic of projection.diagnostics) {
            requireFact(sameRange(diagnostic.rawRange, range(diagnostic.normalizedRange)));
        }
        const outline = runtime.createMarkdownOutlineEntries(stable);
        requireFact(outline.length <= maxNodes && new Set(stable.nodes.map((node) => node.id)).size === stable.nodes.length);
        canonical = {
            schema: searchSchema,
            publicModule,
            publicEntryDigest: input.publicEntryDigest,
            wasmModuleDigest: compiledModules[0],
            parser: projection.identity.parser,
            version: projection.identity.version,
            sourceIdentity: projection.identity.sourceIdentity,
            sourceDigest: sha256(bytes),
            sourceUtf16Length: rawSource.length,
            normalizedUtf16Length: coordinates.normalizedSource.length,
            parseLifetimeId: stable.documentIdentity.id,
            heldSourceSequence: stable.documentIdentity.epoch,
            projectionNodeCount: projection.nodes.length,
            nodes: stable.nodes,
            diagnostics: projection.diagnostics,
            outline,
        };
    } else {
        const anchors = runtime.collectMarkdownAnchorNodes(coordinates.normalizedSource);
        const embeds = runtime.collectMarkdownEmbedNodes(coordinates.normalizedSource);
        requireFact(anchors.length <= maxNodes && embeds.length <= maxNodes);
        const literalNodes = stable.nodes.filter((node) => ['code', 'latex', 'mermaid'].includes(node.kind));
        const nodes = [];
        for (const node of stable.nodes) {
            requireFact(sameRange(range(node.normalizedRange), node.rawRange));
            if (!['link', 'anchor', 'embed'].includes(node.kind)) continue;
            requireFact(node.status === 'valid');
            // Conflicting public projections are unavailable, never repaired by scanning
            // source or silently turning literal text into a relation/embed dependency.
            requireFact(!literalNodes.some((literal) => contains(literal.normalizedRange, node.normalizedRange)));
            const projected = {
                nodeIdentity: node.id,
                blockIdentity: node.blockIdentity,
                kind: node.kind,
                rawRange: range(node.normalizedRange),
                linkSourceRange: null,
                normalizedRange: node.normalizedRange,
                parentRawRange: node.parentNormalizedRange === null ? null : range(node.parentNormalizedRange),
                rawContentRanges: node.normalizedContentRanges.map(range),
                targetUrl: null,
                anchorId: null,
                embedMode: null,
            };
            if (node.kind === 'link') {
                // A projection range may own a collapsed BOM/CRLF caret. Literal link
                // selection uses the public map's inward boundary affinities instead.
                projected.linkSourceRange = {
                    start: coordinates.toRawOffset(node.normalizedRange.start, { affinity: 'forward' }),
                    end: coordinates.toRawOffset(node.normalizedRange.end, { affinity: 'backward' }),
                };
                requireFact(sameRange(coordinates.toNormalizedRange(projected.linkSourceRange), node.normalizedRange));
                requireFact(contains(projected.rawRange, projected.linkSourceRange));
                for (const offset of [projected.linkSourceRange.start, projected.linkSourceRange.end]) {
                    requireFact(coordinates.toRawOffsetFromUtf8(coordinates.toRawUtf8Offset(offset)) === offset);
                    requireFact(coordinates.toRawOffsetFromLineColumn(coordinates.toRawLineColumn(offset)) === offset);
                }
                const target = node.normalizedContentRanges[1];
                // Parser-owned destination range only. URLs are candidates, never identities.
                projected.targetUrl = target === undefined ? null : coordinates.normalizedSource.slice(target.start, target.end);
            } else if (node.kind === 'anchor') {
                const matches = anchors.filter((anchor) => anchor.ok && contains(node.normalizedRange, anchor.ranges.full));
                requireFact(matches.length === 1);
                projected.anchorId = matches[0].id;
            } else {
                const matches = embeds.filter((embed) => embed.ok && contains(node.normalizedRange, embed.ranges.full));
                requireFact(matches.length === 1);
                projected.targetUrl = matches[0].target;
                projected.embedMode = matches[0].mode;
            }
            nodes.push(projected);
        }
        const diagnostics = projection.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            rawRange: range(diagnostic.normalizedRange),
        }));
        requireFact(new Set(nodes.map((node) => node.nodeIdentity)).size === nodes.length);
        canonical = {
            schema,
            publicModule,
            publicEntryDigest: input.publicEntryDigest,
            wasmModuleDigest: compiledModules[0],
            parser: projection.identity.parser,
            version: projection.identity.version,
            sourceIdentity: projection.identity.sourceIdentity,
            sourceDigest: sha256(bytes),
            sourceUtf16Length: rawSource.length,
            normalizedUtf16Length: coordinates.normalizedSource.length,
            documentId: stable.documentIdentity.id,
            documentEpoch: stable.documentIdentity.epoch,
            projectionNodeCount: projection.nodes.length,
            nodes,
            diagnostics,
        };
    }
    requireFact(sha256(await readFile(entry)) === input.publicEntryDigest);
    // getrusage maxRSS can retain the .NET parent's pre-exec high-water mark on
    // Linux. The parent monitor and this check use the actual Node address space.
    requireFact(process.memoryUsage().rss <= 256 * 1024 * 1024);
    // The authority operation receives only the original source/context, never the
    // producer's proposed identities. A new process reconstructs the entire tuple.
    const output = Buffer.from(JSON.stringify(operation === 'identity-closure' || operation === 'search-identity-closure'
        ? { schema: searchPurpose ? searchIdentityClosureSchema : identityClosureSchema, canonical }
        : canonical));
    requireFact(output.length <= maxOutputBytes);
    await new Promise((resolve, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve()));
} catch {
    process.stderr.write('canonical_article_relation_parse_refused\n');
    process.exitCode = 1;
}
