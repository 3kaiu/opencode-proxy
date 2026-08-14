#!/usr/bin/env python3
# scripts/mitm_capture.py — mitmdump 纯透传抓包 addon
#   只记录 opencode.ai（含 *.opencode.ai）流量, 不拦截不改写, 全部放行
#   日志累积追加到 ~/Desktop/opencode-mitm/opencode-ai.jsonl (JSONL, 每行一个请求)
#   完整留存: HTTP 版本/方法/URL/请求头/trailers/请求体(完整无截断)
#             响应状态/响应头/trailers/响应体(解压后文本完整) + 压缩原始字节(base64)
#             + WebSocket 双向消息
# 用法: mitmdump -q -s scripts/mitm_capture.py -p 8090

import base64
import json
import os
import time

LOG_PATH = os.path.abspath(
    os.path.join(os.path.expanduser("~"), "Desktop", "opencode-mitm", "opencode-ai.jsonl")
)
RAW_CAP = 2 * 1024 * 1024  # 压缩原始字节的留存上限(仅核对用, 正常请求为 0 开销)


class OpenCodeAICapture:
    def __init__(self):
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        self._fd = open(LOG_PATH, "a")

    def _is_opencode_ai(self, flow) -> bool:
        host = flow.request.pretty_host.lower()
        return host == "opencode.ai" or host.endswith(".opencode.ai")

    @staticmethod
    def _headers(headers) -> dict | None:
        if not headers:
            return None
        return {k: v for k, v in headers.items()}

    @staticmethod
    def _is_text(headers: dict | None, content: bytes | None) -> bool:
        if not content:
            return True
        ct = ""
        if headers:
            for k, v in headers.items():
                if k.lower() == "content-type":
                    ct = v
                    break
        if ct.startswith("text/") or "json" in ct or "event-stream" in ct or "javascript" in ct:
            return True
        return False

    @staticmethod
    def _body(content: bytes | None, headers: dict | None, raw: bytes | None = None, compressed: bool = False):
        data = content or b""
        out = {"len": len(data)}
        if OpenCodeAICapture._is_text(headers, data):
            out["text"] = data.decode("utf-8", "replace")
        else:
            out["b64"] = base64.b64encode(data).decode("ascii")
        if compressed and raw is not None and raw != data:
            out["raw_len"] = len(raw)
            out["raw_b64"] = base64.b64encode(raw[:RAW_CAP]).decode("ascii")
            if len(raw) > RAW_CAP:
                out["raw_truncated"] = True
        return out

    def _log(self, flow, error=None):
        if not self._is_opencode_ai(flow):
            return
        req = flow.request
        started = flow.metadata.get("oc_capture_ts", time.time())
        entry = {
            "ts": started,
            "ms": int((time.time() - started) * 1000),
            "http_version": req.http_version,
            "method": req.method,
            "url": req.pretty_url,
            "request": {
                "headers": self._headers(req.headers),
                "trailers": self._headers(getattr(req, "trailers", None)),
            },
        }
        if req.raw_content:
            entry["request"]["body"] = self._body(
                req.content, self._headers(req.headers), req.raw_content,
                compressed=bool(req.headers.get("content-encoding")),
            )
        if error is not None:
            entry["error"] = error
        elif flow.response is not None:
            res = flow.response
            res_headers = self._headers(res.headers)
            entry["response"] = {
                "status": res.status_code,
                "http_version": getattr(res, "http_version", None),
                "headers": res_headers,
                "trailers": self._headers(getattr(res, "trailers", None)),
            }
            if res.content:
                entry["response"]["body"] = self._body(
                    res.content, res_headers, res.raw_content,
                    compressed=bool(res.headers.get("content-encoding")),
                )
        try:
            self._fd.write(json.dumps(entry, ensure_ascii=False) + "\n")
            self._fd.flush()
        except Exception:
            pass

    def request(self, flow):
        flow.metadata["oc_capture_ts"] = time.time()

    def response(self, flow):
        self._log(flow)

    def error(self, flow):
        self._log(flow, error=str(flow.error))

    def websocket_start(self, flow):
        if self._is_opencode_ai(flow):
            flow.metadata["oc_ws"] = []

    def websocket_message(self, flow):
        if flow.metadata.get("oc_ws") is None:
            return
        if not self._is_opencode_ai(flow):
            return
        msg = flow.messages[-1]
        content = msg.content or b""
        record = {
            "ts": time.time(),
            "dir": "client->server" if msg.from_client else "server->client",
            "type": msg.type,
            "len": len(content),
        }
        try:
            record["text"] = content.decode("utf-8", "replace")
        except Exception:
            record["b64"] = base64.b64encode(content).decode("ascii")
        flow.metadata["oc_ws"].append(record)

    def websocket_end(self, flow):
        ws = flow.metadata.get("oc_ws")
        if not ws:
            return
        started = flow.metadata.get("oc_capture_ts", time.time())
        try:
            self._fd.write(json.dumps({
                "ts": started,
                "ms": int((time.time() - started) * 1000),
                "http_version": flow.request.http_version,
                "method": flow.request.method,
                "url": flow.request.pretty_url,
                "upgraded": True,
                "request": {"headers": self._headers(flow.request.headers)},
                "response": {"status": flow.response.status_code if flow.response else None,
                             "headers": self._headers(flow.response.headers) if flow.response else None},
                "websocket_messages": ws,
            }, ensure_ascii=False) + "\n")
            self._fd.flush()
        except Exception:
            pass


addons = [OpenCodeAICapture()]