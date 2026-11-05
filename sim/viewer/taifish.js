// 大肥鱼 32×32 模板 + 调色板提取
// 上传的图只用来取颜色，形状永远是同一只鱼
(function () {
  var S = 32;

  function hex2rgb(h) {
    var n = parseInt(String(h).replace('#', ''), 16);
    if (!isFinite(n)) return [128, 128, 128];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgb2hex(r, g, b) {
    var f = function (v) { return ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2); };
    return '#' + f(r) + f(g) + f(b);
  }
  function mix(a, b, t) {
    var A = hex2rgb(a), B = hex2rgb(b);
    return rgb2hex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
  }
  function darken(c, t) { return mix(c, '#000000', t); }
  function lighten(c, t) { return mix(c, '#ffffff', t); }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    var h = 0, s = 0, l = (mx + mn) / 2;
    if (mx !== mn) {
      var d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (mx === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return [h * 360, s, l];
  }

  // 从图里取 5 个颜色：头发（上半）/ 衣服（下半）/ 皮肤 / 白色 / 点缀
  function extractPalette(img) {
    var W = 64, H = 64;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    var px = g.getImageData(0, 0, W, H).data;

    var topBuckets = {}, botBuckets = {};
    var whiteSum = [0, 0, 0, 0];
    var skinSum = [0, 0, 0, 0];
    var satBest = -1, accent = '#ffffff';

    function add(bucket, r, gg, bb, sat, lig) {
      var key = ((r >> 4) << 8) | ((gg >> 4) << 4) | (bb >> 4);
      var e = bucket[key];
      if (!e) { e = bucket[key] = { r: 0, g: 0, b: 0, n: 0 }; }
      e.r += r; e.g += gg; e.b += bb; e.n++;
    }

    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4;
        if (px[i + 3] < 180) continue;
        var r = px[i], gg = px[i + 1], bb = px[i + 2];
        var hsl = rgbToHsl(r, gg, bb);
        var hue = hsl[0], sat = hsl[1], lig = hsl[2];
        if (sat < 0.13 && lig > 0.8) { whiteSum[0] += r; whiteSum[1] += gg; whiteSum[2] += bb; whiteSum[3]++; continue; }
        if (hue > 8 && hue < 45 && sat > 0.1 && sat < 0.5 && lig > 0.62 && lig < 0.92) {
          skinSum[0] += r; skinSum[1] += gg; skinSum[2] += bb; skinSum[3]++;
        }
        if (sat > satBest) { satBest = sat; accent = rgb2hex(r, gg, bb); }
        if (y < H * 0.45) add(topBuckets, r, gg, bb, sat, lig);
        else add(botBuckets, r, gg, bb, sat, lig);
      }
    }

    function best(bucket, minCount) {
      var out = null;
      for (var k in bucket) {
        var e = bucket[k];
        if (e.n < (minCount || 10)) continue;
        if (!out || e.n > out.n) out = { r: e.r / e.n, g: e.g / e.n, b: e.b / e.n, n: e.n };
      }
      return out ? rgb2hex(out.r, out.g, out.b) : null;
    }

    var hair = best(topBuckets, 8) || '#5b7fd0';
    var dress = best(botBuckets, 8) || '#2f3a52';
    // 衣服太浅就压暗一点，避免整只鱼糊成白色
    var dHsl = rgbToHsl.apply(null, hex2rgb(dress));
    if (dHsl[2] > 0.78) dress = darken(dress, 0.55);
    var hHsl = rgbToHsl.apply(null, hex2rgb(hair));
    if (hHsl[2] > 0.85) hair = darken(hair, 0.35);

    var palette = {
      hair: hair,
      dress: dress,
      skin: skinSum[3] > 15 ? rgb2hex(skinSum[0] / skinSum[3], skinSum[1] / skinSum[3], skinSum[2] / skinSum[3]) : '#f4e3d7',
      white: whiteSum[3] > 15 ? rgb2hex(whiteSum[0] / whiteSum[3], whiteSum[1] / whiteSum[3], whiteSum[2] / whiteSum[3]) : '#ffffff',
      accent: accent
    };
    palette.hairDark = darken(palette.hair, 0.32);
    palette.dressDark = darken(palette.dress, 0.3);
    return palette;
  }
  // 32×32 大肥鱼
  function build(palette) {
    var p = palette || {};
    var hair = p.hair || '#5b7fd0';
    var hairDark = p.hairDark || '#3e5b9e';
    var skin = p.skin || '#f4e3d7';
    var dress = p.dress || '#2f3a52';
    var dressDark = p.dressDark || '#20283a';
    var white = p.white || '#ffffff';
    var accent = p.accent || '#6fa8d8';

    var c = document.createElement('canvas');
    c.width = S; c.height = S;
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;

    function put(x, y, col) {
      if (x < 0 || y < 0 || x >= S || y >= S) return;
      g.fillStyle = col;
      g.fillRect(x, y, 1, 1);
    }

    var grid = [];
    for (var i = 0; i < S * S; i++) grid.push(null);
    function set(x, y, col) {
      if (x < 0 || y < 0 || x >= S || y >= S) return;
      grid[y * S + x] = col;
    }
    function get(x, y) {
      if (x < 0 || y < 0 || x >= S || y >= S) return null;
      return grid[y * S + x];
    }

    // 身体/裙子
    for (var y = 19; y < 31; y++) {
      var half = 4.5 + (y - 19) * 0.55;
      for (var x = 0; x < S; x++) {
        if (Math.abs(x - 16) <= half) set(x, y, dress);
      }
    }
    // 围裙
    for (var y2 = 21; y2 < 30; y2++) {
      var hw = 2.4 + (y2 - 21) * 0.28;
      for (var x2 = 0; x2 < S; x2++) {
        if (Math.abs(x2 - 16) <= hw) set(x2, y2, white);
      }
    }
    // 领口
    for (var x3 = 13; x3 <= 19; x3++) set(x3, 20, dressDark);
    // 蝴蝶结
    set(15, 21, accent); set(16, 21, accent); set(17, 21, accent);
    set(16, 22, accent);
    // 手臂
    for (var y3 = 21; y3 <= 25; y3++) {
      set(9, y3, dress); set(10, y3, dress);
      set(22, y3, dress); set(23, y3, dress);
    }
    // 手
    set(9, 26, skin); set(10, 26, skin); set(22, 26, skin); set(23, 26, skin);

    // 头发（后层）：一个大椭圆
    for (var y4 = 2; y4 <= 20; y4++) {
      for (var x4 = 0; x4 < S; x4++) {
        var dx = (x4 - 16) / 10.5, dy = (y4 - 11) / 9.8;
        if (dx * dx + dy * dy <= 1) set(x4, y4, hair);
      }
    }
    // 双马尾
    for (var y5 = 12; y5 <= 26; y5++) {
      for (var x5 = 0; x5 < S; x5++) {
        var a = (x5 - 5) / 3.6, b = (y5 - 19) / 7.2;
        if (a * a + b * b <= 1) set(x5, y5, hair);
        var a2 = (x5 - 27) / 3.6, b2 = (y5 - 19) / 7.2;
        if (a2 * a2 + b2 * b2 <= 1) set(x5, y5, hair);
      }
    }
    // 脸
    for (var y6 = 6; y6 <= 19; y6++) {
      for (var x6 = 0; x6 < S; x6++) {
        var fx = (x6 - 16) / 7.2, fy = (y6 - 13.5) / 7.0;
        if (fx * fx + fy * fy <= 1) set(x6, y6, skin);
      }
    }
    // 刘海
    for (var y7 = 4; y7 <= 10; y7++) {
      for (var x7 = 0; x7 < S; x7++) {
        var bx = (x7 - 16) / 9.2, by = (y7 - 9) / 6.4;
        if (bx * bx + by * by <= 1) set(x7, y7, hair);
      }
    }
    // 眼睛（写进 grid，避免被后面的绘制盖掉）
    for (var ey = 13; ey <= 16; ey++) {
      set(11, ey, '#2b3350'); set(12, ey, '#2b3350');
      set(19, ey, '#2b3350'); set(20, ey, '#2b3350');
    }
    set(12, 13, '#ffffff'); set(20, 13, '#ffffff');
    // 腮红
    set(9, 17, '#f0a8a8'); set(10, 17, '#f0a8a8');
    set(21, 17, '#f0a8a8'); set(22, 17, '#f0a8a8');
    // 嘴
    set(15, 18, '#c9607a'); set(16, 18, '#c9607a');

    // 鲸尾
    for (var y8 = 26; y8 <= 30; y8++) {
      for (var x8 = 20; x8 < S; x8++) {
        var tx = (x8 - 25) / 5.0, ty = (y8 - 28) / 2.4;
        if (tx * tx + ty * ty <= 1) set(x8, y8, hairDark);
      }
    }

    // 画出来 + 描边
    for (var yy = 0; yy < S; yy++) {
      for (var xx = 0; xx < S; xx++) {
        var col = get(xx, yy);
        if (!col) continue;
        put(xx, yy, col);
      }
    }
    for (var yy2 = 0; yy2 < S; yy2++) {
      for (var xx2 = 0; xx2 < S; xx2++) {
        if (get(xx2, yy2)) continue;
        var near = get(xx2 - 1, yy2) || get(xx2 + 1, yy2) || get(xx2, yy2 - 1) || get(xx2, yy2 + 1);
        if (near) put(xx2, yy2, darken(near, 0.55));
      }
    }
    return c;
  }

  window.TAIFISH = { size: S, extractPalette: extractPalette, build: build, darken: darken, lighten: lighten };
})();