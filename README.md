# claude

Mods for [Claude Code](https://claude.com/claude-code): plugins of function hooks that add to its interface and commands.

| Mod | What it does |
| --- | --- |
| `usage-status` | Your 5-hour and 7-day plan limits as HP bars above the prompt, with when each resets, and context left as an energy bar with a Compact button. |
| `standup` | `/standup [today \| yesterday \| week \| <days>]` turns your commits across the repos in `~/dev` into an update you can paste, with the hours from your Claude Code sessions behind each one, and copies it to the clipboard. |

## Install

In a Claude Code terminal session:

```
/plugin install usage-status --marketplace noldwidjaja/claude
/plugin install standup --marketplace noldwidjaja/claude
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

`standup` searches `~/dev` by default; change **Repos folder** in its plugin settings.
