"use strict";
/* 角色展示页（重做）：角色 / 背包额度 / 储物箱与门禁
 *
 * 数据来源：
 *   - 实时位置、血量：viewer.js 的 updateHud() 每帧推过来（不重建 DOM，节流 350ms）
 *   - 背包 / 技能 / 性格：GET /api/villagers/:id（2.5 秒轮询，SSE 增量不带这些字段）
 *   - 门 / 箱状态：GET /api/props（2.5 秒轮询 + 每次操作后立刻刷新）
 *   - 所有开关与存取：POST /api/props/act，与 Agent 的 applyAction 是同一个内核入口
 *
 * 权限口径：开关 / 锁具按「控制台」语义（不带 actorId，可远程演示）；
 * 存 / 取必须带当前选中村民的 id，因为物品要有明确的来源和去向，且要走到箱子旁。
 */
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var ROLE = {
    farmer: "农人", fisher: "渔夫", cook: "厨子", wanderer: "游荡者", builder: "匠人",
    trader: "商人", child: "孩子", chief: "村长", miner: "矿工", forager: "采集者",
    craftsman: "手艺人", elder: "长者"
  };
  var roleName = function (r) { return ROLE[r] || r || "居民"; };
  var STAGE = { infant: "婴儿", child: "幼年", teen: "少年", adult: "成年", elder: "长者" };
  var STATE_CN = {
    downed: "倒下了", resting: "在休息（回家睡觉）", walking: "在走路", idle: "待着", dead: "已故"
  };

  var sel = null, state = null, villager = null, props = [];
  var tab = "char", filter = "near", propId = null, currentId = null;
  var trace = [], msg = { text: "", cls: "" };
  var lockCfg = false, hoverItem = null, userHidden = false;
  var lastRender = 0, renderTimer = null, initDone = false;
  var input = { cred: "", item: "", count: "1", mode: "code", newSecret: "", hint: "" };

  function api(path, opts) {
    return fetch(path, opts).then(function (r) { return r.json(); });
  }
  function post(cmd) {
    return api("/api/props/act", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(cmd)
    });
  }
  function pct(n, cap) { return Math.max(0, Math.min(100, (Number(n) || 0) / (cap || 1) * 100)); }
  function meter(label, value, cap, cls, text) {
    var p = pct(value, cap);
    var tone = p >= 100 ? "bad" : p >= 78 ? "warn" : "";
    return '<div class="cp-meter"><div class="lab"><span>' + esc(label) + '</span><b>' +
      esc(text || (value + " / " + cap)) + '</b></div><div class="cp-track ' + (cls || "") + " " + tone +
      '"><i style="width:' + p.toFixed(1) + '%"></i></div></div>';
  }

  // ---------- 对外：viewer.js 调用 ----------
  function update(s, st) {
    sel = s || null;
    state = st || state;
    var id = sel ? sel.id : null;
    if (id !== currentId) {
      currentId = id; villager = null; trace = []; msg = { text: "", cls: "" };
      propId = null; lockCfg = false;
      if (id) fetchVillager();
    }
    // 每帧都调，但只在数据签名变化 / 超过 350ms 时重建 DOM，免得输入框一直失焦
    var now = Date.now();
    if (now - lastRender > 350) { lastRender = now; render(); }
    else if (!renderTimer) {
      renderTimer = setTimeout(function () { renderTimer = null; lastRender = Date.now(); render(); }, 350);
    }
  }

  function fetchVillager() {
    if (!currentId) return;
    var id = currentId;
    api("/api/villagers/" + encodeURIComponent(id)).then(function (v) {
      if (currentId !== id) return;
      villager = v; render();
    }).catch(function () {});
  }
  function fetchProps() {
    return api("/api/props").then(function (d) {
      props = Array.isArray(d.props) ? d.props : [];
      // 门开合要反映到地图上：交给 viewer 把 props 同步回 state.doors
      if (window.ViewerAPI && window.ViewerAPI.syncProps) window.ViewerAPI.syncProps(props);
      render();
    }).catch(function () {});
  }

  // ---------- 输入状态保活 ----------
  function capture() {
    var c = $("#cp-cred"); if (c) input.cred = c.value;
    var i = $("#cp-item"); if (i) input.item = i.value;
    var n = $("#cp-count"); if (n) input.count = n.value;
    // 配置区收起后不再回读，否则"保存成功后清空新密码"会被旧 DOM 里的明文重新覆盖
    if (!lockCfg) return;
    var m = $("#cp-mode"); if (m) input.mode = m.value;
    var s = $("#cp-newsecret"); if (s) input.newSecret = s.value;
    var h = $("#cp-hint"); if (h) input.hint = h.value;
  }

  function render() {
    var root = $("#inspector");
    if (!root) return;
    capture();
    if (!sel || userHidden) { root.classList.add("hidden"); return; }
    root.classList.remove("hidden");

    var v = villager || {};
    var mood = sel.mood || v.mood || "平静";
    var goal = sel.goal || v.goal;
    $("#cp-avatar").style.background = sel.color || "#6a8f4a";
    $("#cp-avatar").textContent = (sel.name || "?").slice(0, 1);
    $("#cp-name").textContent = sel.name || "—";
    var stageCn = STAGE[v.stage] || v.stage || "居民";
    $("#cp-role").textContent = roleName(sel.role) + " · " + stageCn;
    $("#cp-mood").innerHTML = "心情 <b>" + esc(mood) + "</b>" +
      (goal ? "　·　打算：<b>" + esc(goal) + "</b>" : "　·　暂时没什么打算");

    var tabs = document.querySelectorAll(".cp-tab");
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle("on", tabs[i].getAttribute("data-tab") === tab);
    var panes = document.querySelectorAll(".cp-pane");
    for (var j = 0; j < panes.length; j++) panes[j].classList.toggle("hidden", panes[j].getAttribute("data-pane") !== tab);

    if (tab === "char") renderChar(v);
    else if (tab === "bag") renderBag(v);
    else renderProps(v);
  }

  // ---------- 视图 1：角色 ----------
  function renderChar(v) {
    var needs = sel.needs || v.needs || { energy: 100, hunger: 100 };
    var hp = Math.round(sel.hp != null ? sel.hp : 100);
    var maxHp = sel.maxHp || 100;
    var html = '<div class="cp-h">身体</div>';
    html += meter("生命", hp, maxHp, "hp", hp + " / " + maxHp);
    html += meter("体力", Math.round(needs.energy), 100, "en");
    html += meter("饥饿", Math.round(needs.hunger), 100, "hu");
    html += '<div class="cp-h">档案</div>';
    var rows = [
      ["状态", (STATE_CN[sel.state] || sel.state || "待着") + (sel.external || v.external ? " · 外部 AI" : "")],
      ["身份", sel.uid || v.uid || "—"],
      ["位置", Math.round(sel.x) + ", " + Math.round(sel.y)],
      ["已知区域", (sel.exploredCount || v.exploredCount || 0) + " 格"],
      ["钱", (sel.coins != null ? sel.coins : v.coins || 0) + " 币"],
      ["背包", (v.bag ? v.bag.slots + "/" + v.bag.slotCap + " 格" : "读取中…")]
    ];
    for (var i = 0; i < rows.length; i++) {
      html += '<div class="cp-row"><span>' + esc(rows[i][0]) + '</span><b>' + esc(rows[i][1]) + "</b></div>";
    }
    var skills = v.skills || {};
    var names = { farming: "耕种", mining: "采矿", foraging: "采集", fishing: "钓鱼", combat: "战斗", cooking: "烹饪", social: "社交" };
    if (Object.keys(skills).length) {
      html += '<div class="cp-h">技能</div>';
      Object.keys(skills).forEach(function (k) {
        var lv = (skills[k] && skills[k].level) || 0;
        html += '<div class="cp-meter"><div class="lab"><span>' + esc(names[k] || k) +
          '</span><b>Lv ' + lv + '</b></div><div class="cp-track"><i style="width:' +
          Math.min(100, lv * 10) + '%"></i></div></div>';
      });
    }
    var p = v.personality;
    if (p) {
      html += '<div class="cp-h">性格（会随经历漂移）</div>';
      Object.keys(p).forEach(function (k) {
        var val = Number(p[k]) || 0;
        html += '<div class="cp-meter"><div class="lab"><span>' + esc(k) + '</span><b>' + val.toFixed(1) +
          ' / 10</b></div><div class="cp-track"><i style="width:' + (val * 10) + '%"></i></div></div>';
      });
    }
    $("#cp-pane-char").innerHTML = html;
  }

  // ---------- 视图 2：背包 ----------
  function renderBag(v) {
    var bag = v.bag || sel.bag;
    if (!bag) { $("#cp-pane-bag").innerHTML = '<div class="cp-empty">正在读取背包额度…</div>'; return; }
    var items = bag.items || [];
    var maxKind = 0;
    items.forEach(function (it) { if (it.slots > maxKind) maxKind = it.slots; });
    var html = '<div class="cp-h">背包额度</div>';
    html += meter("格位", bag.slots, bag.slotCap, "", bag.slots + " / " + bag.slotCap + " 格");
    html += meter("负重", bag.weight, bag.weightCap, "", bag.weight + " / " + bag.weightCap);
    html += meter("单类上限", maxKind, bag.kindCap, "", "最多的一类占 " + maxKind + " / " + bag.kindCap + " 格");

    html += '<div class="cp-h">物品栏（' + bag.total + ' 件 / ' + items.length + ' 类）</div><div class="cp-grid">';
    var slots = [];
    items.forEach(function (it) {
      for (var k = 0; k < it.slots; k++) {
        var n = (k === it.slots - 1) ? (it.count - k * it.stack) : it.stack;
        slots.push({ it: it, n: n });
      }
    });
    for (var i = 0; i < bag.slotCap; i++) {
      var s = slots[i];
      if (!s) { html += '<div class="cp-slot empty"></div>'; continue; }
      html += '<div class="cp-slot filled" data-item="' + esc(s.it.id) + '" title="' + esc(s.it.name) +
        '">' + esc(s.it.emoji || "•") + '<span class="n">×' + s.n + "</span></div>";
    }
    html += "</div>";

    var d = hoverItem && items.find(function (x) { return x.id === hoverItem; });
    html += '<div class="cp-detail">' + (d
      ? "<b>" + esc(d.emoji + " " + d.name) + "</b>　" + esc(d.catName || d.cat) + "<br>持有 " + d.count +
        " 件 · 每格 " + d.stack + " 件（占 " + d.slots + " 格）<br>单价 " + d.value + " 币 · 每件 " + d.unitWeight +
        " 重 · 合计 " + d.weight
      : "把鼠标移到物品上看明细。额度不是「最多几件」，而是格子、堆叠与重量三重约束。") + "</div>";
    html += '<div class="cp-note">常规背包规则：每种物品按堆叠上限折成格子，24 格用完就再也塞不进新种类；' +
      "即使还有空格，总负重超过 80 也会拒绝；同一种物品最多占 6 格，防止一种材料把包塞满。" +
      "产出动作（钓鱼 / 砍树 / 制作 / 赠予 / 交易）在装不下时直接拒绝，不会先扣掉材料。</div>";
    $("#cp-pane-bag").innerHTML = html;

    var cells = document.querySelectorAll("#cp-pane-bag .cp-slot.filled");
    for (var c = 0; c < cells.length; c++) {
      cells[c].addEventListener("mouseenter", function () { hoverItem = this.getAttribute("data-item"); renderBag(villager || {}); });
      cells[c].addEventListener("mouseleave", function () { hoverItem = null; renderBag(villager || {}); });
    }
  }

  // ---------- 视图 3：储物箱 / 门禁 ----------
  function near(p) {
    if (!sel) return 9999;
    return Math.hypot(p.x + 0.5 - sel.x, p.y + 0.5 - sel.y);
  }
  function shownProps() {
    var byDist = function (a, b) { return near(a) - near(b) || a.id.localeCompare(b.id); };
    var list = props.slice();
    if (filter === "door") { list = list.filter(function (p) { return p.kind === "door"; }); list.sort(byDist); return list; }
    if (filter === "chest") { list = list.filter(function (p) { return p.kind === "chest"; }); list.sort(byDist); return list; }
    if (filter === "near") {
      list.sort(byDist);
      var close = list.filter(function (p) { return near(p) <= 12; });
      // 附近一个都没有就退回"离得最近的几个"：新用户不该打开面板看到一片空白
      return (close.length ? close : list).slice(0, 8);
    }
    list.sort(byDist);
    return list;
  }
  function badge(p) {
    var s = '<span class="cp-badge ' + (p.open ? "open" : "") + '">' + (p.open ? "开着" : "关着") + "</span>";
    if (p.lock.locked) s += '<span class="cp-badge locked">已锁</span>';
    else if (p.lock.hasSecret) s += '<span class="cp-badge">' + esc(p.lock.modeName) + "锁</span>";
    var d = near(p);
    if (d <= 2.2) s += '<span class="cp-badge near">身边</span>';
    return s;
  }

  function renderProps(v) {
    var html = '<div class="cp-filters">' +
      [["near", "附近"], ["chest", "储物箱"], ["door", "门"], ["all", "全部"]].map(function (f) {
        return '<button class="cp-mini-btn ' + (filter === f[0] ? "on" : "") + '" data-filter="' + f[0] + '">' + f[1] + "</button>";
      }).join("") + "</div>";
    // 详情放列表**上方**：一选中就能看见三段轨迹与操作区，
    // 否则门一多，详情被挤到滚动区下面，用户以为点了没反应。
    var chosen = props.find(function (x) { return x.id === propId; });
    html += '<div class="cp-detailbox ' + (chosen ? "" : "hidden") + '" id="cp-detailbox"></div>';
    html += '<div class="cp-h" style="margin-top:13px">物件列表</div>';
    var list = shownProps();
    if (!list.length) {
      html += '<div class="cp-empty">这个范围里没有门或储物箱。<br>切到「全部」看看，或让居民走近一点。</div>';
    }
    list.forEach(function (p) {
      html += '<div class="cp-prop ' + (propId === p.id ? "sel" : "") + '" data-prop="' + esc(p.id) + '">' +
        '<div class="cp-prop-top"><span class="cp-prop-ico">' + (p.kind === "door" ? "🚪" : "📦") + '</span>' +
        '<span class="cp-prop-name">' + esc(p.label) + "</span>" + badge(p) + "</div>" +
        '<div class="cp-prop-sub">' + p.x + ", " + p.y + " · 距 " + near(p).toFixed(1) + " 格" +
        (p.kind === "chest" && p.usage ? " · " + p.usage.slots + "/" + p.usage.slotCap + " 格" : "") +
        (p.lock.hint ? " · 提示：" + esc(p.lock.hint) : "") + "</div></div>";
    });
    $("#cp-pane-prop").innerHTML = html;

    var filters = document.querySelectorAll("[data-filter]");
    for (var i = 0; i < filters.length; i++) {
      filters[i].addEventListener("click", function () { filter = this.getAttribute("data-filter"); renderProps(villager || {}); });
    }
    var cards = document.querySelectorAll("[data-prop]");
    for (var j = 0; j < cards.length; j++) {
      cards[j].addEventListener("click", function () {
        var id = this.getAttribute("data-prop");
        propId = propId === id ? null : id;
        trace = []; msg = { text: "", cls: "" }; lockCfg = false;
        renderProps(villager || {});
      });
    }
    var p = props.find(function (x) { return x.id === propId; });
    if (p) renderPropDetail(p);
  }

  function renderPropDetail(p) {
    var box = $("#cp-detailbox");
    if (!box) return;
    var html = '<div class="cp-h">输入 → 判断 → 开关</div><div class="cp-trace">';
    ["输入", "判断", "开关"].forEach(function (s, i) {
      var t = trace[i];
      var cls = t ? (t.ok ? "ok" : "bad") : "pending";
      html += '<div class="cp-step ' + cls + '"><div class="s">' + (i + 1) + ". " + s +
        '</div><div class="d">' + esc(t ? t.detail : "等待操作") + "</div></div>";
    });
    html += "</div>";
    if (msg.text) html += '<div class="cp-msg ' + msg.cls + '">' + esc(msg.text) + "</div>";

    var codeMode = p.lock.mode !== "key";
    html += '<div class="cp-form"><input class="cp-input" id="cp-cred" autocomplete="off" spellcheck="false" ' +
      'type="' + (codeMode ? "password" : "text") + '" placeholder="' +
      (p.lock.mode === "none" ? "这物件没有锁，无需凭证" : codeMode ? "输入密码" : "输入钥匙编号") +
      '" value="' + esc(input.cred) + '" /></div>';

    html += '<div class="cp-btn-row">' +
      '<button class="cp-btn" data-op="open">打开</button>' +
      '<button class="cp-btn gray" data-op="close">关闭</button>' +
      '<button class="cp-btn warn" data-op="lock">上锁</button>' +
      '<button class="cp-btn" data-op="unlock">解锁</button>' +
      '<button class="cp-btn gray" data-op="setLockToggle">' + (lockCfg ? "收起配置" : "配置 / 拆锁") + "</button>" +
      "</div>";

    html += '<div class="cp-lockcfg ' + (lockCfg ? "" : "hidden") + '">' +
      '<div class="cp-form"><select class="cp-select" id="cp-mode">' +
      [["none", "拆除锁具"], ["code", "密码锁"], ["key", "钥匙锁"]].map(function (m) {
        return '<option value="' + m[0] + '"' + (input.mode === m[0] ? " selected" : "") + ">" + m[1] + "</option>";
      }).join("") + "</select></div>" +
      '<div class="cp-form"><input class="cp-input" id="cp-newsecret" type="text" autocomplete="off" placeholder="新密码 / 钥匙编号" value="' +
      esc(input.newSecret) + '" /><input class="cp-input short" id="cp-hint" type="text" placeholder="提示" value="' +
      esc(input.hint) + '" /></div>' +
      '<div class="cp-btn-row"><button class="cp-btn" data-op="setLock">保存锁具</button>' +
      '<span style="font-size:10px;color:#7e906f;align-self:center">改已有锁要填上方旧凭证；密码只存摘要</span></div></div>';

    if (p.kind === "chest") {
      var u = p.usage || { slots: 0, slotCap: 30, weight: 0, weightCap: 200, items: [] };
      html += '<div class="cp-h">箱内容量</div>';
      html += meter("格位", u.slots, u.slotCap, "", u.slots + " / " + u.slotCap + " 格");
      html += meter("负重", u.weight, u.weightCap, "", u.weight + " / " + u.weightCap);
      html += '<div class="cp-chestgrid">';
      var cells = [];
      (u.items || []).forEach(function (it) {
        for (var k = 0; k < it.slots && cells.length < 30; k++) {
          cells.push(esc(it.emoji || "•") + '<span class="n">' + it.count + "</span>");
        }
      });
      for (var i = 0; i < 12; i++) {
        html += cells[i] ? '<div class="cp-slot filled">' + cells[i] + "</div>" : '<div class="cp-slot empty"></div>';
      }
      html += "</div>";

      var bagItems = ((villager && villager.bag && villager.bag.items) || []);
      var chestItems = u.items || [];
      var ids = {};
      bagItems.forEach(function (it) { ids[it.id] = it.name; });
      chestItems.forEach(function (it) { ids[it.id] = it.name; });
      html += '<div class="cp-form"><select class="cp-select" id="cp-item">' +
        Object.keys(ids).map(function (id) {
          return '<option value="' + esc(id) + '"' + (input.item === id ? " selected" : "") + ">" + esc(ids[id]) + "</option>";
        }).join("") + "</select>" +
        '<input class="cp-input short" id="cp-count" type="number" min="1" max="99" value="' + esc(input.count || "1") + '" />' +
        "</div>";
      html += '<div class="cp-btn-row"><button class="cp-btn" data-op="deposit">存入</button>' +
        '<button class="cp-btn gray" data-op="withdraw">取出</button></div>';
      html += '<div class="cp-note">存取以「' + esc(sel ? sel.name : "当前居民") +
        '」的身份进行，需要走到箱子 2.2 格内；箱盖要开着且没锁。开关与锁具是控制台操作，可远程演示。</div>';
    }
    box.innerHTML = html;

    var btns = box.querySelectorAll("[data-op]");
    for (var b = 0; b < btns.length; b++) {
      btns[b].addEventListener("click", function () { onOp(this.getAttribute("data-op"), p); });
    }
  }

  function onOp(op, p) {
    capture();
    if (op === "setLockToggle") { lockCfg = !lockCfg; renderPropDetail(p); return; }
    var cmd = { op: op, id: p.id };
    if (input.cred) cmd.credential = { type: p.lock.mode === "key" ? "key" : "code", value: input.cred };
    if (op === "setLock") {
      cmd.op = "setLock"; cmd.mode = input.mode || "none";
      if (cmd.mode !== "none") { cmd.newSecret = input.newSecret; cmd.hint = input.hint; }
    }
    if (op === "deposit" || op === "withdraw") {
      cmd.item = input.item; cmd.count = Number(input.count) || 1;
      cmd.actorId = sel ? sel.id : null;
      if (!cmd.item) { msg = { text: "背包和箱子都是空的，没有可存取的物品", cls: "bad" }; renderPropDetail(p); return; }
    }
    post(cmd).then(function (r) {
      trace = r.trace || [];
      if (r.ok) {
        var last = trace[trace.length - 1];
        msg = { text: last ? last.detail : "操作完成", cls: "good" };
        input.cred = "";
        if (op === "setLock") {
          // 新凭证只留在这一次请求里：保存完立刻收起配置区并抹掉明文
          lockCfg = false; input.newSecret = ""; input.hint = "";
        }
      } else {
        msg = { text: r.hint || r.reason || "操作被拒绝", cls: "bad" };
      }
      return fetchProps();
    }).then(function () {
      fetchVillager();
      var p2 = props.find(function (x) { return x.id === p.id; });
      if (p2) renderPropDetail(p2);
    }).catch(function (e) {
      msg = { text: "请求失败：" + e.message, cls: "bad" };
      renderPropDetail(p);
    });
  }

  // ---------- 初始化 ----------
  function init() {
    if (initDone) return;
    initDone = true;
    var tabs = document.querySelectorAll(".cp-tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        capture(); tab = this.getAttribute("data-tab"); render();
        if (tab === "prop") fetchProps();
      });
    }
    var close = $("#cp-close");
    if (close) close.addEventListener("click", function () { window.CharacterPanel.hide(); });
    fetchProps();
    setInterval(function () {
      if (currentId) fetchVillager();
      fetchProps();
    }, 2500);
  }

  window.CharacterPanel = {
    update: update,
    init: init,
    openTab: function (t) { tab = t; userHidden = false; init(); render(); if (t === "prop") fetchProps(); },
    hidden: function () { return $("#inspector") ? $("#inspector").classList.contains("hidden") : true; },
    show: function () {
      userHidden = false;
      var e = $("#inspector"); if (e) e.classList.remove("hidden");
      render();
    },
    hide: function () {
      userHidden = true;
      var e = $("#inspector"); if (e) e.classList.add("hidden");
      if (window.ViewerAPI && window.ViewerAPI.hidePanel) window.ViewerAPI.hidePanel();
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
