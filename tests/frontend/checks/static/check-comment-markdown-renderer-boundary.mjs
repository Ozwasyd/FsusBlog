#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), '../..')
const source = readFileSync(resolve(root, 'src/frontend/src/components/article/CommentMarkdownRenderer.vue'), 'utf8')
const errors = []

function fail(message) {
  errors.push(message)
}

// CSS boundary assertions
if ((source.match(/:deep\s*\(/gu) ?? []).length !== 0) {
  fail('CommentMarkdownRenderer must not use :deep() selectors')
}
if (!source.includes('[data-fsus-comment-markdown] .markdown-body p:last-child')) {
  fail('CommentMarkdownRenderer must own p:last-child via stable data hook')
}
if (!source.includes('[data-fsus-comment-markdown] .markdown-body pre')) {
  fail('CommentMarkdownRenderer must own pre via stable data hook')
}
if (!source.includes('[data-fsus-comment-markdown] .markdown-body :is(img, svg, iframe)')) {
  fail('CommentMarkdownRenderer must own img/svg/iframe via stable data hook')
}
if (source.includes('.shiki')) {
  fail('CommentMarkdownRenderer must not contain .shiki - delegated to MarkdownRenderer')
}
if (/\.el-[a-z0-9_-]+/iu.test(source)) {
  fail('CommentMarkdownRenderer must not contain Element Plus internal selectors')
}
if (source.includes('!important')) {
  fail('CommentMarkdownRenderer must not use !important')
}
if (/margin(?:-inline|-block|-left|-right|-top|-bottom)?:\s*-/u.test(source)) {
  fail('CommentMarkdownRenderer must not use negative margin')
}
if (/position:\s*absolute/u.test(source)) {
  fail('CommentMarkdownRenderer must not use position:absolute')
}

if (errors.length > 0) {
  console.error(errors.map((e) => `[comment-markdown-renderer-boundary] ${e}`).join('\n'))
  process.exit(1)
}
console.log('[comment-markdown-renderer-boundary] ok')
