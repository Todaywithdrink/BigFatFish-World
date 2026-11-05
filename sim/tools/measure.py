import sys
from PIL import Image
import numpy as np
im = Image.open(sys.argv[1]).convert("RGBA")
a = np.array(im)
# 找出所有非透明像素的连通块边界（按 16px 对齐的候选块）
def bbox(x0, y0, w, h):
    sub = a[y0:y0+h, x0:x0+w, 3]
    ys, xs = np.where(sub > 20)
    if len(ys) == 0: return None
    return (x0 + xs.min(), y0 + ys.min(), x0 + xs.max(), y0 + ys.max())
for label, x0, y0 in [("down", 0, 0), ("left", 0, 32), ("up", 0, 64), ("row6", 0, 96), ("atk", 0, 128)]:
    print(label, bbox(x0, y0, 64, 32))
# 每列的 bbox，判断帧宽
for cx in range(0, 5):
    print("col", cx, bbox(cx*16, 0, 16, 32))
