import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatPropertyReadTypeScript } from './format-generated-property-value-read-typescript.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const specText = read('tools/contracts/article-inbox-capture-wire-source.json');
const spec = JSON.parse(specText);
if (spec.schemaVersion !== 1 || spec.family !== 'article-inbox-capture'
    || spec.nativeErrorName !== 'ArticleInboxCapturePayloadInvalid'
    || spec.nativeErrorReason !== 'article_inbox_capture_payload_invalid'
    || spec.maxRequestPayloadBytes !== 801568 || spec.maxResponsePayloadBytes !== 882
    || JSON.stringify(Object.keys(spec.roots)) !== JSON.stringify([
        'ArticleInboxCaptureCreateRequest', 'ArticleInboxCaptureReconcileRequest', 'ArticleInboxCaptureResponse'
    ])) throw new Error('capture source specification drift');
const owner = read(spec.contractSource);
for (const [name, fields] of Object.entries(spec.records)) {
    const actual = owner.match(new RegExp(String.raw`public sealed record ${name}\(([\s\S]*?)\);`));
    if (!actual || JSON.stringify(actual[1].split(',').map(field => field.trim())) !== JSON.stringify(fields))
        throw new Error(`capture contract drift:${name}`);
}
for (const [name, value] of Object.entries({ SchemaVersion: 1, MaxSiteScopeCharacters: 128, MaxSiteScopeBytes: 512,
    MaxTitleBytes: 1024, MaxMarkdownBytes: 800000, MaxRequestPayloadBytes: 801568, MaxResponsePayloadBytes: 882 })) {
    const literal = owner.match(new RegExp(`public const int ${name} = ([0-9_]+);`));
    if (!literal || Number(literal[1].replaceAll('_', '')) !== value) throw new Error(`capture bound drift:${name}`);
}
// Canonical central registration is mandatory. Never allocate IDs or emit an unregistered family here.
const protocol = JSON.parse(read('src/shared/Contracts/Validation/aeds-protocol.json'));
const frames = Object.keys(spec.roots).map(name => {
    const entry = protocol.frameTypes.find(frame => frame.name === name);
    if (!entry || entry.goldenFamily !== spec.family || !Number.isInteger(entry.value) || entry.value < 1 || entry.value > 65535)
        throw new Error(`capture central registration missing:${name}`);
    return entry.value;
});
if (new Set(frames).size !== 3) throw new Error('capture frame collision');
const nativeHeader = read('src/frontend/wasm/aeds/include/aeds_decode.hpp');
const nativeErrorEnum = bracedBody(nativeTokens(nativeHeader),
    'enum class ErrorCode : std::uint8_t {').join(' ');
const nativeRegistration = nativeErrorEnum.match(new RegExp(String.raw`\b${spec.nativeErrorName}\s*=\s*([0-9]+)`));
if (!nativeRegistration || Number(nativeRegistration[1]) < 1 || Number(nativeRegistration[1]) > 255)
    throw new Error('capture native error registration missing');
const errorValues = [...nativeErrorEnum.matchAll(/\b[A-Za-z][A-Za-z0-9_]*\s*=\s*([0-9]+)/gu)]
    .filter(match => Number(match[1]) === Number(nativeRegistration[1]));
if (errorValues.length !== 1) throw new Error('capture native error value collision');
const nativeDispatcher = read('src/frontend/wasm/aeds/src/aeds_decode.cpp');
requireNativeCaptureDispatch(nativeDispatcher, frames, spec.nativeErrorName, spec.nativeErrorReason);

