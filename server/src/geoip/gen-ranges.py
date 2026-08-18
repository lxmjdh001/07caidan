#!/usr/bin/env python3
"""从 APNIC delegated 文件生成 CN/HK IP 段数据（src/geoip/ranges.json）。
更新方式：下载 delegated-apnic-latest 后重跑本脚本。"""
import json, sys, ipaddress

src = sys.argv[1]
v4 = []  # [startInt, endInt, region]
v6 = []  # [prefixStr, prefixLen, region]
for line in open(src):
    if line.startswith('#'):
        continue
    parts = line.strip().split('|')
    if len(parts) < 7 or parts[0] != 'apnic' or parts[1] not in ('CN', 'HK'):
        continue
    region = parts[1]
    if parts[2] == 'ipv4':
        start = int(ipaddress.IPv4Address(parts[3]))
        count = int(parts[4])
        v4.append([start, start + count - 1, region])
    elif parts[2] == 'ipv6':
        v6.append([parts[3], int(parts[4]), region])

v4.sort()
# 合并相邻同区段，缩体积
merged = []
for s, e, r in v4:
    if merged and merged[-1][2] == r and merged[-1][1] + 1 == s:
        merged[-1][1] = e
    else:
        merged.append([s, e, r])

out = {'v4': merged, 'v6': v6}
with open('src/geoip/ranges.json', 'w') as f:
    json.dump(out, f, separators=(',', ':'))
print(f'v4 段: {len(merged)}（合并前 {len(v4)}），v6 段: {len(v6)}')
