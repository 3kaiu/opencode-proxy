/** 检测 opencode.ai 是否返回了 Free usage exceeded 限流信号 */
export async function isFreeUsageExceeded(response: Response): Promise<boolean> {
  if (response.status !== 403 && response.status !== 429) return false
  const text = await response.clone().text()
  return text.includes("Free usage exceeded, subscribe to Go")
}