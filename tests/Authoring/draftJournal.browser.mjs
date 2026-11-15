import { deepStrictEqual, equal } from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const requireFsusUi = createRequire(new URL('../../../FsusUI/package.json', import.meta.url))
const { chromium } = requireFsusUi('playwright')
const chrome = process.env.FSUSBLOG_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const fixture = new Map([
  ['/src/Web/src/authoring/draftJournal.ts', '../../src/Web/src/authoring/draftJournal.ts'],
  ['/src/Contracts/wire.generated.ts', '../../src/Contracts/wire.generated.ts'],
  ['/src/Contracts/binary.ts', '../../src/Contracts/binary.ts'],
])

test('IndexedDB recovery after browser restart, local writer isolation, expiry and cleanup', async () => {
  await access(chrome)
  const modules = new Map(await Promise.all(Array.from(fixture, async ([key, path]) =>
    [key, stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), 'utf8'))])))
  const server = createServer((request, response) => {
    if (request.url === '/') return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<title>Draft recovery fixture</title>')
    const module = modules.get(request.url)
    if (module === undefined) return response.writeHead(404).end()
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(module)
  })
  const profile = await mkdtemp(join(tmpdir(), 'fsusblog-v2-journal-'))
  let context
  try {
    await new Promise((ready, fail) => {
      server.once('error', fail)
      server.listen(0, '127.0.0.1', ready)
    })
    const url = `http://127.0.0.1:${server.address().port}`
    const launch = () => chromium.launchPersistentContext(resolve(profile), { executablePath: chrome, headless: true })
    context = await launch()
    let page = context.pages()[0]
    await page.goto(url)
    const modulePath = '/src/Web/src/authoring/draftJournal.ts'
    const time = Date.now() - 1000
    deepStrictEqual(await page.evaluate(async ({ modulePath, time }) => {
      const { DraftJournal } = await import(modulePath)
      Date.now = () => time
      const first = await DraftJournal.open({ site: 'example.test', userId: 'user-1' })
      const second = await DraftJournal.open({ site: 'example.test', userId: 'user-1' })
      const a = { articleId: 21 }
      const b = { articleId: 22 }
      const fresh = { createDraftId: '89bf111b-e994-4788-9218-583ec33dce95' }
      const source = { baseRevision: 1n, title: '原始 🐝', body: '未确认的内容', editSequence: 1 }
      const otherWriter = { ...source, body: 'Another tab' }
      const secondArticle = { ...source, body: 'Another article' }
      const dispositions = await Promise.all([
        first.write(a, source),
        second.write(a, otherWriter),
        first.write(b, secondArticle),
      ])
      const copies = [{ target: a, source }, { target: b, source: secondArticle }]
      const copyChecks = [
        await first.verifyCopies(copies),
        await first.verifyCopies([{ target: a, source: { ...source, baseRevision: 2n } }]),
        await first.verifyCopies([{ target: a, source: { ...source, editSequence: 2 } }]),
        await second.verifyCopies([{ target: a, source: otherWriter }, copies[1]]),
      ]
      const started = first.write(b, { ...source, body: 'Save before write', editSequence: 2 })
      await first.acknowledge(b, 2)
      dispositions.push(await started)
      copyChecks.push(await first.verifyCopies(copies))
      const old = first.write(a, { ...source, body: 'Older', editSequence: 2 })
      const updated = first.write(a, { ...source, body: '新内容 🐈', editSequence: 3 })
      await Promise.all([old, updated])
      await first.acknowledge(a, 2)
      await first.write(fresh, { ...source, body: 'New unpersisted draft', baseRevision: 0n })
      first.close()
      second.close()
      return { dispositions, copyChecks }
    }, { modulePath, time }), { dispositions: ['stored', 'stored', 'stored', 'stale'], copyChecks: [true, false, false, false, false] })
    await context.close()
    context = await launch()
    page = context.pages()[0]
    await page.goto(url)
    const actual = await page.evaluate(async ({ modulePath, time }) => {
      const { DraftJournal, draftJournalLifetimeMs } = await import(modulePath)
      const scope = { site: 'example.test', userId: 'user-1' }
      const target = { articleId: 21 }
      const durable = { title: 'Published before', body: 'Server revision', revision: 2n }
      const journal = await DraftJournal.open(scope)
      const other = await DraftJournal.open({ ...scope, userId: 'user-2' })
      const otherSite = await DraftJournal.open({ ...scope, site: 'test.example.test' })
      Date.now = () => time + draftJournalLifetimeMs - 1
      const beforeExpiry = await journal.inspect(target, durable)
      const newDrafts = await journal.inspectNew()
      const clean = (await journal.inspect({ articleId: 22 }, durable)).length
      const isolated = [await other.inspect(target, durable), await otherSite.inspect(target, durable)].flat().length
      const removed = beforeExpiry.find(record => record.body === 'Another tab')
      if (removed) await journal.discard(target, removed)
      const afterDiscard = (await journal.inspect(target, durable)).length
      Date.now = () => time + draftJournalLifetimeMs
      const afterExpiry = (await journal.inspect(target, durable)).length
      const source = { title: durable.title, body: 'New edit after expiry', baseRevision: 2n, editSequence: 4 }
      await journal.write(target, source)
      const next = await journal.inspect(target, durable)
      const copyBeforePurge = await journal.verifyCopies([{ target, source }])
      const secondWriter = await DraftJournal.open(scope)
      const purgeRace = journal.write(target, { ...source, editSequence: 5, body: 'Logout race' })
      await journal.purge()
      const purgeDisposition = await purgeRace
      const afterPurge = (await journal.inspect(target, durable)).length
      const copyAfterPurge = await journal.verifyCopies([{ target, source }])
      const oldTabAfterLogout = await secondWriter.write(target, { ...source, editSequence: 9, body: 'Old tab' })
      const reauth = await DraftJournal.open(scope)
      const afterReauth = await reauth.write(target, { ...source, editSequence: 1, body: 'New login' })
      secondWriter.close()
      reauth.close()
      journal.close()
      other.close()
      otherSite.close()
      return {
        records: beforeExpiry.map(({ body, relationship }) => [body, relationship]).sort(),
        newDrafts: newDrafts.map(({ body, target }) => [body, target]),
        clean, isolated, afterDiscard, afterExpiry, purgeDisposition, afterPurge, oldTabAfterLogout, afterReauth,
        copyBeforePurge, copyAfterPurge,
        next: next[0]?.relationship, localStorageKeys: Object.keys(localStorage), sessionStorageKeys: Object.keys(sessionStorage),
      }
    }, { modulePath, time })
    deepStrictEqual(actual, {
      records: [['Another tab', 'compare'], ['新内容 🐈', 'compare']],
      newDrafts: [['New unpersisted draft', { createDraftId: '89bf111b-e994-4788-9218-583ec33dce95' }]],
      clean: 0, isolated: 0, afterDiscard: 1, afterExpiry: 0, purgeDisposition: 'closed', afterPurge: 0,
      oldTabAfterLogout: 'closed', afterReauth: 'stored',
      copyBeforePurge: true, copyAfterPurge: false,
      next: 'restore', localStorageKeys: [], sessionStorageKeys: [],
    })
    equal(context.browser()?.isConnected() ?? true, true)
  } finally {
    await context?.close()
    await new Promise(resolveClose => server.close(resolveClose))
    await rm(profile, { recursive: true, force: true })
  }
})
