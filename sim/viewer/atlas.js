// 自动生成，勿手改：sim/tools/build-atlas.mjs
// 素材：tiles2.png + tiles.png（Kenney CC0）+ zelda-like/gfx/Overworld.png
// 分区：行 0..3 地皮 / 行 4..8 道具 / 行 9 起为装饰 / 行 12..15 为水岸
// 说明：①② 位置固定（Tiled gid 依赖它）；③④ 只在末尾追加，永远不影响已有映射。
window.ATLAS = {
  img: "/viewer/atlas.png",
  size: 16, cols: 8, rows: 16,

  // 地皮命名索引（atlas 格 = 本表值，对应 Tiled gid = 值 + 1）
  ground: {"grass": 0, "grass_tuft": 1, "grass_flower": 2, "grass2": 3, "water_a": 4, "water_b": 5, "path": 6, "path2": 7, "path_0": 16, "path_1": 17, "path_2": 18, "path_3": 19, "path_4": 20, "path_5": 21, "path_6": 22, "path_7": 23, "path_8": 24, "path_9": 25, "path_10": 26, "path_11": 27, "path_12": 28, "path_13": 29, "path_14": 30, "path_15": 31},

  // 道具/建筑命名索引（atlas 格 = 32 + 本表值）
  props: {"grass": 0, "grass_tuft": 1, "grass_flower": 2, "water_a": 3, "water_b": 4, "tree_round": 5, "tree_green2": 6, "tree_orange": 7, "tree_autumn": 8, "bush": 9, "fence_h": 10, "fence_v": 11, "rock": 12, "wall": 13, "wall_stone": 14, "floor": 15, "door": 16, "door_open": 17, "roof": 18, "lamp": 19, "sign": 20, "bench": 21, "barrel": 22, "stall": 23, "path_0": 24, "path_1": 25, "path_2": 26, "path_3": 27, "path_4": 28, "path_5": 29, "path_6": 30, "path_7": 31, "path_8": 32, "path_9": 33, "path_10": 34, "path_11": 35, "path_12": 36, "path_13": 37, "path_14": 38, "path_15": 39},

  PROP_BASE: 32,

  // ③ 装饰资源：像素矩形（支持多格精灵，渲染层用 frame 直接切）
  deco: {"well": { x: 0, y: 144, w: 48, h: 47 }},

  // ④ 水岸过渡：mask 位 1=北 2=东 4=南 8=西 为"陆地"；共 16 掩码 × 2 帧
  shore: {
    cell: 16,
    count: 32,
    rect: function (mask, frame) {
      var i = (frame ? 1 : 0) * 16 + (mask & 15);
      return {
        x: (i % 8) * 16,
        y: 192 + Math.floor(i / 8) * 16,
        width: 16, height: 16
      };
    }
  },

  /** Tiled gid → atlas 格（0 表示空） */
  idxOfGid: function (gid) {
    if (!gid) return -1;
    return gid <= 32 ? gid - 1 : (this.PROP_BASE + (gid - 33));
  },

  /** 道具表索引（tiles.js 语义）→ atlas 格 */
  idxOfProp: function (i) { return this.PROP_BASE + i; }
};
