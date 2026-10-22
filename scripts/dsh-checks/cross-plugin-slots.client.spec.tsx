// @vitest-environment jsdom
/**
 * Phase 0 check for docs/DESIGN-CORE-CHANNELS.md §4.6, run against DSH's production slot registry and renderer.
 * One plugin (the workbench) declares a keyed child slot on its own entry; another plugin (a channel) registers into
 * it through ctx.slots.inject, in either load order; uninstalling the channel falls back to the workbench's content.
 *
 * To run: copy into <deepseek-harness>/packages/test-support/client-runtime/tests/ and run
 *   pnpm vitest run packages/test-support/client-runtime/tests/cross-plugin-slots.client.spec.tsx
 * then delete the copy.
 */
import { afterEach, expect, it } from 'vitest'
import { act } from '@testing-library/react'
import { createElement as h } from 'react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'

const runtimes: SlotTestRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose() })

/** The workbench: its entry declares one child slot per channel and renders a generic fallback for unclaimed keys. */
const workbench = {
  name: 'check-workbench',
  inject: ['slots'],
  apply(ctx: any) {
    ctx.slots.inject('check.main', () => ctx.slots.register(
      { name: 'check.main', children: { 'check.channel.settings': { kind: 'keyed', scope: 'root' } } },
      (props: any) => h('section', null, ['email', 'wechat'].map(kind => h('div', { key: kind, 'data-channel': kind },
        props.renderSlot('check.channel.settings', { kind }, { entryKey: kind, fallback: h('span', null, `generic:${kind}`) })))),
    ))
  },
}
/** A channel plugin: fills the workbench's child slot for its own key. */
const wechat = {
  name: 'check-wechat',
  inject: ['slots'],
  apply(ctx: any) {
    ctx.slots.inject('check.channel.settings', () => ctx.slots.register(
      { name: 'check.channel.settings', key: 'wechat' },
      (props: any) => h('span', null, `wechat-settings:${props.kind}`),
    ))
  },
}

for (const order of ['workbench first', 'channel first'] as const) {
  it(`a channel plugin fills the workbench's child slot (${order})`, async () => {
    const runtime = await SlotTestRuntime.create()
    runtimes.push(runtime)
    await runtime.declare({ 'check.main': { kind: 'single', scope: 'root' } } as never)
    const plugins = order === 'workbench first' ? [workbench, wechat] : [wechat, workbench]
    const handles = []
    for (const plugin of plugins) handles.push(await runtime.mount(plugin as never))
    const view = runtime.renderSlot('check.main' as never, {} as never)
    const text = (kind: string) => view.container.querySelector(`[data-channel="${kind}"]`)?.textContent
    expect(text('wechat')).toBe('wechat-settings:wechat')
    expect(text('email')).toBe('generic:email')
    await act(async () => { await handles[plugins.indexOf(wechat)].dispose() })
    expect(text('wechat')).toBe('generic:wechat')
  })
}
