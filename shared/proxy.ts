const TARGET_HOST = "https://opencode.ai"

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
  if (!forwardHeaders.has("Content-Type")) {
    forwardHeaders.set("Content-Type", "application/json")
  }
  if (!forwardHeaders.has("User-Agent")) {
    forwardHeaders.set("User-Agent", "opencode/latest/1.3.15/cli")
  }

  return await fetch(target, {
    method: request.method,
    headers: forwardHeaders,
    body,
  })
}