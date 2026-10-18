import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.resolve(fileURLToPath(new URL('../../../../src/frontend', import.meta.url)));
const playwrightTestInfoPath = path.join(frontendRoot, 'node_modules/playwright/lib/worker/testInfo.js');
const require = createRequire(playwrightTestInfoPath);
const { TestInfoImpl } = require(playwrightTestInfoPath);

export const playwrightScreenshotPathTemplate =
    '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}-chromium-linux{ext}';

export const playwrightLegacyScreenshotPathTemplate =
    '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}';

function createScreenshotPathInfo({
    pathTemplate,
    projectName,
    snapshotSuffix,
    testFile,
    testDir,
    snapshotDir,
    configDir
})
{
    const info = {
        project: {
            name: projectName,
            testDir,
            snapshotDir
        },
        snapshotSuffix,
        _requireFile: testFile,
        _configInternal: { configDir },
        _projectInternal: {
            expect: {
                toHaveScreenshot: {
                    pathTemplate
                }
            }
        },
        _snapshotNames: {
            lastAnonymousSnapshotIndex: 0,
            lastNamedSnapshotIndex: {}
        },
        _ariaSnapshotNames: {
            lastAnonymousSnapshotIndex: 0,
            lastNamedSnapshotIndex: {}
        },
        titlePath: ['visual', 'screenshot-path'],
        _fsSanitizedTestName()
        {
            return 'screenshot-path';
        }
    };
    info._applyPathTemplate = TestInfoImpl.prototype._applyPathTemplate;
    info._resolveSnapshotPaths = TestInfoImpl.prototype._resolveSnapshotPaths;
    return info;
}

/**
 * @param {{ pathTemplate?: string; projectName: string; snapshotSuffix?: string; testFile: string; testDir: string; snapshotDir: string; configDir: string; name: string | string[]; }} options
 * @returns {string}
 */
export function resolvePlaywrightScreenshotPath({
    pathTemplate = playwrightScreenshotPathTemplate,
    projectName,
    snapshotSuffix = '',
    testFile,
    testDir,
    snapshotDir,
    configDir,
    name
})
{
    const info = createScreenshotPathInfo({
        pathTemplate,
        projectName,
        snapshotSuffix,
        testFile,
        testDir,
        snapshotDir,
        configDir
    });
    return info._resolveSnapshotPaths('screenshot', name, 'dontUpdateSnapshotIndex').absoluteSnapshotPath;
}
