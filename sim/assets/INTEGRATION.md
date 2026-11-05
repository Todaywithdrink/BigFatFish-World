# 把美术层接进 viewer.js（不改文件，只给接入点）

美术逻辑已经从 \`viewer.js\` 里抽出来，独立在 **\`viewer/art.js\`**。
它不读 viewer 的任何内部状态，只吃 \`ctx / map / patchMap / 坐标 / 格子像素数\`。
接入 = 在 viewer.js 里换掉 5 个地方的调用，**不新增任何美术代码**。

自检页：\`http://127.0.0.1:8090/viewer/art-preview.html\`（手写小地图，不依赖 /api）。

## 0. 前提：原生低分辨率画布

\`\`\`
世界画布 = 屏幕尺寸 / 整数倍（比如 480×270），每格 16px，1:1 画
外层 canvas 放大 2×/3×/4×（imageSmoothingEnabled = false）
\`\`\`

三条铁律，违反哪条都会糊或抖：

1. **一格的像素数是整数**：传 \`size = 16\`。不要 17、不要 \`z + 1\`、不要 \`z * 1.5\`。
2. **坐标取整**：art.js 内部已经 \`Math.round\`，但相机位置要先取整（\`cam.x * 16\` 再 round），否则整格会抖。
3. **缩放只放大画布，不放大图元**：想要"近一点"，是外层 2×→3×，不是把 size 从 16 改成 21。

## 1. 加载（index.html）

\`\`\`html
<script src="/viewer/tiles.js"></script>   <!-- 图集索引，build-tiles.py 生成 -->
<script src="/viewer/art.js"></script>     <!-- 美术层 -->
<script src="/viewer/viewer.js"></script>
\`\`\`

启动时：

\`\`\`js
ART.load(function (ok) { /* ok=false 就继续用旧的程序化画法 */ });
\`\`\`

## 2. 地面层（drawWorld 的瓦片循环）

\`\`\`js
var props = [];
for (var ty = y0; ty < y1; ty++) {
  for (var tx = x0; tx < x1; tx++) {
    var kind = ART.kindAt(map, patchMap, tx, ty);
    var px = tx * TILE, py = ty * TILE;        // TILE = 16，世界画布像素
    if (ART.needsProp(kind)) {
      ART.ground(ctx, map, patchMap, tx, ty, px, py, TILE, timeMs, true);  // 只铺草皮
      props.push({ prop: true, tx: tx, ty: ty, kind: kind, y: ty + 0.9 });
    } else if (!ART.ground(ctx, map, patchMap, tx, ty, px, py, TILE, timeMs)) {
      drawGroundTile(tx, ty);                   // 没接图的 kind 走旧画法
    }
  }
}
\`\`\`

\`ART.ground\` 自己处理：草地变体、小路 16 种拼边、水面两帧动画、墙/地板/门、
水岸浅滩、墙的上沿暗线、地板缝、屋檐、高度差暗边。

## 3. 门

\`\`\`js
var s = worldToScreen(d.x, d.y);
if (!ART.door(ctx, s.x, s.y, TILE, d.open)) { /* 旧画法 */ }
\`\`\`

## 4. 物件 + 角色（同一层按 y 排序）

\`\`\`js
var drawList = [];
views.forEach(function (e) { drawList.push({ y: e.y, ent: e }); });
props.forEach(function (p) { drawList.push({ y: p.y, prop: p }); });
drawList.sort(function (a, b) { return a.y - b.y; });

drawList.forEach(function (it) {
  if (it.prop) {
    ART.prop(ctx, map, patchMap, it.prop.tx, it.prop.ty, it.prop.kind,
             it.prop.tx * TILE, it.prop.ty * TILE, TILE);
  } else {
    drawFish(...);
  }
});
\`\`\`

这一步不能省：树/围栏/石头必须和角色同层排序，否则"走到树后面"是错的。

## 5. 可以删掉的旧代码

这些现在归 art.js 管，留在 viewer.js 里只会互相打架：

- \`drawSpr\` / \`atlasReady\` / \`atlas\` / \`TS\`
- \`groundSprite\` / \`pathMask\` / \`drawRoof\` / \`drawShore\` / \`drawProp\`
- \`drawGroundTile\` 里的贴图分支（\`if (artOn()) { ... }\`），整段删，函数退回纯程序化
- \`drawWorld\` 里 \`kd === "tree" || ...\` 那段的判定
- COLORS 里给贴图用的颜色可以保留（小地图还在用）

## 6. 和"原生低分辨率"冲突的旧做法

我上一版留在 viewer.js 里的代码有三处是按"高分画布 + 小数缩放"写的，换低分辨率画布时**必须去掉**：

| 旧做法 | 为什么不行 | art.js 里的做法 |
|---|---|---|
| \`TILE = 32\`（素材 16px 放大 2 倍） | 低分辨率画布下等于 2 倍糊 | \`size = 16\`，1:1 |
| \`drawSpr(..., z + 1)\` | 多 1 像素有缝，缩小时变成小数 | 精确 16，接缝由拼边解决 |
| 树 \`z * 1.5\` | 1.5 倍 → 4.5 像素一个源像素，抖 | 1 格，需要大树就用两格高的素材拼 |
