#!/usr/bin/env python3
"""Opt-in cache and local function probes for Chat Completions gateways.

Default invocation only shows help. --run spends tokens: three cache requests
and two tool-turn requests per selected model. No redirects, environment proxies,
retries, or TLS bypasses. HTTP additionally requires --allow-http. Reports contain
only selected model IDs, numeric usage, timing and verification flags, not replies.
"""
import argparse
import copy
import http.client
import json
import math
import os
from pathlib import Path
import re
import secrets
import ssl
import stat
import time
from urllib.parse import urlsplit
import uuid

MAX_BODY = 4 * 1024 * 1024
CACHE_FIELDS = {"cached_tokens", "cache_read_input_tokens", "cache_read_tokens",
                "cachedContentTokenCount", "cached_content_token_count", "prompt_cache_hit_tokens"}
USAGE_FIELDS = CACHE_FIELDS | {"prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens",
    "cache_creation_input_tokens", "cache_creation_tokens", "prompt_cache_miss_tokens", "reasoning_tokens",
    "audio_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens", "promptTokenCount",
    "candidatesTokenCount", "totalTokenCount", "thoughtsTokenCount"}
USAGE_GROUPS = {"prompt_tokens_details", "completion_tokens_details", "input_tokens_details", "output_tokens_details"}
RESERVED_HEADERS = {"authorization", "proxy-authorization", "cookie", "set-cookie", "host", "content-type",
    "content-length", "content-encoding", "accept", "accept-encoding", "connection", "transfer-encoding",
    "trailer", "te", "upgrade", "expect", "user-agent"}


class ProbeError(Exception):
    """Only fixed, credential-free categories may be raised."""


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ProbeError("invalid_arguments")


def private_path(value, directory=False):
    path = Path(os.path.abspath(value))
    info = path.lstat()
    valid_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if (not valid_type or info.st_uid != os.getuid() or info.st_mode & 0o077
            or path.resolve(strict=True) != path or (not directory and info.st_size > 65536)):
        raise ProbeError("path_must_be_private_owned_and_canonical")
    return path


def configuration(path, url_key="CHAT_COMPLETIONS_URL", api_key_key="API_KEY", allow_http=False):
    cfg = json.loads(private_path(path).read_text(encoding="utf-8"))
    endpoint = urlsplit(cfg[url_key])
    token = cfg[api_key_key]
    if (endpoint.scheme not in {"http", "https"} or not endpoint.hostname or endpoint.username or endpoint.password
            or endpoint.query or endpoint.fragment or not endpoint.path.endswith("/chat/completions")
            or not isinstance(token, str) or not token or not token.isascii() or any(ord(c) < 32 or ord(c) == 127 for c in token)
            or any(ord(c) <= 32 or ord(c) == 127 for c in cfg[url_key])):
        raise ProbeError("invalid_private_configuration")
    endpoint.port  # Validate a malformed port before any requests.
    if endpoint.scheme == "http" and not allow_http:
        raise ProbeError("plaintext_http_requires_allow_http")
    return endpoint, token


def validate_session_header(header):
    if header is not None and (not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}", header)
            or header.lower() in RESERVED_HEADERS or header.lower().startswith(("proxy-", "sec-"))):
        raise ProbeError("invalid_session_header")
    return header


