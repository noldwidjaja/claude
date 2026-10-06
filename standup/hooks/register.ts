import type { Register } from 'claude-code'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
// A gap longer than this between two moments of Claude Code activity is a break, not work.
const IDLE = 30 * MINUTE

type Period = { label: string; since: string; until?: string; days: number }

type Commit = { at: number; subject: string; body: string[] }
type Repo = { path: string; name: string; commits: Commit[] }
type Activity = { at: number; cwd: string }

export type Collected = { now: number; sinceMidnight: number; repos: Repo[]; activity: Activity[] }

// What follows /standup: nothing for today, `yesterday`, `week`, or a number of days.
export function periodOf(args: string): Period | undefined {
  const word = args.trim().toLowerCase()

  if (word === '' || word === 'today') {
    return { label: 'today', since: 'midnight', days: 0 }
  }

  if (word === 'yesterday') {
    return { label: 'yesterday', since: 'yesterday midnight', until: 'midnight', days: 1 }
  }

  const days = word === 'week' ? 7 : Number(word)

  return Number.isInteger(days) && days > 0
    ? { label: `the last ${days} day${days === 1 ? '' : 's'}`, since: `${days} days ago`, days }
    : undefined
}

// The period as milliseconds since the epoch, from the machine's clock and its local midnight.
export function windowOf(period: Period, now: number, sinceMidnight: number): { start: number; end: number } {
  const midnight = now - sinceMidnight

  if (period.label === 'today') {
    return { start: midnight, end: now }
  }

  return period.label === 'yesterday' ? { start: midnight - DAY, end: midnight } : { start: now - period.days * DAY, end: now }
}

// Prints, line by line: `NOW <epoch s> <s since local midnight>`; for each repo under the root,
// `REPO <path>`, then `C <epoch s> <subject>` and `B <body line>` for the person's commits; and
// `A <ISO minute>\t<cwd>` for each minute a Claude Code session logged activity.
const COLLECT = `
root="$1"; case "$root" in "~"*) root="$HOME\${root#\\~}";; esac
echo "NOW $(date +%s) $(date '+%H %M %S' | awk '{ print $1 * 3600 + $2 * 60 + $3 }')"
me=$(git config --global user.email)
find "$root" -maxdepth 3 -name .git -type d -prune 2>/dev/null | sort | while read -r dir; do
  repo=$(dirname "$dir")
  echo "REPO $repo"
  git -C "$repo" log --all --no-merges --author="$me" --since="$2" \${3:+--until="$3"} --pretty='C %ct %s%n%w(0,2,2)%b' 2>/dev/null \\
    | grep -v 'Co-Authored-By:' | sed 's/^  /B /' | grep -v '^\\s*$' | head -c 20000
done
find "$HOME/.claude/projects" -name '*.jsonl' -mtime "-$4" -exec awk '{
  c = ""; t = ""
  if (match($0, /"cwd":"[^"]*"/)) c = substr($0, RSTART + 7, RLENGTH - 8)
  if (match($0, /"timestamp":"[^"]*"/)) t = substr($0, RSTART + 13, RLENGTH - 14)
  if (c != "" && t != "") print "A " substr(t, 1, 16) "\\t" c
}' {} + 2>/dev/null | sort -u
`

export function parse(stdout: string): Collected {
  const collected: Collected = { now: 0, sinceMidnight: 0, repos: [], activity: [] }

  for (const line of stdout.split('\n')) {
    const [tag, ...rest] = line.split(' ')
    const value = rest.join(' ')
    const repo = collected.repos.at(-1)

    if (tag === 'NOW') {
      collected.now = Number(rest[0]) * 1000
      collected.sinceMidnight = Number(rest[1]) * 1000
    } else if (tag === 'REPO') {
      collected.repos.push({ path: value, name: value.split('/').at(-1) ?? value, commits: [] })
    } else if (tag === 'C' && repo !== undefined) {
      const [at = '0', ...subject] = rest
      repo.commits.push({ at: Number(at) * 1000, subject: subject.join(' '), body: [] })
    } else if (tag === 'B' && value.trim() !== '') {
      repo?.commits.at(-1)?.body.push(value)
    } else if (tag === 'A') {
      const [minute = '', cwd = ''] = value.split('\t')
      collected.activity.push({ at: Date.parse(`${minute}:00Z`), cwd })
    }
  }

  return collected
}

// Active time between each commit and the one before it, and after the last (not committed yet).
// Each logged minute is credited with the gap since the one before it, or a minute when it starts a burst.
export function workedFor(stamps: readonly number[], commits: readonly number[]): { perCommit: number[]; after: number } {
  const perCommit = commits.map(() => 0)
  let after = 0

  stamps.forEach((at, i) => {
    const gap = i === 0 ? Infinity : at - (stamps[i - 1] ?? at)
    const credit = gap <= IDLE ? gap : MINUTE
    const index = commits.findIndex(committed => committed >= at)

    if (index === -1) {
      after += credit
    } else {
      perCommit[index] = (perCommit[index] ?? 0) + credit
    }
  })

  return { perCommit, after }
}

