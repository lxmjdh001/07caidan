#!/usr/bin/env python3
"""OKX USDT 充值监控。

只读取只读的充值历史，并把最近一段时间内已经入账的充值原子写入本地缓存。
查询 API 只读取这个缓存，因此多个客户端轮询不会放大成大量 OKX API 请求。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import tempfile
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import requests


CONFIG_PATH = Path(os.environ.get("UZF_CONFIG", "config.json"))
OKX_BASE_URL = "https://www.okx.com"


class OKXMonitor:
    def __init__(self, config: dict[str, Any]):
        okx = config.get("okx", {})
        monitor = config.get("monitor", {})
        self.api_key = str(okx.get("api_key", "")).strip()
        self.secret_key = str(okx.get("secret_key", "")).strip()
        self.passphrase = str(okx.get("passphrase", "")).strip()
        if not self.api_key or not self.secret_key or not self.passphrase:
            raise ValueError("缺少 OKX api_key / secret_key / passphrase")

        self.currency = str(monitor.get("currency", "USDT")).strip().upper() or "USDT"
        self.chain = str(monitor.get("chain", "")).strip().upper()
        self.address = str(monitor.get("address", "")).strip()
        self.interval = max(5, int(monitor.get("interval", 10)))
        self.time_window = max(30 * 60, int(monitor.get("time_window_seconds", 2 * 60 * 60)))
        raw_file = Path(str(monitor.get("json_file", "okx_transfers.json")))
        self.json_file = raw_file if raw_file.is_absolute() else CONFIG_PATH.parent / raw_file

    def _signature(self, timestamp: str, method: str, request_path: str) -> str:
        message = f"{timestamp}{method}{request_path}"
        digest = hmac.new(self.secret_key.encode(), message.encode(), hashlib.sha256).digest()
        return base64.b64encode(digest).decode()

    def fetch_deposits(self) -> list[dict[str, Any]]:
        query = urlencode({"ccy": self.currency, "limit": "100"})
        request_path = f"/api/v5/asset/deposit-history?{query}"
        timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        headers = {
            "OK-ACCESS-KEY": self.api_key,
            "OK-ACCESS-SIGN": self._signature(timestamp, "GET", request_path),
            "OK-ACCESS-TIMESTAMP": timestamp,
            "OK-ACCESS-PASSPHRASE": self.passphrase,
            "Accept": "application/json",
        }
        response = requests.get(f"{OKX_BASE_URL}{request_path}", headers=headers, timeout=(4, 8))
        response.raise_for_status()
        payload = response.json()
        if payload.get("code") != "0":
            raise RuntimeError(f"OKX API 错误: {payload.get('msg') or payload.get('code')}")
        data = payload.get("data")
        return data if isinstance(data, list) else []

    def _normalize(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        output: list[dict[str, Any]] = []
        for row in rows:
            # 0=等待确认；1=已入账待解锁；2=充值成功。只有余额已入账后才能给客户充值。
            if str(row.get("state", "")) not in {"1", "2"}:
                continue
            currency = str(row.get("ccy", "")).upper()
            chain = str(row.get("chain", "")).upper()
            address = str(row.get("to", ""))
            if currency != self.currency:
                continue
            if self.chain and chain != self.chain:
                continue
            if self.address and address != self.address:
                continue
            try:
                amount = Decimal(str(row.get("amt", "")))
                timestamp = int(row.get("ts", 0))
            except (InvalidOperation, TypeError, ValueError):
                continue
            deposit_id = str(row.get("depId") or "").strip()
            tx_id = str(row.get("txId") or "").strip()
            bill_id = deposit_id or tx_id
            if not bill_id or not amount.is_finite() or amount <= 0 or timestamp <= 0:
                continue
            bill_time = datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc)
            output.append(
                {
                    "bill_id": bill_id,
                    "deposit_id": deposit_id,
                    "tx_id": tx_id,
                    # 字符串保存，避免二进制浮点让精确金额尾数失真。
                    "amount": format(amount, "f"),
                    "currency": currency,
                    "chain": chain,
                    "address": address,
                    "deposit_type": str(row.get("type", "")),
                    "state": str(row.get("state", "")),
                    "bill_timestamp": timestamp,
                    "bill_time_utc": bill_time.isoformat(),
                }
            )
        return output

    def _load(self) -> list[dict[str, Any]]:
        try:
            with self.json_file.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
            rows = data.get("transfers", [])
            return rows if isinstance(rows, list) else []
        except FileNotFoundError:
            return []
        except (OSError, json.JSONDecodeError) as exc:
            print(f"缓存读取失败，将用本轮数据重建: {exc}", flush=True)
            return []

    def _save(self, rows: list[dict[str, Any]]) -> None:
        now = int(time.time())
        payload = {
            "last_update": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "last_update_timestamp": now,
            "transfers": rows,
            "count": len(rows),
        }
        self.json_file.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_path = tempfile.mkstemp(prefix=f".{self.json_file.name}.", dir=self.json_file.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, self.json_file)
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)

    def update(self) -> int:
        cutoff_ms = (int(time.time()) - self.time_window) * 1000
        merged: dict[str, dict[str, Any]] = {}
        for row in self._load():
            if not isinstance(row, dict):
                continue
            try:
                bill_timestamp = int(row.get("bill_timestamp", 0))
            except (TypeError, ValueError):
                continue
            bill_id = str(row.get("bill_id") or "").strip()
            if bill_id and bill_timestamp >= cutoff_ms:
                merged[bill_id] = row
        for row in self._normalize(self.fetch_deposits()):
            if row["bill_timestamp"] >= cutoff_ms:
                merged[row["bill_id"]] = row
        rows = sorted(merged.values(), key=lambda item: int(item["bill_timestamp"]), reverse=True)
        self._save(rows)
        return len(rows)

    def run(self) -> None:
        print(
            f"UZF OKX 充值监控已启动: currency={self.currency}, chain={self.chain or '全部'}, interval={self.interval}s",
            flush=True,
        )
        while True:
            try:
                count = self.update()
                print(f"充值缓存已更新: {count} 条", flush=True)
            except Exception as exc:  # 监控进程不能因一次网络波动退出
                print(f"充值缓存更新失败: {exc}", flush=True)
            time.sleep(self.interval)


def load_config() -> dict[str, Any]:
    with CONFIG_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


if __name__ == "__main__":
    OKXMonitor(load_config()).run()
