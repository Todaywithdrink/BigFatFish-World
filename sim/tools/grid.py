import sys
from PIL import Image, ImageDraw
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGBA")
W, H = im.size
bg = Image.new("RGBA", (W, H), (215, 235, 215, 255))
bg.alpha_composite(im)
S = 5
big = bg.resize((W*S, H*S), Image.NEAREST)
d = ImageDraw.Draw(big)
for x in range(0, W, 16):
    d.line([(x*S, 0), (x*S, H*S)], fill=(255, 0, 0, 90))
for y in range(0, H, 16):
    d.line([(0, y*S), (W*S, y*S)], fill=(255, 0, 0, 90))
for y in range(0, H, 16):
    d.text((3, y*S+1), str(y//16), fill=(0, 0, 0, 255))
for x in range(0, W, 16):
    d.text((x*S+1, 1), str(x//16), fill=(0, 0, 0, 255))
big.save(dst)
print(W, H, W//16, H//16)
