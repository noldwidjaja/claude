import { expect, mock, test } from 'claude-code/testing'

import type { RenderElement } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

import { bar, hpColor, untilReset, windowsOf } from './register'

type On = Parameters<TestBody>[1]

// What another mod beneath draws in the band, kept under the meters.
const beneath = (on: On) =>
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return h(Box, {}, h(Text, {}, 'beneath')) as RenderElement
  })

const NOW = Date.parse('2026-10-06T12:00:00Z')

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('each limit is an HP bar with its reset countdown', async ($, on) => {
  beneath(on)
  const toasts: string[] = []
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('store.set', () => ({ value: undefined }))
  mock.clock(on, { now: NOW })

  const measure = (percentUsed: number) =>
    $.session.measure({
      context: { window: 200000, tokens: 68000, percent: 34 },
      rateLimits: [
        { kind: 'five_hour', percentUsed, resetsAt: new Date(NOW + 134 * 60_000).toISOString() },
        { kind: 'seven_day', percentUsed: 41, resetsAt: new Date(NOW + (3 * 1440 + 4 * 60) * 60_000).toISOString() },
      ],
      changed: ['rateLimits'],
    })

  await measure(24)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-status', surface, ...BAND })
    expect(await ui.find({ text: '76 HP' })).toBeDefined()
    expect(await ui.find({ text: 'beneath' })).toBeDefined()
    expect(await ui.find({ text: '59 HP' })).toBeDefined()
    expect(await ui.find({ text: '2h 14m' })).toBeDefined()
    expect(await ui.find({ text: '3d 4h' })).toBeDefined()
    expect(await ui.find({ text: '66 EN' })).toBeDefined()
    expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { flexDirection: 'column' } })
    await ui.unmount()
  }

  expect(toasts).toEqual([])
  await measure(91)
  await measure(93)
  expect(toasts).toEqual(['5h at 9 HP left'])
})

test('the ctx row has a Compact button, hidden while a turn runs', async ($, on) => {
  beneath(on)
  let compactions = 0
  const toasts: string[] = []
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.compact', () => (compactions++, { skip: 'nothing to compact' }))
  mock.clock(on, { now: NOW })

  await $.session.measure({
    context: { window: 200000, tokens: 160000, percent: 80 },
    rateLimits: [],
    changed: ['context'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const busy = await $.ui.mount({ plugin: 'usage-status', surface, ...BAND, props: { ...BAND.props, isWorking: true } })
    expect(await busy.find({ key: 'compact' })).toBeUndefined()
    await busy.unmount()

    const ui = await $.ui.mount({ plugin: 'usage-status', surface, ...BAND })
    expect(await ui.find({ text: '20 EN' })).toBeDefined()
    await ui.press({ key: 'compact' })
    await ui.unmount()
  }

  expect(compactions).toBe(2)
  expect(toasts).toEqual(["Didn't compact: nothing to compact", "Didn't compact: nothing to compact"])
})

test('a window left out of a reading, or past its reset, shows full', async ($, on) => {
  beneath(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('store.set', () => ({ value: undefined }))
  mock.clock(on, { now: NOW })

  const measure = (rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]) =>
    $.session.measure({ context: { window: 200000 }, rateLimits, changed: ['rateLimits'] })

  await measure([{ kind: 'seven_day', percentUsed: 41 }])
  await measure([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-status', surface, ...BAND })
    expect(await ui.find({ text: '5h' })).toBeDefined()
    expect(await ui.find({ text: '7d' })).toBeDefined()
    expect(await ui.find({ text: '100 HP' })).toBeDefined()
    expect(await ui.find({ text: '█'.repeat(20) })).toBeDefined()
    await ui.unmount()
  }
})

test('which windows draw', () => {
  const past = new Date(NOW - 60_000).toISOString()
  const soon = new Date(NOW + 60_000).toISOString()

  expect(windowsOf([], false, NOW)).toEqual([])
  expect(windowsOf([], true, NOW)).toEqual([{ kind: 'five_hour', percentUsed: 0 }, { kind: 'seven_day', percentUsed: 0 }])
  expect(windowsOf([{ kind: 'five_hour', percentUsed: 80, resetsAt: past }], true, NOW)[0]).toEqual({ kind: 'five_hour', percentUsed: 0 })
  expect(windowsOf([{ kind: 'five_hour', percentUsed: 80, resetsAt: soon }], true, NOW)[0]?.percentUsed).toBe(80)
  expect(windowsOf([{ kind: 'spend_limit', percentUsed: 5 }], true, NOW).map(w => w.kind)).toEqual(['five_hour', 'seven_day', 'spend_limit'])
})

test('the bar empties and reddens as HP drops', () => {
  expect(bar(100)).toEqual({ full: '█'.repeat(20), empty: '' })
  expect(bar(59)).toEqual({ full: '█'.repeat(12), empty: '░'.repeat(8) })
  expect(bar(0)).toEqual({ full: '', empty: '░'.repeat(20) })
  expect([hpColor(76), hpColor(40), hpColor(9)]).toEqual(['success', 'warning', 'error'])
})

test('countdowns read in days, hours or minutes', () => {
  expect(untilReset('2026-10-06T12:07:30Z', NOW)).toBe('8m')
  expect(untilReset('2026-10-06T11:00:00Z', NOW)).toBe('0m')
  expect(untilReset('2026-10-08T15:00:00Z', NOW)).toBe('2d 3h')
})
