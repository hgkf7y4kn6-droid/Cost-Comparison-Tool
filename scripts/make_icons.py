"""Draws the Sales Hub app icons (brass tile, white rising-arrow mark) at every size the web app,
the iOS app and the Android app need. Pillow only. Run from the repo root:

    python scripts/make_icons.py

Outputs frontend/icons/*.png (web + PWA) and store/assets/* (App Store / Google Play uploads).
The iOS 1024 icon has no transparency and no rounded corners (Apple rounds it); the Android adaptive
icon foreground keeps the mark inside the central safe zone.
"""
import os

from PIL import Image, ImageDraw

BRASS = (168, 122, 42)
INK = (15, 26, 44)
WHITE = (255, 255, 255)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def mark(draw: ImageDraw.ImageDraw, size: int, scale: float = 1.0, color=WHITE) -> None:
    """The arrow from the app's logo, drawn on a 32-unit grid centered in `size`."""
    u = size * scale / 32.0
    ox = (size - size * scale) / 2
    oy = ox - 0.75 * u  # the arrow's visual center sits a little below the grid's
    pts = [(8, 21.5), (13.5, 16), (17.5, 19.5), (24, 12)]
    P = lambda p: (ox + p[0] * u, oy + p[1] * u)  # noqa: E731
    w = max(2, int(2.6 * u))
    line = [P(p) for p in pts]
    draw.line(line, fill=color, width=w, joint="curve")
    head = [P((19.5, 12)), P((24, 12)), P((24, 16.5))]
    draw.line(head, fill=color, width=w, joint="curve")
    for x, y in line + head:  # round caps
        draw.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=color)


def tile(size: int, rounded: bool, scale: float, bg=BRASS, alpha: bool = True) -> Image.Image:
    ss = 4  # supersample for smooth edges
    img = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0) if alpha else bg + (255,))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle((0, 0, size * ss - 1, size * ss - 1), radius=int(size * ss * 0.25), fill=bg + (255,))
    else:
        d.rectangle((0, 0, size * ss, size * ss), fill=bg + (255,))
    mark(d, size * ss, scale)
    out = img.resize((size, size), Image.LANCZOS)
    return out if alpha else out.convert("RGB")


def save(img: Image.Image, *parts: str) -> None:
    path = os.path.join(ROOT, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)
    print("wrote", os.path.relpath(path, ROOT))


def feature_graphic() -> Image.Image:
    w, h = 1024, 500
    img = Image.new("RGB", (w, h), INK)
    d = ImageDraw.Draw(img)
    icon = tile(220, True, 1.3)
    img.paste(icon, (90, (h - 220) // 2), icon)
    return img


if __name__ == "__main__":
    # Web / PWA
    save(tile(192, True, 1.3), "frontend", "icons", "icon-192.png")
    save(tile(512, True, 1.3), "frontend", "icons", "icon-512.png")
    save(tile(512, False, 1.0), "frontend", "icons", "maskable-512.png")       # full bleed, mark inside the 80% safe zone
    save(tile(180, False, 1.3, alpha=False), "frontend", "icons", "apple-touch-icon.png")
    # Store uploads
    save(tile(1024, False, 1.3, alpha=False), "store", "assets", "ios-app-icon-1024.png")
    save(tile(512, True, 1.3), "store", "assets", "play-icon-512.png")
    save(feature_graphic(), "store", "assets", "play-feature-graphic-1024x500.png")
    # Android adaptive icon pieces (copied into the native project by scripts/native_assets.sh)
    save(tile(432, False, 0.0001, bg=BRASS, alpha=False), "store", "assets", "android-adaptive-background-432.png")
    fg = Image.new("RGBA", (432, 432), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fg)
    mark(fd, 432, 1.05)
    save(fg, "store", "assets", "android-adaptive-foreground-432.png")
