import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { PlanChoice } from '../types'

const PANE = 'plan-view'
const TITLE = 'Plan'
const LISTED = 12
const MINUTE = 60_000

const plan = atom({ plugin: 'plan-view', key: 'plan' } as const, null)
// This session's plan, kept by the host so a reload of the mod still knows it.
const sessionPlan = atom({ plugin: 'plan-view', key: 'sessionPlan' } as const, null)
const choices = atom({ plugin: 'plan-view', key: 'choices' } as const, [])
const view = atom({ plugin: 'plan-view', key: 'view' } as const, 'plan')

type Host = Parameters<Hook<'session.start'>>[0]

export const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export const isPlanFile = (path: string, current: string | null) =>
  path === current || (path.includes('/.claude/plans/') && path.endsWith('.md'))

export const tildify = (path: string, home: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

export function ago(mtimeMs: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - mtimeMs) / MINUTE))
  if (minutes < 60) {
    return `${minutes}m ago`
  }

  return minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`
}

// `grep -o` lines `<transcript>:"file_path":"<...>/.claude/plans/<name>.md"`, a tool call that
// wrote the plan (a mere mention is no match), kept for a session's own
// transcript (`<projects>/<folder>/<id>.jsonl`) and not a subagent's: plan name to transcript.
export function transcriptsOf(stdout: string, projects: string): Map<string, string> {
  const found = new Map<string, string>()

  for (const line of stdout.split('\n')) {
    const cut = line.indexOf('.jsonl:')
    if (cut < 0) {
      continue
    }

    const transcript = line.slice(0, cut + '.jsonl'.length)
    const isSession = transcript.startsWith(`${projects}/`) && transcript.slice(projects.length + 1).split('/').length === 2
    if (isSession) {
      found.set(nameOf(line.slice(cut + '.jsonl:'.length).replace(/"$/, '')), transcript)
    }
  }

  return found
}

// `grep -m1 -oH` lines `<transcript>:"cwd":"<folder>"`: transcript to the folder it ran in.
export function cwdsOf(stdout: string): Map<string, string> {
  const found = new Map<string, string>()

  for (const line of stdout.split('\n')) {
    const cut = line.indexOf(':"cwd":"')
    if (cut >= 0 && line.endsWith('"')) {
      found.set(line.slice(0, cut), line.slice(cut + ':"cwd":"'.length, -1))
    }
  }

  return found
}

async function homeOf($: Host): Promise<string | undefined> {
  return $.env.get('HOME')
}

// The plans in ~/.claude/plans, newest first, each with the project whose session wrote it.
async function listPlans($: Host): Promise<PlanChoice[]> {
  const home = await homeOf($)
  if (home === undefined) {
    return []
  }

  const dir = `${home}/.claude/plans`
  const entries = await $.fs.list(dir).catch(() => [])
  const files = entries
    .filter(one => one.kind === 'file' && one.name.endsWith('.md'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, LISTED)

  const projects = `${home}/.claude/projects`
  const refs = await $.process
    .run(['grep', '-roE', '--include=*.jsonl', '"file_path":"[^"]*/\\.claude/plans/[A-Za-z0-9_-]+\\.md"', projects])
    .catch(() => undefined)
  const transcripts = transcriptsOf(refs?.stdout ?? '', projects)

  const wanted = [...new Set(files.flatMap(one => transcripts.get(one.name) ?? []))]
  const cwds =
    wanted.length === 0
      ? new Map<string, string>()
      : cwdsOf((await $.process.run(['grep', '-m1', '-oH', '"cwd":"[^"]*"', ...wanted]).catch(() => undefined))?.stdout ?? '')

  return files.map(one => {
    const transcript = transcripts.get(one.name)
    const project = transcript === undefined ? undefined : cwds.get(transcript)

    return { path: `${dir}/${one.name}`, mtimeMs: one.mtimeMs, ...(project === undefined ? {} : { project }) }
  })
}

async function load($: Host, path: string) {
  const text = await $.fs.read(path).catch(() => undefined)
  if (typeof text === 'string') {
    await update($, plan, () => ({ path, text }))
    await update($, view, () => 'plan' as const)
  }
}

// Remembers the plan this session writes, shows it, and opens the pane the first time.
async function follow($: Host, path: string) {
  const known = await read($, sessionPlan)
  await update($, sessionPlan, () => path)
  await load($, path)
  if (known === null) {
    await $.ui.open({ id: PANE, title: TITLE })
  }
}

async function openPlan($: Host, path: string) {
  await load($, path)
  await $.ui.open({ id: PANE, title: TITLE })
}

async function showList($: Host) {
  await update($, choices, () => [])
  await update($, view, () => 'list' as const)
  await $.ui.open({ id: PANE, title: TITLE })
  const listed = await listPlans($)
  await update($, choices, () => listed)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'plan-view',
      description: "Show this session's plan as rendered markdown, or pick one (optionally: part of a plan name)",
    })

    return next(e)
  })

  on('prompt.attachment', async ($, e, next) => {
    const isPlanMode = e.type === 'plan_mode' || e.type === 'plan_mode_reentry' || e.type === 'plan_mode_exit'
    if (isPlanMode && e.detail !== undefined) {
      const path = e.detail.planFilePath
      const known = await read($, sessionPlan)
      if (path !== known) {
        await update($, sessionPlan, () => path)
        if (await $.fs.exists(path)) {
          await load($, path)
        }
        if (known === null && e.type !== 'plan_mode_exit') {
          await $.ui.open({ id: PANE, title: TITLE })
        }
      }
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // The plan up for approval opens in the pane before the dialog asks.
    if (e.tool === 'ExitPlanMode') {
      const known = await read($, sessionPlan).catch(() => null)
      if (known !== null) {
        await load($, known).catch(() => undefined)
        await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
      }
    }

    const ran = await next(e)

    // The tool has run; a failure to draw the plan never fails it.
    if (e.tool === 'Write' || e.tool === 'Edit') {
      const known = await read($, sessionPlan).catch(() => null)
      if (isPlanFile(e.file_path, known)) {
        await follow($, e.file_path).catch(() => undefined)
      }
    }

    return ran
  })

  // The transcript keeps one line for a plan put up for approval, not the whole plan.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'ExitPlanMode') {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const known = await read($, sessionPlan)
    const state = e.props.isRunning ? 'waiting for approval' : e.props.isErrored ? 'not approved' : 'approved'

    return (
      <Box flexDirection="row" gap={1}>
        <Text bold>Plan</Text>
        <Text dimColor>
          {known === null ? '' : `${nameOf(known)} · `}
          {state}
        </Text>
        {known !== null && (
          <Button key={`open-${e.props.tool_use_id}`} label="Open in plan-view" plain onPress={() => openPlan($, known)} />
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.tool !== 'ExitPlanMode' || e.props.isErrored) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  on('command.run', { command: 'plan-view' }, async ($, e) => {
    const query = e.args.trim()

    if (query !== '') {
      const match = (await listPlans($)).find(one => nameOf(one.path).includes(query))
      if (match === undefined) {
        return { text: `No plan matching "${query}".` }
      }
      await load($, match.path)
      await $.ui.open({ id: PANE, title: TITLE })

      return { text: `Showing ${nameOf(match.path)}.` }
    }

    const known = await read($, sessionPlan)
    if (known !== null) {
      await load($, known)
      await $.ui.open({ id: PANE, title: TITLE })

      return { text: `Showing this session's plan, ${nameOf(known)}.` }
    }

    await showList($)

    return { text: 'No plan in this session yet; pick one in the pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const current = await read($, plan)

    if ((await read($, view)) === 'plan' && current !== null) {
      const known = await read($, sessionPlan)

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="list" label="All plans" plain dimColor onPress={() => showList($)} />
            <Text dimColor>
              {nameOf(current.path)}
              {current.path === known ? ' · this session' : ''}
            </Text>
          </Box>
          <Markdown text={current.text} />
        </Box>
      )
    }

    const listed = await read($, choices)
    const home = (await homeOf($)) ?? ''
    const cwd = await $.session.cwd()
    const now = await $.clock.now()

    return (
      <Box flexDirection="column">
        <Text dimColor>No plan in this session yet. Recent plans:</Text>
        {listed.length === 0 && <Text dimColor>Looking…</Text>}
        {listed.map(one => (
          <Box flexDirection="row" gap={1}>
            <Button key={one.path} label={nameOf(one.path).replace(/\.md$/, '')} plain onPress={() => load($, one.path)} />
            <Text dimColor>
              {one.project === undefined ? 'unknown project' : tildify(one.project, home)}
              {one.project === cwd ? ' (here)' : ''} · {ago(one.mtimeMs, now)}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
