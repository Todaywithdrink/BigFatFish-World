import sys, colorsys
from PIL import Image
import numpy as np
im = Image.open(sys.argv[1]).convert("RGBA")
a = np.array(im)
T = 16
cols, rows = a.shape[1]//T, a.shape[0]//T
cand = {"water": [], "grass": [], "dirt": [], "stone": [], "fence": []}
for ry in range(rows):
    for rx in range(cols):
        t = a[ry*T:(ry+1)*T, rx*T:(rx+1)*T]
        alpha = t[:, :, 3]
        opaque = alpha > 200
        ratio = opaque.mean()
        if ratio < 0.35:
            continue
        px = t[:, :, :3][opaque]
        if len(px) < 40:
            continue
        med = np.median(px, axis=0)
        r, g, b = [int(v) for v in med]
        h, l, s = colorsys.rgb_to_hls(r/255, g/255, b/255)
        h *= 360
        sd = float(px.std(axis=0).mean())
        if 190 <= h <= 225 and s > 0.25 and l > 0.3:
            cand["water"].append((rx, ry, r, g, b, round(sd,1)))
        elif 80 <= h <= 140 and s > 0.25 and l > 0.25:
            cand["grass"].append((rx, ry, r, g, b, round(sd,1)))
        elif 20 <= h <= 45 and s > 0.2 and l > 0.25 and sd < 14:
            cand["dirt"].append((rx, ry, r, g, b, round(sd,1)))
        elif s < 0.12 and 0.45 < l < 0.8 and sd < 10:
            cand["stone"].append((rx, ry, r, g, b, round(sd,1)))
        elif ratio < 0.6 and 20 <= h <= 45:
            cand["fence"].append((rx, ry, r, g, b, round(sd,1)))
for k, v in cand.items():
    v.sort(key=lambda x: x[5])
    print(k, len(v), v[:6])
