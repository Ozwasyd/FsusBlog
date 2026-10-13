import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';

const maximumBytes = 16 * 1024 * 1024;
const maximumEventBytes = 128 * 1024;
const maximumEvents = 100000;

export function createRandomExecutionJournal({ directory, streamId, identity })
{
    let fd = null;
    let sequence = 0;
    let storedBytes = 0;
    let stopped = false;
    try
    {
        if (!/^[a-z0-9-]+$/u.test(streamId))
        {
            throw new Error('random journal stream filename is invalid');
        }
        fd = openSync(path.join(directory, `${streamId}.events.jsonl`), 'wx', 0o600);
    }
    catch (error)
    {
        stopped = true;
        process.stderr.write(`random execution journal unavailable: ${error.message}\n`);
    }
    const append = (kind, payload) =>
    {
        const bytes = Buffer.from(`${JSON.stringify({ schema: 'fsusblog.random-execution-event.v1',
            qualificationEligible: false, processId: process.pid, identity, sequence, kind, payload })}\n`);
        if (bytes.length > maximumEventBytes || storedBytes + bytes.length > maximumBytes || sequence >= maximumEvents)
        {
            throw new Error('random execution journal capacity exhausted');
        }
        let offset = 0;
        while (offset < bytes.length)
        {
            const written = writeSync(fd, bytes, offset, bytes.length - offset);
            if (!written)
            {
                throw new Error('random execution journal write made no progress');
            }
            offset += written;
            storedBytes += written;
        }
        fsyncSync(fd);
        sequence += 1;
    };
    return {
        record(kind, payload)
        {
            if (stopped)
            {
                return;
            }
            try
            {
                append(kind, payload);
            }
            catch (error)
            {
                stopped = true;
                process.stderr.write(`random execution journal stopped: ${error.message}\n`);
            }
        },
        close()
        {
            if (fd !== null)
            {
                try
                {
                    closeSync(fd);
                }
                catch (error)
                {
                    process.stderr.write(`random execution journal close failed: ${error.message}\n`);
                }
                fd = null;
            }
            stopped = true;
        }
    };
}
