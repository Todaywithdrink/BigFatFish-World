import sys, json, math
from PIL import Image, ImageFilter
import numpy as np

def load(path):
    im = Image.open(path).convert("RGBA")
    return im

def remove_bg(im, tol=60):
    a = np.array(im).astype(np.int16)
    h, w = a.shape[:2]
    # 四角取样做背景色
    corners = [a[0,0,:3], a[0,w-1,:3], a[h-1,0,:3], a[h-1,w-1,:3]]
    bg = np.mean(corners, axis=0)
    d = np.sqrt(((a[:,:,:3] - bg) ** 2).sum(axis=2))
    mask = d > tol
    # 只保留最大的连通区域（去掉零星噪点）
    from collections import deque
    seen = np.zeros((h, w), bool)
    best = None
    for yy in range(0, h, 4):
        for xx in range(0, w, 4):
            if mask[yy,xx] and not seen[yy,xx]:
                q = deque([(yy,xx)]); seen[yy,xx] = True; cnt = 0; pts = []
                while q:
                    y, x = q.popleft(); cnt += 1; pts.append((y,x))
                    for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
                        ny, nx = y+dy, x+dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny,nx] and not seen[ny,nx]:
                            seen[ny,nx] = True; q.append((ny,nx))
                if best is None or cnt > best[0]:
                    best = (cnt, pts)
    if best:
        keep = np.zeros((h, w), bool)
        for y, x in best[1]:
            keep[y, x] = True
        mask = keep
    out = np.array(im)
    out[:,:,3] = np.where(mask, 255, 0)
    return Image.fromarray(out, "RGBA")

def crop_content(im):
    a = np.array(im)
    ys, xs = np.where(a[:,:,3] > 20)
    if len(ys) == 0: return im
    return im.crop((xs.min(), ys.min(), xs.max()+1, ys.max()+1))

def pixelize(im, size=48, colors=24, outline=True):
    # 缩到目标尺寸：用 LANCZOS 做面积平均，比最近邻好看
    w, h = im.size
    s = size / max(w, h)
    nw, nh = max(1, round(w*s)), max(1, round(h*s))
    small = im.resize((nw, nh), Image.LANCZOS)
    # 画布居中
    canvas = Image.new("RGBA", (size, size), (0,0,0,0))
    canvas.paste(small, ((size-nw)//2, (size-nh)//2))
    # 量化：只对不透明像素取色
    a = np.array(canvas)
    rgb = a[:,:,:3].reshape(-1,3)
    alpha = a[:,:,3].reshape(-1)
    opaque = alpha > 40
    if opaque.sum() == 0:
        return canvas
    pal_img = Image.fromarray(a[:,:,:3].copy(), "RGB")
    q = pal_img.quantize(colors=colors, method=Image.MEDIANCUT)
    pal = np.array(q).reshape(-1)
    # 用调色板颜色替换
    palette = q.getpalette()
    out = a.copy()
    for i in range(len(pal)):
        if not opaque[i]: continue
        idx = pal[i]
        out[i//size, i%size, 0] = palette[idx*3]
        out[i//size, i%size, 1] = palette[idx*3+1]
        out[i//size, i%size, 2] = palette[idx*3+2]
    res = Image.fromarray(out, "RGBA")
    if outline:
        arr = np.array(res)
        sil = arr[:,:,3] > 40
        # 轮廓色：取身体所有颜色的暗化均值
        body = arr[sil][:,:3]
        oc = (body.mean(axis=0) * 0.35).astype(np.uint8)
        outarr = arr.copy()
        for y in range(size):
            for x in range(size):
                if sil[y, x]: continue
                n = ((y>0 and sil[y-1,x]) or (y<size-1 and sil[y+1,x]) or
                     (x>0 and sil[y,x-1]) or (x<size-1 and sil[y,x+1]))
                if n:
                    outarr[y,x,:3] = oc
                    outarr[y,x,3] = 255
        res = Image.fromarray(outarr, "RGBA")
    return res

src = sys.argv[1]
dst = sys.argv[2]
size = int(sys.argv[3]) if len(sys.argv) > 3 else 48
im = load(src)
im = remove_bg(im)
im = crop_content(im)
spr = pixelize(im, size=size)
spr.save(dst)
big = spr.resize((size*8, size*8), Image.NEAREST)
big.save(dst.replace(".png", "_x8.png"))
print(json.dumps({"size": size, "out": dst}))
