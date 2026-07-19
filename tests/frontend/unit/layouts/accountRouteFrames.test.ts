import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readLayout = (name: string): string => (
    readFileSync(resolve(process.cwd(), `src/layouts/${name}`), 'utf8')
);

describe('account route frames', () =>
{
    it('keeps AccountLayout limited to shared chrome and frame outlets', () =>
    {
        const source = readLayout('AccountLayout.vue');

        expect(source).toContain('<SiteChromeHeaderAdapter');
        expect(source).toContain('<AccountHeaderMenu');
        expect(source).toContain('<PolicyModal');
        expect(source).toContain('<RouterView name="accountMobileAction" />');
        expect(source).toContain('<RouterView />');
        expect(source).not.toContain('AccountNavigationPanel');
        expect(source).not.toContain('<ElDrawer');
        expect(source).not.toContain('accountContentMode');
        expect(source).not.toContain('accountPageKind');
    });

    it('gives identity and admin distinct frame composition owners', () =>
    {
        const identity = readLayout('AccountIdentityFrame.vue');
        const admin = readLayout('AdminWorkspaceFrame.vue');
        const sharedFrame = readLayout('AccountRouteFrame.vue');
        const identityCss = readFileSync(resolve(process.cwd(), 'src/assets/account-identity.css'), 'utf8');
        const adminCss = readFileSync(resolve(process.cwd(), 'src/assets/admin-workspace.css'), 'utf8');

        expect(identity).toContain("surface: 'self'");
        expect(identity).toContain('frame-class="account-identity-frame"');
        expect(identityCss).toContain('max-width: var(--fsusblog-container-account)');
        expect(identity).toContain("resolveAccountPageKindClass('self'");
        expect(identity).toContain("resolveAccountRouteMotionPolicy(\n    'self'");
        expect(admin).toContain("surface: 'manage'");
        expect(admin).toContain('frame-class="admin-workspace-frame"');
        expect(adminCss).toContain('max-width: var(--fsusblog-container-wide)');
        expect(admin).toContain("resolveAccountPageKindClass('manage'");
        expect(admin).toContain("resolveAccountRouteMotionPolicy(\n    'manage'");
        expect(sharedFrame.match(/<ElDrawer/gu)).toHaveLength(1);
        expect(sharedFrame).toContain('variant="mobile"');
        expect(sharedFrame).toContain('variant="desktop"');
        expect(sharedFrame).toContain(':key="accountRouteViewKey"');
        expect(sharedFrame).toContain(':disabled="motionPolicy.preset === null || !motionEnabled"');
        expect(sharedFrame).not.toContain('mode="out-in"');
        expect(sharedFrame).not.toContain(':duration="220"');
        expect(sharedFrame).toContain('shouldRestoreAccountRouteFocus');
        expect(readLayout('AccountFrameMobileAction.vue')).toContain('watch(() => route.fullPath');
    });

    it('routes each area through its frame without changing leaf paths', () =>
    {
        const router = readFileSync(resolve(process.cwd(), 'src/router/index.ts'), 'utf8');

        expect(router).toMatch(/path:\s*''[\s\S]*?AccountIdentityFrame\.vue[\s\S]*?AccountFrameMobileAction\.vue/gu);
        expect(router).toMatch(/path:\s*'manage'[\s\S]*?AdminWorkspaceFrame\.vue[\s\S]*?AccountFrameMobileAction\.vue/gu);
        expect(router).toContain("path: 'identity/passkeys', name: 'UserIdentityPasskeys'");
        expect(router).toContain("path: 'article/edit/:id', name: 'ManageEditArticle'");
        expect(router).toContain("path: 'security',");
    });
});
