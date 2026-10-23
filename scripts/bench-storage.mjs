#!/usr/bin/env node
/**
 * Storage baseline (docs/DESIGN-CORE-CHANNELS.md, phase 0): how long the workbench takes to read its data, write one
 * change, build the page snapshot, and run one idle background step, with synthetic tasks of realistic size.
 * Run after `pnpm run build`:  node scripts/bench-storage.mjs [task counts, default 100,1000,3000]
 * Data goes to a temporary folder that is removed afterwards; nothing touches your workbench data.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../lib/store.js'
import { Engine } from '../lib/engine.js'
import { WorkbenchApi } from '../lib/api.js'

const counts = (process.argv[2] || '100,1000,3000').split(',').map(Number).filter(n => Number.isSafeInteger(n) && n > 0)
const words = ['报价', '合同', '发票', '交期', '样品', '付款', '型号', '数量', '会议', '确认']
/** About 13 KB of UTF-8 text plus a short history, close to the 14 KB per task seen in real data. */
const syntheticTask = i => {
  const at = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(), status = ['review', 'sent', 'completed', 'unmatched', 'ignored'][i % 5]
  return {
    id: randomUUID(), revision: 1, title: `产品询价 ${i}`, account: 'sales', status, from: `客户 ${i % 50} <buyer${i % 50}@example.test>`, subject: `产品询价 ${i}`,
    body: Array.from({ length: 300 }, (_, k) => words[(i + k) % words.length] + '内容' + k).join('，'),
    receivedAt: at, updatedAt: at, source: { account: 'sales', folder: 'INBOX', uid: i + 1, uidValidity: 7 }, attachments: [], attempts: 1,
    history: Array.from({ length: 6 }, (_, k) => ({ at, message: `处理记录 ${k}` })), summary: '已整理客户需求。', triage: { state: 'done', category: 'request', urgency: 'normal' },
  }
}
const time = async (runs, work) => {
  const samples = []
  for (let i = 0; i < runs; i++) { const start = performance.now(); await work(i); samples.push(performance.now() - start) }
  samples.sort((a, b) => a - b)
  return { p50: samples[Math.floor(runs / 2)], p95: samples[Math.floor(runs * 0.95)] }
}
const ms = value => value.toFixed(value < 10 ? 2 : 0).padStart(8)

console.log('tasks  file MB  read p50/p95 ms    write p50/p95 ms   snapshot p50/p95 ms  snapshot MB  idle step ms')
for (const count of counts) {
  const root = await mkdtemp(join(tmpdir(), 'bkms-bench-'))
  try {
    const store = new Store(root)
    await store.mutate(state => { for (let i = 0; i < count; i++) state.tasks.push(syntheticTask(i)) })
    const size = (await stat(store.file)).size
    const engine = new Engine(store, () => undefined, { available: () => false, async run() { throw new Error('unused') } })
    const api = new WorkbenchApi(engine)
    await engine.start()
    try {
      const runs = count > 2000 ? 5 : 20
      const read = await time(runs, () => store.read())
      const ids = (await store.read()).tasks.map(task => task.id)
      const write = await time(runs, i => store.mutate(state => { const task = state.tasks.find(item => item.id === ids[(i * 37) % ids.length]); task.summary = `新摘要 ${i}`; task.revision++ }))
      let bytes = 0
      const snapshot = await time(runs, async () => { bytes = Buffer.byteLength(JSON.stringify(await api.snapshot())) })
      // processNext with nothing queued: the background does this on every tick while processing is on.
      const idle = await time(runs, () => engine.processNext())
      console.log(`${String(count).padStart(5)} ${(size / 1048576).toFixed(1).padStart(8)} ${ms(read.p50)} /${ms(read.p95)} ${ms(write.p50)} /${ms(write.p95)} ${ms(snapshot.p50)} /${ms(snapshot.p95)} ${(bytes / 1048576).toFixed(1).padStart(10)} ${ms(idle.p50)}`)
    } finally { await engine.stop() }
  } finally { await rm(root, { recursive: true, force: true }) }
}
