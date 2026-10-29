import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { promptOf, stepsOf, summaryOf, wrap } from './register'

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'rename greet to welcome<system-reminder>ignore me</system-reminder>', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [
      { tool_use_id: 't1', tool: 'Grep', input: { pattern: 'greet' } },
      { tool_use_id: 't2', tool: 'Edit', input: { file_path: '/repo/src/a.ts' } },
      { tool_use_id: 't3', tool: 'Edit', input: { file_path: '/repo/src/a.ts' } },
    ],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false }] },
  {
    role: 'assistant',
    text: 'Renamed it in **two** places.',
    toolUses: [{ tool_use_id: 't4', tool: 'Bash', input: { command: 'npm test', description: 'Run the tests' }, isError: true }],
  },
  { role: 'user', text: '[Request interrupted by user]', toolUses: [] },
  { role: 'user', text: 'check a.ts', toolUses: [] },
  { role: 'assistant', text: 'Looks fine.', toolUses: [{ tool_use_id: 't5', tool: 'Read', input: { file_path: '/repo/src/a.ts' } }, { tool_use_id: 't6', tool: 'Read', input: { file_path: '/repo/b.md' } }] },
  { role: 'user', text: '<command-name>/model</command-name><command-args>opus</command-args>', toolUses: [] },
  { role: 'assistant', text: 'Switched.', toolUses: [] },
]

const PANE = {
  plugin: 'catchup',
  component: 'Pane',
  requestId: 'catchup',
  props: {
    title: 'Catch up',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('a prompt reads as typed', () => {
  expect(promptOf('<command-name>/model</command-name><command-args>opus</command-args>')).toBe('/model opus')
  expect(promptOf('<bash-input>ls -la</bash-input>')).toBe('! ls -la')
  expect(promptOf('<system-reminder>x</system-reminder>')).toBe('')
  expect(promptOf('[Request interrupted by user for tool use]')).toBe('')
})

test('the session splits into one step per prompt', () => {
  const steps = stepsOf(MESSAGES, '/repo')

  expect(steps.map(step => step.prompt)).toEqual(['rename greet to welcome', 'check a.ts', '/model opus'])
  expect(steps[0]?.actions).toEqual([
    { kind: 'search', label: 'Searched for "greet"', count: 1, isError: false },
    { kind: 'edit', label: 'Edited src/a.ts', count: 2, isError: false },
    { kind: 'run', label: 'Run the tests', count: 1, isError: true },
  ])
  expect(steps[0]?.answer).toBe('Renamed it in **two** places.')
})

test('the pane steps from the overview to each step', async ($, on) => {
  on('command.register', () => ({ value: { command: 'catchup' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', (_, e) => ({
    value: { isAnswered: true, text: e.system?.toString().includes('stands') ? 'You renamed greet; tests fail.' : 'Changed: Renamed greet to welcome.', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'catchup', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /WHERE THINGS STAND/ }))?.text).toBe('WHERE THINGS STAND')
    expect((await ui.find({ type: 'Text', text: /tests fail/ }))?.text).toBe('You renamed greet; tests fail.')
    // Each card: the tag's badge, the prompt, what happened, and the step's actions.
    expect((await ui.find({ type: 'Text', text: /^ changed/ }))?.text).toBe(' changed   ')
    expect((await ui.find({ type: 'Text', text: /❯ rename/ }))?.text).toBe('❯ rename greet to welcome')
    expect((await ui.find({ type: 'Text', text: /^Renamed greet/ }))?.text).toBe('Renamed greet to welcome.')
    expect((await ui.find({ type: 'Text', text: /4 actions/ }))?.text).toBe(' 4 actions')
    expect((await ui.find({ type: 'Text', text: /answered directly/ }))?.text).toBe('no tools: answered directly')

    await ui.press({ key: 'next' })
    expect((await ui.find({ type: 'Text', text: /Step \d/ }))?.text).toBe('✻ Step 1 of 3')
    expect((await ui.find({ type: 'Text', text: /Run the tests/ }))?.text).toBe('Run the tests')

    await ui.press({ key: 'overview' })
    await ui.unmount()
  }
})

test("the model's tag is read off its line, and a line without one is still kept", () => {
  const [step] = stepsOf(MESSAGES, '/repo')

  if (step === undefined) {
    throw new Error('no step')
  }

  expect(summaryOf('Fixed: the failing test now passes.', step)).toEqual({ tag: 'fixed', line: 'the failing test now passes.' })
  expect(summaryOf('**asked** — which colour you want', step)).toEqual({ tag: 'asked', line: 'which colour you want' })
  expect(summaryOf('Renamed greet everywhere.', step)).toEqual({ tag: 'changed', line: 'Renamed greet everywhere.' })
  expect(summaryOf('', step)).toBeUndefined()
})

test('a summary wraps at word breaks', () => {
  expect(wrap('the quick brown fox jumps', 10)).toEqual(['the quick', 'brown fox', 'jumps'])
  expect(wrap('abcdefghijklmnop', 6)).toEqual(['abcde…'])
})

