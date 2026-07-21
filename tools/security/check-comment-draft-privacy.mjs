#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');
const COMPOSER_FILE = 'src/frontend/src/components/article/ArticleCommentComposer.vue';
const STORAGE_FILE = 'src/frontend/src/privacy/commentPublicDraftStorage.ts';
const REGISTRY_FILE = 'src/frontend/src/services/privateStorageRegistry.ts';

export function validateCommentDraftPrivacy(root = DEFAULT_ROOT)
{
    const sources = {
        [COMPOSER_FILE]: readFileSync(path.join(root, COMPOSER_FILE), 'utf8'),
        [STORAGE_FILE]: readFileSync(path.join(root, STORAGE_FILE), 'utf8'),
        [REGISTRY_FILE]: readFileSync(path.join(root, REGISTRY_FILE), 'utf8')
    };
    const frontendSources = readFrontendSources(path.join(root, 'src/frontend/src'));
    return { ...validateCommentDraftPrivacySources(sources, frontendSources), sources };
}

export function validateCommentDraftPrivacySources(sources, frontendSources = {})
{
    const errors = [];
    const composer = sources[COMPOSER_FILE] ?? '';
    const storage = sources[STORAGE_FILE] ?? '';
    const registry = sources[REGISTRY_FILE] ?? '';

    if (/(?:localStorage|sessionStorage)\s*\.\s*setItem|indexedDB\s*\.\s*open|caches\s*\.\s*open/u.test(composer))
    {
        errors.push(`${COMPOSER_FILE}: composer must not own a persistent browser-storage sink`);
    }
    for (const token of [
        'writeCommentPublicDraft',
        "authorModeModel.value !== 'public'",
        'draftNeedsReview.value',
        "registerCommentPrivacyCredentialPurgeHandler(handleDraftPrivacyPurge)",
        "handleDraftPrivacyPurge('feature-disabled')"
    ])
    {
        if (!composer.includes(token))
        {
            errors.push(`${COMPOSER_FILE}: missing ${token}`);
        }
    }

    for (const forbidden of ['accountId', 'authorMode', 'publicSendConfirmed', 'zk_anonymous'])
    {
        if (storage.includes(forbidden))
        {
            errors.push(`${STORAGE_FILE}: persisted public draft boundary must not contain ${forbidden}`);
        }
    }
    for (const token of [
        "COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX = 'fsus:comment-public-draft:v2:'",
        "LEGACY_COMMENT_DRAFT_STORAGE_PREFIX = 'fsus:comment-draft:v1:'",
        'cryptoSource.getRandomValues(bytes)',
        'value.version === 2',
        'typeof value.policyHash === \'string\''
    ])
    {
        if (!storage.includes(token))
        {
            errors.push(`${STORAGE_FILE}: missing ${token}`);
        }
    }

    for (const token of [
        "value: 'fsus:comment-draft:v1:'",
        "value: 'fsus:comment-public-draft:v2:'",
        "value: 'fsus:comment-public-draft-scope:v2'",
        "'epoch-changed'",
        "'feature-disabled'",
        "'panic'"
    ])
    {
        if (!registry.includes(token))
        {
            errors.push(`${REGISTRY_FILE}: missing ${token}`);
        }
    }

    const anonymousPersistence = /zk_anonymous[\s\S]{0,800}(?:localStorage|sessionStorage)\s*\.\s*setItem|(?:localStorage|sessionStorage)\s*\.\s*setItem[\s\S]{0,800}zk_anonymous|zk_anonymous[\s\S]{0,800}(?:indexedDB|caches)\s*\.\s*(?:open|put)/u;
    for (const [file, source] of Object.entries(frontendSources))
    {
        if (anonymousPersistence.test(source))
        {
            errors.push(`${file}: anonymous comment material is adjacent to a persistent browser-storage sink`);
        }
        if (file !== STORAGE_FILE && /fsus:comment-public-draft:v2:[\s\S]{0,500}(?:setItem|\.put\s*\()/u.test(source))
        {
            errors.push(`${file}: public comment draft persistence must stay inside ${STORAGE_FILE}`);
        }
    }

    return { errors };
}

function readFrontendSources(sourceRoot)
{
    const sources = {};
    const visit = (directory) =>
    {
        for (const entry of readdirSync(directory, { withFileTypes: true }))
        {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory())
            {
                visit(absolute);
                continue;
            }
            if (!/\.(?:js|mjs|ts|tsx|vue)$/u.test(entry.name))
            {
                continue;
            }
            const relative = path.relative(DEFAULT_ROOT, absolute).replaceAll('\\', '/');
            sources[relative] = readFileSync(absolute, 'utf8');
        }
    };
    visit(sourceRoot);
    return sources;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH)
{
    const result = validateCommentDraftPrivacy();
    if (result.errors.length > 0)
    {
        console.error(result.errors.join('\n'));
        process.exit(1);
    }
    console.log('[check-comment-draft-privacy] ok');
}
