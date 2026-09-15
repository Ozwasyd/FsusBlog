import fs from 'node:fs'

import {
  exactAssertionResult,
  mapConcurrent,
  produceMeasuredScenarioReceipt
} from '../run-runtime-cache-evidence.mjs'
import { evaluateLogicalPaginationDatabaseCommands } from '../runtime-cache-evidence-contract.mjs'
import { createScenarioApi } from './runtime-scenario-support.mjs'

function paginationInput(identity) {
  const fixture = JSON.parse(fs.readFileSync(identity.fixtureFile, 'utf8'))
  const pagination = fixture.pagination ?? fixture.producerOutputs?.['public-content']?.projection?.pagination
  if (!pagination || pagination.route !== 'article/list/home' || pagination.sort !== 'latest' || pagination.pageSize !== 10) {
    throw new Error('pagination requires the current prepared runtime-cache-pagination projection')
  }
  const expectedPages = [10, 100, 1000]
  const cursors = new Map((pagination.cursors ?? []).map((item) => [item.logicalPage, item.cursor]))
  if (expectedPages.some((page) => typeof cursors.get(page) !== 'string' || cursors.get(page).length === 0)) {
    throw new Error('pagination projection lacks production page 10/100/1000 cursors')
  }
  return { ...pagination, cursors }
}

function route(page, size, parameters) {
  const query = new URLSearchParams(parameters)
  return `/api/binary/article/list/home/${page}/${size}.aeds?${query}`
}

function logicalSpec(input, logicalPage) {
  const cursor = logicalPage === 1 ? null : input.cursors.get(logicalPage)
  return {
    method: 'GET',
    path: route(logicalPage, input.pageSize, {
      sort: input.sort,
      ...(cursor === null ? {} : { cursor })
    }),
    subcaseId: `page-${logicalPage}`,
    parityGroup: `pagination-page-${logicalPage}`,
    headers: {}
  }
}

function cursorlessSpec(input, logicalPage) {
  return {
    method: 'GET',
    path: route(logicalPage, input.pageSize, {
      sort: input.sort
    }),
    subcaseId: 'cursorless-deep',
    parityGroup: `pagination-cursorless-${logicalPage}`,
    headers: {}
  }
}

export async function producePaginationReceipt(options) {
  const { scenario, identity, baseUrl } = options
  const input = paginationInput(identity)
  const logicalPages = scenario.requirements.logicalPages
  const api = options.scenarioApi ? createScenarioApi(options) : null
  let cacheBoundary

  return produceMeasuredScenarioReceipt(options, {
    warmup: async ({ collect, runId }) => {
      const specs = Array.from({ length: scenario.warmupRequests }, () => ({
        method: 'GET',
        path: '/api/binary/system/seo',
        subcaseId: 'page-1',
        parityGroup: 'pagination-warmup',
        headers: {}
      }))
      const requests = await mapConcurrent(specs, scenario.concurrency, (spec, index) => collect(spec, index, 'warmup'))
      if (api) {
        const baseUrls = [baseUrl]
        if (options.secondaryBaseUrl && options.secondaryBaseUrl !== baseUrl) {
          baseUrls.push(options.secondaryBaseUrl)
        }
        const results = await Promise.all(baseUrls.map((nodeBaseUrl, index) => api.cleanup(nodeBaseUrl, {
          scenario: 'pagination',
          runId,
          articleId: 0,
          eventId: null,
          keyCount: 0,
          deleteDurable: false,
          deleteShared: index === 0
        })))
        cacheBoundary = {
          nodes: results,
          measuredBaseUrl: baseUrl
        }
      }
      return requests
    },
    sample: async ({ collect }) => {
      const logical = []
      for (const [index, page] of logicalPages.entries()) {
        logical.push(await collect(logicalSpec(input, page), index))
      }
      const cursorlessPages = [10, 100, 1000, 1001]
      const cursorless = []
      for (const [index, page] of cursorlessPages.entries()) {
        cursorless.push(await collect(cursorlessSpec(input, page), logical.length + index))
      }
      const requests = [...logical, ...cursorless]
      const dbCounts = Object.fromEntries(logical.map((request) =>
        [Number.parseInt(request.subcaseId.slice('page-'.length), 10), request.dbCommands.length]))
      const logicalPageCommandResult = evaluateLogicalPaginationDatabaseCommands(dbCounts, scenario.requirements)
      const logicalPageCommandExpected = Object.fromEntries(
        Object.keys(logicalPageCommandResult).map((key) => [key, true]))
      const deepReferenceCount = logical[1]?.dbCommands.length
      const firstLogicalFailure = logical[0].dbCommands.length > scenario.requirements.countCacheMissDbCommandsMax
        ? logical[0]
        : logical.slice(1).find((request) =>
            request.dbCommands.length > scenario.requirements.countCacheHitDbCommandsMax ||
            request.dbCommands.length !== deepReferenceCount) ??
          logical.find((request) => request.dbCommands.length === 0) ??
          logical[0]
      const cursorlessCounts = {
        redis: cursorless.reduce((sum, request) => sum + request.redisCommands.length, 0),
        database: cursorless.reduce((sum, request) => sum + request.dbCommands.length, 0)
      }
      return {
        requests,
        assertionResults: [
          exactAssertionResult(
            'logical-page-command-constant',
            logicalPageCommandExpected,
            logicalPageCommandResult,
            firstLogicalFailure),
          exactAssertionResult(
            'cursorless-deep-zero-commands',
            { redis: 0, database: 0 },
            cursorlessCounts,
            cursorless.find((request) => request.redisCommands.length > 0 || request.dbCommands.length > 0) ?? cursorless[0])
        ],
        parameters: {
          route: '/api/binary/article/list/home/{page}/10.aeds',
          sort: input.sort,
          generation: input.generation,
          articleCount: input.articleCount,
          ownedArticleCount: input.ownedArticleCount,
          logicalPages,
          cursorlessPages,
          cacheBoundary
        }
      }
    }
  })
}
