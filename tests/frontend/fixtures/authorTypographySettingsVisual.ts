import { createApp, h, nextTick, shallowRef } from 'vue';
import { ElMarkdownRenderer } from '@ozwasyd/element-plus';
import '@/assets/main.css';
import AuthorTypographySettings from '@/components/admin/article/AuthorTypographySettings.vue';
import type { AuthorTypographySettingsView } from '@/view-contracts/authorTypographySettings';

// Synthetic display observations exercise composition only. No access, device,
// default, persistence, apply, or font readiness is asserted by this fixture.
const params = new URL(window.location.href).searchParams;
const requested = params.get('state') ?? 'current';
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.classList.toggle('dark', theme === 'dark');
document.documentElement.dataset.themeMode = theme;
document.documentElement.dataset.themeResolved = theme;
document.body.className = 'account-shell';
const host = document.getElementById('author-typography-fixture');
if (!host) throw new Error('author_typography_fixture_host_missing');
host.className = 'account-content';

const current: AuthorTypographySettingsView = Object.freeze({
    profile: Object.freeze({
        schemaVersion: 1, fontFamily: 'cjk-sans', fontSize: 'large', lineHeight: 'relaxed',
        canvasWidth: 'narrow', paragraphSpacing: 'compact'
    }),
    revision: 17, status: 'current', permission: 'allowed', device: 'verified',
    designDefault: 'verified', font: 'unavailable'
});
const states: Record<string, AuthorTypographySettingsView> = {
    current,
    loading: { ...current, status: 'loading', profile: null, revision: null },
    saving: { ...current, status: 'saving' },
    saved: { ...current, status: 'saved' },
    conflict: { ...current, status: 'conflict' },
    unavailable: { ...current, status: 'unavailable' },
    permission: { ...current, permission: 'denied' },
    device: { ...current, device: 'unavailable' },
    default: { ...current, designDefault: 'unavailable' },
    exhausted: { ...current, revision: Number.MAX_SAFE_INTEGER },
    'font-loaded': { ...current, font: 'loaded' },
    'font-loading': { ...current, font: 'loading' },
    'font-failed': { ...current, font: 'failed' },
    'font-fallback': { ...current, font: 'fallback' }
};
const view = shallowRef(states[requested] ?? current);
let changes = 0;
let resets = 0;
let reloads = 0;
const app = createApp({
    render: () => h('main', { 'aria-label': '作者排版测试表面' }, [h(AuthorTypographySettings, {
        view: view.value,
        onChange: () => { document.documentElement.dataset.typographyChanges = String(++changes); },
        onReset: () => { document.documentElement.dataset.typographyResets = String(++resets); },
        onReload: () =>
        {
            document.documentElement.dataset.typographyReloads = String(++reloads);
            view.value = { ...current, revision: 18, profile: { ...current.profile!, fontSize: 'compact' } };
        }
    })])
});
app.component('ElMarkdownRenderer', ElMarkdownRenderer);
app.mount(host);
await nextTick();
document.documentElement.dataset.typographyFixtureReady = 'true';
