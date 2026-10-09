// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { ElCheckbox } from '@ozwasyd/element-plus';
import { nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Login from '@/views/auth/Login.vue';

const rememberMe = ref(true);
const loading = ref(false);
const loginWithPasskey = vi.fn();
const rememberLabel = ref('记住这台设备');

vi.mock('@/composables/useAuthLogin', () => ({
    useAuthLogin: () => ({
        errorMessage: ref(''),
        rememberMe,
        isProcessing: ref(false),
        handleMfaVerify: vi.fn(),
        requiresMfa: ref(false),
        mfaMode: ref('totp'),
        mfaCode: ref(''),
        mfaRecoveryCode: ref('')
    })
}));

vi.mock('@/composables/usePasskeyLogin', () => ({
    usePasskeyLogin: () => ({ loading, error: ref(''), loginWithPasskey })
}));

vi.mock('@/composables/useI18nText', () => ({
    useI18nText: () => ({
        messages: ref({
            auth: {
                login: {
                    title: '登录',
                    description: '使用通行密钥登录',
                    get rememberMe() { return rememberLabel.value; },
                    passkeyButton: '使用通行密钥',
                    passkeyLoading: '正在登录',
                    passkeyHint: '在这台设备上使用通行密钥',
                    recoverLink: '恢复账号',
                    registerLink: '注册',
                    cancelLink: '返回'
                }
            }
        })
    })
}));

function mountLogin()
{
    return mount(Login, {
        attachTo: document.body,
        global: {
            components: { ElCheckbox },
            stubs: { ElButton: true, ElIcon: true, ElInput: true, ElRadioButton: true, ElRadioGroup: true, RouterLink: true }
        }
    });
}

describe('login remember public Checkbox boundary 20261009', () =>
{
    beforeEach(() =>
    {
        rememberMe.value = true;
        loading.value = false;
        rememberLabel.value = '记住这台设备';
        loginWithPasskey.mockClear();
    });

    afterEach(() =>
    {
        document.body.innerHTML = '';
    });

    it('keeps short and expanded copy inside the public default slot and native label association', async () =>
    {
        const wrapper = mountLogin();
        await nextTick();
        const checkbox = wrapper.getComponent(ElCheckbox);
        const input = wrapper.get<HTMLInputElement>('input[type="checkbox"]');
        const label = wrapper.get('.login-remember-label');
        expect(label.text()).toBe(rememberLabel.value);
        expect(input.attributes('id')).toBe('anonymous-remember-me');
        expect(input.attributes('name')).toBe('rememberMe');
        expect(input.element.labels?.[0]?.textContent?.trim()).toBe(rememberLabel.value);
        expect(input.element.checked).toBe(true);
        expect(checkbox.props('modelValue')).toBe(true);

        rememberLabel.value = 'Remember this device and keep this browser session available when returning to read articles on this personal computer.';
        await nextTick();
        expect(label.text()).toBe(rememberLabel.value);
        expect(input.element.labels?.[0]?.textContent?.trim()).toBe(rememberLabel.value);
        expect(loginWithPasskey).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('updates the existing remembered-session model through the real public checkbox', async () =>
    {
        const wrapper = mountLogin();
        const input = wrapper.get<HTMLInputElement>('input[type="checkbox"]');
        await input.setValue(false);
        expect(rememberMe.value).toBe(false);
        await input.setValue(true);
        expect(rememberMe.value).toBe(true);
        expect(loginWithPasskey).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('preserves checked state and disables label activation while the passkey control is loading', async () =>
    {
        loading.value = true;
        const wrapper = mountLogin();
        const input = wrapper.get<HTMLInputElement>('input[type="checkbox"]');
        expect(input.element.disabled).toBe(true);
        expect(input.element.checked).toBe(true);
        await wrapper.get('.login-remember-label').trigger('click');
        expect(rememberMe.value).toBe(true);
        expect(input.element.checked).toBe(true);
        expect(loginWithPasskey).not.toHaveBeenCalled();
        wrapper.unmount();
    });
});
