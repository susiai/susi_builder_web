"""Draw a geometric landscape with Pillow, then reopen it for a thumbnail."""

import json
from pathlib import Path

from PIL import Image, ImageDraw


def main():
    folder = Path("python-examples/image")
    folder.mkdir(parents=True, exist_ok=True)
    source = folder / "palette.json"
    image_path = folder / "mountain-lake.png"
    thumbnail_path = folder / "mountain-lake-thumb.png"

    if not source.exists():
        palette = {
            "title": "Bergsee bei Zürich", "sky": "#ffd8aa", "sun": "#ff9662",
            "mountain": "#50637a", "snow": "#f9f5e7", "lake": "#215d66",
            "reflection": "#80c8b8",
        }
        source.write_text(json.dumps(palette, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    palette = json.loads(source.read_text(encoding="utf-8"))
    image = Image.new("RGB", (640, 400), palette["sky"])
    draw = ImageDraw.Draw(image)
    draw.ellipse((423, 47, 541, 165), fill=palette["sun"])
    draw.polygon([(0, 278), (198, 68), (368, 252), (464, 142), (640, 277)], fill=palette["mountain"])
    draw.polygon([(141, 128), (198, 68), (254, 128), (221, 115), (185, 139)], fill=palette["snow"])
    draw.rectangle((0, 272, 640, 400), fill=palette["lake"])
    for y, length in [(291, 52), (307, 96), (327, 72), (359, 126)]:
        draw.line((466 - length // 2, y, 466 + length // 2, y), fill=palette["reflection"], width=3)
    image.save(image_path)

    with Image.open(image_path) as preview:
        preview.thumbnail((160, 100))
        preview.save(thumbnail_path)

    print(f"{palette['title']}: wrote {image_path} and {thumbnail_path}.")


if __name__ == "__main__":
    main()
