/** 检测 opencode.ai 是否返回了免费额度限流信号（触发自动重新部署换 IP） */
export async function isFreeUsageExceeded(response: Response): Promise<boolean> {
  if (response.status !== 403 && response.status !== 429) return false
  const text = await response.clone().text()
  return (
    text.includes("Free usage exceeded, subscribe to Go") ||
    text.includes("FreeUsageLimitError") ||
    text.includes("Rate limit exceeded")
  )
}