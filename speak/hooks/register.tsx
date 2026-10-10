import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// Per session: $.state belongs to the session, so each one starts off.
const isOn = atom({ plugin: 'speak', key: 'isOn' } as const, false)
// The session's last steps, newest last, for /speak log.
const log = atom({ plugin: 'speak', key: 'log' } as const, [])
const LOG_LINES = 30

const STATUS = '🔊 speaking answers · /speak off'
const USAGE = 'Usage: /speak [on | off | log]'

const SYSTEM = `You turn a coding assistant's reply into what a voice says aloud when it finishes.
Say in one or two short sentences what was done or found, and anything the listener must decide or do.
Plain spoken English: no markdown, code, file paths, or lists. Never start with "The assistant".`

// The answer as something worth hearing: code blocks, tables and markdown marks dropped,
// links read as their text.
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, '\n')
    .split('\n')
    .filter(line => !/^\s*\|/.test(line))
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*([-*_]\s*){3,}$/gm, '')
    .replace(/(\*\*|__|\*|~~)(\S[^\n]*?)\1/g, '$2')
    .replace(/<[^>\n]+>/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

// $1 is the voice, empty for the system default; the summary comes on standard input.
const SAY = 'echo $$; if [ -n "$1" ]; then exec say -v "$1" -f -; else exec say -f -; fi'

// When the model can't summarize: the answer's first two sentences.
export function opening(text: string): string {
  const sentences = text.replace(/\n+/g, ' ').match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? []

  return sentences.slice(0, 2).join('').trim()
}

// One step to the debug log (`claude --debug`) and to the session's /speak log.
async function note($: EngineInterface, line: string) {
  $.ui.log(line, { to: 'debug' })
  const at = new Date(await $.clock.now()).toTimeString().slice(0, 8)
  await update($, log, lines => [...lines, `${at} ${line}`].slice(-LOG_LINES))
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

// Summarizes the answer and speaks it, until `signal` aborts.
async function say($: EngineInterface, answer: string, voice: string | undefined, signal: AbortSignal) {
  const askedAt = await $.clock.now()
  const reply = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt: answer, maxTokens: 150 }, { signal })
  const took = seconds((await $.clock.now()) - askedAt)

  if (signal.aborted) {
    await note($, `summary cut short after ${took}`)
    return
  }

  const isSummarized = reply.isAnswered && reply.text.trim() !== ''
  const summary = isSummarized ? reply.text.trim() : opening(answer)
  const why = reply.isAnswered ? 'empty reply' : reply.reason === 'api-error' ? `api-error ${reply.status}` : reply.reason
  await note($, isSummarized ? `summarized ${answer.length} chars in ${took}: ${summary}` : `no summary (${why}) after ${took}; speaking the opening: ${summary}`)

  // The shell prints its PID and becomes `say` (exec keeps the PID), so stopping is a kill.
  const child = $.process.spawn({ argv: ['sh', '-c', SAY, 'say', voice ?? ''], input: summary })
  const startedAt = await $.clock.now()
  let pid: string | undefined
  const kill = () => void (pid === undefined ? undefined : $.process.run(['kill', pid]).catch(() => undefined))
  signal.addEventListener('abort', kill)

  for await (const { stream, text } of child) {
    if (stream === 'stdout' && pid === undefined) {
      pid = text.trim()
      await note($, `say started (pid ${pid}${voice === undefined ? '' : `, voice ${voice}`})`)

      if (signal.aborted) {
        kill()
      }
    } else if (stream === 'stderr' && text.trim() !== '') {
      await note($, `say error: ${text.trim()}`)
      $.ui.toast(`Couldn't speak: ${text.trim()}`)
    }
  }

  const { code, signal: killedBy } = await child.result
  const ran = seconds((await $.clock.now()) - startedAt)
  await note($, killedBy !== null ? `say stopped by ${killedBy} after ${ran}` : `say finished in ${ran} (exit ${code})`)
}

// The summary or speech in progress, so a new prompt or /speak off can cut it short.
let speaking: { controller: AbortController; done: Promise<void> } | undefined

// Cuts short what is being said, and resolves once it has gone quiet.
async function stop($: EngineInterface, why: string) {
  const current = speaking

  if (current !== undefined) {
    speaking = undefined
    await note($, `stopping: ${why}`)
    current.controller.abort()
    await current.done
  }
}

// Turns speaking on or off, from /speak or the button above the prompt.
async function turn($: EngineInterface, isNowOn: boolean, via: string) {
  await update($, isOn, () => isNowOn)
  $.ui.status(isNowOn ? STATUS : undefined)
  await note($, `turned ${isNowOn ? 'on' : 'off'} by ${via}`)

  if (!isNowOn) {
    await stop($, `turned off by ${via}`)
  }
}

export const register: Register = (on, options) => {
  const voice = typeof options.voice === 'string' && options.voice.trim() !== '' ? options.voice.trim() : undefined
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'speak', description: "Speak a summary of Claude's answers in this session (on, off, toggle, or log)" })
    // A reload runs this again; the toggle kept in $.state brings its status line back.
    const isNowOn = await read($, isOn)
    $.ui.status(isNowOn ? STATUS : undefined)
    await note($, `loaded (${isNowOn ? 'on' : 'off'})`)

    return next(e)
  })

  on('command.run', { command: 'speak' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()

    if (word === 'log') {
      const lines = await read($, log)

      return { text: lines.length === 0 ? 'Nothing logged yet in this session.' : lines.join('\n') }
    }

    if (word !== '' && word !== 'on' && word !== 'off') {
      return { text: USAGE }
    }

    const isNowOn = word === '' ? !(await read($, isOn)) : word === 'on'
    await turn($, isNowOn, '/speak')

    return { text: isNowOn ? "Speaking a summary of Claude's answers in this session." : 'Stopped speaking answers in this session.' }
  })

  // A button above the prompt that turns it on and off; whatever else draws there stays above it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const above = await next(e)

    if (e.props.hasSurvey) {
      return above
    }

    const isNowOn = await read($, isOn)
    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {above}
        <Box flexDirection="row">
          <Button
            key="speak"
            label={isNowOn ? '🔊 Speaking answers' : '🔈 Speak answers'}
            hotkey="s"
            dimColor={!isNowOn}
            onPress={() => turn($, !isNowOn, 'the button')}
          />
        </Box>
      </Box>
    )
  })

  // Whatever is still being said gives way to what you type next.
  on('prompt.submit', async ($, e, next) => {
    await stop($, 'new prompt')

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // The main conversation's answers only: not subagents'.
    if (e.agentId !== undefined || !(await read($, isOn))) {
      return result
    }

    const answer = speakable(e.answer)

    if (e.reason !== 'answer' || answer === '') {
      await note($, `skipped: ${e.reason === 'answer' ? 'nothing to say once code and tables are dropped' : `turn ended by ${e.reason}`}`)
      return result
    }

    await stop($, 'a newer answer')
    const controller = new AbortController()
    await note($, `summarizing an answer of ${answer.length} chars`)

    // Not awaited: the turn ends now and the summary is spoken behind it.
    const done = say($, answer, voice, controller.signal).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      await note($, `failed: ${message}`)
      $.ui.toast(`Couldn't speak: ${message}`)
    })
    const current = { controller, done }
    speaking = current
    void done.finally(() => {
      if (speaking === current) {
        speaking = undefined
      }
    })

    return result
  })
}
