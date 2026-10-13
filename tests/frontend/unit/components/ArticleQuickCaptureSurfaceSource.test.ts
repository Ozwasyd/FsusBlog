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
            const button = source.match(new RegExp(`<ElButton\\b([^>]*)>${label}</ElButton>`))?.[1];
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
});
