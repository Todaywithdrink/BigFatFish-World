const fs = require("fs");
const p = "viewer/viewer.js";
let lines = fs.readFileSync(p, "utf8").split(/\r?\n/);

// 行号 -> 替换成的若干行（从后往前应用）
const fix = {
2: ["// 观测站：只消费 /api/world + /api/stream，不依赖任何私有格式。", "(function () {"],
29: ["  var artOff = false;   // ?art=off：退回旧的程序化画法，只用来做前后对比", "  var forceHour = null; // ?hour=11：只看白天光照，截图用", "  var TILE = 32;"],
57: ["  // ---------- 图集（Kenney CC0：Tiny Town / Tiny Battle）----------"],
142: ['      setBadge("观看：" + d.villager.name);'],
201: ["  // ---------- 事件流 ----------"],
219: ['      return { cls: "danger", who: "!", txt: "有人从" + ev.drop + " 米高处摔下来，掉了" + ev.damage + " 点", t: t };'],
222: ['      return { cls: "danger", who: "!", txt: "有人倒下了", t: t };'],
225: ['      return { cls: "good", who: "+", txt: "有人学会了做" + ev.name + "！", t: t };'],
228: ['      return { cls: "danger", who: "!", txt: "有人挨了一下，掉" + ev.damage + " 点血", t: t };'],
260: ['    document.getElementById("clock-text").textContent = "第" + state.clock.day + " 天 · " + clockText();'],
283: ['      (sel.state === "downed" ? "倒下了" :'],
284: ['       sel.state === "resting" ? "在休息（回家睡觉）" :'],
285: ['       sel.state === "walking" ? "在走路" :'],
286: ['       sel.talkTo ? "在说话" : "待着") + (sel.external ? " · 外部 AI" : "");'],
289: ['    if (known) known.textContent = (sel.exploredCount || 0) + " 格";'],
291: ['    if (uidEl) uidEl.textContent = sel.uid || "—";'],
295: ['      coinsEl.textContent = c < 0 ? "-" + (-c) + " 币" : c + " 币";'],
303: ['        : "—";'],
338: ['      p.textContent = "还没练出什么本事";'],
378: ["  // ---------- 主循环 ----------"],
409: ["    // 世界层画在 1/PIXEL 的画布上"],
418: ["    // 整数倍放大到主画布（最近邻）", "    ctx = mainCtx;"],
438: ["    // 地面（树/栅栏/石头只铺草皮，本体进下面的 y 排序层）"],
454: ["    // 门", "    var doors = state.doors || [];"],
492: ["    // 选中视野锥", "    var sel = views.get(selectedId);"],
507: ["    // 实体 + 物件（统一按 y 排序：这样树才会挡住站在它后面的人）"],
622: ["  // 地形贴图：同一格按位置散列取变体，看起来不重复", "  function groundSprite(kind, tx, ty) {"],
630: ['    if (kind === "door") return "wall";      // 门后面是墙，门本身在上面单独画', '    if (kind === "lamp") return "lamp";'],
636: ["  // 和邻格不同就在那一边压一道暗边，盖住硬接缝", "  function drawRim(kind, tx, ty, s, z, color) {"],
645: ["  // 屋檐：取屋顶图的下半条，画在房子上沿外侧（不会挡住屋里的地面）", "  function drawRoof(s, z) {"],
668: ["  // 物件层：树 / 栅栏 / 石头"],
680: ['      var tw = z * 1.5;                       // 树画得比格子高一点，才有"树"的体积', '      drawSpr(tname, s.x + z * 0.5 - tw / 2, s.y + z - tw + z * 0.12, tw);'],
707: ["    // 有图集：地面出贴图，物件的格子只铺草皮", "    if (artOn()) {"],
713: ['        if (!baseOnly && kind === "wall") {            // 墙的上沿压暗，房子才有厚度', '          ctx.fillStyle = "rgba(30,18,10,.35)";'],
720: ['        // 房子最上面一排：往上压一条屋檐，房子才有"顶"'],
918: ["    // 悬崖边缘：比下面那格高，就画一道暗边", "    var below = ty + 1 < map.height ? Number(map.heights[ty + 1][tx]) : 0;"],
980: ["  // ---------- 分层像素角色：身体 / 上衣 / 帽子，按 8 个朝向预生成 ----------"],
991: ["  // 在 16x16 的网格上逐像素判定，天然是像素画"],
993: ["    // 尾鳍（在身体后面）", "    if (bx < -4.4) {"],
1004: ["    // 帽子：帽檐 + 帽顶"],
1015: ["    // 上衣：身体下半段一条带子 + 领口"],
1212: ["  // ---------- 小地图 ----------"]
};

const keys = Object.keys(fix).map(Number).sort((a, b) => b - a);
for (const n of keys) {
  const idx = n - 1;
  if (idx < 0 || idx >= lines.length) continue;
  lines.splice(idx, 1, ...fix[n]);
}
fs.writeFileSync(p, lines.join("\n"), "utf8");
console.log("fixed lines:", keys.length);
