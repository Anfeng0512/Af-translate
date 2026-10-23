"""生成扩展图标：渐变圆角底 + 白色「译」字（超采样后缩放，16px 也清晰）。"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
OUT.mkdir(parents=True, exist_ok=True)

SIZE = 512
xx, yy = np.meshgrid(np.linspace(0, 1, SIZE), np.linspace(0, 1, SIZE))
t = np.clip(xx * 0.65 + yy * 0.35, 0, 1)[..., None]
c1 = np.array([99, 102, 241], dtype=float)
c2 = np.array([6, 182, 212], dtype=float)
arr = (c1 * (1 - t) + c2 * t).astype(np.uint8)

base = Image.fromarray(arr, "RGB").convert("RGBA")
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.23), fill=255)
base.putalpha(mask)

font = ImageFont.truetype(r"C:\Windows\Fonts\msyhbd.ttc", int(SIZE * 0.60))
text = "译"

shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
bbox = sd.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
pos = ((SIZE - tw) / 2 - bbox[0], (SIZE - th) / 2 - bbox[1] - SIZE * 0.015)
sd.text((pos[0] + SIZE * 0.012, pos[1] + SIZE * 0.018), text, font=font, fill=(15, 23, 42, 110))
base = Image.alpha_composite(base, shadow.filter(ImageFilter.GaussianBlur(SIZE * 0.012)))

draw = ImageDraw.Draw(base)
draw.text(pos, text, font=font, fill=(255, 255, 255, 255))

for size in (16, 32, 48, 128):
    base.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")

print("icons written:", sorted(p.name for p in OUT.glob("*.png")))
