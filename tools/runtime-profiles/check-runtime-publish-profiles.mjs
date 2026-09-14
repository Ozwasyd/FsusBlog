#!/usr/bin/env node
import process from 'node:process';

import { readRuntimeProfileManifest } from './runtime-publish-profile.mjs';

try
{
    const fileIndex = process.argv.indexOf('--manifest');
    const file = fileIndex >= 0 ? process.argv[fileIndex + 1] : undefined;
    if (fileIndex >= 0 && !file)
    {
        throw new Error('--manifest requires a path');
    }
    const loaded = readRuntimeProfileManifest(file);
    console.log(JSON.stringify({
        schema: 'fsusblog.runtime-publish-profile-validation.v1',
        status: 'ok',
        manifest: loaded.file,
        digest: loaded.digest,
        defaultProfile: loaded.manifest.defaultProfile,
        profileCount: loaded.manifest.profiles.length
    }));
}
catch (error)
{
    console.error(`[check-runtime-publish-profiles] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
