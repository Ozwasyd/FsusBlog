#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const clientRoot = process.cwd();
const repoRoot = resolve(clientRoot, '..', '..');

const scanRoots = [
  join(repoRoot, 'src', 'backend'),
  join(repoRoot, 'src', 'core'),
  join(repoRoot, 'src', 'shared')
];

const defaultWhitelist = [
  'src/backend/Program.cs',
  'src/backend/Infrastructure/Audit/',
  'src/backend/Infrastructure/Auth/',
  'src/backend/Infrastructure/Binary/BinaryRequestBinder.cs',
  'src/backend/Infrastructure/Bootstrap/LifecycleHostedBootstrapService.cs',
  'src/backend/Infrastructure/NotificationStream/',
  'src/backend/Infrastructure/NotificationStream/',
  'src/backend/Infrastructure/Cache/',
  'src/backend/Infrastructure/SchemaMigration/',
  'src/backend/Infrastructure/Spa/',
  'src/backend/Infrastructure/Middlewares/',
  'src/backend/Infrastructure/Observability/',
  'src/backend/Infrastructure/Execution/',
  'src/backend/Infrastructure/Filters/',
  'src/backend/Infrastructure/Helpers/',
  'src/backend/Infrastructure/Integrity/IntegrityAdminConsoleService.cs',
  'src/backend/Infrastructure/Integrity/IntegrityProofPipeline.cs',
  'src/backend/Infrastructure/Integrity/IntegrityProofVerification.cs',
  'src/backend/Infrastructure/Integrity/SiteIntegritySigning.cs',
  'src/backend/Infrastructure/Operations/',
  'src/backend/Infrastructure/PublicAot/',
  'src/backend/Infrastructure/PublicReadArtifacts/',
  'src/backend/Infrastructure/PowLoadResetWorker.cs',
  'src/backend/Infrastructure/Results/AedsJsonResults.cs',
  'src/backend/Infrastructure/Security/',
  'src/backend/Infrastructure/Storage/DataProtectionKeyRingProbe.cs',
  'src/backend/Infrastructure/Storage/ReleaseDerivedArtifactPublisher.cs',
  'src/backend/Infrastructure/Storage/UploadCommitTempCleanupLease.cs',
  'src/backend/Modules/Endpoints/AuthoringEndpoints.cs',
  'src/backend/Modules/Endpoints/AdminIntegrityConsoleEndpoints.cs',
  'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.cs',
  'src/backend/Modules/Endpoints/Binary/',
  'src/backend/Modules/Endpoints/LocalAuthFixtureEndpoints.cs',
  'src/backend/Modules/Endpoints/LocalAuthFixtureRefreshRunner.cs',
  'src/backend/Modules/Endpoints/NotificationStreamDrillEndpoints.cs',
  'src/backend/Modules/Endpoints/SecurityEndpoints.cs',
  'src/backend/Services/Background/',
  'src/backend/Services/ArticleMutationSideEffects.cs',
  'src/backend/Services/ArticleService.cs',
  'src/backend/Services/ArticleViewWriteBuffer.cs',
  'src/backend/Services/Authoring/AuthoringWorkflowService.cs',
  'src/backend/Services/FileService.cs',
  'src/backend/Services/Moderation/',
  'src/backend/Services/SearchIndexService.cs',
  'src/backend/Services/Security/',
  'src/backend/Services/Subscriptions/SiteSubscriptionProofService.cs',
  'src/backend/Services/Telemetry/',
  'src/backend/Services/UserService.cs',
  'src/backend/Services/UserService.Ports.cs',
  'src/backend/Services/NotificationStream/',
  'src/backend/Services/VisitLog/',
  'src/core/Cache/',
  'src/core/Integrity/ArtifactDigestV1.cs',
  'src/core/Mapping/Codecs/',
  'src/shared/Contracts/Outputs/',
  'src/shared/Contracts/Security/'
];

const extraWhitelist = (process.env.FSUSBLOG_TRY_CATCH_WHITELIST ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const whitelist = [...defaultWhitelist, ...extraWhitelist].map(normalizeRelativePath);

function normalizeRelativePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, value.endsWith('/') ? '/' : '');
}

function walkCsFiles(dir, output = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (shouldSkip(entry.name)) {
      continue;
    }

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkCsFiles(fullPath, output);
      continue;
    }

    if (entry.isFile() && fullPath.endsWith('.cs') && !fullPath.endsWith('.g.cs') && !fullPath.endsWith('.generated.cs')) {
      output.push(fullPath);
    }
  }

  return output;
}

