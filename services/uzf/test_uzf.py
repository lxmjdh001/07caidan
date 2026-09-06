import base64
import hashlib
import hmac
import tempfile
import unittest
from pathlib import Path

from okx_monitor import OKXMonitor
from query_api import verify_signature


class UzfTests(unittest.TestCase):
    def config(self, directory: str):
        return {
            "okx": {"api_key": "key", "secret_key": "secret", "passphrase": "pass"},
            "monitor": {
                "currency": "USDT",
                "chain": "USDT-TRC20",
                "address": "T-RECEIVE",
                "json_file": str(Path(directory) / "transfers.json"),
            },
        }

    def test_okx_signature(self):
        with tempfile.TemporaryDirectory() as directory:
            monitor = OKXMonitor(self.config(directory))
            path = "/api/v5/asset/deposit-history?ccy=USDT&limit=100"
            source = f"2026-09-07T00:00:00.000ZGET{path}"
            expected = base64.b64encode(hmac.new(b"secret", source.encode(), hashlib.sha256).digest()).decode()
            self.assertEqual(monitor._signature("2026-09-07T00:00:00.000Z", "GET", path), expected)

    def test_only_credited_matching_deposits_are_exposed(self):
        with tempfile.TemporaryDirectory() as directory:
            monitor = OKXMonitor(self.config(directory))
            rows = monitor._normalize([
                {"depId": "ok", "amt": "10.07", "ccy": "USDT", "chain": "USDT-TRC20", "to": "T-RECEIVE", "ts": "1700000000000", "state": "2", "type": "4"},
                {"depId": "waiting", "amt": "10.07", "ccy": "USDT", "chain": "USDT-TRC20", "to": "T-RECEIVE", "ts": "1700000000000", "state": "0", "type": "4"},
                {"depId": "wrong-address", "amt": "10.07", "ccy": "USDT", "chain": "USDT-TRC20", "to": "OTHER", "ts": "1700000000000", "state": "2", "type": "4"},
            ])
            self.assertEqual([row["bill_id"] for row in rows], ["ok"])
            self.assertEqual(rows[0]["amount"], "10.07")

    def test_query_signature_uses_constant_time_comparison(self):
        now = "1700000000"
        params = {"amount": "10.07", "currency": "USDT"}
        source = "amount=10.07&currency=USDT&timestamp=1700000000&secret=query-secret"
        signature = hmac.new(b"query-secret", source.encode(), hashlib.sha256).hexdigest()
        import unittest.mock
        with unittest.mock.patch("query_api.time.time", return_value=1700000000):
            self.assertTrue(verify_signature(params, signature, now, "query-secret"))
            self.assertFalse(verify_signature(params, "0" * 64, now, "query-secret"))


if __name__ == "__main__":
    unittest.main()
