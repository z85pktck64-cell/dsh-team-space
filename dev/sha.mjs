#!/usr/bin/env node
// 计算 lib/client.js 的指纹（与宿主 hashOfText 一致：sha256 hex）
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const text = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
console.log(createHash('sha256').update(text).digest('hex'))
