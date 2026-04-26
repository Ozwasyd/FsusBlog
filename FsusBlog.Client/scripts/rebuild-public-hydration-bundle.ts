import { createHash } from 'node:crypto';
import { buildPublicHydrationBundle } from '../src/helpers/publicAotBundle';

type ApiEnvelope<T> = {
  code?: number;
  message?: string;
  data?: T;
};

type ArticleDetailResponse = {
  id: number;
  title: string;
  content: string;
  summary?: string | null;
  views: number;
  createTime: string;
  category?: {
    id: number;
    name: string;
  };
  tags: Array<{
    id: number;
    name: string;
  }>;
};

type ArticleListItemResponse = {
  id: number;
  title: string;
  summary: string;
  snippet?: string;
  views: number;
  createTime: string;
  category: {
    id: number;
    name: string;
  };
  tags: Array<{
    id: number;
    name: string;
  }>;
};

type PageResponse<T> = {
  items: T[];
  total: number;
};

type SeoConfigPublic = {
  title?: string;
  description?: string;
  baseUrl?: string;
};

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000';
const publicBaseUrl = process.env.FSUSBLOG_PUBLIC_BASE_URL || 'http://127.0.0.1:8080';
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin';
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!';
const articleId = Number(process.env.FSUSBLOG_ARTICLE_ID || '1');
const homePage = Number(process.env.FSUSBLOG_HOME_PAGE || '1');
const homeSize = Number(process.env.FSUSBLOG_HOME_SIZE || '10');
const skipHome = process.env.FSUSBLOG_REBUILD_SKIP_HOME === '1';
const deviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'public-hydration-rebuild';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T> | T): T {
  if (payload && typeof payload === 'object' && ('data' in (payload as ApiEnvelope<T>) || 'code' in (payload as ApiEnvelope<T>))) {
    const envelope = payload as ApiEnvelope<T>;
    return (envelope.data ?? payload) as T;
  }

  return payload as T;
}

function hasLeadingDifficulty(hash: Buffer, difficulty: number): boolean {
  const fullBytes = Math.floor(difficulty / 2);
  for (let i = 0; i < fullBytes; i += 1) {
    if (hash[i] !== 0) {
      return false;
    }
  }

  if (difficulty % 2 === 1) {
    return (hash[fullBytes] & 0xf0) === 0;
  }

  return true;
}

function solvePowNonce(salt: string, browserFp: string, difficulty: number): string {
  let nonce = 0;
  while (true) {
    const payload = `${salt}:${nonce}:${browserFp}`;
    const hash = createHash('sha256').update(payload, 'utf8').digest();
    if (hasLeadingDifficulty(hash, difficulty)) {
      return String(nonce);
    }
    nonce += 1;
  }
}

function toSafeBase64(payloadObject: object): string {
  const json = JSON.stringify(payloadObject);
  return Buffer.from(json, 'utf8').toString('base64');
}

function readCookieHeader(response: Response): string {
  const values = response.headers.getSetCookie();
  assert(values && values.length > 0, 'missing set-cookie in login response');

  const pairs: string[] = [];
  for (const raw of values) {
    const idx = raw.indexOf(';');
    pairs.push(idx >= 0 ? raw.slice(0, idx) : raw);
  }

  return pairs.join('; ');
}

function describeBundleEntry(entry: {
  pageId: number;
  routeKey: string;
  articleId?: number | null;
  rendererVersion?: string | null;
  islandsJson?: string | null;
}): string {
  const hasIslands = Boolean(entry.islandsJson && entry.islandsJson.trim().length > 0);
  return `pageId=${entry.pageId} routeKey=${entry.routeKey} articleId=${entry.articleId ?? 'n/a'} rendererVersion=${entry.rendererVersion ?? 'n/a'} islands=${hasIslands ? 'yes' : 'no'}`;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.headers ?? {})
    }
  });

  assert(response.ok, `${path} failed: ${response.status}`);
  const payload = await response.json();
  return unwrapEnvelope<T>(payload);
}

