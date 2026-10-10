import { describe, expect, test } from 'claude-code/testing'
import type { RenderElement } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

import { opening, speakable } from './register'

const typed = (args = '') =>
  ({ command: 'speak', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as const

const answered = (answer: string, extra: { agentId?: string; reason?: 'answer' | 'aborted' | 'error' } = {}) =>
  ({ answer, durationMs: 1000, isAborted: extra.reason === 'aborted', turnId: 't1', reason: extra.reason ?? 'answer', ...(extra.agentId === undefined ? {} : { agentId: extra.agentId }) }) as const

const ZERO = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const ran = { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }

type On = Parameters<TestBody>[1]

// The engine beneath the plugin: the model answers `summary` (or fails), and `say` prints its
// PID and runs until `kill` names it. Each spoken text, voice and kill is recorded.
const engine = (on: On, summary: string | null = 'All tests pass now.') => {
  const spoken: { text: string; voice: string }[] = []
  const killed: string[] = []
  const prompts: string[] = []
  let started = () => {}
  let isStarted = new Promise<void>(resolve => (started = resolve))
  let ended = () => {}

  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.parse('2026-10-10T08:00:00Z') }))
  on('model.complete', ($, e) => (
    prompts.push(e.prompt),
    summary === null
      ? { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: ZERO } }
      : { value: { isAnswered: true as const, text: summary, usage: ZERO } }
  ))
  on('process.spawn', async function* ($, e) {
    spoken.push({ text: e.input ?? '', voice: e.argv.at(-1) ?? '' })
    const isEnded = new Promise<void>(resolve => (ended = resolve))
    yield { stream: 'stdout' as const, text: '4242\n' }
    started()
    await isEnded

    return { value: { code: null, signal: 'SIGTERM' } }
  })
  on('process.run', ($, e) => (killed.push(e.argv.join(' ')), ended(), ran))

  return {
    spoken,
    killed,
    prompts,
    started: async () => {
      await isStarted
      isStarted = new Promise<void>(resolve => (started = resolve))
    },
  }
}

describe('/speak', () => {
  test("speaks a summary of the answer once on, and nothing while off", async ($, on) => {
    const say = engine(on)

    await $.turn.complete(answered('Before.'))
    expect(say.spoken).toEqual([])

    expect((await $.command.run(typed())).text).toContain('Speaking')
    await $.turn.complete(answered('Done. **All** tests pass.\n\n```ts\nx\n```'))
    await say.started()
    expect(say.prompts).toEqual(['Done. All tests pass.'])
    expect(say.spoken).toEqual([{ text: 'All tests pass now.', voice: '' }])

    expect((await $.command.run(typed('off'))).text).toContain('Stopped')
    expect(say.killed).toEqual(['kill 4242'])
    await $.turn.complete(answered('After.'))
    expect(say.spoken.length).toBe(1)
  })

  test('a new prompt stops the speech', async ($, on) => {
    const say = engine(on)

    await $.command.run(typed('on'))
    await $.turn.complete(answered('A long answer.'))
    await say.started()
    await $.prompt.submit({ text: 'next' } as never)

    expect(say.killed).toEqual(['kill 4242'])
  })

  test("falls back to the answer's opening when the model can't summarize", async ($, on) => {
    const say = engine(on, null)

    await $.command.run(typed('on'))
    await $.turn.complete(answered('First. Second! Third? Fourth.'))
    await say.started()

    expect(say.spoken[0]?.text).toBe('First. Second!')
    await $.command.run(typed('off'))
  })

  test("skips subagents', interrupted and code-only turns", async ($, on) => {
    const say = engine(on)

    await $.command.run(typed('on'))
    await $.turn.complete(answered('Subagent report', { agentId: 'a1' }))
    await $.turn.complete(answered('Half', { reason: 'aborted' }))
    await $.turn.complete(answered('```ts\nconst x = 1\n```'))

    expect(say.prompts).toEqual([])
  })

  test('passes the configured voice', { options: { voice: 'Samantha' } }, async ($, on) => {
    const say = engine(on)

    await $.command.run(typed('on'))
    await $.turn.complete(answered('Hi.'))
    await say.started()

    expect(say.spoken[0]?.voice).toBe('Samantha')
    await $.command.run(typed('off'))
  })

  test('/speak log shows each step', async ($, on) => {
    const say = engine(on)

    expect((await $.command.run(typed('log'))).text).toBe('Nothing logged yet in this session.')
    await $.command.run(typed('on'))
    await $.turn.complete(answered('Half', { reason: 'aborted' }))
    await $.turn.complete(answered('Done.'))
    await say.started()
    await $.prompt.submit({ text: 'next' } as never)

    const lines = ((await $.command.run(typed('log'))).text ?? '').split('\n').map(line => line.slice(9))
    expect(lines.slice(0, 5)).toEqual([
      'turned on by /speak',
      'skipped: turn ended by aborted',
      'summarizing an answer of 5 chars',
      'summarized 5 chars in 0.0s: All tests pass now.',
      'say started (pid 4242)',
    ])
    expect(lines).toContain('stopping: new prompt')
  })

  test('the button above the prompt turns it on and off', async ($, on) => {
    const say = engine(on)
    // The engine draws nothing of its own in the band.
    on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)

    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({
        plugin: 'speak',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 } } as never,
      })
      expect((await band.find({ key: 'speak' }))?.props.label).toBe('🔈 Speak answers')

      await band.press({ key: 'speak' })
      expect((await band.find({ key: 'speak' }))?.props.label).toBe('🔊 Speaking answers')
      await $.turn.complete(answered('Done.'))
      await say.started()

      await band.press({ key: 'speak' })
      expect((await band.find({ key: 'speak' }))?.props.label).toBe('🔈 Speak answers')
      expect(say.killed.at(-1)).toBe('kill 4242')
      await band.unmount()
    }
  })

  test('rejects other arguments', async ($, on) => {
    engine(on)
    expect((await $.command.run(typed('loud'))).text).toBe('Usage: /speak [on | off | log]')
  })
})

describe('speakable', () => {
  test('drops code, tables and markdown marks', () => {
    const markdown = [
      '## Summary',
      '',
      'Fixed the bug in `register.ts` — see [the docs](https://x.y).',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
      '| a | b |',
      '|---|---|',
      '',
      '- **First** thing',
      '1. Second _thing_',
    ].join('\n')

    expect(speakable(markdown)).toBe('Summary\nFixed the bug in register.ts — see the docs.\nFirst thing\nSecond _thing_')
  })

  test('opening keeps the first two sentences', () => {
    expect(opening('One. Two.\nThree.')).toBe('One. Two.')
    expect(opening('No full stop')).toBe('No full stop')
  })
})
