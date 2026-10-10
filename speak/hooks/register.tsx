import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// Per session: $.state belongs to the session, so each one starts off.
const isOn = atom({ plugin: 'speak', key: 'isOn' } as const, false)
// The session's last steps, newest last, for /speak log.
const log = atom({ plugin: 'speak', key: 'log' } as const, [])
const LOG_LINES = 30

const STATUS = '🔊 speaking answers · /speak off'
const USAGE = 'Usage: /speak [on | off | log]'

const SYSTEM = `You write the spoken update a coding assistant gives when it finishes, for a developer who may be away from the screen.
The assistant's reply comes inside <reply> tags. From it, say only what matters:
- what was done or found: the outcome, not the steps;
- what the developer needs to do or decide next, if anything;
- otherwise, the one suggestion for moving forward, if the reply makes one.
Leave out explanations, background, caveats, and numbers or names that don't change what the developer does.
At most two short sentences, under 40 words. Speak as the assistant ("I") to the developer ("you"), in plain spoken English: no markdown, code, file paths, or lists.
Text the reply quotes or offers as an example, sample or draft did not happen: say what it is, not what it says.
Only summarize the reply; never answer it, ask about it, or comment on it.`

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

// Starts Kokoro's server from its folder ($1, ~ allowed) with its own Python; $2 is the server.
const KOKORO_RUN = 'd="$1"; case "$d" in "~"*) d="$HOME${d#\\~}";; esac; cd "$d" && exec ./bin/python -c "$2"'

// The Kokoro server, run with python -c: the model loaded once, speaking over a Unix socket.
const KOKORO = String.raw`# Speaks text with Kokoro, the model loaded once, over a Unix socket in a private temp folder.
# Run from the Kokoro folder (kokoro-v1.0.onnx, voices-v1.0.bin) with its own Python.
# Prints READY <pid> <socket> once listening. POST /speak?voice=<v> with the text as the body
# plays it sentence by sentence (the next generated while one plays) and answers done or
# stopped; POST /stop cuts short what is playing.
import os, queue, re, shutil, signal, socketserver, subprocess, tempfile, threading
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import soundfile as sf
from kokoro_onnx import Kokoro

kokoro = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
folder = tempfile.mkdtemp(prefix="speak-")
lock = threading.Lock()
current = {"stop": threading.Event(), "player": None}


def sentences(text):
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s.strip()]


def speak(text, voice):
    stop = threading.Event()

    with lock:
        cut()
        current["stop"] = stop

    clips = queue.Queue(maxsize=2)

    def generate():
        for i, sentence in enumerate(sentences(text)):
            if stop.is_set():
                break
            samples, rate = kokoro.create(sentence, voice=voice, speed=1.0, lang="en-us")
            path = os.path.join(folder, f"{id(stop)}-{i}.wav")
            sf.write(path, samples, rate)
            clips.put(path)
        clips.put(None)

    threading.Thread(target=generate, daemon=True).start()

    while (path := clips.get()) is not None:
        if not stop.is_set():
            with lock:
                player = current["player"] = subprocess.Popen(["afplay", path])
            player.wait()
        os.remove(path)

    return "stopped" if stop.is_set() else "done"


def cut():
    current["stop"].set()
    player = current["player"]
    if player is not None and player.poll() is None:
        player.terminate()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        url = urlparse(self.path)
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()

        try:
            if url.path == "/speak":
                voice = parse_qs(url.query).get("voice", ["af_bella"])[0]
                answer, status = speak(body, voice), 200
            elif url.path == "/stop":
                with lock:
                    cut()
                answer, status = "stopped", 200
            else:
                answer, status = "not found", 404
        except Exception as error:
            answer, status = f"{type(error).__name__}: {error}", 500

        data = answer.encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def address_string(self):
        return "local"

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


path = os.path.join(folder, "kokoro.sock")
server = Server(path, Handler)


def quit(*_):
    cut()
    shutil.rmtree(folder, ignore_errors=True)
    os._exit(0)


signal.signal(signal.SIGTERM, quit)
print(f"READY {os.getpid()} {path}", flush=True)
server.serve_forever()
`

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

type Voices = { say: string | undefined; kokoro: string; kokoroFolder: string }
type Server = { pid: string; socket: string }

// Kokoro's server while it runs or is starting, one per loaded module: `server` once it
// listens (undefined when it ended first), `ended` when its process has.
let kokoro: { server: Promise<Server | undefined>; ended: Promise<void> } | undefined

// Forgets the server that ended, unless a newer one has taken its place.
function forgetKokoro(server: Promise<Server | undefined>) {
  if (kokoro?.server === server) {
    kokoro = undefined
  }
}

