import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, RenderChildren, SessionMessage, ToolUseSummary } from 'claude-code'

import type { Overview, Summaries, Summary, Tag } from '../types'

const PANE = 'catchup'
// Change a tag when its value's fields change: it declines what an earlier version stored.
const summaries = atom({ plugin: 'catchup', key: 'summaries' } as const, {} as Summaries, { shape: 'summaries-2' })
const overview = atom({ plugin: 'catchup', key: 'overview' } as const, { key: '', text: '' } as Overview, { shape: 'overview-1' })
// The page on show: 0 the overview, then one per step.
const page = atom({ plugin: 'catchup', key: 'page' } as const, 0)

const MAX_ACTIONS = 20
const AT_ONCE = 4

const STEP = `You recap one step of a coding session for the developer who ran it.
The step comes as <prompt> (what the developer asked), <actions> (what the assistant did, in order) and <answer> (what it replied at the end).
Answer with one tag, a colon, and one line: "<tag>: <line>".
The tag is the kind of step: built (made something new), changed (reworked something that existed), fixed (repaired a bug or failure), explained (answered a question), explored (looked into code, docs or options without changing anything), asked (ended on a question or choice for the developer), planned (laid out an approach before doing it).
The line is under 25 words, in the past tense: what came of the step, meaning what was done, found or decided, or the question left for the developer.
Name a file or command only when it is the point. Plain text: no markdown, no preamble, no quotes around it.`

// How each tag shows: its word on the badge and its theme colour.
const TAGS: Record<Tag, Color> = {
  built: 'success',
  changed: 'suggestion',
  fixed: 'merged',
  explained: 'permission',
  explored: 'ide',
  asked: 'warning',
  planned: 'planMode',
}
const BADGE = Math.max(...Object.keys(TAGS).map(tag => tag.length)) + 2

// The model's "<tag>: <line>" as a summary; a line with no known tag is tagged by what the
// step did.
export function summaryOf(reply: string, step: Step): Summary | undefined {
  const text = plain(reply, 240)
  const match = text.match(/^\W*([a-z]+)\W*[:|–—-]\s*(.+)$/i)
  const word = match?.[1]?.toLowerCase()

  if (match?.[2] !== undefined && word !== undefined && word in TAGS) {
    return { tag: word as Tag, line: match[2].trim() }
  }

  if (text === '') {
    return undefined
  }

  return { tag: step.actions.some(action => action.kind === 'edit') ? 'changed' : 'explained', line: text }
}

// Words laid into lines of at most `width` cells; a word longer than that is cut.
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''

  for (const word of text.split(/\s+/).filter(word => word !== '')) {
    const piece = word.length > width ? `${word.slice(0, width - 1)}…` : word

    if (line !== '' && line.length + 1 + piece.length > width) {
      lines.push(line)
      line = piece
    } else {
      line = line === '' ? piece : `${line} ${piece}`
    }
  }

  return line === '' ? lines : [...lines, line]
}

const OVERVIEW = `You tell a developer where their coding session stands.
The steps so far come numbered inside <steps>, one line each, and the last step's full answer inside <last-answer>.
Write two or three short sentences: what they're working toward, what's done, and what's open or next (a question waiting on them, a failing check, an unfinished change).
Plain text: no markdown, no lists, no preamble.`

// One prompt of the session and what came of it.
export type Step = { key: string; prompt: string; actions: Action[]; answer: string }
export type Action = { kind: Kind; label: string; count: number; isError: boolean }
export type Kind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'other'