function shouldSkip(name) {
  return name === 'bin'
    || name === 'obj'
    || name === '.git'
    || name === '.codex'
    || name === '.vscode'
    || name === 'node_modules'
    || name === 'dist'
    || name === 'BenchmarkDotNet.Artifacts';
}

function isWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function isIdentStart(char) {
  return (char >= 'A' && char <= 'Z')
    || (char >= 'a' && char <= 'z')
    || char === '_';
}

function isIdentPart(char) {
  return isIdentStart(char) || (char >= '0' && char <= '9');
}

function isWhitelisted(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  return whitelist.some((entry) => {
    if (entry.endsWith('/')) {
      return normalized.startsWith(entry);
    }

    return normalized === entry;
  });
}

function previousNonWhitespace(source, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (!isWhitespace(source[i])) {
      return source[i];
    }
  }

  return '';
}

function findTryCatchViolations(source) {
  const violations = [];
  let state = 'code';
  let rawQuoteCount = 0;
  let line = 1;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1] ?? '';

    if (char === '\n') {
      line++;
    }

    if (state === 'lineComment') {
      if (char === '\n') {
        state = 'code';
      }
      continue;
    }

    if (state === 'blockComment') {
      if (char === '*' && next === '/') {
        state = 'code';
        i++;
      }
      continue;
    }

    if (state === 'string') {
      if (char === '\\') {
        i++;
        continue;
      }

      if (char === '"') {
        state = 'code';
      }
      continue;
    }

    if (state === 'verbatimString') {
      if (char === '"' && next === '"') {
        i++;
        continue;
      }

      if (char === '"') {
        state = 'code';
      }
      continue;
    }

    if (state === 'char') {
      if (char === '\\') {
        i++;
        continue;
      }

      if (char === '\'') {
        state = 'code';
      }
      continue;
    }

    if (state === 'rawString') {
      let quoteCount = 0;
      while (source[i + quoteCount] === '"') {
        quoteCount++;
      }

      if (quoteCount >= rawQuoteCount) {
        i += quoteCount - 1;
        state = 'code';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      state = 'lineComment';
      i++;
      continue;
    }

    if (char === '/' && next === '*') {
      state = 'blockComment';
      i++;
      continue;
    }

    if (char === '"') {
      let quoteCount = 1;
      while (source[i + quoteCount] === '"') {
        quoteCount++;
      }

      if (quoteCount >= 3) {
        state = 'rawString';
        rawQuoteCount = quoteCount;
        i += quoteCount - 1;
        continue;
      }

      const previous = previousNonWhitespace(source, i);
      const beforePrevious = previousNonWhitespace(source, i - 1);
      if (previous === '@' || (previous === '$' && beforePrevious === '@') || (previous === '@' && beforePrevious === '$')) {
        state = 'verbatimString';
      } else {
        state = 'string';
      }
      continue;
    }

    if (char === '\'') {
      state = 'char';
      continue;
    }

    if (!isIdentStart(char)) {
      continue;
    }

    const start = i;
    let end = i + 1;
    while (end < source.length && isIdentPart(source[end])) {
      end++;
    }

    const token = source.slice(start, end);
    const before = source[start - 1] ?? '';
    const after = source[end] ?? '';
    const isBoundaryBefore = !isIdentPart(before);
    const isBoundaryAfter = !isIdentPart(after);

    if (isBoundaryBefore && isBoundaryAfter && (token === 'try' || token === 'catch')) {
      violations.push({ token, line });
    }

    i = end - 1;
  }

  return violations;
}

const violations = [];

for (const root of scanRoots) {
  for (const filePath of walkCsFiles(root)) {
    const relativePath = relative(repoRoot, filePath).split(sep).join('/');
    if (isWhitelisted(relativePath)) {
      continue;
    }

    const source = readFileSync(filePath, 'utf8');
    const fileViolations = findTryCatchViolations(source);
    for (const violation of fileViolations) {
      violations.push({
        path: relativePath,
        line: violation.line,
        token: violation.token
      });
    }
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`[server-try-catch] violation: ${violation.path}:${violation.line} contains "${violation.token}" outside whitelist`);
  }

  console.error(`[server-try-catch] failed total=${violations.length} whitelist=${whitelist.length}`);
  process.exit(1);
}

console.log(`[server-try-catch] ok total=0 whitelist=${whitelist.length} scanned=${scanRoots.length}`);
