export type Voice = string

declare module 'claude-code' {
  interface PluginState {
    speak: { isOn: boolean; log: string[]; last: string; claimed: string }
  }
}