// How each kind of action is marked: its glyph and theme colour, and its word in a step's tally.
const KINDS: Record<Kind, { glyph: string; color: Color; word: string }> = {
  read: { glyph: '◇', color: 'suggestion', word: 'read' },
  edit: { glyph: '✎', color: 'warning', word: 'edited' },
  run: { glyph: '›', color: 'success', word: 'ran' },
  search: { glyph: '⌕', color: 'permission', word: 'searched' },
  web: { glyph: '↗', color: 'planMode', word: 'fetched' },
  agent: { glyph: '◆', color: 'claude', word: 'delegated' },
  other: { glyph: '·', color: 'subtle', word: 'other' },
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

function short(line: string, most = 70) {
  const one = line.replace(/\s+/g, ' ').trim()

  return one.length > most ? `${one.slice(0, most - 1)}…` : one
}

// A short, stable key for a step: where it sits and what was asked.
function keyOf(index: number, prompt: string) {
  let hash = 5381

  for (const char of prompt.slice(0, 200)) {
    hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0
  }

  return `${index}-${(hash >>> 0).toString(36)}`
}

// What the developer typed, from a user message: a slash command as typed, a shell command
// with its `!`, pasted text as a mark, and the engine's own additions dropped. '' when the
// message holds nothing they typed.
export function promptOf(message: string): string {
  const command = message.match(/<command-name>([^<]*)<\/command-name>/)

  if (command?.[1] !== undefined) {
    const args = message.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim() ?? ''

    return `${command[1].trim()}${args === '' ? '' : ` ${args}`}`
  }

  const shell = message.match(/<bash-input>([\s\S]*?)<\/bash-input>/)

  if (shell?.[1] !== undefined) {
    return `! ${shell[1].trim()}`
  }

  const typed = message
    .replace(/<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|command-message|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g, '')
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, '[pasted text]')
    .trim()

  if (typed.startsWith('[Request interrupted')) {
    return ''
  }

  if (typed.startsWith('This session is being continued from a previous conversation')) {
    return '(the conversation before it was compacted)'
  }

  return typed
}

// One tool call as a line a person reads.
export function actionOf(use: ToolUseSummary, cwd: string): Action {
  const input = use.input
  const path = (value: unknown) => {
    const full = text(value)

    return cwd !== '' && full.startsWith(`${cwd}/`) ? full.slice(cwd.length + 1) : full
  }
  const kind: Kind = (() => {
    switch (use.tool) {
      case 'Read':
        return 'read'
      case 'Edit':
      case 'MultiEdit':
      case 'Write':
      case 'NotebookEdit':
        return 'edit'
      case 'Bash':
        return 'run'
      case 'Grep':
      case 'Glob':
        return 'search'
      case 'WebFetch':
      case 'WebSearch':
        return 'web'
      case 'Agent':
      case 'Task':
        return 'agent'
    }

    return 'other'
  })()
  const label = (() => {
    switch (use.tool) {
      case 'Read':
        return `Read ${path(input.file_path)}`
      case 'Edit':
      case 'MultiEdit':
        return `Edited ${path(input.file_path)}`
      case 'Write':
        return `Wrote ${path(input.file_path)}`
      case 'NotebookEdit':
        return `Edited ${path(input.notebook_path)}`
      case 'Bash':
        return text(input.description) === '' ? `$ ${short(text(input.command), 60)}` : short(text(input.description))
      case 'Grep':
        return `Searched for "${short(text(input.pattern), 50)}"`
      case 'Glob':
        return `Looked for ${short(text(input.pattern), 50)}`
      case 'WebFetch':
        return `Fetched ${short(text(input.url), 60)}`
      case 'WebSearch':
        return `Searched the web for "${short(text(input.query), 50)}"`
      case 'Agent':
      case 'Task':
        return `Sent an agent: ${short(text(input.description), 60)}`
      case 'Skill':
        return `Used the ${text(input.skill)} skill`
      case 'TodoWrite':
        return 'Updated the to-do list'
      case 'AskUserQuestion':
        return 'Asked you a question'
      case 'ToolSearch':
        return 'Loaded tools'
    }

    const mcp = use.tool.match(/^mcp__(.+?)__(.+)$/)

    return mcp?.[1] !== undefined && mcp[2] !== undefined ? `${mcp[1]}: ${mcp[2].replace(/_/g, ' ')}` : use.tool
  })()

  return { kind, label, count: 1, isError: use.isError === true }
}

