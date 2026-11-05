// 自动生成，勿手改：sim/tools/build-char.mjs
// 源：sim/viewer/char.png（272×256，17 列 × 3 朝向行）
// 说明：walkFrames 为走路循环长度；右侧朝向由 left 行水平镜像得到，不单独占行
window.CHAR_SET = {
  img: "/viewer/char.png",
  frameW: 16,
  frameH: 22,
  cols: 17,
  walkFrames: 4,
  rows: {"down":6,"left":38,"up":70},
  /** 朝向 → 行 y 起点（right 走 left 行镜像） */
  rowY: function (face) {
    if (face === "right") face = "left";
    return this.rows[face] != null ? this.rows[face] : this.rows.down;
  }
};
