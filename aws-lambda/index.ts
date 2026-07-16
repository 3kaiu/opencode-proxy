import { proxyToOpenCode } from "../shared/proxy.js"

// AWS Lambda + API Gateway 入口
// API Gateway 配置: REST API (REST) 或 HTTP API，将全部请求转发到 Lambda
// Lambda 运行时: Node.js 20 (或 22)
// 部署方式: 打包为 zip 上传，或通过 SAM/Serverless Framework/CDK
// 出口 IP 是 AWS 随机分配的，自动变化，不需要手动触发重建

import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda"

export const handler = async (event: APIGatewayProxyEvent, _context: Context): Promise<APIGatewayProxyResult> => {
  // 只处理 POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Only POST allowed" }),
    }
  }

  // 构造标准 Request 对象，复用共享模块
  const headers = new Headers()
  if (event.headers["x-opencode-api-key"]) headers.set("x-opencode-api-key", event.headers["x-opencode-api-key"])
  if (event.headers["authorization"] || event.headers["Authorization"]) {
    headers.set("authorization", event.headers["authorization"] || event.headers["Authorization"]!)
  }
  if (event.headers["content-type"] || event.headers["Content-Type"]) {
    headers.set("content-type", event.headers["content-type"] || event.headers["Content-Type"]!)
  }

  const request = new Request("http://localhost/", {
    method: "POST",
    headers,
    body: event.body || undefined,
  })

  const response = await proxyToOpenCode(request)

  // 转发响应
  const responseBody = await response.text()
  const responseHeaders: Record<string, string> = { "Access-Control-Allow-Origin": "*" }
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })

  return {
    statusCode: response.status,
    headers: responseHeaders,
    body: responseBody,
  }
}