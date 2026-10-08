import fs from 'node:fs';
import readline from 'node:readline';
const { startInheritedViteListener } = await import(process.env.FSUSBLOG_ADAPTER_REPO + '/tools/test-runtime/inherited-vite-listener.mjs');
const fd = Number(process.env.RESERVED_FD);
const port = Number(process.env.RESERVED_PORT);
const inode = fs.readlinkSync(`/proc/self/fd/${fd}`);
const expected = process.env.RESERVED_INODE;
if (inode !== expected) throw new Error('inherited descriptor identity mismatch');
const lines = readline.createInterface({ input: process.stdin });
console.log(JSON.stringify({ event: 'prepared', inode, pid: process.pid }));
const [command] = await new Promise(resolve => lines.once('line', line => resolve([line])));
if (command !== 'activate') throw new Error('activation denied');
if (process.env.FAIL_STAGE === 'before') throw new Error('injected before activation');
const { server } = await startInheritedViteListener({ mode: process.env.ROLE === 'vite-dev' ? 'dev' : 'preview',
  root: process.env.FSUSBLOG_ADAPTER_SITE, configFile: false, hmr: false });
if (fs.readlinkSync(`/proc/self/fd/${fd}`) !== expected) throw new Error('FD changed after adoption');
console.log(JSON.stringify({ event: 'listening', inode: expected, address: server.httpServer.address(), pid: process.pid }));
if (process.env.FAIL_STAGE === 'after') { await server.close(); process.exit(42); }
async function stop() { await server.close(); lines.close(); process.exit(0); }
process.on('SIGTERM', stop);
lines.once('line', line => { if (line === 'stop') stop(); });