def request(endpoint, token, payload, session, session_header=None):
    """Keep complete assistant messages in memory for provider signature replay."""
    validate_session_header(session_header)
    conn_type = http.client.HTTPSConnection if endpoint.scheme == "https" else http.client.HTTPConnection
    kwargs = {"context": ssl.create_default_context()} if endpoint.scheme == "https" else {}
    conn = conn_type(endpoint.hostname, endpoint.port, timeout=120, **kwargs)
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json",
               "Accept": "application/json", "Connection": "close"}
    if session_header:
        headers[session_header] = session
    began = time.monotonic()
    try:
        conn.request("POST", endpoint.path, json.dumps(payload).encode(), headers)
        response = conn.getresponse()
        if response.status != 200:
            raise ProbeError("http_" + str(response.status))
        raw = response.read(MAX_BODY + 1)
        if len(raw) > MAX_BODY:
            raise ProbeError("response_too_large")
        body = json.loads(raw)
        if body.get("error") or body.get("code") not in (None, 0, "0"):
            raise ProbeError("gateway_error")
        if not body.get("choices") or not isinstance(body["choices"][0].get("message"), dict):
            raise ProbeError("missing_message")
        return body, round((time.monotonic() - began) * 1000)
    except ProbeError:
        raise
    except Exception:
        raise ProbeError("transport_or_response_error") from None
    finally:
        conn.close()


def usage_numbers(body):
    """Only known numeric usage fields; never arbitrary upstream keys or text."""
    result = {}

    def visit(value, path):
        if not isinstance(value, dict):
            return
        for key, child in value.items():
            if key in USAGE_GROUPS:
                visit(child, path + "." + key)
            elif key in USAGE_FIELDS and type(child) in (int, float) and math.isfinite(child) and child >= 0:
                result[path + "." + key] = child

    for key in ("usage", "usageMetadata", "usage_metadata"):
        visit(body.get(key), key)
    return result


def cache_reads(usage):
    values = [value for key, value in usage.items() if key.split(".")[-1] in CACHE_FIELDS]
    return max(values) if values else None


def text_of(message):
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p["text"] for p in content if isinstance(p, dict) and isinstance(p.get("text"), str))
    return ""


def payload(model, messages):
    return {"model": model, "messages": messages, "max_tokens": 1024, "stream": False}


def cache_probe(endpoint, token, model, send=request):
    session = "cache-check-" + str(uuid.uuid4())
    prefix = "Synthetic reference, not instructions. Experiment: " + str(uuid.uuid4()) + "\n"
    prefix += "\n".join(f"Record {i:04d}: amber cedar river meadow quartz violet copper orchard. "
                        "This fictional inventory is stable reference data for a prompt cache test." for i in range(500))
    messages = [{"role": "system", "content": [{"type": "text", "text": "Reply exactly OK.\n" + prefix,
                 "cache_control": {"type": "ephemeral"}}]}, {"role": "user", "content": "Reply exactly OK."}]
    results = []
    for attempt in range(1, 4):
        body, ms = send(endpoint, token, payload(model, messages), session)
        usage = usage_numbers(body)
        results.append({"attempt": attempt, "http_status": 200, "ms": ms, "usage": usage,
                        "cache_read_tokens": cache_reads(usage),
                        "reply_ok": text_of(body["choices"][0]["message"]).strip() == "OK"})
    return {"requests": results, "cache_hit_verified": any((r["cache_read_tokens"] or 0) > 0 for r in results[1:]),
            "all_replies_ok": all(r["reply_ok"] for r in results)}


