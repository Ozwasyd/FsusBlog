import assert from 'node:assert/strict';

// eslint-disable-next-line import-x/no-relative-parent-imports -- The isolated test child runs an exact copied owner from its own checkout.
import { createPublicShellFiniteInputOwner } from '../browser-contract/public-shell-finite-input-owner.mjs';

assert.equal(typeof process.send, 'function', 'finite input fixture requires its owned IPC parent');
let owner = await createPublicShellFiniteInputOwner();
process.on('message', async message =>
{
    try
    {
        assert.ok(message && typeof message.id === 'number', 'finite input fixture request identity');
        let value;
        if (message.action === 'load')
        {
            const module = await owner.load(message.moduleId);
            value = Object.fromEntries(Object.entries(module).filter(([, item]) => typeof item !== 'function'));
        }
        else if (message.action === 'refs')
        {
            value = owner.refs();
        }
        else if (message.action === 'schema')
        {
            const bindings = await owner.schemaBindings();
            value = { exportNames: bindings.exportNames, schemaDigests: bindings.schemaDigests };
        }
        else if (message.action === 'refresh')
        {
            owner = await createPublicShellFiniteInputOwner();
            value = owner.sourceCommit;
        }
        else
        {
            assert.fail('unknown finite input fixture action');
        }
        process.send({ id: message.id, value });
    }
    catch (error)
    {
        process.send({ id: message.id, error: error.message });
    }
});
process.on('disconnect', () => process.exit(0));
process.send({ ready: true });
