const TARGET_HOST = "https://opencode.ai"

// 随机 User-Agent 池 — 模拟不同客户端指纹，增加链路多样性
const USER_AGENTS = [
  "opencode/latest/1.3.15/cli",
  "opencode/latest/1.3.16/cli",
  "opencode/latest/1.3.17/cli",
  "opencode/latest/1.4.0/cli",
  "opencode/latest/1.4.1/cli",
]

const randomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]

const randomHex = (bytes = 8) => {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("")
}

export async function proxyToOpenCode(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const target = TARGET_HOST + url.pathname + url.search

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer()

  const forwardHeaders = new Headers()
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase()
    if (lowerKey.startsWith("x-opencode-") || lowerKey === "authorization") {
      forwardHeaders.set(key, value)
    }
  }
  forwardHeaders.set("User-Agent", randomUserAgent())
  forwardHeaders.set("X-Random-ID", randomHex(8))
  if (!forwardHeaders.has("Content-Type")) {
    forwardHeaders.set("Content-Type", "application/json")
  }

  return await fetch(target, {
    method: request.method,
    headers: forwardHeaders,
    body,
  })
}