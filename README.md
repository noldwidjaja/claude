# claude

Mods for [Claude Code](https://claude.com/claude-code): plugins of function hooks that add to its interface and commands.

| Mod | What it does |
| --- | --- |
| `usage-status` | Your 5-hour and 7-day plan limits as HP bars above the prompt, with when each resets, and context left as an energy bar with a Compact button. |
| `standup` | `/standup [today \| yesterday \| week \| <days>]` turns your commits across the repos in `~/dev` into an update you can paste, with the hours from your Claude Code sessions behind each one, and copies it to the clipboard. |
| `plan-view` | The plan as rendered markdown in a pane beside the conversation. It opens when Claude asks you to approve a plan, and the transcript keeps one line for the plan instead of the whole thing. `/plan-view` shows this session's plan, or lists recent plans with the project each came from; `/plan-view <word>` opens one by name. |
| `speak` | A **Speak answers** button above the prompt (or `/speak`) speaks a one- or two-sentence summary of Claude's answer with macOS `say` when it finishes a turn, in this session only. Sending your next prompt cuts it off; `/speak off` turns it off, and `/speak log` shows what it did lately (summaries, timings, errors). Pick a voice under **Voice** in its plugin settings. |

## Install

In a Claude Code terminal session:

```
/plugin install usage-status --marketplace noldwidjaja/claude
/plugin install standup --marketplace noldwidjaja/claude
/plugin install plan-view --marketplace noldwidjaja/claude
/plugin install speak --marketplace noldwidjaja/claude
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

`standup` searches `~/dev` by default; change **Repos folder** in its plugin settings.
