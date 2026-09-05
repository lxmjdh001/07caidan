#!/usr/bin/env python3
"""
品牌图标生成器：branding/<brand>.json + 本脚本 → branding/<brand>/icon.{png,icns,ico}

用法：python3 branding/make-icons.py [brand] [源图标.png]
- 不给源图：按品牌 themeColor + logoText 自动画一个渐变圆角图标
- 给源图（≥1024x1024 PNG）：只做格式转换（贴牌客户提供自己的 logo 时用这条路）
打包时 electron-builder 会自动拾取 branding/<brand>/icon.icns|ico。
"""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.abspath(__file__))
brand = sys.argv[1] if len(sys.argv) > 1 else "default"
src = sys.argv[2] if len(sys.argv) > 2 else None

cfg_path = os.path.join(ROOT, f"{brand}.json")
with open(cfg_path) as f:
    cfg = json.load(f)

out_dir = os.path.join(ROOT, brand)
os.makedirs(out_dir, exist_ok=True)
S = 1024


def hex_rgb(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def darken(rgb, f=0.72):
    return tuple(int(c * f) for c in rgb)


if src:
    img = Image.open(src).convert("RGBA").resize((S, S), Image.LANCZOS)
else:
    base = hex_rgb(cfg.get("themeColor", "#22a06b"))
    lo = darken(base, 0.58)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # 对角渐变
    grad = Image.new("RGBA", (S, S))
    gp = grad.load()
    for y in range(S):
        for x in range(0, S, 4):  # 步进 4 加速，视觉无差
            t = (x + y) / (2 * S)
            c = tuple(int(base[i] + (lo[i] - base[i]) * t) for i in range(3)) + (255,)
            for dx in range(4):
                if x + dx < S:
                    gp[x + dx, y] = c
    # 圆角遮罩（macOS 风格 squircle 近似：22.5% 圆角）
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255)
    img.paste(grad, (0, 0), mask)
    # 左上柔光与内描边，让小尺寸 Dock/任务栏图标仍有层次。
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([-220, -360, 820, 660], fill=(255, 255, 255, 30))
    img = Image.alpha_composite(img, glow)
    img.putalpha(mask)
    ImageDraw.Draw(img).rounded_rectangle(
        [10, 10, S - 11, S - 11],
        radius=int(S * 0.215),
        outline=(255, 255, 255, 48),
        width=10,
    )

    # WzzScrm 使用固定的连续 W 图形；其它白牌仍可回落文字标识。
    text = cfg.get("logoText", "W")[:3]
    if text.upper() == "W":
        points = [(218, 292), (376, 724), (512, 448), (648, 724), (806, 292)]

        def rounded_line(layer, line_points, color, width):
            draw = ImageDraw.Draw(layer)
            draw.line(line_points, fill=color, width=width, joint="curve")
            radius = width // 2
            for x, y in line_points:
                draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=color)

        shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        rounded_line(shadow, [(x, y + 20) for x, y in points], (0, 58, 38, 72), 112)
        img = Image.alpha_composite(img, shadow)
        mark = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        rounded_line(mark, points, (255, 255, 255, 255), 98)
        img = Image.alpha_composite(img, mark)
        img.putalpha(mask)
    else:
        font = None
        for cand in [
            "/System/Library/Fonts/SFNSRounded.ttf",
            "/System/Library/Fonts/SFNS.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        ]:
            if os.path.exists(cand):
                try:
                    font = ImageFont.truetype(cand, int(S * 0.42))
                    break
                except OSError:
                    continue
        d = ImageDraw.Draw(img)
        bbox = d.textbbox((0, 0), text, font=font)
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        d.text(((S - w) / 2 - bbox[0], (S - h) / 2 - bbox[1]), text, font=font, fill=(255, 255, 255, 255))

png = os.path.join(out_dir, "icon.png")
img.save(png)

# Windows ico（多尺寸）
img.save(os.path.join(out_dir, "icon.ico"), sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

# macOS icns（iconutil，多分辨率 iconset）
iconset = os.path.join(out_dir, "icon.iconset")
os.makedirs(iconset, exist_ok=True)
for size in (16, 32, 128, 256, 512):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, f"icon_{size}x{size}.png"))
    img.resize((size * 2, size * 2), Image.LANCZOS).save(
        os.path.join(iconset, f"icon_{size}x{size}@2x.png")
    )
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(out_dir, "icon.icns")], check=True)
subprocess.run(["rm", "-rf", iconset], check=True)
print(f"生成完成：{out_dir}/icon.png icon.icns icon.ico")
