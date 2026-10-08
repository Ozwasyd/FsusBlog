// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import VaultStatusUnavailable from '@/components/admin/article/vault/VaultStatusUnavailable.vue';

 describe('missing canonical Vault capability disclosure', () => {
    it('keeps the status compact and unknown with no fake commands or successful connection state', async () => {
        const wrapper = mount(VaultStatusUnavailable);
        expect(wrapper.find('details').attributes('open')).toBeUndefined();
        expect(wrapper.find('summary').text()).toBe('Vault：状态未知');
        expect(wrapper.find('[role="status"]').text()).toContain('尚不可用');
        expect(wrapper.text()).toContain('服务端文章编辑、保存、发布和恢复仍可使用');
        expect(wrapper.findAll('button')).toHaveLength(0);
        expect(wrapper.emitted()).toEqual({});
        wrapper.unmount();
    });
});