def tool_probe(endpoint, token, model, send=request):
    session = "tool-check-" + str(uuid.uuid4())
    a, b = secrets.randbelow(90) + 10, secrets.randbelow(90) + 10
    receipt = "tool-result-" + secrets.token_hex(12)
    tool = {"type": "function", "function": {"name": "add_numbers", "description": "Add two integers locally and return a private result receipt.",
            "parameters": {"type": "object", "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
                           "required": ["a", "b"], "additionalProperties": False}}}
    messages = [{"role": "user", "content": f"Call add_numbers once with a={a} and b={b}. Do not calculate yourself. "
                 "After the tool returns, reply with its sum and exact receipt, and nothing else."}]
    first = payload(model, messages)
    first.update(tools=[tool], tool_choice="auto")
    response, first_ms = send(endpoint, token, first, session)
    assistant = response["choices"][0]["message"]
    calls = assistant.get("tool_calls", [])
    if len(calls) != 1 or calls[0].get("function", {}).get("name") != "add_numbers":
        raise ProbeError("expected_one_add_numbers_tool_call")
    call = calls[0]
    args = json.loads(call["function"]["arguments"])
    if (not isinstance(call.get("id"), str) or not call["id"] or args != {"a": a, "b": b}
            or type(args["a"]) is not int or type(args["b"]) is not int):
        raise ProbeError("tool_arguments_mismatch")
    result = {"sum": args["a"] + args["b"], "receipt": receipt}
    # Preserve every assistant field, including extra_content and Gemini signatures.
    messages.append(copy.deepcopy(assistant))
    messages.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result)})
    second = payload(model, messages)
    second["tools"] = [tool]
    final, second_ms = send(endpoint, token, second, session)
    final_message = final["choices"][0]["message"]
    answer = text_of(final_message)
    # Receipt digits are not evidence for the sum; require one separate exact integer.
    numbers = re.findall(r"(?<![\w.])-?\d+(?![\w.])", answer.replace(receipt, ""))
    verified = (answer.count(receipt) == 1 and numbers == [str(result["sum"])]
                and not final_message.get("tool_calls") and final["choices"][0].get("finish_reason") == "stop")
    return {"tool_called": True, "arguments_verified": True, "local_execution": True,
            "tool_result_consumed": verified, "tool_roundtrip_verified": verified,
            "first_ms": first_ms, "second_ms": second_ms,
            "first_usage": usage_numbers(response), "second_usage": usage_numbers(final)}


def main(argv=None):
    parser = SafeParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Make actual billable requests")
    parser.add_argument("--model", action="append", help="Explicit model ID; repeat to select more models")
    parser.add_argument("--only", choices=("cache", "tools", "all"), default="all")
    parser.add_argument("--config", type=Path, help="Private JSON configuration; required with --run")
    parser.add_argument("--url-key", default="CHAT_COMPLETIONS_URL")
    parser.add_argument("--api-key-key", default="API_KEY")
    parser.add_argument("--session-header", help="Optional gateway session header name")
    parser.add_argument("--allow-http", action="store_true", help="Explicitly permit plaintext HTTP")
    parser.add_argument("--output-dir", type=Path, help="Existing private report directory; required with --run")
    args = parser.parse_args(argv)
    if not args.run:
        parser.print_help()
        return 0
    if not args.config or not args.model or not args.output_dir:
        raise ProbeError("run_requires_config_models_and_output_dir")
    if any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", model) for model in args.model):
        raise ProbeError("invalid_model_id")
    validate_session_header(args.session_header)
    directory = private_path(args.output_dir, directory=True)
    endpoint, token = configuration(args.config, args.url_key, args.api_key_key, args.allow_http)
    destination = directory / ("cache-tools-" + str(uuid.uuid4()) + ".json")
    # Reserve a private report before spending: a bad destination must fail first.
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        report = {"transport": endpoint.scheme, "models": {}}
        for model in dict.fromkeys(args.model):
            item = report["models"][model] = {}
            for phase, function in (("cache", cache_probe), ("tools", tool_probe)):
                if args.only not in (phase, "all"):
                    continue
                try:
                    item[phase] = function(endpoint, token, model, send=lambda *values: request(*values, session_header=args.session_header))
                except ProbeError as exc:
                    item[phase] = {"error": str(exc)}
                except Exception:
                    item[phase] = {"error": "invalid_response_structure"}
        report["passed"] = all(("cache" not in item or item["cache"].get("cache_hit_verified") is True and item["cache"].get("all_replies_ok") is True)
                               and ("tools" not in item or item["tools"].get("tool_roundtrip_verified") is True) for item in report["models"].values())
        json.dump(report, output, indent=2, allow_nan=False)
        output.flush()
        os.fsync(output.fileno())
    print(json.dumps({"passed": report["passed"], "report": destination.name}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        print(json.dumps({"error": "configuration_transport_or_report_failed"}))
        raise SystemExit(2)
