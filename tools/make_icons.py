"""Generate the app icons (orange tile, white dumbbell) without external libraries."""
import struct, zlib, sys, os

BG = (242, 96, 12)
FG = (255, 255, 255)

def rrect(x, y, x0, y0, x1, y1, r):
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r and x0 <= x <= x1 and y0 <= y <= y1

def inside(u, v):  # u, v in 0..1
    shapes = [
        (0.30, 0.47, 0.70, 0.53, 0.02),  # bar
        (0.20, 0.30, 0.30, 0.70, 0.035),  # inner plates
        (0.70, 0.30, 0.80, 0.70, 0.035),
        (0.12, 0.38, 0.20, 0.62, 0.03),  # outer plates
        (0.80, 0.38, 0.88, 0.62, 0.03),
    ]
    return any(rrect(u, v, *s) for s in shapes)

def png(size, path):
    ss = 3
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            hits = sum(inside((x + (i + .5) / ss) / size, (y + (j + .5) / ss) / size)
                       for i in range(ss) for j in range(ss))
            a = hits / (ss * ss)
            row += bytes(round(BG[k] * (1 - a) + FG[k] * a) for k in range(3))
        rows.append(bytes(row))
    raw = zlib.compress(b''.join(rows), 9)
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) \
        + chunk(b'IDAT', raw) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(data)

out = sys.argv[1] if len(sys.argv) > 1 else 'icons'
for s in (180, 192, 512):
    png(s, os.path.join(out, f'icon-{s}.png'))
print('ok')
