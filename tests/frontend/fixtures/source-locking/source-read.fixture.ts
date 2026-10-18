import { readFileSync } from 'node:fs'
import '../../unit/view-contracts/aboutPage.test.ts'

const repoFile = (path: string): string => path
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

readRepoFile('src/frontend/src/example.ts')
