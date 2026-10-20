/** Types for fake-anthropic.mjs (a stand-in for the Messages API, for tests). */
export interface FakeRequest {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown>
}

export interface FakePlan {
  text?: string[]
  refusal?: string
  fallback?: string
  then?: string[]
  status?: number
  error?: string
}

export function startFakeAnthropic(reply?: (body: Record<string, unknown>) => FakePlan): Promise<{ url: string; requests: FakeRequest[]; close: () => Promise<void> }>
