#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(new URL('../..', import.meta.url).pathname)
const findingsPath = resolve(root, '.tmp/ux/usability-findings.json')
const requiredTaskIds = [
  'find_article',
  'login_and_messages',
  'create_draft',
  'publish_with_seo',
  'moderate_comment',
  'reply_ticket',
  'mobile_restore_trash'
]
const requiredFindingFields = [
  'participantId',
  'taskId',
  'pausePoints',
  'misclicks',
  'backtrackCount',
  'rereadCount',
  'confusionPoints',
  'completionTimeSeconds',
  'completed'
]

function fail(message) {
  console.error(`[ux-findings] ${message}`)
  process.exit(1)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const data = readJson(findingsPath)
if (data.version !== 1) fail('version must be 1')
if (typeof data.studyDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.studyDate)) {
  fail('studyDate must use YYYY-MM-DD')
}
if (!Array.isArray(data.participants)) fail('participants must be an array')
if (data.participants.length > 0 && (data.participants.length < 5 || data.participants.length > 8)) {
  fail('participants must contain 5-8 people once a study starts')
}
if (!Array.isArray(data.tasks)) fail('tasks must be an array')
const taskIds = new Set(data.tasks.map((task) => task?.id))
for (const taskId of requiredTaskIds) {
  if (!taskIds.has(taskId)) fail(`missing task ${taskId}`)
}
if (!Array.isArray(data.findings)) fail('findings must be an array')
for (const [index, finding] of data.findings.entries()) {
  for (const field of requiredFindingFields) {
    if (!(field in finding)) fail(`findings[${index}] missing ${field}`)
  }
  if (!taskIds.has(finding.taskId)) fail(`findings[${index}] references unknown taskId`)
  if (!Array.isArray(finding.pausePoints)) fail(`findings[${index}].pausePoints must be an array`)
  if (!Array.isArray(finding.misclicks)) fail(`findings[${index}].misclicks must be an array`)
  if (!Array.isArray(finding.confusionPoints)) fail(`findings[${index}].confusionPoints must be an array`)
  if (!Number.isInteger(finding.backtrackCount) || finding.backtrackCount < 0) fail(`findings[${index}].backtrackCount invalid`)
  if (!Number.isInteger(finding.rereadCount) || finding.rereadCount < 0) fail(`findings[${index}].rereadCount invalid`)
  if (typeof finding.completed !== 'boolean') fail(`findings[${index}].completed must be boolean`)
}

console.log(`[ux-findings] ok: ${data.tasks.length} tasks, ${data.findings.length} findings`)
