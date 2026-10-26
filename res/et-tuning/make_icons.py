"""Regenerate every icon and logo in the app from res/et-tuning/logo-source.jpg.

Run from the repo root: python3 res/et-tuning/make_icons.py
Needs Pillow, numpy and ImageMagick's `convert` (for the multi-size .ico files).
"""
import subprocess
import tempfile
from collections import deque
import numpy as np
from PIL import Image, ImageFilter

src = "res/et-tuning/logo-source.jpg"
out = tempfile.mkdtemp()
im = Image.open(src).convert("RGB")
a = np.asarray(im).astype(np.int16)
h, w, _ = a.shape
fg0 = Image.fromarray((a.max(axis=2) >= 28).astype(np.uint8) * 255)
# Seal the small gaps in the artwork's outline so the fill below cannot leak
# into the black parts inside the emblem, then shrink back.
R = 21
sealed = np.asarray(fg0.filter(ImageFilter.MaxFilter(R))) > 0
dark = ~sealed
bg = np.zeros((h, w), bool)
q = deque()
for x in range(w):
    for y in (0, h - 1):
        if dark[y, x] and not bg[y, x]:
            bg[y, x] = True; q.append((y, x))
for y in range(h):
    for x in (0, w - 1):
        if dark[y, x] and not bg[y, x]:
            bg[y, x] = True; q.append((y, x))
while q:
    y, x = q.popleft()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ny, nx = y + dy, x + dx
        if 0 <= ny < h and 0 <= nx < w and dark[ny, nx] and not bg[ny, nx]:
            bg[ny, nx] = True; q.append((ny, nx))
silhouette = Image.fromarray(np.where(bg, 0, 255).astype(np.uint8)).filter(ImageFilter.MinFilter(R))
# keep everything inside the silhouette, plus any bright pixel the erosion trimmed
inside = (np.asarray(silhouette) > 0) | (np.asarray(fg0) > 0)
bg = ~inside
alpha = Image.fromarray(np.where(bg, 0, 255).astype(np.uint8))
# soften the cut edge a little
alpha = alpha.filter(ImageFilter.GaussianBlur(0.8))
rgba = im.copy(); rgba.putalpha(alpha)
bbox = rgba.getbbox()
full = rgba.crop(bbox)

def square(img, pad=0.04):
    s = int(max(img.size) * (1 + pad * 2))
    c = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    c.paste(img, ((s - img.width) // 2, (s - img.height) // 2), img)
    return c

icon_full = square(full).resize((1024, 1024), Image.LANCZOS)
# Simplified small icon: the blue truck alone, since the full emblem is a blur
# at tray and taskbar sizes.
truck = rgba.crop((300, 300, 660, 560))
icon_small = square(truck, 0.02).resize((256, 256), Image.LANCZOS)


def sized(img, size):
    return img.resize((size, size), Image.LANCZOS)


def ico(dest, images):
    paths = []
    for i, img in enumerate(images):
        path = f"{out}/ico_{i}.png"
        img.save(path)
        paths.append(path)
    subprocess.run(["convert", *paths, dest], check=True)


def fit(img, w, h):
    r = min(w / img.width, h / img.height)
    return img.resize((int(img.width * r), int(img.height * r)), Image.LANCZOS)


app_ico = [sized(icon_full, s) for s in (256, 128, 64, 48)] + [
    sized(icon_small, s) for s in (32, 24, 16)
]
ico("res/icon.ico", app_ico)
ico("flutter/windows/runner/resources/app_icon.ico", app_ico)
ico("res/tray-icon.ico", [sized(icon_small, s) for s in (48, 32, 24, 16)])
icon_full.save("res/icon.png")
sized(icon_small, 32).save("res/32x32.png")
sized(icon_full, 64).save("res/64x64.png")
sized(icon_full, 128).save("res/128x128.png")
sized(icon_full, 256).save("res/128x128@2x.png")
icon_small.save("flutter/assets/icon.png")
full.resize((600, round(600 * full.height / full.width)), Image.LANCZOS).save(
    "flutter/assets/logo.png"
)

# MSI installer artwork (WiX sizes), copied into res/msi by the build workflow.
banner = Image.new("RGB", (493, 58), (255, 255, 255))
l = fit(full, 100, 54)
banner.paste(l, (493 - l.width - 6, (58 - l.height) // 2), l)
banner.save("res/et-tuning/WixUIBannerBmp.bmp")
dialog = Image.new("RGB", (493, 312), (255, 255, 255))
dialog.paste(Image.new("RGB", (164, 312), (18, 18, 20)), (0, 0))
l = fit(full, 150, 150)
dialog.paste(l, ((164 - l.width) // 2, (312 - l.height) // 2 - 20), l)
dialog.save("res/et-tuning/WixUIDialogBmp.bmp")
print("bbox", bbox)
