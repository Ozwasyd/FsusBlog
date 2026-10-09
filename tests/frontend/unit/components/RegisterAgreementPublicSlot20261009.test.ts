// @vitest-environment happy-dom

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ElButton, ElCheckbox, ElInput } from '@ozwasyd/element-plus';
import { mount } from '@vue/test-utils';
import { computed, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auth } from '@/locales/en-US/auth';
import Register from '@/views/auth/Register.vue';

function createOnboardingFixture() {
    const isAgreed = ref(false);
    const loading = ref(false);
    const publicHandleHint = ref('');
    const showGuidelines = ref(false);
    return {
        localError: ref(''),
        publicHandle: ref(''),
        publicHandleHint,
        isAgreed,
        showGuidelines,
        loading,
        step: ref('account'),
        recoveryKeyPlaintext: ref(''),
        recoveryKeyVersion: ref<number | null>(null),
        recoveryKeyCreatedAt: ref<string | null>(null),
        recoveryKeySaved: ref(false),
        passkeyModalVisible: ref(false),
        isProcessing: computed(() => loading.value),
        canCreateAnonymousAccount: computed(() => isAgreed.value && !publicHandleHint.value && !loading.value),
        canRegisterPasskey: computed(() => false),
        handleGuidelinesActivator: vi.fn(() => { showGuidelines.value = true; }),
        createAnonymousAccount: vi.fn(),
        copyRecoveryKey: vi.fn(),
        openPasskeyRegistration: vi.fn(),
        onPasskeyRegistered: vi.fn(),
        finishOnboarding: vi.fn()
    };
}

function createCopyFixture(agreementPrefix: string = auth.register.agreementPrefix) {
    return ref({ auth: { ...auth, register: { ...auth.register, agreementPrefix } } });
}

const fixture = vi.hoisted(() => ({
    onboarding: null as ReturnType<typeof createOnboardingFixture> | null,
    messages: null as ReturnType<typeof createCopyFixture> | null
}));

vi.mock('@/composables/useAnonymousOnboarding', () => ({
    useAnonymousOnboarding: () => fixture.onboarding
}));
vi.mock('@/composables/useI18nText', () => ({
    useI18nText: () => ({ messages: fixture.messages })
}));

const mountOptions = {
    global: {
        components: { ElButton, ElCheckbox, ElInput },
        stubs: { PolicyModal: true, PasskeyRegisterModal: true, RouterLink: true }
    }
};

