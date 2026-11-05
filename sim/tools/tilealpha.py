import sys
from PIL import Image
import numpy as np
im = Image.open(sys.argv[1]).convert("RGBA")
a = np.array(im)
for (name, idx) in [("lamp",19),("bench",21),("rock",12),("fence_h",10)]:
    x, y = (idx % 8) * 16, (idx // 8) * 16
    t = a[y:y+16, x:x+16]
    print(name, "corner alpha", int(t[0,0,3]), "center", list(map(int, t[8,8])), "opaque%", round(float((t[:,:,3]>200).mean())*100,1))