// Starts Kokoro's server, unless it runs already. It ends first when Kokoro isn't installed or
// the install is broken, and its last error line is logged.
function startKokoro($: EngineInterface, folder: string) {
  if (kokoro !== undefined) {
    return kokoro
  }

  let ready: (server: Server | undefined) => void = () => {}
  const server = new Promise<Server | undefined>(resolve => (ready = resolve))

  const ended = (async () => {
    const startedAt = await $.clock.now()
    const child = $.process.spawn({ argv: ['sh', '-c', KOKORO_RUN, 'kokoro', folder, KOKORO] })
    let out = ''
    let errors = ''

    for await (const { stream, text } of child) {
      if (stream === 'stderr') {
        errors += text
        continue
      }

      out += text
      const match = out.match(/READY (\d+) (\S+)/)

      if (match?.[1] !== undefined && match[2] !== undefined) {
        await note($, `kokoro ready in ${seconds((await $.clock.now()) - startedAt)} (pid ${match[1]})`)
        ready({ pid: match[1], socket: match[2] })
      }
    }

    const last = errors.trim().split('\n').at(-1)
    await note($, `kokoro server ended${last === undefined || last === '' ? '' : `: ${last}`}`)

    forgetKokoro(server)
    ready(undefined)
  })()

  kokoro = { server, ended }

  return kokoro
}

// Shuts Kokoro's server down, freeing its memory, and resolves once it has gone.
async function stopKokoro($: EngineInterface) {
  const current = kokoro

  if (current !== undefined) {
    const server = await current.server

    if (server !== undefined) {
      await $.process.run(['kill', server.pid]).catch(() => undefined)
    }

    await current.ended
  }
}

// Speaks with Kokoro; false when it couldn't, so the caller falls back to say.
async function speakWithKokoro($: EngineInterface, summary: string, voices: Voices, signal: AbortSignal): Promise<boolean> {
  if (voices.kokoroFolder === '') {
    return false
  }

  const server = await startKokoro($, voices.kokoroFolder).server

  if (server === undefined || signal.aborted) {
    return server !== undefined
  }

  const socketPath = server.socket
  const cut = () => void $.http.fetch('http://kokoro/stop', { method: 'POST', socketPath }).catch(() => undefined)
  signal.addEventListener('abort', cut)
  const startedAt = await $.clock.now()

  try {
    const spoken = $.http.fetch(`http://kokoro/speak?voice=${encodeURIComponent(voices.kokoro)}`, { method: 'POST', body: summary, socketPath })

    if (signal.aborted) {
      cut()
    }

    const { ok, text } = await spoken
    const took = seconds((await $.clock.now()) - startedAt)

    if (!ok) {
      await note($, `kokoro failed after ${took}: ${text}; using say`)
      return false
    }

    await note($, `kokoro ${text} after ${took} (voice ${voices.kokoro})`)
    return true
  } catch (error) {
    // Whatever it may still be saying stops before say starts.
    cut()
    await note($, `kokoro unreachable: ${error instanceof Error ? error.message : String(error)}; using say`)
    return false
  }
}

// Speaks with macOS say, until `signal` aborts.
async function speakWithSay($: EngineInterface, summary: string, voice: string | undefined, signal: AbortSignal) {
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

// Summarizes the answer and speaks it, with Kokoro when it can and say when not, until `signal` aborts.
async function say($: EngineInterface, answer: string, voices: Voices, signal: AbortSignal) {
  const askedAt = await $.clock.now()
  const reply = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt: `<reply>\n${answer}\n</reply>`, maxTokens: 100 }, { signal })
  const took = seconds((await $.clock.now()) - askedAt)

  if (signal.aborted) {
    await note($, `summary cut short after ${took}`)
    return
  }

  const isSummarized = reply.isAnswered && reply.text.trim() !== ''
  const summary = isSummarized ? reply.text.trim() : opening(answer)
  const why = reply.isAnswered ? 'empty reply' : reply.reason === 'api-error' ? `api-error ${reply.status}` : reply.reason
  await note($, isSummarized ? `summarized ${answer.length} chars in ${took}: ${summary}` : `no summary (${why}) after ${took}; speaking the opening: ${summary}`)

  if (!(await speakWithKokoro($, summary, voices, signal)) && !signal.aborted) {
    await speakWithSay($, summary, voices.say, signal)
  }
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
async function turn($: EngineInterface, isNowOn: boolean, via: string, folder: string) {
  await update($, isOn, () => isNowOn)
  $.ui.status(isNowOn ? STATUS : undefined)
  await note($, `turned ${isNowOn ? 'on' : 'off'} by ${via}`)

  // Kokoro loads while you work, so the first answer isn't kept waiting for it.
  if (isNowOn && folder !== '') {
    startKokoro($, folder)
  }

  if (!isNowOn) {
    await stop($, `turned off by ${via}`)
    await stopKokoro($)
  }
}

export const register: Register = (on, options) => {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const voices: Voices = {
    say: text(options.voice) === '' ? undefined : text(options.voice),
    kokoro: text(options.kokoroVoice) === '' ? 'af_bella' : text(options.kokoroVoice),
    kokoroFolder: text(options.kokoroFolder),
  }
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'speak', description: "Speak a summary of Claude's answers in this session (on, off, toggle, or log)" })
    // A reload runs this again; the toggle kept in $.state brings its status line back.
    const isNowOn = await read($, isOn)
    $.ui.status(isNowOn ? STATUS : undefined)
    await note($, `loaded (${isNowOn ? 'on' : 'off'})`)

    if (isNowOn && voices.kokoroFolder !== '') {
      startKokoro($, voices.kokoroFolder)
    }

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
    await turn($, isNowOn, '/speak', voices.kokoroFolder)

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
            onPress={() => turn($, !isNowOn, 'the button', voices.kokoroFolder)}
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
    const done = say($, answer, voices, controller.signal).catch(async (error: unknown) => {
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
