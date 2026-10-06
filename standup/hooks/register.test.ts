import { describe, expect, test } from 'claude-code/testing'

import { duration, parse, periodOf, reportOf, workedFor } from './register'

const MINUTE = 60_000
const ZERO = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const typed = (args = '') =>
  ({ command: 'standup', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as const

const ran = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// 12:00 UTC, with local midnight at 00:00 UTC. Sprite activity 09:00–09:20 (21m: its first minute
// and twenty more), committed at 09:20; 09:30–09:40 (20m: the 10-minute pause is under the idle
// limit, so it counts), committed at 09:40; 10:00–10:10 (30m the same way), not committed.
const NOW = Date.parse('2026-10-06T12:00:00Z') / 1000
const minutes = (from: string, count: number, step = 1) =>
  Array.from({ length: count }, (_, i) => {
    const at = new Date(Date.parse(`2026-10-06T${from}:00Z`) + i * step * MINUTE).toISOString().slice(0, 16)

    return `A ${at}\t/Users/me/dev/sprite/Sources`
  })

const COLLECTED = [
  `NOW ${NOW} ${12 * 3600}`,
  'REPO /Users/me/dev/sprite',
  `C ${Date.parse('2026-10-06T09:20:00Z') / 1000} Robots hop onto the Dock`,
  'B Busy robots walk the floor.',
  'B ',
  `C ${Date.parse('2026-10-06T09:40:00Z') / 1000} Shut eyes cover their pixel`,
  'REPO /Users/me/dev/quiet',
  ...minutes('09:00', 21),
  ...minutes('09:30', 11),
  ...minutes('10:00', 11),
  'A 2026-10-05T23:30\t/Users/me/dev/sprite',
].join('\n')

describe('/standup', () => {
  test('summarizes commits with the hours behind each, and copies the update', async ($, on) => {
    const argvs: string[][] = []
    const prompts: string[] = []
    const copied: string[] = []
    on('process.run', ($, e) => (argvs.push([...e.argv]), ran(COLLECTED)))
    on('model.complete', ($, e) => (prompts.push(e.prompt), { value: { isAnswered: true as const, text: '**sprite** (1h)\n- Robots now hop onto the Dock (20m)', usage: ZERO } }))
    on('ui.copy', ($, e) => (copied.push(e.text), { value: { isCopied: true } }))

    const { text } = await $.command.run(typed())

    expect(argvs[0]?.slice(-4)).toEqual(['~/dev', 'midnight', '', '1'])
    expect(prompts[0]).toContain('## sprite — 1h 11m\n- [21m] Robots hop onto the Dock\n    Busy robots walk the floor.\n- [20m] Shut eyes')
    expect(prompts[0]).toContain('- [30m, not committed yet] Work in progress')
    expect(prompts[0]).not.toContain('quiet')
    expect(copied).toEqual(['**sprite** (1h)\n- Robots now hop onto the Dock (20m)\n\nTotal: 1h 11m'])
    expect(text).toContain('Copied to your clipboard.')
  })

  test('says so when there is nothing to report', async ($, on) => {
    on('process.run', () => ran(`NOW ${NOW} 0\nREPO /Users/me/dev/quiet\n`))

    const { text } = await $.command.run(typed())

    expect(text).toBe('No commits by you in ~/dev today.')
  })

  test('falls back to the raw report when the model cannot answer', async ($, on) => {
    on('process.run', () => ran(COLLECTED))
    on('model.complete', () => ({ value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: ZERO } }))
    on('ui.copy', () => ({ value: { isCopied: false, reason: 'no-surface' } }))

    const { text } = await $.command.run(typed('week'))

    expect(text).toContain('## sprite')
    expect(text).toContain("Couldn't summarize: empty-reply")
  })
})

describe('hours', () => {
  test('each commit gets the active time since the one before; breaks over 30 min count for nothing', () => {
    const at = (m: number) => m * MINUTE
    const stamps = [at(0), at(10), at(20), at(70), at(80), at(200)]

    expect(workedFor(stamps, [at(20), at(90)])).toEqual({ perCommit: [at(21), at(11)], after: at(1) })
  })

  test('only the period counts: yesterday evening stays out of today', () => {
    const { total } = reportOf(parse(COLLECTED), periodOf('')!)

    expect(duration(total)).toBe('1h 11m')
  })

  test('durations read as hours and minutes', () => {
    expect([duration(45 * MINUTE), duration(60 * MINUTE), duration(200 * MINUTE)]).toEqual(['45m', '1h', '3h 20m'])
  })

  test('the period comes from the argument', () => {
    expect(periodOf('')).toEqual({ label: 'today', since: 'midnight', days: 0 })
    expect(periodOf('week')?.since).toBe('7 days ago')
    expect(periodOf('3')?.label).toBe('the last 3 days')
    expect(periodOf('soon')).toBeUndefined()
  })
})
