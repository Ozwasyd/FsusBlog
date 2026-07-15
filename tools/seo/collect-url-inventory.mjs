#!/usr/bin/env node

import process from 'node:process'
import { collectUrlInventory, writeJson } from './measurement-lib.mjs'

function args(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) values[argv[index]?.replace(/^--/u, '')] = argv[index + 1]
  return values
}

const options = args(process.argv.slice(2))
const siteUrl = options.site ?? process.env.FSUSBLOG_SEARCH_CONSOLE_SITE
if (!siteUrl) {
  console.error('[seo-inventory] --site or FSUSBLOG_SEARCH_CONSOLE_SITE is required')
  process.exit(2)
}
const inventory = await collectUrlInventory({
  siteUrl,
  concurrency: options.concurrency ? Number(options.concurrency) : undefined
})
const output = options.output ?? '.tmp/seo/url-inventory-input.json'
writeJson(output, inventory)
console.log(`[seo-inventory] urls=${inventory.urls.length} sitemaps=${inventory.sitemapSources.length} output=${output}`)
