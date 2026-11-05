import sys, json
from PIL import Image
import numpy as np
from collections import Counter

def remove_bg(im, tol=60):
    a = np.array(im).astype(np.int16)
    h, w = a.shape[:2]
    corners = [a[0,0,:3], a[0,w-1,:3], a[h-1,0,:3], a[h-1,w-1,:3]]
    bg = np.mean(corners, axis=0)
    d = np.sqrt(((a[:,:,:3] - bg) ** 2).sum(axis=2))
    mask = d > tol
    out = np.array(im)
    out[:,:,3] = np.where(mask, 255, 0)
    return Image.fromarray(out, "RGBA")

def crop_content(im):
    a = np.array(im)
    ys, xs = np.where(a[:,:,3] > 20)
    if len(ys) == 0: return im
    return im.crop((xs.min(), ys.min(), xs.max()+1, ys.max()+1))

def mode_downscale(im, size, colors=20):
    arr = np.array(im)
    h, w = arr.shape[:2]
    # 先量化到统一调色板，避免每格颜色都不一样
    rgb = Image.fromarray(arr[:, :, :3].copy(), "RGB")
    q = rgb.quantize(colors=colors, method=Image.MEDIANCUT)
    pal = np.array(q.getpalette()).reshape(-1, 3)
    idx = np.array(q)
    out = np.zeros((size, size, 4), np.uint8)
    for ty in range(size):
        y0 = int(ty * h / size); y1 = max(y0 + 1, int((ty + 1) * h / size))
        for tx in range(size):
            x0 = int(tx * w / size); x1 = max(x0 + 1, int((tx + 1) * w / size))
            block_a = arr[y0:y1, x0:x1, 3]
            opaque = (block_a > 100).mean()
            if opaque < 0.5:
                continue
            block = idx[y0:y1, x0:x1].ravel()
            c = Counter(block.tolist()).most_common(1)[0][0]
            out[ty, tx, :3] = pal[c]
            out[ty, tx, 3] = 255
    return Image.fromarray(out, "RGBA")

src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src).convert("RGBA")
im = remove_bg(im)
im = crop_content(im)
spr = mode_downscale(im, size)
spr.save(dst)
spr.resize((size*8, size*8), Image.NEAREST).save(dst.replace(".png", "_x8.png"))
print(json.dumps({"size": size, "out": dst}))
