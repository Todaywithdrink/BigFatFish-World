import sys
from PIL import Image, ImageDraw
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGBA")
S = 6
picks = {
  "grass": [(15,30),(8,10),(17,29),(18,30),(14,20),(10,20)],
  "water": [(3,7),(3,4),(16,2),(19,9),(17,3),(12,1)],
  "dirt":  [(36,11),(1,30),(36,10),(2,32),(27,14),(1,35)],
  "fence": [(35,11),(37,11),(5,23),(1,0),(10,11),(29,5)],
}
rows = len(picks)
COLS = 6
cell = 16*S
pad = 18
W = COLS*(cell+8)+8
H = rows*(cell+pad+8)+8
img = Image.new("RGBA", (W, H), (30, 34, 28, 255))
d = ImageDraw.Draw(img)
for ri,(name, coords) in enumerate(picks.items()):
    y = 8 + ri*(cell+pad+8)
    d.text((6, y-10), name, fill=(240, 240, 220, 255))
    for ci,(cx,cy) in enumerate(coords):
        t = im.crop((cx*16, cy*16, cx*16+16, cy*16+16)).resize((cell, cell), Image.NEAREST)
        x = 8 + ci*(cell+8)
        img.alpha_composite(t, (x, y))
        d.text((x, y+cell+2), f"{cx},{cy}", fill=(200, 220, 200, 255))
img.save(dst)
print(img.size)
