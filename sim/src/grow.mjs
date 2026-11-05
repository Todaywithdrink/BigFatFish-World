// 地图生长：人多地不够时，向东接出一块新地
export function growEast(map, columns = 16) {
  const oldW = map.width;
  const H = map.height;

  // 先把旧的东边界（两列树）拆掉
  for (let y = 0; y < H; y++) {
    map.setKind(oldW - 2, y, "grass");
    map.setKind(oldW - 1, y, "grass");
  }

  // 加宽
  for (let y = 0; y < H; y++) {
    for (let i = 0; i < columns; i++) map.tiles[y].push(map.makeTile("grass", 0));
  }
  map.width = oldW + columns;
  const W = map.width;

  // 横向主路接过去
  for (let y = 35; y <= 37; y++) {
    for (let x = oldW - 2; x < W - 2; x++) map.setKind(x, y, "path");
  }
  // 一条竖路
  for (let y = 12; y <= 52; y++) {
    for (let x = oldW + 6; x <= oldW + 8; x++) map.setKind(x, y, "path");
  }

  // 两栋新房子
  const spots = [{ x: oldW + 1, y: 20 }, { x: oldW + 1, y: 44 }];
  for (const s of spots) {
    for (let y = s.y; y <= s.y + 5; y++) {
      for (let x = s.x; x <= s.x + 6; x++) map.setKind(x, y, "wall");
    }
    for (let y = s.y + 1; y <= s.y + 4; y++) {
      for (let x = s.x + 1; x <= s.x + 5; x++) map.setKind(x, y, "floor");
    }
    map.setKind(s.x + 3, s.y + 5, "door");
    map.setKind(s.x + 1, s.y + 1, "bed");
    map.setKind(s.x + 5, s.y + 1, "stove");
    map.homes.push({ x: s.x + 3, y: s.y + 6 });
  }

  // 田和树
  for (let y = 40; y <= 46; y++) {
    for (let x = oldW + 10; x <= oldW + 13; x++) map.setKind(x, y, "soil");
  }
  for (let y = 6; y <= 18; y += 4) {
    for (let x = oldW + 2; x <= W - 4; x += 5) map.setKind(x, y, "tree");
  }

  // 新的东边界
  for (let y = 0; y < H; y++) {
    map.setKind(W - 2, y, "tree");
    map.setKind(W - 1, y, "tree");
  }

  return { added: columns, houses: spots.length };
}
