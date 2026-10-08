import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    root: fileURLToPath(new URL('../', import.meta.url)),
    test: {
        environment: 'node',
        include: ['audit-workspace-races-20261008/*.test.ts'],
        maxWorkers: 1,
        fileParallelism: false,
        reporters: ['verbose']
    }
});
