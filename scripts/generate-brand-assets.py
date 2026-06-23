from __future__ import annotations

import math
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
BRAND_SVG = ROOT / "assets" / "brand" / "roadlens-mark.svg"
APP_BRAND_DIR = ROOT / "app" / "public" / "brand"
DOCS_ASSET_DIR = ROOT / "docs" / "assets"
WEB_FLASHER_DIR = ROOT / "web" / "flasher"
RES_DIR = ROOT / "app" / "android" / "app" / "src" / "main" / "res"

BG = (13, 18, 22, 255)
PANEL = (20, 32, 39, 255)
MINT = (38, 217, 161, 255)
MINT_SOFT = (124, 248, 206, 255)
AMBER = (255, 209, 102, 255)
CORAL = (247, 127, 95, 255)
LINE = (66, 87, 98, 255)
WHITE = (246, 251, 248, 255)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def draw_mark(size: int, rounded: bool = True) -> Image.Image:
    scale = size / 256
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    if rounded:
        bg = Image.new("RGBA", (size, size), BG)
        for y in range(size):
            mix = y / max(1, size - 1)
            color = (
                int(PANEL[0] * (1 - mix) + BG[0] * mix),
                int(PANEL[1] * (1 - mix) + BG[1] * mix),
                int(PANEL[2] * (1 - mix) + BG[2] * mix),
                255,
            )
            ImageDraw.Draw(bg).line((0, y, size, y), fill=color)
        image.alpha_composite(bg)

    def p(value: float) -> float:
        return value * scale

    road = [(p(49), p(192)), (p(82), p(171)), (p(133), p(158)), (p(181), p(145)), (p(207), p(127))]
    draw.line(road, fill=LINE, width=max(5, int(p(12))), joint="curve")
    draw.line(road, fill=(104, 129, 136, 230), width=max(1, int(p(3))), joint="curve")

    pin_center = (p(128), p(105))
    pin_radius = p(70)
    draw.ellipse(
        (pin_center[0] - pin_radius, pin_center[1] - pin_radius, pin_center[0] + pin_radius, pin_center[1] + pin_radius),
        fill=MINT,
    )
    tail = [(p(83), p(159)), (p(128), p(221)), (p(173), p(159))]
    draw.polygon(tail, fill=MINT)
    draw.ellipse((p(81), p(58), p(175), p(152)), fill=BG)
    draw.ellipse((p(99), p(77), p(157), p(135)), fill=AMBER)
    draw.arc((p(106), p(86), p(145), p(126)), 130, 285, fill=WHITE, width=max(3, int(p(6))))
    draw.line((p(194), p(68), p(211), p(51)), fill=AMBER, width=max(4, int(p(8))))
    draw.line((p(206), p(90), p(230), p(87)), fill=AMBER, width=max(4, int(p(8))))
    draw.line((p(176), p(53), p(180), p(29)), fill=AMBER, width=max(4, int(p(8))))

    if rounded:
        mask = rounded_mask(size, int(size * 0.22))
        output = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        output.paste(image, (0, 0), mask)
        return output
    return image


def draw_splash(width: int, height: int) -> Image.Image:
    image = Image.new("RGBA", (width, height), BG)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        mix = y / max(1, height - 1)
        color = (
            int(16 * (1 - mix) + 9 * mix),
            int(28 * (1 - mix) + 15 * mix),
            int(33 * (1 - mix) + 19 * mix),
            255,
        )
        draw.line((0, y, width, y), fill=color)

    grid_color = (43, 58, 66, 120)
    step = max(42, width // 14)
    for x in range(-height, width + height, step):
        draw.line((x, height, x + height, 0), fill=grid_color, width=2)

    mark_size = min(width, height) // 4
    mark = draw_mark(mark_size)
    image.alpha_composite(mark, ((width - mark_size) // 2, int(height * 0.28)))

    try:
        font_big = ImageFont.truetype("arialbd.ttf", max(34, width // 18))
        font_small = ImageFont.truetype("arial.ttf", max(17, width // 42))
    except OSError:
        font_big = ImageFont.load_default()
        font_small = ImageFont.load_default()

    title = "RoadLens Scout"
    subtitle = "Signal map ready"
    title_box = draw.textbbox((0, 0), title, font=font_big)
    subtitle_box = draw.textbbox((0, 0), subtitle, font=font_small)
    title_x = (width - (title_box[2] - title_box[0])) // 2
    subtitle_x = (width - (subtitle_box[2] - subtitle_box[0])) // 2
    title_y = int(height * 0.55)
    draw.text((title_x, title_y), title, fill=WHITE, font=font_big)
    draw.text((subtitle_x, title_y + (title_box[3] - title_box[1]) + 14), subtitle, fill=MINT_SOFT, font=font_small)
    return image


def save_icon_set() -> None:
    densities = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    foreground_scale = 1.45
    for folder, size in densities.items():
        target = RES_DIR / folder
        target.mkdir(parents=True, exist_ok=True)
        icon = draw_mark(size)
        icon.save(target / "ic_launcher.png")
        icon.save(target / "ic_launcher_round.png")

        fg_size = int(math.ceil(size * foreground_scale))
        foreground = Image.new("RGBA", (fg_size, fg_size), (0, 0, 0, 0))
        mark = draw_mark(int(fg_size * 0.72), rounded=False)
        foreground.alpha_composite(mark, ((fg_size - mark.width) // 2, (fg_size - mark.height) // 2))
        foreground = foreground.resize((size, size), Image.Resampling.LANCZOS)
        foreground.save(target / "ic_launcher_foreground.png")


def save_splash_set() -> None:
    sizes = {
        "drawable": (720, 720),
        "drawable-port-mdpi": (320, 480),
        "drawable-port-hdpi": (480, 800),
        "drawable-port-xhdpi": (720, 1280),
        "drawable-port-xxhdpi": (960, 1600),
        "drawable-port-xxxhdpi": (1280, 1920),
        "drawable-land-mdpi": (480, 320),
        "drawable-land-hdpi": (800, 480),
        "drawable-land-xhdpi": (1280, 720),
        "drawable-land-xxhdpi": (1600, 960),
        "drawable-land-xxxhdpi": (1920, 1280),
    }
    for folder, size in sizes.items():
        target = RES_DIR / folder
        target.mkdir(parents=True, exist_ok=True)
        draw_splash(*size).save(target / "splash.png")


def copy_web_assets() -> None:
    APP_BRAND_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_ASSET_DIR.mkdir(parents=True, exist_ok=True)
    WEB_FLASHER_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(BRAND_SVG, APP_BRAND_DIR / "roadlens-mark.svg")
    shutil.copyfile(BRAND_SVG, DOCS_ASSET_DIR / "roadlens-mark.svg")
    shutil.copyfile(BRAND_SVG, WEB_FLASHER_DIR / "roadlens-mark.svg")


def main() -> None:
    copy_web_assets()
    save_icon_set()
    save_splash_set()
    print("RoadLens Scout brand assets generated.")


if __name__ == "__main__":
    main()