async function fetchChallenge() {
  return await fetchJson<{
    salt: string;
    difficulty: number;
    timestamp: number;
    signature: string;
  }>('/api/Auth/pow-challenge');
}

async function loginWithPow(username: string, password: string): Promise<string> {
  const challenge = await fetchChallenge();
  const browserFp = deviceFingerprint;
  const nonce = solvePowNonce(challenge.salt, browserFp, Number(challenge.difficulty ?? 4));
  const powHeader = toSafeBase64({
    powSalt: challenge.salt,
    powNonce: nonce,
    powTimestamp: challenge.timestamp,
    difficulty: challenge.difficulty,
    powSignature: challenge.signature,
    browserFp
  });

  const response = await fetch(`${baseUrl}/api/Auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Fsus-Pow-Proof': powHeader,
      'X-Fsus-Device-Fp': deviceFingerprint
    },
    body: JSON.stringify({ username, password })
  });

  assert(response.ok, `login failed: ${response.status}`);
  return readCookieHeader(response);
}

async function postWithPow(path: string, cookieHeader: string, body: unknown): Promise<void> {
  const challenge = await fetchChallenge();
  const browserFp = deviceFingerprint;
  const nonce = solvePowNonce(challenge.salt, browserFp, Number(challenge.difficulty ?? 4));
  const powHeader = toSafeBase64({
    powSalt: challenge.salt,
    powNonce: nonce,
    powTimestamp: challenge.timestamp,
    difficulty: challenge.difficulty,
    powSignature: challenge.signature,
    browserFp
  });

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Cookie: cookieHeader,
      'X-Fsus-Pow-Proof': powHeader,
      'X-Fsus-Device-Fp': deviceFingerprint
    },
    body: JSON.stringify(body)
  });

  assert(response.ok, `${path} failed: ${response.status} ${await response.text()}`);
}

async function main() {
  assert(Number.isFinite(articleId) && articleId > 0, 'FSUSBLOG_ARTICLE_ID must be a positive number');

  console.log(
    `[rebuild-public-hydration] start baseUrl=${baseUrl} publicBaseUrl=${publicBaseUrl} articleId=${articleId} homePage=${homePage} homeSize=${homeSize} includeHome=${skipHome ? 'false' : 'true'}`
  );

  const [seo, article] = await Promise.all([
    fetchJson<SeoConfigPublic>('/api/System/seo'),
    fetchJson<ArticleDetailResponse>(`/api/Article/${articleId}`)
  ]);

  const home = skipHome
    ? null
    : await fetchJson<PageResponse<ArticleListItemResponse>>(`/api/Article?page=${homePage}&size=${homeSize}&isDeleted=false`);

  const bundle = await buildPublicHydrationBundle({
    articleId: article.id,
    title: article.title,
    content: article.content,
    summary: article.summary ?? '',
    createTime: article.createTime,
    categoryId: article.category?.id ?? null,
    categoryName: article.category?.name ?? null,
    tags: article.tags,
    siteTitle: seo.title ?? "Fsus's Blog",
    siteDescription: seo.description ?? '记录技术与生活',
    baseUrl: publicBaseUrl || seo.baseUrl?.trim() || baseUrl,
    includeHome: !skipHome,
    homeResponse: home ?? undefined,
    homePage,
    homeSize
  });

  console.log(
    `[rebuild-public-hydration] bundle entries:\n  - ${bundle.entries.map(describeBundleEntry).join('\n  - ')}`
  );

  const cookieHeader = await loginWithPow(adminName, adminPassword);
  await postWithPow(`/api/Article/${article.id}/aot-bundle`, cookieHeader, bundle);

  console.log(`[rebuild-public-hydration] uploaded bundle for article=${article.id}, homePage=${homePage}, entries=${bundle.entries.length}`);
}

main().catch((error) => {
  console.error('[rebuild-public-hydration] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
