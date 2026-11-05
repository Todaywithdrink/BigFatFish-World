// 地形：高度场 + 水文（湖泊在水洼里，河流沿坡往下走），用绝对坐标，模块之间能接上
export function makeNoise(seed) {
  const rnd = (x, y) => {
    let h = (x * 374761393 + y * 668265263 + seed * 144665) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  return function noise(x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const a = rnd(x0, y0), b = rnd(x0 + 1, y0);
    const c = rnd(x0, y0 + 1), d = rnd(x0 + 1, y0 + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

/**
 * 生成一块区域的地形（只给尺寸和绝对偏移，边界对得上）。
 * 返回 kind 网格：water / sand / grass / forest / rock
 */
export function generateTerrain({ x0, y0, width, height, seed }) {
  const n1 = makeNoise(seed);
  const hash2 = (x, y) => {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 97);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  };
  const n2 = makeNoise(seed + 77);
  const grid = [];
  const heights = [];

  for (let ly = 0; ly < height; ly++) {
    const row = [], hrow = [];
    for (let lx = 0; lx < width; lx++) {
      const wx = x0 + lx, wy = y0 + ly;
      // 两层噪声叠出高度
      let h = n1(wx * 0.045, wy * 0.045) * 0.7 + n2(wx * 0.13, wy * 0.13) * 0.3;
      h = Math.max(0, Math.min(1, h));
      hrow.push(h);
      row.push(h);
    }
    heights.push(hrow);
  }

  // 湖泊：低洼处
  const kind = heights.map((row) => row.map((h) => (h < 0.33 ? "water" : "grass")));

  // 河流：从高处往下走，直到出水或碰到湖
  const riverCount = Math.max(1, Math.round(width / 64));
  for (let r = 0; r < riverCount; r++) {
    let x = ((r * 37 + seed) % width);
    let y = 0;
    let guard = 0;
    // 起点找一条稍微高一点的位置
    while (heights[0][x] < 0.45 && guard++ < width) x = (x + 1) % width;
    guard = 0;
    while (y >= 0 && y < height - 1 && guard++ < width * height) {
      kind[y][x] = "water";
      if (x + 1 < width && y + 1 < height) kind[y][x + 1] = "water";
      // 往最低的邻居走（只往下游）
      const cand = [
        [x - 1, y + 1], [x, y + 1], [x + 1, y + 1], [x - 1, y], [x + 1, y]
      ].filter(([nx, ny]) => nx >= 0 && nx < width && ny > y && ny < height);
      if (!cand.length) break;
      cand.sort((a, b) => heights[a[1]][a[0]] - heights[b[1]][b[0]]);
      const [nx, ny] = cand[0];
      x = nx; y = ny;
      // 偶尔断掉，别都长得一样。
      // 用绝对坐标的哈希而不是 Math.random：同一块地无论生成几次、按什么顺序生成，
      // 河断在哪里都必须是同一个答案，否则存档里的地形和重新长出地形对不上。
      if (guard > 8 && hash2(x0 + x, y0 + y) < 0.02) break;
    }
  }

  // 岸、林、石
  for (let ly = 0; ly < height; ly++) {
    for (let lx = 0; lx < width; lx++) {
      const wx = x0 + lx, wy = y0 + ly;
      if (kind[ly][lx] === "water") continue;
      const h = heights[ly][lx];
      const nearWater =
        (lx > 0 && kind[ly][lx - 1] === "water") ||
        (lx < width - 1 && kind[ly][lx + 1] === "water") ||
        (ly > 0 && kind[ly - 1][lx] === "water") ||
        (ly < height - 1 && kind[ly + 1][lx] === "water");
      if (nearWater) { kind[ly][lx] = "sand"; continue; }
      const forest = n2(wx * 0.08, wy * 0.08);
      if (h > 0.78) kind[ly][lx] = "rock";
      else if (forest > 0.86) kind[ly][lx] = "forest";
      else if (forest < 0.12) kind[ly][lx] = "flower";
      else {
        // 草地上的杂物：花、石头（按格子散列，模块之间稳定）
        const sc = hash2(wx * 3 + 11, wy * 5 + 7);
        if (sc > 0.90) kind[ly][lx] = "flower";
        else if (sc < 0.02) kind[ly][lx] = "rock";
        else kind[ly][lx] = "grass";
      }
    }
  }

  return kind;
}
