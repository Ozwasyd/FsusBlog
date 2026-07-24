import fs from 'node:fs';
import path from 'node:path';

const resultFile = process.env.FSUSBLOG_STATIC_GOVERNANCE_HOST_RESULT;

function writeResult(events)
{
    if (!resultFile)
    {
        throw new Error('FSUSBLOG_STATIC_GOVERNANCE_HOST_RESULT is required');
    }
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    const temporary = `${resultFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({
        schema: 'fsusblog.static-governance-host-result.v1',
        events
    }, null, 2)}\n`);
    fs.renameSync(temporary, resultFile);
}

export default async function* staticGovernanceReporter(source)
{
    const events = [];
    try
    {
        for await (const event of source)
        {
            if (['test:pass', 'test:fail'].includes(event.type) && Number(event.data?.nesting ?? 0) === 0)
            {
                events.push({
                    type: event.type,
                    name: event.data.name,
                    file: event.data.file,
                    skipped: event.data.skip === true,
                    todo: event.data.todo === true
                });
            }
            if (event.type === 'test:fail')
            {
                yield `[static-governance] failed: ${event.data.file ?? '<unknown>'}: ${event.data.name}\n`;
            }
        }
    }
    finally
    {
        writeResult(events);
    }
}
