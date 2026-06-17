#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { registerWithPow } from '../support/auth-helpers.mjs';
import { probeReachable, parseTimeoutMs } from '../support/http.mjs';

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:7568';
const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser';
const userPassword = process.env.FSUSBLOG_USER_PASSWORD || 'BinaryUserPass123!';
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin';
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!';
const promoteAdmin = (process.env.FSUSBLOG_PROMOTE_ADMIN ?? '1') !== '0';
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000);
const deviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'binary-smoke-node';

const pgContainer = process.env.FSUSBLOG_PG_CONTAINER || 'fsusblog-postgres';
const pgUser = process.env.FSUSBLOG_PG_USER || 'fsusblog';
const pgDb = process.env.FSUSBLOG_PG_DB || 'fsusblog';
const testSession = process.env.FSUSBLOG_TEST_SESSION || '';

function sessionSchema() {
  if (!testSession) {
    return '';
  }

  return `fsus_e2e_${testSession.replaceAll('-', '_')}`;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function registerUser(username, password) {
  try {
    await registerWithPow(username, password, deviceFingerprint, requestTimeoutMs);
    console.log(`[prepare-auth-users] registered: ${username}`);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('409')) {
      console.log(`[prepare-auth-users] exists: ${username}`);
      return;
    }

    throw error;
  }
}

function promoteAdminRole(username) {
  const schema = sessionSchema();
  const sql = `${schema ? `set search_path to "${schema}", public;` : ''} update sys_user set role='admin' where username='${username}';`;
  const result = spawnSync('docker', [
    'exec',
    '-i',
    pgContainer,
    'psql',
    '-U',
    pgUser,
    '-d',
    pgDb,
    '-c',
    sql
  ], { encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`promote admin failed: ${result.stderr || result.stdout}`);
  }

  console.log(`[prepare-auth-users] promoted admin: ${username}`);
}

async function main() {
  await probeReachable(`${baseUrl}/api/binary/auth/pow-challenge`, '[prepare-auth-users backend]', requestTimeoutMs);

  await registerUser(userName, userPassword);
  await registerUser(adminName, adminPassword);

  if (promoteAdmin) {
    promoteAdminRole(adminName);
  } else {
    console.log('[prepare-auth-users] skip admin promotion');
  }

  console.log('[prepare-auth-users] done');
  console.log(`[prepare-auth-users] export FSUSBLOG_USER_USERNAME=${userName}`);
  console.log(`[prepare-auth-users] export FSUSBLOG_USER_PASSWORD=${userPassword}`);
  console.log(`[prepare-auth-users] export FSUSBLOG_ADMIN_USERNAME=${adminName}`);
  console.log(`[prepare-auth-users] export FSUSBLOG_ADMIN_PASSWORD=${adminPassword}`);
}

main().catch((error) => {
  console.error('[prepare-auth-users] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