describe('Register agreement public slot presentation', () => {
    let wrapper: ReturnType<typeof mount>;

    beforeEach(() => {
        fixture.onboarding = createOnboardingFixture();
        fixture.messages = createCopyFixture();
        wrapper = mount(Register, mountOptions);
    });

    afterEach(() => {
        wrapper.unmount();
    });

    it('keeps the complete expanded agreement and embedded action associated with the real checkbox', async () => {
        const prefix = 'I have read and accept the complete site guidelines, including discussion and publishing rules. '.repeat(8);
        fixture.messages!.value.auth.register.agreementPrefix = prefix;
        await nextTick();

        const input = wrapper.get<HTMLInputElement>('input#agreement');
        const label = input.element.closest('label');
        const content = wrapper.get('.register-agreement-label');
        expect(label).not.toBeNull();
        expect(label!.contains(content.element)).toBe(true);
        expect(content.text()).toContain(prefix.trim());
        expect(content.get('button').text()).toBe(auth.register.guidelinesLink);
        expect(input.attributes('name')).toBe('agreement');
        expect(input.element.checked).toBe(false);
        expect(wrapper.getComponent(ElCheckbox).attributes('aria-required')).toBe('true');
    });

    it('preserves consent binding, validation feedback and revocation without submitting an account', async () => {
        const input = wrapper.get<HTMLInputElement>('input#agreement');
        const submit = wrapper.get<HTMLButtonElement>('.register-submit-button');
        expect(submit.element.disabled).toBe(true);
        await input.setValue(true);
        expect(fixture.onboarding!.isAgreed.value).toBe(true);
        expect(submit.element.disabled).toBe(false);

        fixture.onboarding!.publicHandleHint.value = 'Invalid public name';
        await nextTick();
        expect(submit.element.disabled).toBe(true);
        expect(wrapper.get('#public-handle-hint').text()).toBe('Invalid public name');
        fixture.onboarding!.publicHandleHint.value = '';
        await input.setValue(false);
        expect(fixture.onboarding!.isAgreed.value).toBe(false);
        expect(submit.element.disabled).toBe(true);
        expect(fixture.onboarding!.createAnonymousAccount).not.toHaveBeenCalled();
    });

    it.each([false, true])('opens guidelines without toggling consent when checked=%s', async (checked) => {
        fixture.onboarding!.isAgreed.value = checked;
        await nextTick();
        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        wrapper.get('.register-guidelines-button').element.dispatchEvent(click);
        await nextTick();

        expect(click.defaultPrevented).toBe(true);
        expect(fixture.onboarding!.showGuidelines.value).toBe(true);
        expect(fixture.onboarding!.handleGuidelinesActivator).toHaveBeenCalledTimes(1);
        expect(wrapper.get<HTMLInputElement>('input#agreement').element.checked).toBe(checked);
        expect(fixture.onboarding!.isAgreed.value).toBe(checked);
        expect(fixture.onboarding!.createAnonymousAccount).not.toHaveBeenCalled();
    });

    it.each([false, true])('retains checked=%s while processing disables the native checkbox', async (checked) => {
        fixture.onboarding!.isAgreed.value = checked;
        fixture.onboarding!.loading.value = true;
        await nextTick();
        const input = wrapper.get<HTMLInputElement>('input#agreement');
        expect(input.element.disabled).toBe(true);
        input.element.click();
        await nextTick();
        expect(input.element.checked).toBe(checked);
        expect(fixture.onboarding!.isAgreed.value).toBe(checked);
        expect(wrapper.get<HTMLButtonElement>('.register-submit-button').element.disabled).toBe(true);
        expect(fixture.onboarding!.createAnonymousAccount).not.toHaveBeenCalled();
    });
});

it('reproduces the exact rejected blob and passes the unchanged official checker with the final Register file', () => {
    const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    expect(gitRoot.status).toBe(0);
    const repository = gitRoot.stdout.trim();
    const root = mkdtempSync(path.join(tmpdir(), 'register-agreement-public-slot-20261009-'));
    const target = 'src/frontend/src/views/auth/Register.vue';
    const checker = path.join(repository, 'tests/frontend/checks/static/check-fsusui-boundary.mjs');
    const supportingPaths = [
        'src/frontend/package.json',
        'src/frontend/src/fsusui',
        'src/frontend/src/components/admin/AdminInlineEmptyState.vue',
        'src/frontend/src/views/user/IdentityCenter.vue',
        'src/frontend/src/views/user/Profile.vue',
        target
    ];
    const check = () => spawnSync(process.execPath, [checker, '--strict'], {
        cwd: repository,
        encoding: 'utf8',
        env: { ...process.env, FSUSBLOG_FSUSUI_BOUNDARY_ROOT: root }
    });

    try {
        for (const source of supportingPaths) {
            const destination = path.join(root, source);
            mkdirSync(path.dirname(destination), { recursive: true });
            cpSync(path.join(repository, source), destination, { recursive: true });
        }
        const rejected = spawnSync('git', ['cat-file', 'blob', 'fb737e632a4c3d4ef282970b038c929c0a5d5f2d'], {
            cwd: repository,
            encoding: 'utf8'
        });
        expect(rejected.status).toBe(0);
        writeFileSync(path.join(root, target), rejected.stdout);
        const before = check();
        expect(before.status).toBe(1);
        expect(before.stdout).toContain(`${target}: internal-selector: uses .el-checkbox__label`);

        cpSync(path.join(repository, target), path.join(root, target));
        const after = check();
        expect(after.stderr).toBe('');
        expect(after.status, after.stdout).toBe(0);
        expect(after.stdout).toContain('[fsusui-boundary] ok warnings=0 strict=true');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
