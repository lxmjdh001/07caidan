#!/usr/bin/env python3
"""供 WzzScrm 后端查询 UZF 充值缓存的内网 API。"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request


app = Flask(__name__)
CONFIG_PATH = Path(os.environ.get("UZF_CONFIG", "config.json"))


def load_runtime() -> tuple[dict[str, Any], Path, str]:
    with CONFIG_PATH.open("r", encoding="utf-8") as handle:
        config = json.load(handle)
    monitor = config.get("monitor", {})
    raw_file = Path(str(monitor.get("json_file", "okx_transfers.json")))
    json_file = raw_file if raw_file.is_absolute() else CONFIG_PATH.parent / raw_file
    secret = str(config.get("query_api", {}).get("secret", "")).strip()
    if not secret:
        raise RuntimeError("缺少 query_api.secret")
    return config, json_file, secret


def verify_signature(params: dict[str, str], signature: str, timestamp: str, secret: str) -> bool:
    try:
        request_time = int(timestamp)
    except (TypeError, ValueError):
        return False
    # 查询仅在本机回环地址开放；再将签名有效期限制为 5 分钟，降低重放窗口。
    if abs(int(time.time()) - request_time) > 300:
        return False
    param_string = "&".join(f"{key}={value}" for key, value in sorted(params.items()))
    source = f"{param_string}&timestamp={timestamp}&secret={secret}"
    expected = hmac.new(secret.encode(), source.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)


def load_transfers(json_file: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    with json_file.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    rows = payload.get("transfers", [])
    if not isinstance(rows, list):
        raise ValueError("充值缓存格式错误")
    return rows, payload


@app.after_request
def no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/query")
def query_transfers():
    params = request.args.to_dict()
    signature = params.pop("signature", "")
    timestamp = params.pop("timestamp", "")
    try:
        _, json_file, secret = load_runtime()
    except (OSError, ValueError, json.JSONDecodeError, RuntimeError):
        return jsonify({"success": False, "message": "服务配置错误"}), 503
    if not signature or not timestamp or not verify_signature(params, signature, timestamp, secret):
        return jsonify({"success": False, "message": "签名验证失败"}), 403

    try:
        rows, payload = load_transfers(json_file)
    except FileNotFoundError:
        return jsonify({"success": False, "message": "充值缓存尚未生成"}), 503
    except (OSError, ValueError, json.JSONDecodeError):
        return jsonify({"success": False, "message": "充值缓存不可用"}), 503

    currency = params.get("currency", "USDT").upper()
    try:
        exact_amount = Decimal(params["amount"]) if "amount" in params else None
        min_amount = Decimal(params["min_amount"]) if "min_amount" in params else None
        max_amount = Decimal(params["max_amount"]) if "max_amount" in params else None
    except (InvalidOperation, ValueError):
        return jsonify({"success": False, "message": "金额格式错误"}), 400
    if any(value is not None and not value.is_finite() for value in (exact_amount, min_amount, max_amount)):
        return jsonify({"success": False, "message": "金额格式错误"}), 400

    result: list[dict[str, Any]] = []
    for row in rows:
        try:
            amount = Decimal(str(row.get("amount", "")))
        except InvalidOperation:
            continue
        if not amount.is_finite():
            continue
        if str(row.get("currency", "")).upper() != currency:
            continue
        if exact_amount is not None and amount != exact_amount:
            continue
        if min_amount is not None and amount < min_amount:
            continue
        if max_amount is not None and amount > max_amount:
            continue
        result.append(row)

    return jsonify(
        {
            "success": True,
            "data": {
                "last_update": payload.get("last_update", ""),
                "last_update_timestamp": payload.get("last_update_timestamp", 0),
                "transfers": result,
                "count": len(result),
                "total_count": len(rows),
            },
        }
    )


@app.get("/health")
def health():
    try:
        _, json_file, _ = load_runtime()
        _, payload = load_transfers(json_file)
        last_update = int(payload.get("last_update_timestamp", 0))
        age_seconds = max(0, int(time.time()) - last_update) if last_update else None
        healthy = age_seconds is not None and age_seconds <= 60
        return jsonify({"status": "ok" if healthy else "stale", "ageSeconds": age_seconds}), 200 if healthy else 503
    except Exception:
        return jsonify({"status": "unavailable"}), 503


if __name__ == "__main__":
    config, _, _ = load_runtime()
    api = config.get("query_api", {})
    # 默认只监听本机，不能把查询接口暴露到公网。
    app.run(host=str(api.get("host", "127.0.0.1")), port=int(api.get("port", 6000)), debug=False)
