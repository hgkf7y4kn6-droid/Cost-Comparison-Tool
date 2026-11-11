"""Writes the app icon and launch screen into the native iOS and Android projects, from the same artwork
as the web icons (scripts/make_icons.py). Run after `npx cap add` or whenever the artwork changes:

    python scripts/make_icons.py && python scripts/native_assets.py
"""
import glob
import os

from PIL import Image, ImageDraw

import importlib.util

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("make_icons", os.path.join(ROOT, "scripts", "make_icons.py"))
mi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mi)

RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def splash(w: int, h: int) -> Image.Image:
    img = Image.new("RGB", (w, h), mi.INK)
    side = int(min(w, h) * 0.24)
    icon = mi.tile(side, True, 1.3)
    img.paste(icon, ((w - side) // 2, (h - side) // 2), icon)
    return img


def main() -> None:
    # iOS
    ios = os.path.join(ROOT, "ios", "App", "App", "Assets.xcassets")
    if os.path.isdir(ios):
        mi.tile(1024, False, 1.3, alpha=False).save(os.path.join(ios, "AppIcon.appiconset", "AppIcon-512@2x.png"))
        for f in glob.glob(os.path.join(ios, "Splash.imageset", "*.png")):
            splash(2732, 2732).save(f, optimize=True)
        print("iOS icon and launch screen written")
    # Android
    if os.path.isdir(RES):
        for name, scale in DENSITIES.items():
            d = os.path.join(RES, f"mipmap-{name}")
            if not os.path.isdir(d):
                continue
            legacy, adaptive = int(48 * scale), int(108 * scale)
            mi.tile(legacy, True, 1.3).save(os.path.join(d, "ic_launcher.png"), optimize=True)
            round_ = Image.new("RGBA", (legacy * 4, legacy * 4), (0, 0, 0, 0))
            ImageDraw.Draw(round_).ellipse((0, 0, legacy * 4 - 1, legacy * 4 - 1), fill=mi.BRASS + (255,))
            mi.mark(ImageDraw.Draw(round_), legacy * 4, 1.0)
            round_.resize((legacy, legacy), Image.LANCZOS).save(os.path.join(d, "ic_launcher_round.png"), optimize=True)
            fg = Image.new("RGBA", (adaptive * 4, adaptive * 4), (0, 0, 0, 0))
            mi.mark(ImageDraw.Draw(fg), adaptive * 4, 1.05)  # inside the adaptive icon's 66% safe zone
            fg.resize((adaptive, adaptive), Image.LANCZOS).save(os.path.join(d, "ic_launcher_foreground.png"), optimize=True)
        with open(os.path.join(RES, "values", "ic_launcher_background.xml"), "w") as f:
            f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#A87A2A</color>\n</resources>\n')
        for f in glob.glob(os.path.join(RES, "drawable*", "splash.png")):
            w, h = Image.open(f).size
            splash(w, h).save(f, optimize=True)
        print("Android icons and launch screen written")


if __name__ == "__main__":
    main()
