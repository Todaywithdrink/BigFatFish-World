# -*- coding: utf-8 -*-
"""
把 Kenney CC0 素材包里的 16x16 瓦片拼成观测站用的图集。
输入（只读）：sim/assets/_src/{tiny-town,tiny-battle}
输出：sim/viewer/tiles.png + sim/viewer/tiles.js

素材与许可：
  Kenney "Tiny Town" (1.1)    CC0  https://kenney.nl/assets/tiny-town
  Kenney "Tiny Battle" (1.x)  CC0  https://kenney.nl/assets/tiny-battle
  rock = Tiny Town 树丛灰化；path_N = Tiny Town 沙地块 3x3 拼边（同 CC0）

小路的自动拼边：沙地素材包给了 3x3 的圆角块（左上/上/右上/左/中/右/左下/下/右下），
这里按 16 种邻接情况预先合成好，运行时只按邻格算一个 4 位掩码。
  bit0 北  bit1 东  bit2 南  bit3 西  （该方向不是路）
"""
import os, colorsys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "assets", "_src")
OUT_DIR = os.path.join(ROOT, "viewer")

TT = Image.open(os.path.join(SRC, "tiny-town", "Tilemap", "tilemap_packed.png")).convert("RGBA")
TB = Image.open(os.path.join(SRC, "tiny-battle", "Tilemap", "tilemap_packed.png")).convert("RGBA")
TC = Image.open(os.path.join(SRC, "tiny-city", "Tilemap", "tilemap_packed.png")).convert("RGBA")

def crop(sheet, idx, cols, t=16):
    c, r = idx % cols, idx // cols
    return sheet.crop((c * t, r * t, c * t + t, r * t + t))

def tt(idx): return crop(TT, idx, 12)
def tb(idx): return crop(TB, idx, 18)
def tc(idx): return crop(TC, idx, 12)