// Runs of the same action as one line with a count.
function collapse(actions: Action[]): Action[] {
  const out: Action[] = []
  let count = 0

  for (const [index, action] of actions.entries()) {
    count++
    const nextOne = actions[index + 1]

    if (nextOne?.label === action.label && nextOne.isError === action.isError) {
      continue
    }

    out.push({ ...action, count })
    count = 0
  }

  return out
}

// The session as steps: each prompt the developer sent, the tool calls after it, and the
// last thing Claude said before the next prompt.
export function stepsOf(messages: readonly SessionMessage[], cwd: string): Step[] {
  const steps: Step[] = []

  for (const message of messages) {
    if (message.role === 'user') {
      const prompt = (message.toolResults?.length ?? 0) > 0 ? '' : promptOf(message.text)

      if (prompt !== '') {
        steps.push({ key: keyOf(steps.length, prompt), prompt, actions: [], answer: '' })
      }

      continue
    }

    const step = steps.at(-1)

    if (step === undefined) {
      continue
    }

    step.actions.push(...message.toolUses.map(use => actionOf(use, cwd)))

    if (message.text.trim() !== '') {
      step.answer = message.text.trim()
    }
  }

  return steps.map(step => ({ ...step, actions: collapse(step.actions) }))
}

// Markdown as a short run of plain text.
export function plain(markdown: string, most = 320) {
  return short(
    markdown
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*_#>|]/g, ''),
    most,
  )
}

// The steps as last read, while the pane is open; undefined when it isn't, so the next draw
// reads the session again.
let steps: Step[] | undefined
// Whether the main loop is on a turn: its step is still in progress.
let isBusy = false
const writing = new Set<string>()

const finished = (all: Step[]) => (isBusy ? all.slice(0, -1) : all)

async function summarize($: EngineInterface, step: Step) {
  writing.add(step.key)

  try {
    const actions = step.actions.map(action => `${action.isError ? '(failed) ' : ''}${action.label}${action.count > 1 ? ` (${action.count} times)` : ''}`).join('\n')
    const reply = await $.model.complete({
      model: 'haiku',
      system: STEP,
      prompt: `<prompt>\n${step.prompt.slice(0, 2000)}\n</prompt>\n<actions>\n${actions || '(none)'}\n</actions>\n<answer>\n${step.answer.slice(0, 4000)}\n</answer>`,
      maxTokens: 120,
      effort: 'low',
    })
    const summary = reply.isAnswered ? summaryOf(reply.text, step) : undefined

    if (summary !== undefined) {
      await update($, summaries, all => ({ ...all, [step.key]: summary }))
    } else {
      $.ui.log(`catchup: no summary for step ${step.key} (${reply.isAnswered ? 'empty' : reply.reason})`, { to: 'debug' })
    }
  } finally {
    writing.delete(step.key)
  }
}

async function writeOverview($: EngineInterface, all: Step[], lines: Summaries, key: string) {
  writing.add(key)

  try {
    const numbered = all.map((step, index) => `${index + 1}. ${lines[step.key]?.line ?? short(step.prompt, 200)}`).join('\n')
    const reply = await $.model.complete({
      model: 'haiku',
      system: OVERVIEW,
      prompt: `<steps>\n${numbered}\n</steps>\n<last-answer>\n${(all.at(-1)?.answer ?? '').slice(0, 4000)}\n</last-answer>`,
      maxTokens: 200,
      effort: 'low',
    })

    if (reply.isAnswered && reply.text.trim() !== '') {
      await update($, overview, () => ({ key, text: plain(reply.text, 600) }))
    }
  } finally {
    writing.delete(key)
  }
}