// Check the original DecodeFrame execution branch, not text in comments, other
// functions or the reason table. This is bounded source admission, not native qualification.
function nativeTokens(source) {
    const result = [];
    const token = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|::|&&|\|\||==|!=|<=|>=|./gy;
    while (token.lastIndex < source.length) {
        const start = token.lastIndex;
        const match = token.exec(source);
        if (!match || token.lastIndex <= start) throw new Error('capture native source tokenization failed');
        const text = match[0];
        if (text === '"' || text === "'" || text === '/' && source.startsWith('/*', start))
            throw new Error('capture native source contains an unterminated literal or comment');
        if (/^\s|^\/\//u.test(text) || text.startsWith('/*')) continue;
        result.push(text);
    }
    return result;
}

function sameTokens(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function balancedEnd(tokens, start, open, close) {
    if (tokens[start] !== open) throw new Error('capture native source boundary missing');
    let depth = 0;
    for (let index = start; index < tokens.length; index++) {
        if (tokens[index] === open) depth++;
        if (tokens[index] === close && --depth === 0) return index;
    }
    throw new Error('capture native source boundary incomplete');
}

function bracedBody(tokens, signature) {
    const expected = nativeTokens(signature);
    const matches = [];
    for (let index = 0; index <= tokens.length - expected.length; index++) {
        if (sameTokens(tokens.slice(index, index + expected.length), expected)) matches.push(index);
    }
    if (matches.length !== 1) throw new Error('capture native original declaration is missing or ambiguous');
    const start = matches[0] + expected.length - 1;
    return tokens.slice(start + 1, balancedEnd(tokens, start, '{', '}'));
}

function requireNativeCaptureDispatch(source, frameValues, errorName, errorReason) {
    const tokens = nativeTokens(source);
    // Conditional/macro text cannot stand in for the active original dispatch branch.
    for (let index = 0; index < tokens.length; index++) {
        if (tokens[index] === '#' && tokens[index + 1] !== 'include')
            throw new Error('capture native conditional or macro dispatch is not admitted');
    }
    const captureHeader = nativeTokens('#include "article_inbox_capture_wire.generated.hpp"');
    if (!tokens.some((_, index) => sameTokens(tokens.slice(index, index + captureHeader.length), captureHeader)))
        throw new Error('capture native generated validator include missing');
    const body = bracedBody(tokens,
        'DecodeResult DecodeFrame(const std::uint8_t* frame, std::size_t frameLen) {');
    const condition = nativeTokens(`(FrameType == ${frameValues[0]} || FrameType == ${frameValues[1]} || FrameType == ${frameValues[2]})
        && !ValidateArticleInboxCapturePayload(FrameType, payload, PayloadLength)`);
    const refusal = nativeTokens(`return MakeError(ErrorCode::${errorName});`);
    let depth = 0;
    let captureIndex = -1;
    const successIndexes = [];
    for (let index = 0; index < body.length; index++) {
        if (depth === 0) {
            if (sameTokens(body.slice(index, index + 5), ['DecodeResult', 'ok', '{', '}', ';'])) successIndexes.push(index);
            if (body[index] === 'if' && body[index + 1] === '(') {
                const end = balancedEnd(body, index + 1, '(', ')');
                if (sameTokens(body.slice(index + 2, end), condition)) {
                    if (captureIndex !== -1 || body[end + 1] !== '{')
                        throw new Error('capture native validator branch is ambiguous');
                    const blockEnd = balancedEnd(body, end + 1, '{', '}');
                    if (!sameTokens(body.slice(end + 2, blockEnd), refusal))
                        throw new Error('capture native validator refusal is not the original error return');
                    captureIndex = index;
                }
            }
        }
        if (body[index] === '{') depth++;
        if (body[index] === '}') depth--;
    }
    if (captureIndex < 0 || successIndexes.length !== 1 || successIndexes[0] <= captureIndex
        || body.filter(token => token === 'ValidateArticleInboxCapturePayload').length !== 1)
        throw new Error('capture native DecodeFrame validator call is missing, redirected or after success');
    for (const declaration of [
        'const std::uint16_t FrameType = ReadU16Le(frame + 8);',
        'const std::uint32_t PayloadLength = ReadU32Le(frame + 10);',
        'const std::uint8_t* payload = frame + kHeaderSize;'
    ]) {
        const expected = nativeTokens(declaration);
        const positions = [];
        for (let index = 0; index < body.length; index++) {
            if (sameTokens(body.slice(index, index + expected.length), expected)) positions.push(index);
        }
        if (positions.length !== 1 || positions[0] >= captureIndex)
            throw new Error('capture native validator is not bound to the original frame/payload coordinates');
    }
    for (let index = 0; index < captureIndex; index++) {
        if (body[index] !== 'return') continue;
        const prefix = nativeTokens('return MakeError(ErrorCode::');
        if (!sameTokens(body.slice(index, index + prefix.length), prefix)
            || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(body[index + prefix.length] ?? '')
            || !sameTokens(body.slice(index + prefix.length + 1, index + prefix.length + 3), [')', ';']))
            throw new Error('capture native success or redirected return precedes validator admission');
    }

    const errorBody = bracedBody(tokens, 'const char* ToErrorString(ErrorCode errorCode) {');
    const switchHead = nativeTokens('switch (errorCode) {');
    if (!sameTokens(errorBody.slice(0, switchHead.length), switchHead)
        || balancedEnd(errorBody, switchHead.length - 1, '{', '}') !== errorBody.length - 1)
        throw new Error('capture native original error switch changed');
    const errorCase = nativeTokens(`case ErrorCode::${errorName}: return ${JSON.stringify(errorReason)};`);
    const cases = [];
    depth = 0;
    for (let index = 0; index < errorBody.length; index++) {
        if (depth === 1 && sameTokens(errorBody.slice(index, index + errorCase.length), errorCase)) cases.push(index);
        if (errorBody[index] === '{') depth++;
        if (errorBody[index] === '}') depth--;
    }
    if (cases.length !== 1) throw new Error('capture native error reason is not the original active switch case');
}
const header = `// <auto-generated by tools/contracts/generate-article-inbox-capture-wire.mjs>\n// Shared owner/spec SHA256 ${createHash('sha256').update(owner + specText).digest('hex')}; Int64 stays lossless.\n`;
const outputs = [
    ['cs', 'src/core/Cache/PodBinaryCodec.ArticleInboxCapture.Generated.cs'],
    ['ts', 'src/frontend/src/codecs/binary/articleInboxCaptureWire.generated.ts'],
    ['hpp', 'src/frontend/wasm/aeds/include/article_inbox_capture_wire.generated.hpp'],
    ['routes', 'src/backend/Modules/Endpoints/ArticleInboxCaptureEndpoints.Generated.cs']
];
for (const [extension, output] of outputs) {
    let source = read(`tools/contracts/article-inbox-capture-wire-templates/${extension === 'routes' ? 'routes.cs' : `wire.${extension}`}.inc`);
    source = source.replaceAll('@CAPTURE_CREATE_FRAME@', String(frames[0]))
        .replaceAll('@CAPTURE_RECONCILE_FRAME@', String(frames[1])).replaceAll('@CAPTURE_RESPONSE_FRAME@', String(frames[2]));
    let content = header + source;
    if (extension === 'ts') content = await formatPropertyReadTypeScript(content, root, output);
    if (process.argv.includes('--check')) {
        if (read(output) !== content) { process.stderr.write(`stale:${output}\n`); process.exitCode = 1; }
    } else writeFileSync(path.join(root, output), content);
}
