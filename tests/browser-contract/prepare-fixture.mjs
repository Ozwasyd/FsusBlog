// fixture-catalog: consumer browser-contract-prepare acceptance-representative
import {
    cleanupBrowserContractFixture,
    prepareBrowserContractFixture
} from './fixture-lifecycle.mjs';

export {
    createBrowserContractFixtureApi,
    resolveBrowserContractRunIdentity
} from './fixture-lifecycle.mjs';

export async function prepareSingleBrowserContractFixture(options = {})
{
    return await prepareBrowserContractFixture(options);
}

export async function cleanupSingleBrowserContractFixture(prepared, options = {})
{
    return await cleanupBrowserContractFixture(prepared, options);
}
