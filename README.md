# claude

Mods for [Claude Code](https://claude.com/claude-code): plugins of function hooks that add to its interface and commands.

| Mod | What it does |
| --- | --- |
| `usage-status` | Your 5-hour and 7-day plan limits as HP bars above the prompt, with when each resets, and context left as an energy bar with a Compact button. |
| `standup` | `/standup [today \| yesterday \| week \| <days>]` turns your commits across the repos in `~/dev` into an update you can paste, with the hours from your Claude Code sessions behind each one, and copies it to the clipboard. |
| `plan-view` | The plan as rendered markdown in a pane beside the conversation. It opens when Claude asks you to approve a plan, and the transcript keeps one line for the plan instead of the whole thing. `/plan-view` shows this session's plan, or lists recent plans with the project each came from; `/plan-view <word>` opens one by name. |
| `speak` | A **Speak answers** button above the prompt (or `/speak`) speaks a one- or two-sentence summary of Claude's answer when it finishes a turn, in this session only. It uses [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), a local voice model, when installed (see below), and macOS `say` otherwise. **↻ Replay** beside it (or `/speak replay`) says the last summary again. Sending your next prompt cuts it off; `/speak log` shows what it did lately (summaries, timings, errors). |

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

`speak` uses Kokoro when it finds it in `~/.claude/kokoro` (change **Kokoro folder** in its settings, or empty it to always use `say`), with **Kokoro voice** `af_bella` by default:

```
brew install uv
uv venv ~/.claude/kokoro --python 3.12
uv pip install --python ~/.claude/kokoro kokoro-onnx soundfile
cd ~/.claude/kokoro
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```
