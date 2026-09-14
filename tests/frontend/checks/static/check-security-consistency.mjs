import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { analyzeHtmlSinks } = await import(new URL('../../../../tools/security/html-sink-ast.mjs', import.meta.url));

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const srcRoot = resolve(repoRoot, 'src/frontend/src');

const bannedRules = [
    {
        label: 'stale token localStorage fallback',
        regex: /localStorage\.getItem\(\s*['"]token['"]\s*\)/g
    },
    {
        label: 'DOMPurify mainline import',
        regex: /from\s+['"]dompurify['"]/g
    },
    {
        label: 'local Markdown or preview HTML sanitizer',
        regex: /\b(?:sanitizePreviewHtml|sanitizeMarkdownRuntimeHtml|sanitizeHtmlAllowlist|sanitizeHtmlFallback)\b/g
    }
];

const cspRuntimeStyleBoundary = 'services/cspStyleRuntime.ts';

const violations = [];

function walk(dir)
{
    const entries = readdirSync(dir);
    for (let i = 0; i < entries.length; i += 1)
    {
        const fullPath = join(dir, entries[i]);
        const stats = statSync(fullPath);
        if (stats.isDirectory())
        {
            walk(fullPath);
            continue;
        }

        if (!/\.(ts|vue|js|mjs)$/.test(fullPath))
        {
            continue;
        }

        const relativePath = relative(srcRoot, fullPath).replace(/\\/g, '/');
        const content = readFileSync(fullPath, 'utf8');

        for (let j = 0; j < bannedRules.length; j += 1)
        {
            const rule = bannedRules[j];
            if (rule.regex.test(content))
            {
                violations.push(`${relativePath}: forbidden ${rule.label}`);
            }
            rule.regex.lastIndex = 0;
        }

        for (const diagnostic of analyzeHtmlSinks(content, { filePath: relativePath }))
        {
            violations.push(
                `${relativePath}:${diagnostic.line}:${diagnostic.column}: forbidden HTML sink ${diagnostic.sink}`
            );
        }

        if (relativePath !== cspRuntimeStyleBoundary)
        {
            if (/(?:^|\s)(?::|v-bind:)?style\s*=/.test(content))
            {
                violations.push(`${relativePath}: CSP forbids HTML style attributes and Vue style bindings`);
            }
            if (/\b[A-Za-z_$][\w$]*\.style(?:\.|\[)/.test(content))
            {
                violations.push(`${relativePath}: CSP forbids direct element.style mutation`);
            }
            if (/\.setAttribute\(\s*['"]style['"]/.test(content))
            {
                violations.push(`${relativePath}: CSP forbids setAttribute style mutation`);
            }
            if (/\bstyle\s*:\s*(?:\{|\[)/.test(content))
            {
                violations.push(`${relativePath}: CSP forbids render-function style props`);
            }
        }

        if (relativePath.endsWith('.vue'))
        {
            for (const match of content.matchAll(/<el-input\b[^>]*\btype=["']textarea["'][^>]*>/gu))
            {
                if (!/\b:csp-safe=["']true["']|\bcsp-safe(?:\s|=|\/>)/u.test(match[0]))
                {
                    violations.push(`${relativePath}: ElInput textarea must enable csp-safe under style-src-attr 'none'`);
                }
            }
        }
    }
}

walk(srcRoot);

if (existsSync(resolve(srcRoot, 'fsusui/markdownContract.ts')))
{
    violations.push('fsusui/markdownContract.ts: Markdown safe-result authority must remain owned by FsusUI');
}

function readRepoFile(path)
{
    return readFileSync(resolve(repoRoot, path), 'utf8');
}

function requireContains(file, needle, message)
{
    const content = readRepoFile(file);
    if (!content.includes(needle))
    {
        violations.push(`${file}: ${message}`);
    }
}

function requireNotContains(file, needle, message)
{
    const content = readRepoFile(file);
    if (content.includes(needle))
    {
        violations.push(`${file}: ${message}`);
    }
}

const privatePreview = readRepoFile('src/frontend/src/components/admin/article/ArticlePrivatePreviewPanel.vue');
for (const forbidden of ['<iframe', 'srcdoc', '<!doctype', 'sanitizePreviewHtml', 'toTrustedSanitizedHtml'])
{
    if (privatePreview.toLowerCase().includes(forbidden.toLowerCase()))
    {
        violations.push(`src/frontend/src/components/admin/article/ArticlePrivatePreviewPanel.vue: structured preview must not contain ${forbidden}`);
    }
}
for (const required of [
    ':src="preview.normalizedCoverImageUrl"',
    '{{ preview.normalizedTitle }}',
    '{{ preview.normalizedSummary }}',
    ':content="preview.normalizedMarkdownSource"',
    'normalizePreviewCoverImageUrl'
])
{
    if (!privatePreview.includes(required))
    {
        violations.push(`src/frontend/src/components/admin/article/ArticlePrivatePreviewPanel.vue: structured preview must include ${required}`);
    }
}

const previewDto = /public sealed record class ArticlePreviewResponse\(([\s\S]*?)\)\s*;/.exec(
    readRepoFile('src/backend/Models/Dtos/AuthoringDtos.cs')
);
if (!previewDto)
{
    violations.push('src/backend/Models/Dtos/AuthoringDtos.cs: ArticlePreviewResponse record is missing');
}
else if (/\bHtml\b/i.test(previewDto[1]))
{
    violations.push('src/backend/Models/Dtos/AuthoringDtos.cs: ArticlePreviewResponse must not contain an Html field');
}

const previewTs = /export interface ArticlePreviewResponse \{([\s\S]*?)\n\}/.exec(
    readRepoFile('src/frontend/src/api/authoring.ts')
);
if (!previewTs)
{
    violations.push('src/frontend/src/api/authoring.ts: ArticlePreviewResponse interface is missing');
}
else if (/\bhtml\b/i.test(previewTs[1]))
{
    violations.push('src/frontend/src/api/authoring.ts: ArticlePreviewResponse must not contain an html field');
}

const previewLifecycle = readRepoFile('src/backend/Services/Authoring/AuthoringDraftLifecycleService.cs');
const previewMethod = /public Task<ArticlePreviewResponse> PreviewAsync\([\s\S]*?\n {4}\}/.exec(previewLifecycle)?.[0]
    ?? '';
if (!previewMethod)
{
    violations.push('src/backend/Services/Authoring/AuthoringDraftLifecycleService.cs: PreviewAsync is missing');
}
for (const forbidden of ['RenderPreviewMarkdown', '<!doctype', 'srcdoc', 'HtmlEncode', '<article>', '<h1>', '<figure>'])
{
    if (previewLifecycle.includes(forbidden) || previewMethod.includes(forbidden))
    {
        violations.push(`src/backend/Services/Authoring/AuthoringDraftLifecycleService.cs: preview path must not contain ${forbidden}`);
    }
}
requireContains(
    'src/frontend/src/api/authoring.ts',
    'article_preview_html_field_forbidden',
    'private preview decoder must fail closed on leftover html fields'
);
requireContains(
    'src/frontend/src/components/admin/article/ArticleBodyMarkdownPreview.vue',
    'mode="preview"',
    'private preview markdown must use FsusUI MarkdownRenderer mode=preview'
);

const localFixtureSession = readRepoFile('src/frontend/src/services/localFixtureSession.ts');
for (const token of ['import.meta.env.MODE', 'import.meta.env.PROD', 'isLocalFixtureHost'])
{
    if (!localFixtureSession.includes(token))
    {
        violations.push(`src/frontend/src/services/localFixtureSession.ts: local fixture gate must include ${token}`);
    }
}

const binaryClient = readRepoFile('src/frontend/src/api/binaryApiClient.ts');
const binaryContracts = readRepoFile('src/frontend/src/api/contracts.ts');
if (!binaryClient.includes('FSUS_HEADERS.csrfToken') || !binaryClient.includes('readCsrfToken') || !binaryContracts.includes("csrfToken: 'X-Fsus-Csrf-Token'"))
{
    violations.push('src/frontend/src/api/binaryApiClient.ts: credentialed mutation requests must attach X-Fsus-Csrf-Token when available');
}

const adminArticleWrite = readRepoFile('src/frontend/src/composables/useAdminArticleWrite.ts');
if (/localStorage\.setItem\(key,\s*encodePublicAotPayload\(snapshot\)\)/.test(adminArticleWrite))
{
    violations.push('src/frontend/src/composables/useAdminArticleWrite.ts: article draft body must not be persisted to localStorage');
}

const challengeProofStore = readRepoFile('src/frontend/src/security/challenge-proof-store.ts');
for (const forbidden of ['localStorage', 'sessionStorage', 'BroadcastChannel', 'URLSearchParams', 'console.'])
{
    if (challengeProofStore.includes(forbidden))
    {
        violations.push(`src/frontend/src/security/challenge-proof-store.ts: proof storage must stay memory-only and telemetry-free; found ${forbidden}`);
    }
}

const openResty = readRepoFile('ops/gateway/production-openresty.conf');
for (const header of ['Content-Security-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy', 'Cross-Origin-Resource-Policy'])
{
    if (!openResty.includes(header))
    {
        violations.push(`ops/gateway/production-openresty.conf: missing ${header} response header`);
    }
}
for (const token of ["require-trusted-types-for 'script'", 'trusted-types vue fsusblog fsusblog-spa-entry fsusui-markdown-feature;'])
{
    if (!openResty.includes(token))
    {
        violations.push(`ops/gateway/production-openresty.conf: production CSP must include ${token}`);
    }
}
if (/trusted-types\s+(?:\*|default)|allow-duplicates/.test(openResty))
{
    violations.push('ops/gateway/production-openresty.conf: Trusted Types CSP must not allow wildcard, default, or duplicate policies');
}

const viteConfig = readRepoFile('src/frontend/vite.config.ts');
for (const token of ['Content-Security-Policy', "default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "style-src-attr 'none'", 'report-uri /api/security/csp-report'])
{
    if (!viteConfig.includes(token))
    {
        violations.push(`src/frontend/vite.config.ts: preview security headers must include ${token}`);
    }
}
if (viteConfig.includes("style-src-attr 'unsafe-inline'"))
{
    violations.push("src/frontend/vite.config.ts: preview CSP must not allow inline style attributes");
}
if (viteConfig.includes("require-trusted-types-for 'script'") || viteConfig.includes('trusted-types vue fsusblog'))
{
    violations.push('src/frontend/vite.config.ts: development and preview CSP must preserve HMR by leaving Trusted Types enforcement disabled');
}

const composition = readRepoFile('src/backend/Infrastructure/Bootstrap/PublicWebRuntime.cs');
const staticCspSource = composition.slice(
    composition.indexOf('internal static string BuildStaticCsp'),
    composition.indexOf('internal static string BuildHtmlCsp')
);
for (const token of ["style-src-attr 'none'", 'report-uri /api/security/csp-report'])
{
    if (!staticCspSource.includes(token))
    {
        violations.push(`src/backend/Infrastructure/Bootstrap/PublicWebRuntime.cs: static CSP must include ${token}`);
    }
}
if (staticCspSource.includes('wasm-unsafe-eval') || staticCspSource.includes("style-src-attr 'unsafe-inline'"))
{
    violations.push('src/backend/Infrastructure/Bootstrap/PublicWebRuntime.cs: non-HTML CSP must deny Wasm compilation and inline style attributes');
}
for (const token of ["require-trusted-types-for 'script'", 'trusted-types vue fsusblog fsusblog-spa-entry fsusui-markdown-feature;'])
{
    if (!composition.includes(token))
    {
        violations.push(`src/backend/Infrastructure/Bootstrap/PublicWebRuntime.cs: production CSP must include ${token}`);
    }
}
if (/trusted-types\s+(?:\*|default)|allow-duplicates/.test(composition))
{
    violations.push('src/backend/Infrastructure/Bootstrap/PublicWebRuntime.cs: Trusted Types CSP must not allow wildcard, default, or duplicate policies');
}

const trustedTypesRuntime = readRepoFile('src/frontend/src/security/trustedTypesRuntime.ts');
for (const token of [
    "const APP_POLICY_NAME = 'fsusblog'",
    "const COMMENT_PRIVACY_PROVER_MODULE_PATH = '/wasm/comment-privacy-prover.js'",
    'const MARKDOWN_RENDERER_WORKER_PATH =',
    'const APPLICATION_WORKER_PATH =',
    "const SERVICE_WORKER_MODULE_PATH = '/sw.js'",
    'toTrustedMarkdownHtml',
    'setNonExecutableScriptText',
    'setCommentPrivacyProverScriptUrl',
    'toTrustedMarkdownWorkerScriptUrl',
    'toTrustedApplicationWorkerScriptUrl',
    'toTrustedServiceWorkerScriptUrl'
])
{
    if (!trustedTypesRuntime.includes(token))
    {
        violations.push(`src/frontend/src/security/trustedTypesRuntime.ts: audited Trusted Types boundary must include ${token}`);
    }
}
if (/createPolicy\(\s*['"](?:default|\*)['"]|allow-duplicates/.test(trustedTypesRuntime))
{
    violations.push('src/frontend/src/security/trustedTypesRuntime.ts: policy must not use default, wildcard, or duplicate escape hatches');
}
for (const forbidden of [
    'FeatureRenderOutput',
    'MarkdownFeatureOutputForTrustedParsing',
    'MARKDOWN_FEATURE_OUTPUT_KINDS',
    'toTrustedMarkdownFeatureHtml',
    'fsusui-markdown-feature'
])
{
    if (trustedTypesRuntime.includes(forbidden))
    {
        violations.push(`src/frontend/src/security/trustedTypesRuntime.ts: FsusBlog must not convert feature-output strings to TrustedHTML via ${forbidden}`);
    }
}
for (const forbidden of [
    'bindMarkdownFeatureTrustedTypes',
    'bind-markdown-feature-trusted-types',
    'toTrustedMarkdownFeatureHtml'
])
{
    if (viteConfig.includes(forbidden))
    {
        violations.push(`src/frontend/vite.config.ts: FsusUI feature-output gateway must not be rewritten through ${forbidden}`);
    }
}
const publicBlogLayoutShell = readRepoFile('src/frontend/src/components/public/PublicBlogLayoutShell.vue');
if ((publicBlogLayoutShell.match(/fsusblog-public-shell-runtime/gu) ?? []).length !== 1)
{
    violations.push('src/frontend/src/components/public/PublicBlogLayoutShell.vue: runtime geometry variables must have one cascade owner');
}
requireContains(
    'src/frontend/src/components/public/PublicBlogLayoutShell.vue',
    "v-bind=\"{ 'data-public-sticky-geometry-owner': '' }\"",
    'public shell must expose one explicit runtime geometry owner below library fallback variables'
);
requireContains(
    'src/frontend/src/privacy/commentPrivacyWasmProver.ts',
    'setCommentPrivacyProverScriptUrl(script, moduleUrl)',
    'privacy prover module must use the exact-path TrustedScriptURL wrapper'
);
requireNotContains(
    'src/frontend/src/privacy/commentPrivacyWasmProver.ts',
    'script.src =',
    'privacy prover must not assign raw strings to script.src'
);
requireContains(
    'src/frontend/src/components/ui/MarkdownRenderer.vue',
    ':trusted-script-url-factory="toTrustedMarkdownWorkerScriptUrl"',
    'Markdown worker must use the hashed-asset TrustedScriptURL wrapper'
);
requireNotContains(
    'src/frontend/src/public-renderers/publicHydrationRoot.ts',
    "from '@/public-renderers/publicEntryCore'",
    'client hydration must not pull the server/AOT core into its bundle closure'
);
requireContains(
    'src/frontend/src/services/serviceWorkerRuntime.ts',
    'serviceWorker.register(toTrustedServiceWorkerScriptUrl(',
    'service worker registration must use the exact-path TrustedScriptURL wrapper'
);
for (const workerRuntime of [
    'src/frontend/src/services/binaryTransport.ts',
    'src/frontend/src/composables/usePow.ts',
    'src/frontend/src/services/securityPoSpaceClient.ts',
    'src/frontend/src/services/securityPerceptionV2Client.ts',
    'src/frontend/src/privacy/commentPrivacyWorkerClient.ts'
])
{
    requireContains(
        workerRuntime,
        'toTrustedApplicationWorkerScriptUrl(',
        'application Worker must use the named hashed-asset TrustedScriptURL wrapper'
    );
    requireNotContains(
        workerRuntime,
        'new Worker(new URL(',
        'application Worker must not receive a raw URL'
    );
    requireContains(
        workerRuntime,
        '?worker&url',
        'application Worker must use a Vite-emitted JavaScript asset URL before Trusted Types wrapping'
    );
}
requireNotContains(
    'src/frontend/src/router/index.ts',
    "import('nprogress')",
    'strict-CSP navigation must not load the innerHTML/style-mutating NProgress runtime'
);
requireContains(
    'src/frontend/src/services/navigationProgress.ts',
    "document.createElement('div')",
    'navigation progress must build its fixed DOM without innerHTML'
);
requireContains(
    'src/frontend/vite.config.ts',
    'modulePreload: false',
    'Vite runtime modulepreload injection must stay disabled under production Trusted Types'
);

requireContains(
    'src/backend/Modules/Endpoints/CspReportEndpoints.cs',
    'internal const string ReportPath = "/api/security/csp-report"',
    'CSP report collector route must remain available'
);

const routerSource = readRepoFile('src/frontend/src/router/index.ts');
for (const pattern of [/\bmeta\b[^\n]*\broles\b/u, /to[.]meta[.]roles/u, /meta:\s*\{\s*roles:/u])
{
    if (pattern.test(routerSource))
    {
        violations.push(`src/frontend/src/router/index.ts: route authorization must not restore legacy role metadata ${pattern}`);
    }
}

for (const forbidden of [
    'sanitizePreviewHtml',
    'sanitizeMarkdownRuntimeHtml',
    'sanitizeHtmlAllowlist',
    'sanitizeHtmlFallback',
    'toTrustedSanitizedHtml',
    'setSanitizedTemplateHtml',
    'initialHtml',
    'initial-html',
    'allowHtml',
    'allow-html'
])
{
    for (const sourceFile of [
        'src/frontend/src/fsusui/markdown.ts',
        'src/frontend/src/components/ui/MarkdownRenderer.vue',
        'src/frontend/src/public-renderers/publicEntryCore.ts'
    ])
    {
        requireNotContains(sourceFile, forbidden, `Markdown safety boundary must not contain legacy ${forbidden}`);
    }
}
requireContains(
    'src/frontend/src/fsusui/markdown.ts',
    'return result',
    'Markdown runtime wrapper must preserve the FsusUI result object'
);
requireContains(
    'src/frontend/src/fsusui/markdown.ts',
    "from '@ozwasyd/element-plus/markdown-runtime'",
    'Markdown safe types must come directly from FsusUI'
);
requireNotContains(
    'src/frontend/src/fsusui/markdown.ts',
    "from '@/fsusui/markdownContract'",
    'Markdown safe types must not come from a Blog-local duplicate contract'
);
requireContains(
    'src/frontend/src/components/ui/MarkdownRenderer.vue',
    ':initial-render="props.initialRender"',
    'Markdown renderer must accept only the FsusUI safe initial result'
);
requireContains(
    'src/frontend/src/components/ui/MarkdownRenderer.vue',
    ':trusted-html-factory="toTrustedMarkdownHtml"',
    'Markdown renderer must pass the opaque FsusUI HTML brand to the host policy'
);
requireNotContains(
    'src/frontend/eslint.config.mjs',
    'export default []',
    'eslint config must not be empty for security-sensitive frontend code'
);

if (violations.length > 0)
{
    console.error('[check-security-consistency] failed');
    for (let i = 0; i < violations.length; i += 1)
    {
        console.error(`- ${violations[i]}`);
    }
    process.exit(1);
}

console.log('[check-security-consistency] ok');
