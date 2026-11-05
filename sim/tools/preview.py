import sys
from PIL import Image
src, dst, scale = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src).convert("RGBA")
bg = Image.new("RGBA", im.size, (24, 28, 22, 255))
bg.alpha_composite(im)
big = bg.resize((im.width * scale, im.height * scale), Image.NEAREST)
big.save(dst)
print(im.size)
