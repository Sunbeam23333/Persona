"""Offline protocol and privacy regressions; no model or network requests."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

import cache_tools as probe


def completion(text="OK", usage=None, message=None, finish="stop"):
    return {"choices": [{"message": message or {"role": "assistant", "content": text}, "finish_reason": finish}], "usage": usage or {}}


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cache-tools-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({"CHAT_COMPLETIONS_URL": "https://gateway.example/chat/completions", "API_KEY": "test-only-token"}))
        self.config.chmod(0o600)
        self.output = self.root / "reports"
        self.output.mkdir(mode=0o700)
        self.args = ["--run", "--config", str(self.config), "--model", "example/model-v1", "--output-dir", str(self.output)]

    def test_default_and_help_never_read_config_or_send(self):
        with patch.object(probe, "configuration", side_effect=AssertionError("no config reads")), patch.object(probe, "request", side_effect=AssertionError("no requests")), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(probe.main([]), 0)
            self.assertEqual(probe.main(["--config", "/missing/file"]), 0)

    def test_run_requires_explicit_configuration_models_and_output(self):
        with patch.object(probe, "request", side_effect=AssertionError("no requests")):
            for missing in ("--config", "--model", "--output-dir"):
                args = self.args.copy()
                index = args.index(missing)
                del args[index:index + 2]
                with self.assertRaises(probe.ProbeError):
                    probe.main(args)

    def test_custom_config_keys_and_http_opt_in(self):
        self.config.write_text(json.dumps({"ENDPOINT_FIELD": "http://gateway.example/chat/completions", "TOKEN_FIELD": "test-only-token"}))
        with self.assertRaises(probe.ProbeError):
            probe.configuration(self.config, "ENDPOINT_FIELD", "TOKEN_FIELD")
        endpoint, token = probe.configuration(self.config, "ENDPOINT_FIELD", "TOKEN_FIELD", True)
        self.assertEqual(endpoint.scheme, "http")
        self.assertEqual(token, "test-only-token")

    def test_private_config_rejects_permissions_symlinks_and_bad_auth(self):
        self.config.chmod(0o644)
        with self.assertRaises(probe.ProbeError):
            probe.configuration(self.config)
        self.config.chmod(0o600)
        alias = self.root / "alias.json"
        alias.symlink_to(self.config)
        with self.assertRaises(probe.ProbeError):
            probe.configuration(alias)
        self.config.write_text(json.dumps({"CHAT_COMPLETIONS_URL": "https://gateway.example/chat/completions", "API_KEY": "bad\r\nheader"}))
        with self.assertRaises(probe.ProbeError):
            probe.configuration(self.config)

    def test_unsafe_report_directory_fails_before_spending(self):
        self.output.chmod(0o755)
        with patch.object(probe, "request", side_effect=AssertionError("no requests")), self.assertRaises(probe.ProbeError):
            probe.main(self.args)
        self.assertEqual(list(self.output.iterdir()), [])
        self.output.chmod(0o700)
        with patch.object(probe.os, "open", side_effect=PermissionError), patch.object(probe, "request", side_effect=AssertionError("no requests")), self.assertRaises(PermissionError):
            probe.main(self.args)

    def test_session_header_rejects_reserved_and_injection_names(self):
        self.assertEqual(probe.validate_session_header("X-Example-Session"), "X-Example-Session")
        self.assertIsNone(probe.validate_session_header(None))
        for header in ("Authorization", "HOST", "Content-Length", "Cookie", "Connection", "Transfer-Encoding", "Proxy-Key", "Sec-Token", "Bad\r\nName", "Name: value", ""):
            with self.assertRaises(probe.ProbeError):
                probe.validate_session_header(header)

    def test_usage_allows_known_numbers_not_arbitrary_strings(self):
        usage = probe.usage_numbers({"usage": {"prompt_tokens": 12, "private-upstream-key": 99, "total_tokens": True,
            "input_tokens": float("inf"), "output_tokens": -1, "prompt_tokens_details": {"cached_tokens": 8, "unknown": 5}},
            "usageMetadata": {"cachedContentTokenCount": 9}})
        self.assertEqual(probe.cache_reads(usage), 9)
        self.assertEqual(set(usage), {"usage.prompt_tokens", "usage.prompt_tokens_details.cached_tokens", "usageMetadata.cachedContentTokenCount"})
        self.assertIsNone(probe.cache_reads({"usage.total_tokens": 500}))

    def test_cache_reuses_exact_prefix_and_session_for_three_requests(self):
        sent = []

        def send(endpoint, token, payload, session):
            sent.append((copy.deepcopy(payload), session))
            return completion(usage={"prompt_tokens_details": {"cached_tokens": 0 if len(sent) == 1 else 100}}), 1

        result = probe.cache_probe(None, "test-only-token", "example-model", send)
        self.assertEqual(len(sent), 3)
        self.assertEqual(sent[0], sent[1])
        self.assertEqual(sent[1], sent[2])
        self.assertEqual(sent[0][0]["messages"][0]["content"][0]["cache_control"], {"type": "ephemeral"})
        self.assertTrue(result["cache_hit_verified"])
        self.assertTrue(result["all_replies_ok"])

    def test_cache_requires_repeat_read_counter_not_latency_or_first_hit(self):
        for counters in ([None, None, None], [12, 0, 0]):
            values = iter(counters)
            result = probe.cache_probe(None, "test-only-token", "example-model", lambda *args: (completion(usage={"cached_tokens": next(values)}), 0))
            self.assertFalse(result["cache_hit_verified"])

    def tool_sender(self, answer=None, bad_args=False):
        seen = []
        assistant = None

        def send(endpoint, token, payload, session):
            nonlocal assistant
            seen.append(copy.deepcopy(payload))
            if len(seen) == 1:
                a, b = map(int, re.search(r"a=(\d+) and b=(\d+)", payload["messages"][0]["content"]).groups())
                assistant = {"role": "assistant", "content": None, "extra_content": {"google": {"thought_signature": "synthetic-signature"}},
                    "tool_calls": [{"id": "test-tool-id", "type": "function", "function": {"name": "add_numbers", "arguments": json.dumps({"a": a + int(bad_args), "b": b})},
                                    "extra_content": {"google": {"thought_signature": "synthetic-call-signature"}}}]}
                return completion(message=assistant, finish="tool_calls"), 2
            self.assertEqual(payload["messages"][1], assistant)
            self.assertIsNot(payload["messages"][1], assistant)
            self.assertEqual(payload["messages"][2]["tool_call_id"], "test-tool-id")
            result = json.loads(payload["messages"][2]["content"])
            text = answer(result) if answer else f'{result["sum"]} {result["receipt"]}'
            return completion(text), 3

        return send, seen

    def test_tool_roundtrip_executes_locally_and_preserves_assistant_extras(self):
        send, seen = self.tool_sender()
        result = probe.tool_probe(None, "test-only-token", "example-model", send)
        self.assertEqual(len(seen), 2)
        self.assertTrue(result["local_execution"])
        self.assertTrue(result["tool_roundtrip_verified"])
        self.assertNotIn("synthetic-signature", json.dumps(result))

    def test_receipt_substring_wrong_sum_and_extra_numbers_are_not_success(self):
        for answer in (lambda r: r["receipt"], lambda r: f'{r["sum"] + 1} {r["receipt"]}',
                       lambda r: f'{r["sum"]} 999 {r["receipt"]}'):
            send, _ = self.tool_sender(answer)
            with patch.object(probe.secrets, "randbelow", return_value=0), patch.object(probe.secrets, "token_hex", return_value="20"):
                self.assertFalse(probe.tool_probe(None, "test-only-token", "example-model", send)["tool_roundtrip_verified"])

    def test_invalid_tool_arguments_never_start_second_request(self):
        send, seen = self.tool_sender(bad_args=True)
        with self.assertRaises(probe.ProbeError):
            probe.tool_probe(None, "test-only-token", "example-model", send)
        self.assertEqual(len(seen), 1)

    def test_transport_uses_verified_tls_custom_header_and_no_redirect(self):
        class Connection:
            def __init__(self):
                self.status = 200
                self.closed = False

            def request(self, method, path, data, headers):
                self.headers = headers
                self.method = method

            def getresponse(self):
                return self

            def read(self, limit):
                return json.dumps(completion()).encode()

            def close(self):
                self.closed = True

        connection = Connection()
        with patch.object(probe.http.client, "HTTPSConnection", return_value=connection) as constructor:
            probe.request(urlsplit("https://gateway.example/chat/completions"), "test-only-token", {}, "synthetic-session", "X-Example-Session")
            self.assertTrue(constructor.call_args.kwargs["context"].check_hostname)
            self.assertEqual(connection.headers["X-Example-Session"], "synthetic-session")
            self.assertEqual(connection.headers["Authorization"], "Bearer test-only-token")
            self.assertTrue(connection.closed)
            connection.status = 302
            with self.assertRaisesRegex(probe.ProbeError, "^http_302$"):
                probe.request(urlsplit("https://gateway.example/chat/completions"), "test-only-token", {}, "synthetic-session")
            self.assertEqual(constructor.call_count, 2)

    def test_run_writes_private_sanitized_report_with_fake_transport(self):
        with patch.object(probe, "request", return_value=(completion(usage={"cached_tokens": 100}), 1)), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(probe.main(self.args + ["--only", "cache"]), 0)
        files = list(self.output.iterdir())
        self.assertEqual(len(files), 1)
        self.assertEqual(stat.S_IMODE(files[0].stat().st_mode), 0o600)
        report = json.loads(files[0].read_text())
        self.assertTrue(report["passed"])
        combined = files[0].read_text() + output.getvalue()
        for private in ("test-only-token", "gateway.example", str(self.config), "Synthetic reference"):
            self.assertNotIn(private, combined)

    def test_invalid_model_and_errors_cannot_echo_upstream_payload(self):
        args = self.args.copy()
        args[args.index("--model") + 1] = "model\nheader"
        with patch.object(probe, "request", side_effect=AssertionError("no requests")), self.assertRaises(probe.ProbeError):
            probe.main(args)
        with patch.object(probe, "request", side_effect=ValueError("private response contents")), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(probe.main(self.args + ["--only", "cache"]), 1)
        report = next(self.output.iterdir()).read_text()
        self.assertIn("invalid_response_structure", report)
        self.assertNotIn("private response contents", report)


if __name__ == "__main__":
    unittest.main()
