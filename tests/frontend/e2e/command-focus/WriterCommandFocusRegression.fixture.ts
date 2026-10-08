import { createApp, h } from 'vue';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import FsusUi from '@ozwasyd/element-plus';

import '@/assets/main.css';
import Write from '@/views/admin/article/Write.vue';
import { activateLocaleRuntime } from '@/locales';
import { useAdminStore } from '@/store/admin';

// Mount the unchanged product route, composable, editor and inspector. Only the
// local session projection is seeded; remote requests remain real fail-closed IO.
export async function mountWriterCommandFocusRegression(): Promise<void>
{
    await activateLocaleRuntime('zh-CN', ['common', 'admin']);
    const pinia = createPinia();
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/manage/article/write', component: Write },
            { path: '/manage/article', component: { render: () => h('p', 'Article list destination') } }
        ]
    });
    const admin = useAdminStore(pinia);
    admin.setAdminPrincipal({
        id: 'command-focus-local-fixture',
        displayName: 'Local integration fixture',
        source: 'independent',
        permissions: ['article.write'],
        adminSessionStatus: 'active'
    });
    await router.push('/manage/article/write');
    await router.isReady();
    const app = createApp(RouterView);
    app.use(pinia);
    app.use(router);
    app.use(FsusUi);
    app.mount('#writer-command-focus-regression');
    Object.assign(window, {
        writerCommandFocusFixture: Object.freeze({
            revokePermission: () => admin.setAdminPrincipal({
                ...admin.adminPrincipal!, permissions: []
            }),
            unmount: () => app.unmount()
        })
    });
    document.documentElement.dataset.writerCommandFocusMounted = 'true';
}

if (document.getElementById('writer-command-focus-regression'))
{
    void mountWriterCommandFocusRegression();
}
