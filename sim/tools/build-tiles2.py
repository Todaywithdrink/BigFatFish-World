import sys
from PIL import Image
import numpy as np
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGBA")

def tile(cx, cy):
    return im.crop((cx*16, cy*16, cx*16+16, cy*16+16))

grass = tile(15, 30)
water_a = tile(3, 7)
water_b = tile(3, 4)
dirt = tile(36, 11)
dirt2 = tile(1, 30)

def dom(img):
    a = np.array(img)
    px = a[a[:,:,3] > 200][:, :3]
    return tuple(int(v) for v in np.median(px, axis=0))

grass_c = dom(grass)
dirt_c = dom(dirt)
dark = tuple(max(0, int(v*0.78)) for v in dirt_c)
grass_dark = tuple(max(0, int(v*0.80)) for v in grass_c)
grass_light = tuple(min(255, int(v*1.10)) for v in grass_c)

# 草地变体：同一底色，只加几簇草，避免棋盘感
def grass_variant(seed):
    t = np.array(grass).copy()
    rng = np.random.default_rng(seed)
    for _ in range(10):
        x = int(rng.integers(1, 14)); y = int(rng.integers(1, 14))
        t[y, x] = (*grass_dark, 255)
        if rng.random() < 0.6 and y + 1 < 16:
            t[y+1, x] = (*grass_dark, 255)
    return Image.fromarray(t, "RGBA")

out = Image.new("RGBA", (16*8, 16*4), (0,0,0,0))
def put(img, i):
    out.alpha_composite(img, ((i%8)*16, (i//8)*16))

put(grass, 0)
put(grass_variant(1), 1)
put(grass_variant(7), 2)
put(grass_variant(13), 3)
put(water_a, 4); put(water_b, 5)
put(dirt, 6); put(dirt2, 7)

for mask in range(16):
    t = np.array(dirt).copy()
    if mask & 1:
        for x in range(16):
            t[0, x] = (*grass_c, 255); t[1, x] = (*dark, 255)
    if mask & 4:
        for x in range(16):
            t[15, x] = (*grass_c, 255); t[14, x] = (*dark, 255)
    if mask & 8:
        for y in range(16):
            t[y, 0] = (*grass_c, 255); t[y, 1] = (*dark, 255)
    if mask & 2:
        for y in range(16):
            t[y, 15] = (*grass_c, 255); t[y, 14] = (*dark, 255)
    if (mask & 1) and (mask & 8): t[1, 1] = (*grass_c, 255)
    if (mask & 1) and (mask & 2): t[1, 14] = (*grass_c, 255)
    if (mask & 4) and (mask & 8): t[14, 1] = (*grass_c, 255)
    if (mask & 4) and (mask & 2): t[14, 14] = (*grass_c, 255)
    put(Image.fromarray(t, "RGBA"), 16 + mask)

out.save(dst)
print("ok")
