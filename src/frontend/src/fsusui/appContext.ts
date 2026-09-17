import { ID_INJECTION_KEY } from '@ozwasyd/element-plus';

import type { App } from 'vue';

const FSUSBLOG_FSUSUI_ID_PREFIX = 240524;

export function provideFsusUiAppContext(app: App): void
{
    app.provide(ID_INJECTION_KEY, {
        prefix: FSUSBLOG_FSUSUI_ID_PREFIX,
        current: 0
    });
}
