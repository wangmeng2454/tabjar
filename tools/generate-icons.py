"""生成扩展所需的四种尺寸 PNG 图标。

浏览器要求图标是 PNG 格式，而 ImageMagick / Pillow 这类图形库
不一定每台电脑都装了。所以这里用 Python 标准库（zlib + struct）
手写一个最小 PNG 编码器，做到「零依赖、随时可重现」。

用法：
    python tools/generate-icons.py

输出：
    public/icons/icon16.png
    public/icons/icon32.png
    public/icons/icon48.png
    public/icons/icon128.png
"""

import os
import struct
import zlib

# 图形放大 4 倍再缩小（超采样），这样边缘不会出现锯齿
SUPERSAMPLE = 4

# 品牌色：华为红
BRAND = (207, 10, 44, 255)
WHITE = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)


def inside_round_rect(x: float, y: float, w: float, h: float, r: float) -> bool:
    """判断点 (x, y) 是否落在一个圆角矩形内（矩形原点在 0,0）。"""
    # 先夹到矩形范围内，再判断到「圆角圆心」的距离
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def render_high_res(size: int):
    """在 size*SUPERSAMPLE 的分辨率上绘制图形，返回二维像素数组。"""
    w = size * SUPERSAMPLE
    # 每个像素是 (R, G, B, A) 四元组
    pixels = [[TRANSPARENT for _ in range(w)] for _ in range(w)]

    # ---- 1. 圆角方形底 ----
    radius = w * 0.22
    for y in range(w):
        for x in range(w):
            if inside_round_rect(x, y, w, w, radius):
                pixels[y][x] = BRAND

    # ---- 2. 三条白色横杠，象征「被收纳成列表的标签页」 ----
    bar_h = w * 0.095
    bar_w = w * 0.52
    gap = w * 0.155
    total_h = bar_h * 3 + gap * 2
    top = (w - total_h) / 2
    left = (w - bar_w) / 2
    bar_radius = bar_h / 2

    for i in range(3):
        by = top + i * (bar_h + gap)
        y_start = int(by)
        y_end = int(by + bar_h) + 1
        x_start = int(left)
        x_end = int(left + bar_w) + 1
        for y in range(y_start, y_end):
            for x in range(x_start, x_end):
                if inside_round_rect(x - left, y - by, bar_w, bar_h, bar_radius):
                    pixels[y][x] = WHITE

    return pixels


def downsample(pixels, size: int):
    """把超采样图缩回目标尺寸，顺带做抗锯齿（按 alpha 加权平均颜色）。"""
    scale = SUPERSAMPLE
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            r = g = b = a = 0
            for dy in range(scale):
                for dx in range(scale):
                    pr, pg, pb, pa = pixels[y * scale + dy][x * scale + dx]
                    # 用 alpha 加权，避免半透明边缘混进黑色
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            if a > 0:
                row.append((r // a, g // a, b // a, a // (scale * scale)))
            else:
                row.append((0, 0, 0, 0))
        out.append(row)
    return out


def write_png(path: str, size: int, pixels) -> None:
    """把一个像素数组写成 PNG 文件（手写 PNG：签名 + IHDR + IDAT + IEND）。"""
    # PNG 的每一行前面要加一个字节的「过滤器类型」，0 表示不过滤
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        # 每个数据块 = 长度(4字节) + 类型 + 数据 + CRC32(4字节)
        return (
            struct.pack(">I", len(data))
            + body
            + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        )

    # IHDR：宽、高、位深 8、颜色类型 6(RGBA)、压缩/过滤/隔行均为 0
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )

    with open(path, "wb") as f:
        f.write(png)


def main() -> None:
    # 脚本放在 tools/ 下，所以项目根目录是它的上一级
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "public", "icons")
    os.makedirs(out_dir, exist_ok=True)

    for size in (16, 32, 48, 128):
        pixels = downsample(render_high_res(size), size)
        path = os.path.join(out_dir, f"icon{size}.png")
        write_png(path, size, pixels)
        print(f"已生成 {path}")


if __name__ == "__main__":
    main()
