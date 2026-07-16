/**
 * 触发平台重新部署自身，以获得新的出口 IP。
 *
 * 原理：Vercel/Deno Deploy 都是 Serverless 平台，单实例无法控制出口 IP。
 * 但重新部署会分配新的基础设施节点，出口 IP 几乎必然变化。
 * 通过平台 Deploy Hook API 触发部署。
 */
export async function triggerSelfRedeploy(hookUrl: string | undefined): Promise<void> {
  if (!hookUrl) {
    console.error("[redeploy] No deploy hook URL configured — skipping")
    return
  }
  console.log("[redeploy] Free usage limit hit, triggering self redeploy...")
  try {
    const res = await fetch(hookUrl, { method: "POST" })
    if (!res.ok) {
      console.error(`[redeploy] Hook returned ${res.status}: ${await res.text()}`)
    } else {
      console.log("[redeploy] Redeploy triggered successfully")
    }
  } catch (err) {
    console.error("[redeploy] Failed to trigger redeploy:", err)
  }
}