def grey(im, hue=0.60, sat=0.08, val=0.92):
    out = im.copy(); px = out.load()
    for y in range(out.size[1]):
        for x in range(out.size[0]):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if 0.12 < h < 0.48:
                nr, ng, nb = colorsys.hsv_to_rgb(hue, min(s, sat), v * val)
                px[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
    return out

def recolor(im, hue=0.30, lo=0.02, hi=0.14, smin=0.28):
    """把橙/黄系的像素转成其它色相（树干是低饱和的土色，不受影响）。"""
    out = im.copy(); px = out.load()
    for y in range(out.size[1]):
        for x in range(out.size[0]):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if lo <= h <= hi and s >= smin:
                nr, ng, nb = colorsys.hsv_to_rgb(hue, s, v)
                px[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
    return out

def tint(im, k):
    out = im.copy(); px = out.load()
    for y in range(out.size[1]):
        for x in range(out.size[0]):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            px[x, y] = (min(255, int(r * k[0])), min(255, int(g * k[1])), min(255, int(b * k[2])), a)
    return out

# ---------- 小路 3x3 拼边 ----------
SAND = tt(25)   # 3x3 沙地块的"中间"格：纯沙色，没有草
EDGE = {
    1: tt(13),   # 北：上边缘
    2: tt(26),   # 东：右边缘
    4: tt(37),   # 南：下边缘
    8: tt(24),   # 西：左边缘
}
CORNER = {
    (1, 8): tt(12),   # 左上
    (1, 2): tt(14),   # 右上
    (4, 8): tt(36),   # 左下
    (4, 2): tt(38),   # 右下
}

def composite(donors, tol=26):
    base = SAND.copy()
    pb = base.load()
    for d in donors:
        pd = d.load()
        for y in range(16):
            for x in range(16):
                r, g, b, a = pd[x, y]
                if a == 0:
                    continue
                rb, gb, bb, ab = pb[x, y]
                if abs(r - rb) + abs(g - gb) + abs(b - bb) > tol:   # 只贴和沙底不同的像素
                    pb[x, y] = (r, g, b, a)
    return base

def path_tile(mask):
    n, e, s, w = mask & 1, mask & 2, mask & 4, mask & 8
    donors = []
    corner = None
    for (a, b), piece in CORNER.items():
        if (n and a == 1) or (s and a == 4):
            if (w and b == 8) or (e and b == 2):
                corner = piece
                break
    if corner is not None:
        donors.append(corner)
        used_n = bool(n and corner is not None and (n and (mask & 1)))
    else:
        used_n = False
    if not (corner is not None and n):
        if n: donors.append(EDGE[1])
    if not (corner is not None and s):
        if s: donors.append(EDGE[4])
    if not (corner is not None and w):
        if w: donors.append(EDGE[8])
    if not (corner is not None and e):
        if e: donors.append(EDGE[2])
    return composite(donors) if donors else SAND.copy()

TILES = [
    ("grass",        tt(0)),
    ("grass_tuft",   tt(1)),
    ("grass_flower", tt(2)),
    ("water_a",      tint(tb(37), (0.62, 0.74, 0.88))),
    ("water_b",      tint(tb(38), (0.62, 0.74, 0.88))),
    ("tree_round",   recolor(tt(15), 0.30)),   # 橙树染成绿树（1:1 下这个形状最好认）
    ("tree_green2",  recolor(tt(3), 0.27)),    # 另一棵绿树，形状不同
    ("tree_orange",  tt(15)),                  # 橙叶树
    ("tree_autumn",  tt(3)),                   # 黄叶树
    ("bush",         tt(17)),
    ("fence_h",      tt(69)),   # 横向围栏：左右都带栏杆，可无缝重复
    ("fence_v",      tt(56)),   # 纵向围栏
    ("rock",         grey(tt(7))),
    # 房子：墙 / 地板 / 门 / 屋顶
    ("wall",         tt(73)),                                   # 木板墙
    ("wall_stone",   tt(76)),                                   # 石墙（以后换房子用）
    ("floor",        tint(tt(109), (1.15, 0.98, 0.76))),          # 纯色石地板染暖，当屋内地面（接缝由代码画）
    ("door",         tt(85)),                                   # 关着的木门
    ("door_open",    tt(74)),                                   # 敞开的门洞
    ("roof",         tt(53)),                                   # 红瓦屋顶
    # 日常用具（Tiny City）
    ("lamp",         tc(86)),                                   # 路灯
    ("sign",         tc(87)),                                   # 木牌
    ("bench",        tc(110)),                                  # 长椅
    ("barrel",       tc(118)),                                  # 木桶
    ("stall",        tc(105)),                                  # 摊位
]
for m in range(16):
    TILES.append(("path_%d" % m, path_tile(m)))

COLS = 8
T = 16
ROWS = (len(TILES) + COLS - 1) // COLS
sheet = Image.new("RGBA", (COLS * T, ROWS * T), (0, 0, 0, 0))
for i, (name, im) in enumerate(TILES):
    sheet.paste(im, ((i % COLS) * T, (i // COLS) * T))
sheet.save(os.path.join(OUT_DIR, "tiles.png"))

idx = {name: i for i, (name, _) in enumerate(TILES)}
js = """// 自动生成，勿手改：sim/tools/build-tiles.py
// 素材：Kenney Tiny Town / Tiny Battle（CC0，https://kenney.nl）
window.TILESET = {
  img: "/viewer/tiles.png",
  size: %d, cols: %d, rows: %d,
  idx: { %s }
};
""" % (T, COLS, ROWS, ", ".join('"%s": %d' % (k, v) for k, v in idx.items()))
open(os.path.join(OUT_DIR, "tiles.js"), "w", encoding="utf-8").write(js)
print("tiles.png", sheet.size, "tiles", len(TILES))

# 拼边自检图：把 16 种掩码排成一条，右边放一张用掩码 5（北+南）的路
dbg = Image.new("RGBA", (16 * 48, 3 * 48), (132, 198, 105, 255))
for m in range(16):
    i = idx["path_%d" % m]
    t = sheet.crop(((i % COLS) * T, (i // COLS) * T, (i % COLS) * T + T, (i // COLS) * T + T))
    dbg.alpha_composite(t.resize((48, 48), Image.NEAREST), (m * 48, 0))
import random
random.seed(3)
grid = Image.new("RGBA", (16 * 48, 12 * 48), (132, 198, 105, 255))
road = [[1 if (5 <= y < 11 and 3 <= x < 13) or (x == 7) else 0 for x in range(16)] for y in range(12)]
for y in range(12):
    for x in range(16):
        if not road[y][x]:
            continue
        mask = 0
        if y == 0 or not road[y-1][x]: mask |= 1
        if x == 15 or not road[y][x+1]: mask |= 2
        if y == 11 or not road[y+1][x]: mask |= 4
        if x == 0 or not road[y][x-1]: mask |= 8
        i = idx["path_%d" % mask]
        t = sheet.crop(((i % COLS) * T, (i // COLS) * T, (i % COLS) * T + T, (i // COLS) * T + T))
        grid.alpha_composite(t.resize((48, 48), Image.NEAREST), (x * 48, y * 48))
grid.save(os.path.join(SRC, "_path_preview.png"))
print("preview ok")
