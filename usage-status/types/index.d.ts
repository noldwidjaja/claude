export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Figures = { context: { window: number; tokens?: number; percent?: number }; rateLimits: Limit[] }

declare module 'claude-code' {
  interface PluginState {
    'usage-status': { figures: Figures | null; now: number; isCompacting: boolean; hasLimits: boolean }
  }
}