export function duration(ms: number): string {
  const minutes = Math.round(ms / MINUTE)
  const hours = Math.floor(minutes / 60)

  if (hours === 0) {
    return `${minutes}m`
  }

  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
}

// The longest repo path that holds the folder a session ran in.
const repoOf = (repos: readonly Repo[], cwd: string) =>
  repos
    .filter(repo => cwd === repo.path || cwd.startsWith(`${repo.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]

// The commits and hours, per repo, as the model reads them; and the total worked.
export function reportOf(collected: Collected, period: Period): { report: string; total: number } {
  const { start, end } = windowOf(period, collected.now, collected.sinceMidnight)
  const stamps = new Map<Repo, number[]>()

  for (const { at, cwd } of collected.activity) {
    const repo = repoOf(collected.repos, cwd)

    if (repo !== undefined && at >= start && at < end) {
      stamps.set(repo, [...(stamps.get(repo) ?? []), at])
    }
  }

  let total = 0
  const sections: string[] = []

  for (const repo of collected.repos) {
    const commits = [...repo.commits].sort((a, b) => a.at - b.at)
    const times = [...new Set(stamps.get(repo) ?? [])].sort((a, b) => a - b)
    const { perCommit, after } = workedFor(times, commits.map(commit => commit.at))
    const worked = perCommit.reduce((sum, ms) => sum + ms, 0) + after
    const isInProgress = after >= 5 * MINUTE

    if (commits.length === 0 && !isInProgress) {
      continue
    }

    total += worked
    const lines = commits.map((commit, i) => {
      const spent = perCommit[i] ?? 0
      const time = spent >= MINUTE ? duration(spent) : 'no Claude time'

      return [`- [${time}] ${commit.subject}`, ...commit.body.map(line => `    ${line}`)].join('\n')
    })

    if (isInProgress) {
      lines.push(`- [${duration(after)}, not committed yet] Work in progress`)
    }

    const heading = worked >= MINUTE ? `## ${repo.name} — ${duration(worked)}` : `## ${repo.name}`
    sections.push([heading, ...lines].join('\n'))
  }

  return { report: sections.join('\n\n'), total }
}

const SYSTEM = `You turn a developer's git commits into a standup update they can paste into a team chat.
Each project comes as "## name — time"; write it as "**name** (time)", or "**name**" when it has no time.
Under it, one bullet per commit, in order, rewritten in first person, past tense, plain English:
what got done and why it matters, not commit jargon. End each bullet with its bracketed time in
parentheses, copied exactly, e.g. "(45m)"; leave the time off when it says "no Claude time".
A "Work in progress" line becomes a bullet saying work continued there, with its time.
No commit hashes, no preamble, no totals, no sign-off.`

const USAGE = 'Usage: /standup [today | yesterday | week | <days>]'

export const register: Register = (on, options) => {
  const reposRoot = typeof options.reposRoot === 'string' ? options.reposRoot : '~/dev'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'standup',
      description: 'Summarize your commits and hours for a standup update (today, yesterday, week, or N days)',
    })

    return next(e)
  })

  on('command.run', { command: 'standup' }, async ($, e) => {
    const period = periodOf(e.args)

    if (period === undefined) {
      return { text: USAGE }
    }

    const argv = ['sh', '-c', COLLECT, 'standup', reposRoot, period.since, period.until ?? '', String(period.days + 1)]
    const { stdout } = await $.process.run(argv, { timeoutMs: 60_000 })
    const { report, total } = reportOf(parse(stdout), period)

    if (report === '') {
      return { text: `No commits by you in ${reposRoot} ${period.label}.` }
    }

    const reply = await $.model.complete({
      model: 'haiku',
      system: SYSTEM,
      prompt: `My commits from ${period.label}:\n\n${report}`,
      maxTokens: 2048,
      timeoutMs: 60_000,
    })
    const summary = reply.isAnswered ? reply.text.trim() : report
    const update = total >= MINUTE ? `${summary}\n\nTotal: ${duration(total)}` : summary
    const copied = await $.ui.copy({ text: update })
    const footer = [
      reply.isAnswered ? undefined : `(Couldn't summarize: ${reply.reason}; these are the raw commits.)`,
      copied.isCopied ? 'Copied to your clipboard.' : undefined,
    ].filter(line => line !== undefined)

    return { text: [`Standup for ${period.label}:`, '', update, '', ...footer].join('\n') }
  })
}
