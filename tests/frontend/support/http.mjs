#!/usr/bin/env node

import { withTestSessionHeaders } from './test-session.mjs';

const DEFAULT_HTTP_TIMEOUT_MS = Number(process.env.FSUSBLOG_HTTP_TIMEOUT_MS || '15000');

export function parseTimeoutMs(value, fallback = DEFAULT_HTTP_TIMEOUT_MS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`request timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...withTestSessionHeaders(init),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeReachable(url, label, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
  try {
    await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (FsusBlog Smoke Probe)',
        Accept: 'application/octet-stream,text/html'
      }
    }, timeoutMs);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} unreachable: ${url} | reason: ${reason}`);
  }
}