// Reads the session again, then writes what's missing: each finished step's line, a few at
// a time, then the overview over them.
async function refresh($: EngineInterface) {
  const cwd = await $.session.cwd().catch(() => '')
  const all = stepsOf(await $.session.messages(), cwd)
  steps = all
  $.ui.invalidate('ui.render')

  const done = finished(all)
  const missing = done.filter(step => !writing.has(step.key))
  const known = await read($, summaries)
  const queue = missing.filter(step => known[step.key] === undefined)
  const workers = Array.from({ length: Math.min(AT_ONCE, queue.length) }, async () => {
    for (let step = queue.shift(); step !== undefined; step = queue.shift()) {
      await summarize($, step).catch(error => $.ui.log(`catchup: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
    }
  })
  await Promise.all(workers)

  const lines = await read($, summaries)
  const key = `overview:${done.map(step => step.key).join(',')}`

  if (done.length > 0 && (await read($, overview)).key !== key && !writing.has(key)) {
    await writeOverview($, done, lines, key)
  }
}

// The catch-up as transcript text, for a terminal with no room for the pane.
async function asText($: EngineInterface) {
  await refresh($)
  const all = steps ?? []
  const lines = await read($, summaries)
  const where = (await read($, overview)).text

  if (all.length === 0) {
    return 'Nothing to catch up on yet.'
  }

  return [
    where === '' ? '' : `Where things stand: ${where}\n`,
    ...all.map((step, index) => {
      const summary = lines[step.key]

      return `${index + 1}. ${summary === undefined ? short(step.prompt, 100) : `[${summary.tag}] ${summary.line}`}`
    }),
  ]
    .filter(line => line !== '')
    .join('\n')
}

async function open($: EngineInterface) {
  await update($, page, () => 0)
  void refresh($)

  return $.ui.open({ id: PANE, title: 'Catch up', focus: true, closeOnEscape: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'catchup', description: 'Step through what has happened since the session started (or /catchup text)' })

    return next(e)
  })

  on('command.run', { command: 'catchup' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'text') {
      return { text: await asText($) }
    }

    const opened = await open($)

    return { text: opened.isPlaced ? 'Catch-up opened.' : await asText($) }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isBusy = true

      if (steps !== undefined) {
        void refresh($)
      }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined) {
      isBusy = false

      if (steps !== undefined) {
        void refresh($)
      }
    }

    return result
  })

  on('ui.close', ($, e, next) => {
    if (e.id === PANE) {
      steps = undefined
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)

    if (steps === undefined) {
      void refresh($)

      return <Text dimColor>Reading the session…</Text>
    }

    const all = steps
    const total = all.length

    if (total === 0) {
      return <Text dimColor>Nothing yet: the catch-up fills in as you send prompts.</Text>
    }

    const at = Math.min(await read($, page), total)
    const lines = await read($, summaries)
    const where = await read($, overview)
    const go = (to: number) => update($, page, () => Math.max(0, Math.min(to, total)))
    const isRunning = (index: number) => isBusy && index === total - 1
    const isWaiting = (step: Step, index: number) => lines[step.key] === undefined && !isRunning(index)
    const lineOf = (step: Step, index: number) =>
      lines[step.key]?.line ?? (isRunning(index) ? 'In progress…' : writing.has(step.key) ? 'Summarizing…' : 'Not summarized yet.')
    // A step's tag as a filled badge, padded so the prompts after it line up.
    const badge = (step: Step, index: number) => {
      const tag = lines[step.key]?.tag

      if (isRunning(index)) {
        return <Text inverse color="warning">{' working'.padEnd(BADGE)}</Text>
      }

      return tag === undefined ? <Text dimColor>{' ·'.padEnd(BADGE)}</Text> : <Text inverse bold color={TAGS[tag]}>{` ${tag}`.padEnd(BADGE)}</Text>
    }
    const colorOf = (step: Step, index: number): Color => {
      const tag = lines[step.key]?.tag

      return isRunning(index) ? 'warning' : tag === undefined ? 'subtle' : TAGS[tag]
    }
    const width = Math.max(20, e.props.bodyColumns)
    const actionCount = all.reduce((sum, step) => sum + step.actions.reduce((one, action) => one + action.count, 0), 0)

    // How many of each kind a step did, as coloured glyphs: ◇3 ✎2 ›1.
    const tally = (step: Step, isWordy: boolean) => {
      const counts = new Map<Kind, number>()

      for (const action of step.actions) {
        counts.set(action.kind, (counts.get(action.kind) ?? 0) + action.count)
      }

      const failed = step.actions.filter(action => action.isError).length

      return (
        <Box flexDirection="row" gap={isWordy ? 2 : 1}>
          {[...counts].map(([kind, count]) => (
            <Text color={KINDS[kind].color}>{isWordy ? `${KINDS[kind].glyph} ${count} ${KINDS[kind].word}` : `${KINDS[kind].glyph}${count}`}</Text>
          ))}
          {failed > 0 ? <Text color="error">{isWordy ? `✗ ${failed} failed` : `✗${failed}`}</Text> : null}
        </Box>
      )
    }

    // The title row, then a rule filled as far as the page on show.
    const header = (title: string, meta: string) => {
      const filled = Math.round((width * at) / total)

      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold color="claude">{`✻ ${title}`}</Text>
            <Text dimColor>{meta}</Text>
          </Box>
          <Box flexDirection="row">
            <Text color="claude">{'━'.repeat(filled)}</Text>
            <Text color="subtle">{'─'.repeat(width - filled)}</Text>
          </Box>
        </Box>
      )
    }

    // A heading in small capitals, its body indented under it.
    const section = (glyph: string, color: Color, title: string, body: RenderChildren, aside?: RenderChildren) => (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1}>
          <Text color={color}>{glyph}</Text>
          <Text bold color={color}>
            {title.toUpperCase()}
          </Text>
          {aside ?? null}
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          {body}
        </Box>
      </Box>
    )

    const buttons = (
      <Box flexDirection="row" gap={2}>
        <Button key="prev" label="◀ Prev" hotkey="p" dimColor={at === 0} onPress={() => go(at - 1)} />
        <Button key="next" label="Next ▶" hotkey="n" variant="primary" autoFocus dimColor={at === total} onPress={() => go(at + 1)} />
        <Button key="overview" label="≡ Overview" hotkey="o" dimColor={at === 0} onPress={() => go(0)} />
        <Button key="close" label="Close" hotkey="c" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )

    // A step's actions as one bar, a coloured run per kind, as long against the busiest step.
    const busiest = Math.max(1, ...all.map(step => step.actions.reduce((sum, action) => sum + action.count, 0)))
    const bar = (step: Step, room: number) => {
      const counts = new Map<Kind, number>()

      for (const action of step.actions) {
        counts.set(action.kind, (counts.get(action.kind) ?? 0) + action.count)
      }

      const count = [...counts.values()].reduce((a, b) => a + b, 0)
      const failed = step.actions.filter(action => action.isError).reduce((sum, action) => sum + action.count, 0)
      const long = Math.max(counts.size, Math.round((Math.max(4, room - 14) * count) / busiest))

      if (count === 0) {
        return <Text dimColor>no tools: answered directly</Text>
      }

      return (
        <Box flexDirection="row">
          {[...counts].map(([kind, one]) => (
            <Text color={KINDS[kind].color}>{'▆'.repeat(Math.max(1, Math.round((long * one) / count)))}</Text>
          ))}
          <Text dimColor>{` ${count} action${count === 1 ? '' : 's'}`}</Text>
          {failed > 0 ? <Text color="error">{` · ${failed} failed`}</Text> : null}
        </Box>
      )
    }

    // One step on the timeline: a node on the line, its tag and prompt, then what happened
    // and its bar beside the line running down to the next step.
    const card = (step: Step, index: number) => {
      const color = colorOf(step, index)
      const isLast = index === total - 1
      const number = String(index + 1).padStart(String(total).length)
      const indent = number.length + 3
      const room = Math.max(10, width - indent - 2)
      const rail = (
        <Text color={color} dimColor={!isRunning(index)}>
          {isLast ? ' ' : '│'}
        </Text>
      )
      const body = wrap(lineOf(step, index), room)

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={color} bold>
              {isRunning(index) ? '◌' : '●'}
            </Text>
            <Text dimColor>{number}</Text>
            {badge(step, index)}
            <Box flexShrink={1}>
              <Text wrap="truncate-end" color="claude">
                {`❯ ${short(step.prompt, 200)}`}
              </Text>
            </Box>
          </Box>
          {body.map(line => (
            <Box flexDirection="row">
              {rail}
              <Box paddingLeft={indent - 1}>
                <Text dimColor={isWaiting(step, index)} color={isRunning(index) ? 'warning' : undefined}>
                  {line}
                </Text>
              </Box>
            </Box>
          ))}
          <Box flexDirection="row">
            {rail}
            <Box paddingLeft={indent - 1}>{bar(step, room)}</Box>
          </Box>
          {isLast ? null : rail}
        </Box>
      )
    }

    if (at === 0) {
      const isStale = where.key !== `overview:${finished(all).map(step => step.key).join(',')}`

      return (
        <Box flexDirection="column">
          {header('Catch up', `${total} step${total === 1 ? '' : 's'} · ${actionCount} action${actionCount === 1 ? '' : 's'}`)}
          {section(
            '◎',
            'claude',
            'Where things stand',
            where.text === '' ? <Text dimColor>Writing the overview…</Text> : <Text dimColor={isStale}>{where.text}</Text>,
          )}
          {section(
            '┊',
            'suggestion',
            'Timeline',
            all.map((step, index) => card(step, index)),
            width >= 72 ? (
              <Box flexDirection="row" gap={1} marginLeft={1}>
                {(['read', 'edit', 'run', 'search', 'web', 'agent'] as const).map(kind => (
                  <Text color={KINDS[kind].color}>{`▆ ${KINDS[kind].word}`}</Text>
                ))}
              </Box>
            ) : undefined,
          )}
          {buttons}
        </Box>
      )
    }

    const index = at - 1
    const step = all[index]

    if (step === undefined) {
      return <Text dimColor>No such step.</Text>
    }

    const shown = step.actions.slice(0, MAX_ACTIONS)
    const more = step.actions.length - shown.length

    return (
      <Box flexDirection="column">
        {header(`Step ${at} of ${total}`, isRunning(index) ? '◌ in progress' : '● done')}
        {section('❯', 'claude', 'You asked', <Text>{short(step.prompt, 400)}</Text>)}
        {section(
          '◎',
          'success',
          'What happened',
          <Box flexDirection="column">
            <Text dimColor={isWaiting(step, index)} color={isRunning(index) ? 'warning' : undefined}>
              {lineOf(step, index)}
            </Text>
            <Box marginTop={1}>{bar(step, width - 2)}</Box>
          </Box>,
          badge(step, index),
        )}
        {section(
          '┊',
          'suggestion',
          'Actions',
          step.actions.length === 0 ? (
            <Text dimColor>None: Claude answered from what it knew.</Text>
          ) : (
            <Box flexDirection="column">
              {shown.map(action => (
                <Box flexDirection="row" gap={1}>
                  <Text color={action.isError ? 'error' : KINDS[action.kind].color}>{action.isError ? '✗' : KINDS[action.kind].glyph}</Text>
                  <Box flexShrink={1}>
                    <Text wrap="truncate-end" color={action.isError ? 'error' : undefined}>
                      {action.label}
                    </Text>
                  </Box>
                  {action.count > 1 ? <Text dimColor>{`×${action.count}`}</Text> : null}
                </Box>
              ))}
              {more > 0 ? <Text dimColor>{`… ${more} more`}</Text> : null}
            </Box>
          ),
          step.actions.length === 0 ? undefined : tally(step, true),
        )}
        {step.answer === '' ? null : section('✻', 'subtle', 'Claude said', <Text dimColor>{plain(step.answer)}</Text>)}
        {buttons}
      </Box>
    )
  })
}
