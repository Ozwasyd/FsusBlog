import type { MarkdownSafeHtml } from '@/fsusui/markdown';
import { isCanonicalReleaseId } from '@/generated/releaseIdContract';

interface TrustedTypePolicyRules {
    createHTML?: (value: string) => string;
    createScript?: (value: string) => string;
    createScriptURL?: (value: string) => string;
}

interface TrustedTypePolicyLike {
    createHTML(value: string): unknown;
    createScript(value: string): unknown;
    createScriptURL(value: string): unknown;
}

interface TrustedTypePolicyFactoryLike {
    createPolicy(name: string, rules: TrustedTypePolicyRules): TrustedTypePolicyLike;
}

const APP_POLICY_NAME = 'fsusblog';
const COMMENT_PRIVACY_PROVER_MODULE_PATH = '/wasm/comment-privacy-prover.js';
const MARKDOWN_RENDERER_WORKER_PATH = /^\/assets\/markdown-renderer\.worker-[A-Za-z0-9_-]+\.js$/u;
const APPLICATION_WORKER_PATH = /^\/assets\/(?:commentPrivacy|perception-v2|pospace|pow|wasmDecode)\.worker-[A-Za-z0-9_-]+\.js$/u;
const APPLICATION_WORKER_DEV_SOURCE_PATH = /^\/src\/workers\/(?:(?:pow|wasmDecode)\.worker|security\/(?:perception-v2|pospace)\.worker|privacy\/commentPrivacy\.worker)\.ts$/u;
const SERVICE_WORKER_MODULE_PATH = '/sw.js';
const IMMUTABLE_BUILD_ID = /^\d{14}-[0-9a-f]{12}$/u;
const MUTABLE_BUILD_IDS = new Set(['latest', 'current', 'development']);
const NON_EXECUTABLE_SCRIPT_TYPES = new Set([
    'application/json',
    'application/ld+json',
    'application/octet-stream'
]);
let appPolicy: TrustedTypePolicyLike | null = null;
let policyCreationAttempted = false;

export function toTrustedMarkdownHtml(safeHtml: MarkdownSafeHtml): object
{
    const policy = getAppPolicy();
    return (policy?.createHTML(safeHtml) ?? safeHtml);
}

export function setNonExecutableScriptText(script: HTMLScriptElement, value: string): void
{
    const scriptType = script.type.trim().toLowerCase();
    if (!NON_EXECUTABLE_SCRIPT_TYPES.has(scriptType))
    {
        throw new Error('trusted_types_executable_script_text_rejected');
    }
    const policy = getAppPolicy();
    script.textContent = (policy?.createScript(value) ?? value) as string;
}

export function setCommentPrivacyProverScriptUrl(script: HTMLScriptElement, moduleUrl: string): void
{
    const resolved = resolveCommentPrivacyProverModuleUrl(moduleUrl);
    const policy = getAppPolicy();
    script.src = (policy?.createScriptURL(resolved) ?? resolved) as string;
}

export function resolveCommentPrivacyProverModuleUrl(moduleUrl: string): string
{
    const resolved = resolveApplicationUrl(moduleUrl, 'comment_privacy_prover_artifact_invalid');
    if (resolved.pathname !== COMMENT_PRIVACY_PROVER_MODULE_PATH || resolved.search || resolved.hash)
    {
        throw new Error('comment_privacy_prover_artifact_invalid');
    }
    return resolved.href;
}

export function toTrustedMarkdownWorkerScriptUrl(moduleUrl: URL | string): unknown
{
    const resolved = resolveApplicationUrl(
        String(moduleUrl),
        'markdown_renderer_worker_artifact_invalid'
    );
    if (!MARKDOWN_RENDERER_WORKER_PATH.test(resolved.pathname) || resolved.search || resolved.hash)
    {
        throw new Error('markdown_renderer_worker_artifact_invalid');
    }
    const policy = getAppPolicy();
    return policy?.createScriptURL(resolved.href) ?? resolved.href;
}

export function toTrustedApplicationWorkerScriptUrl(moduleUrl: URL | string): unknown
{
    const resolved = resolveApplicationUrl(
        String(moduleUrl),
        'application_worker_artifact_invalid'
    );
    const isProductionAsset = APPLICATION_WORKER_PATH.test(resolved.pathname);
    const isDevelopmentSource = import.meta.env.DEV
    && APPLICATION_WORKER_DEV_SOURCE_PATH.test(resolved.pathname);
    if ((!isProductionAsset && !isDevelopmentSource)
    || isProductionAsset && resolved.search
    || resolved.hash)
    {
        throw new Error('application_worker_artifact_invalid');
    }
    const policy = getAppPolicy();
    return policy?.createScriptURL(resolved.href) ?? resolved.href;
}

export function toTrustedServiceWorkerScriptUrl(moduleUrl: string): unknown
{
    const resolved = resolveApplicationUrl(
        moduleUrl,
        'service_worker_artifact_invalid'
    );
    const buildIds = resolved.searchParams.getAll('build');
    const buildId = buildIds[0] ?? '';
    const hasValidBuildId = buildIds.length === 0
    || buildIds.length === 1
      && IMMUTABLE_BUILD_ID.test(buildId)
      && isCanonicalReleaseId(buildId)
      && !MUTABLE_BUILD_IDS.has(buildId);
    if (resolved.pathname !== SERVICE_WORKER_MODULE_PATH
    || resolved.hash
    || [...resolved.searchParams.keys()].some(key => key !== 'build')
    || !hasValidBuildId)
    {
        throw new Error('service_worker_artifact_invalid');
    }
    const policy = getAppPolicy();
    return policy?.createScriptURL(resolved.href) ?? resolved.href;
}

export function resetTrustedTypesRuntimeForTests(): void
{
    appPolicy = null;
    policyCreationAttempted = false;
}

function getAppPolicy(): TrustedTypePolicyLike | null
{
    if (policyCreationAttempted)
    {
        return appPolicy;
    }
    policyCreationAttempted = true;
    const factory = (globalThis as typeof globalThis & {
        trustedTypes?: TrustedTypePolicyFactoryLike;
    }).trustedTypes;
    if (!factory || typeof factory.createPolicy !== 'function')
    {
        return null;
    }
    try
    {
        appPolicy = factory.createPolicy(APP_POLICY_NAME, {
            createHTML: value => value,
            createScript: value => value,
            createScriptURL: value => value
        });
    }
    catch
    {
        appPolicy = null;
    }
    return appPolicy;
}

function resolveApplicationUrl(value: string, invalidArtifactError: string): URL
{
    const raw = value.trim();
    if (!raw)
    {
        throw new Error(invalidArtifactError);
    }
    const runtimeLocation = typeof globalThis.location === 'undefined' ? null : globalThis.location;
    const baseHref = runtimeLocation?.href ?? 'http://localhost/';
    let resolved: URL;
    try
    {
        resolved = new URL(raw, baseHref);
    }
    catch
    {
        throw new Error(invalidArtifactError);
    }
    const expectedOrigin = runtimeLocation?.origin ?? new URL(baseHref).origin;
    if (resolved.origin !== expectedOrigin || resolved.username || resolved.password)
    {
        throw new Error(invalidArtifactError);
    }
    return resolved;
}
