#!/usr/bin/env node

const baseUrl = (process.env.FSUSBLOG_BASE_URL ?? process.argv[2] ?? 'http://127.0.0.1:7568').replace(/\/+$/, '');
const token = process.env.FSUSBLOG_PUBLIC_AOT_TOKEN ?? process.env.FSUSBLOG_PUBLIC_AOT_MANIFEST_TOKEN ?? '';
const url = `${baseUrl}/internal/public-aot/health`;

const headers = {};
if (token)
{
    headers['X-Fsus-Public-Aot-Token'] = token;
}

const response = await fetch(url, { headers });
const text = await response.text();
if (!response.ok)
{
    console.error(`[public-aot-health] ${response.status} ${response.statusText}`);
    console.error(text);
    process.exit(1);
}

try
{
    const json = JSON.parse(text);
    console.log(JSON.stringify(json, null, 2));
}
catch
{
    console.log(text);
}
