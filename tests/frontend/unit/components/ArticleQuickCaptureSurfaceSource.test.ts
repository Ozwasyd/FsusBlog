import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('../../../../src/frontend/src/components/admin/article/ArticleQuickCaptureSurface.vue', import.meta.url), 'utf8');

describe('Quick Capture unactivated leaf source boundary', () =>
{
    it('consumes original capture types without adding a store, create path or success callback', () =>
    {
        expect(source).toContain("from '@/services/articleCaptureRecovery'");
        expect(source).toContain('describeArticleCaptureRequest(');
        expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|fetch\(|binaryRequest|createInboxCapture|new ArticleCaptureRecovery/u);
        expect(source).not.toMatch(/crypto\.randomUUID|createArticleRecoveryClientRevision|openOrActivate|v-html|:deep\(/u);
        expect(source).not.toMatch(/onSave|onSuccess|'saved'\s*:|'submit'\s*:/u);
    });

    it('keeps every missing server, open and reconciliation action unconditionally disabled', () =>
    {
        for (const label of ['保存到收件箱', '保存并打开', '恢复', '重试', '丢弃未确认输入'])
        {
            const button = source.match(new RegExp(String.raw`<ElButton\b([^>]*)>${label}</ElButton>`))?.[1];
            expect(button, label).toBeDefined();
            expect(button, label).toMatch(/\sdisabled(?:\s|$)/u);
            expect(button, label).not.toContain('@click');
        }
        expect(source).not.toMatch(/canSave|transportReady|verifiedReceipt/u);
    });

    it('does not trim, truncate, stage or replace an unknown original request', () =>
    {
        expect(source).not.toMatch(/\.trim\(|\.slice\(|\.substring\(|maxlength|\.stage\(|\.discardOwned\(|\.retire\(/u);
        expect(source).toContain('props.stageResult !== null');
        expect(source).toContain('scopeCurrent.value && !attempted.value');
        expect(source).toContain('保存结果尚未确认');
        expect(source).toContain('未确认窗口不受本地保护');
    });

    it('keeps blocked input readable without treating a blocked observation as an unbound request', () =>
    {
        expect(source).toContain("props.stageResult?.status === 'blocked'");
        expect(source).toContain("if (!scopeCurrent.value) return { schemaVersion: 1, title: '', markdownContent: '' };");
        expect(source).toContain('if (blockedObservation.value || !attempted.value) return props.modelValue;');
        expect(source).toContain('return boundInput.value ??');
        expect(source.match(/:readonly="!editable"/gu)).toHaveLength(2);
        expect(source.match(/:disabled="!scopeCurrent"/gu)).toHaveLength(2);
        expect(source).toContain("props.stageResult.reason === 'scope-retired'");
        expect(source).toContain('当前输入仅供查看和复制');
    });

    it('names input fields, announces status and hides input when the original scope changes', () =>
    {
        expect(source).toContain('props.currentScope.owner === openedScope.owner');
        expect(source).toContain('props.currentScope.adminPrincipalId === openedScope.adminPrincipalId');
        expect(source).toContain('props.currentScope.siteScope === openedScope.siteScope');
        expect(source).toContain("{ schemaVersion: 1, title: '', markdownContent: '' }");
        expect(source).toContain(':for="titleId"');
        expect(source).toContain(':for="bodyId"');
        expect(source).toContain('aria-live="polite"');
        expect(source).toContain('native-type="button"');
        expect(source).toContain('模板：未选择');
    });

    it('keeps observed retirement terminal when a late blocked/busy result or replacement scope prop arrives', () =>
    {
        // Source policy only: immediate/synchronous observation prevents render batching from
        // dropping retirement, and the one-way latch has no prop-driven local reset.
        expect(source).toContain('const scopeRetired = ref(false);');
        expect(source).toContain("props.stageResult.reason === 'scope-retired'");
        expect(source).toContain("props.discoveryResult.reason === 'scope-retired'");
        expect(source).toContain("{ immediate: true, flush: 'sync' }");
        expect(source.match(/scopeRetired\.value\s*=/gu)).toHaveLength(1);
        expect(source).toContain('if (retired) scopeRetired.value = true;');
        expect(source).toContain('const scopeCurrent = computed(() => !scopeRetired.value && openedScope !== null');
        expect(source).toContain("if (!scopeCurrent.value) return { schemaVersion: 1, title: '', markdownContent: '' };");
        expect(source).toContain('if (blockedObservation.value || !attempted.value) return props.modelValue;');
    });
});
