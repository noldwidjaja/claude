import { atom, read, update } from 'claude-code'
import type { Color, Hook, Register } from 'claude-code'

import type { Figures, Limit } from '../types'

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const WARN_AT = 90
const MINUTE = 60_000
const BAR_CELLS = 20

const figures = atom({ plugin: 'usage-status', key: 'figures' } as const, null)
const now = atom({ plugin: 'usage-status', key: 'now' } as const, 0)
const isCompacting = atom({ plugin: 'usage-status', key: 'isCompacting' } as const, false)

const label = (r: Limit) => LABELS[r.kind] ?? r.kind

export const hpOf = (r: Limit) => Math.max(0, Math.min(100, Math.round(100 - r.percentUsed)))

// Context left in the window, drained as the conversation fills it.
export const energyOf = (percent: number) => Math.max(0, Math.min(100, 100 - percent))

export function hpColor(hp: number): Color {
  if (hp > 50) {
    return 'success'
  }

  return hp > 20 ? 'warning' : 'error'
}

export function bar(hp: number): { full: string; empty: string } {
  const filled = Math.ceil((hp / 100) * BAR_CELLS)

  return { full: '█'.repeat(filled), empty: '░'.repeat(BAR_CELLS - filled) }
}

export function untilReset(resetsAt: string, at: number): string {
  const minutes = Math.max(0, Math.ceil((Date.parse(resetsAt) - at) / MINUTE))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)

  if (days > 0) {
    return `${days}d ${hours}h`
  }

  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

// Windows already toasted about; a window that drops back under WARN_AT can warn again.
const warned = new Set<string>()

async function measured($: Parameters<Hook<'session.measure'>>[0], next: Figures) {
  await update($, figures, () => next)
  await update($, now, () => 0)

  for (const r of next.rateLimits) {
    if (r.percentUsed < WARN_AT) {
      warned.delete(r.kind)
    } else if (!warned.has(r.kind)) {
      warned.add(r.kind)
      $.ui.toast(`${label(r)} at ${hpOf(r)} HP left`)
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The bars replace the text line older versions pinned.
    $.ui.status(undefined)
    await measured($, await $.session.usage())
    // Redraw each minute so the countdowns stay current.
    $.clock.every(MINUTE, () => void $.clock.now().then(t => update($, now, () => t)))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await measured($, e)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, figures)
    const percent = shown?.context.percent

    if (e.props.hasSurvey || shown === null || (shown.rateLimits.length === 0 && percent === undefined)) {
      return next(e)
    }

    const at = (await read($, now)) || (await $.clock.now())
    const { Box, Button, Text } = $.ui.resolve(e)

    const compact = async () => {
      await update($, isCompacting, () => true)

      try {
        const result = await $.session.compact()

        if (result.skip !== undefined) {
          $.ui.toast(`Didn't compact: ${result.skip}`)
        }
      } finally {
        await update($, isCompacting, () => false)
      }
    }

    // Compacting mid-turn would cut the turn short, so the button waits for it to end.
    const compactControl = (await read($, isCompacting)) ? (
      <Text dimColor>compacting…</Text>
    ) : e.props.isWorking ? undefined : (
      <Button key="compact" label="Compact" hotkey="c" dimColor onPress={compact} />
    )

    // One row per meter, every column a fixed width so the bars line up.
    const meter = (key: string, icon: string, name: string, value: number, unit: string, color: Color, note?: string, extra?: JSX.Element) => {
      const { full, empty } = bar(value)

      return (
        <Box key={key} flexDirection="row" columnGap={1}>
          {/* ⚡ draws two cells wide and ♥ one: a fixed-width cell keeps the bars in line. */}
          <Box width={2}>
            <Text color={color}>{icon}</Text>
          </Box>
          <Box width={3}>
            <Text bold>{name}</Text>
          </Box>
          <Text>
            <Text color={color}>{full}</Text>
            <Text dimColor>{empty}</Text>
          </Text>
          <Box width={6}>
            <Text color={color}>{`${value} ${unit}`}</Text>
          </Box>
          {note === undefined ? null : <Text dimColor>{note}</Text>}
          {extra}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {shown.rateLimits.map(r => {
          const hp = hpOf(r)
          const note = r.resetsAt === undefined ? undefined : untilReset(r.resetsAt, at)

          return meter(r.kind, '♥', label(r), hp, 'HP', hpColor(hp), note)
        })}
        {percent === undefined ? null : meter('context', '⚡', 'ctx', energyOf(percent), 'EN', 'warning', undefined, compactControl)}
      </Box>
    )
  })
}
