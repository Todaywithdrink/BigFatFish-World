import sys
from PIL import Image
import numpy as np
from collections import Counter
im = Image.open(sys.argv[1]).convert("RGBA")
a = np.array(im)
px = a[a[:,:,3] > 200][:, :3]
c = Counter(map(tuple, px))
print("top colors:")
for col, n in c.most_common(14):
    r, g, b = col
    # 粗略色相
    import colorsys
    h, l, s = colorsys.rgb_to_hls(r/255, g/255, b/255)
    print(f"  #{r:02x}{g:02x}{b:02x}  n={n:5d}  hue={h*360:5.1f} sat={s:.2f} lig={l:.2f}")
