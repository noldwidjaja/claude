// What kind of step it was, as the timeline tags it.
export type Tag = 'built' | 'changed' | 'fixed' | 'explained' | 'explored' | 'asked' | 'planned'
// What a step's summary says: its tag and one line.
export type Summary = { tag: Tag; line: string }
// Each step's summary, by the step's key.
export type Summaries = Record<string, Summary>
// The overview of the session, and the steps it was written from.
export type Overview = { key: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    catchup: { summaries: Shaped<Summaries>; overview: Shaped<Overview>; page: number }
  }
}
