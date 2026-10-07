export type Plan = { path: string; text: string }

// A plan file in ~/.claude/plans, with the folder of the session that wrote it when a
// transcript names it.
export type PlanChoice = { path: string; mtimeMs: number; project?: string }

declare module 'claude-code' {
  interface PluginState {
    'plan-view': {
      plan: Plan | null
      sessionPlan: string | null
      choices: PlanChoice[]
      view: 'plan' | 'list'
    }
  }
}
