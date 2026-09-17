import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    validateCommentDraftPrivacy,
    validateCommentDraftPrivacySources
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/security/check-comment-draft-privacy.mjs')).href);

test('comment draft privacy gate accepts the public-only persistence boundary', () =>
{
    const validation = validateCommentDraftPrivacy();
    assert.deepEqual(validation.errors, []);
});

test('comment draft privacy gate rejects an anonymous persistence regression', () =>
{
    const validation = validateCommentDraftPrivacy();
    const sources = { ...validation.sources };
    const composerFile = 'src/frontend/src/components/article/ArticleCommentComposer.vue';
    sources[composerFile] = sources[composerFile]
        .concat("\nif (authorModeModel.value === 'zk_anonymous') localStorage.setItem('draft', contentModel.value)\n");

    const regressed = validateCommentDraftPrivacySources(sources, sources);
    assert.ok(regressed.errors.some(error => /persistent browser-storage sink|anonymous comment material/.test(error)));
});

test('comment draft privacy gate rejects raw account identity in the storage owner', () =>
{
    const validation = validateCommentDraftPrivacy();
    const sources = { ...validation.sources };
    const storageFile = 'src/frontend/src/privacy/commentPublicDraftStorage.ts';
    sources[storageFile] = sources[storageFile].concat('\nconst rawIdentity = accountId\n');

    const regressed = validateCommentDraftPrivacySources(sources, sources);
    assert.ok(regressed.errors.some(error => /must not contain accountId/.test(error)));
});
