import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { ago, cwdsOf, isPlanFile, nameOf, tildify, transcriptsOf } from './register'

const HOME = '/Users/me'
const PROJECTS = `${HOME}/.claude/projects`
const PLAN = `${HOME}/.claude/plans/tidy-plan.md`
const NOW = Date.parse('2026-10-07T12:00:00Z')

const REFS = [
  `${PROJECTS}/-Users-me-dev-app/aaa.jsonl:"file_path":"${HOME}/.claude/plans/tidy-plan.md"`,
  `${PROJECTS}/-Users-me-dev-app/aaa/subagents/agent-1.jsonl:"file_path":"${HOME}/.claude/plans/tidy-plan-agent-1.md"`,
  `${PROJECTS}/-Users-me-dev-site/bbb.jsonl:"file_path":"${HOME}/.claude/plans/old-plan.md"`,
].join('\n')

const CWDS = [`${PROJECTS}/-Users-me-dev-app/aaa.jsonl:"cwd":"/Users/me/dev/app"`, `${PROJECTS}/-Users-me-dev-site/bbb.jsonl:"cwd":"/Users/me/dev/my-site"`].join('\n')

const PANE = {
  component: 'Pane',
  requestId: 'plan-view',
  props: {
    title: 'Plan',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

function host(on: On, onOpen = () => {}) {
  on('env.get', () => ({ value: HOME }))
  on('session.cwd', () => ({ value: '/Users/me/dev/app' }))
  on('fs.list', () => ({
    value: [
      { name: 'old-plan.md', kind: 'file', size: 10, mtimeMs: NOW - 3 * 86_400_000, isLink: false },
      { name: 'tidy-plan.md', kind: 'file', size: 10, mtimeMs: NOW - 2 * 3_600_000, isLink: false },
    ],
  }))
  on('fs.read', ($, e) => ({ value: e.path === PLAN ? '# Tidy up\n\n- [ ] step one' : '# Old' }))
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('-roE') ? REFS : CWDS,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('ui.open', () => (onOpen(), { value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'plan-view' } }))
  on('command.run', () => ({ text: 'unhandled' }))
  mock.clock(on, { now: NOW })
}

test('plan files are the named one or any markdown under ~/.claude/plans', async () => {
  expect(isPlanFile(PLAN, null)).toBe(true)
  expect(isPlanFile('/repo/notes.md', '/repo/notes.md')).toBe(true)
  expect(isPlanFile('/repo/README.md', PLAN)).toBe(false)
  expect(nameOf(PLAN)).toBe('tidy-plan.md')
  expect(tildify('/Users/me/dev/app', HOME)).toBe('~/dev/app')
  expect(ago(NOW - 5 * 60_000, NOW)).toBe('5m ago')
  expect(ago(NOW - 3 * 86_400_000, NOW)).toBe('3d ago')
})

test('transcripts name the project that wrote each plan, subagents left out', async () => {
  const transcripts = transcriptsOf(REFS, PROJECTS)
  expect(transcripts.get('tidy-plan.md')).toBe(`${PROJECTS}/-Users-me-dev-app/aaa.jsonl`)
  expect(transcripts.has('tidy-plan-agent-1.md')).toBe(false)
  expect(cwdsOf(CWDS).get(`${PROJECTS}/-Users-me-dev-site/bbb.jsonl`)).toBe('/Users/me/dev/my-site')
})

test('/plan-view with no session plan lists recent plans by project, and one opens on press', async ($, on) => {
  host(on)

  const ran = await $.command.run({ command: 'plan-view', args: '', ...RUN })
  expect(ran.text).toBe('No plan in this session yet; pick one in the pane.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'plan-view', surface, ...PANE })
    expect(await ui.find({ text: '~/dev/app (here) · 2h ago' })).toBeDefined()
    expect(await ui.find({ text: '~/dev/my-site · 3d ago' })).toBeDefined()

    await ui.press({ key: PLAN })
    expect(await ui.find({ text: '# Tidy up\n\n- [ ] step one' })).toBeDefined()

    await ui.press({ key: 'list' })
    expect(await ui.find({ text: '~/dev/app (here) · 2h ago' })).toBeDefined()
  }
})

test('/plan-view <word> opens the newest plan whose name holds it', async ($, on) => {
  host(on)

  const ran = await $.command.run({ command: 'plan-view', args: 'old', ...RUN })
  expect(ran.text).toBe('Showing old-plan.md.')

  const ui = await $.ui.mount({ plugin: 'plan-view', surface: 'terminal', ...PANE })
  expect(await ui.find({ text: 'old-plan.md' })).toBeDefined()
})

const ROW = {
  tool_use_id: 'toolu_1',
  tool: 'ExitPlanMode',
  input: {},
  isRunning: true,
  isErrored: false,
  isInterrupted: false,
}

test('a plan up for approval is one line in the transcript that opens the pane', async ($, on) => {
  let opened = 0
  host(on, () => opened++)
  // Claude writing the plan makes it this session's.
  on('tool.call', () => ({
    result: { type: 'create', filePath: PLAN, content: '# Tidy up', structuredPatch: [], originalFile: null },
  }))
  await $.tool.call({ tool: 'Write', file_path: PLAN, content: '# Tidy up' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({ plugin: 'plan-view', surface, component: 'ToolUse', requestId: 'toolu_1', props: ROW })
    expect(await row.find({ text: 'tidy-plan.md · waiting for approval' })).toBeDefined()

    await row.press({ key: 'open-toolu_1' })
    const pane = await $.ui.mount({ plugin: 'plan-view', surface, ...PANE })
    expect(await pane.find({ text: '# Tidy up\n\n- [ ] step one' })).toBeDefined()
  }
  expect(opened).toBe(3)
})
