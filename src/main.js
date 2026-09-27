// 描画・ループ・入力・交通・採点
(function () {
  const ATC = window.ATC;
  const cv = document.getElementById("scope");
  const ctx = cv.getContext("2d");
  const $ = (id) => document.getElementById(id);
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
                  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* 保存できなくても動作に影響なし */ } } };

  // ---- 表示テーマ（色は状態を表す時だけ使う） ----
  const THEMES = {
    modern: { bg: "#0c1216", coast: "#26323b", ring: "#162028", ringText: "#34424c", star: "#27343e", fix: "#4c5b67", fixText: "#63727e",
              tt: "#26323b", rwy: "#9aa9b5", cl: "#2e3c47", own: "#dfe7ec", offer: "#6fd0ff", dim: "#7b8a96", hist: [223, 231, 236],
              warn: "#ffd34d", alert: "#ff5c50", ntz: "rgba(255,92,80,0.35)", font: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace', glow: 0, fs: 14 },
    retro:  { bg: "#000", coast: "rgba(51,255,102,0.28)", ring: "rgba(51,255,102,0.16)", ringText: "rgba(51,255,102,0.35)", star: "rgba(51,255,102,0.4)",
              fix: "rgba(51,255,102,0.45)", fixText: "rgba(51,255,102,0.55)", tt: "rgba(51,255,102,0.18)", rwy: "#33ff66", cl: "rgba(51,255,102,0.18)",
              own: "#33ff66", offer: "#33ff66", dim: "rgba(51,255,102,0.45)", hist: [51, 255, 102], warn: "#ffcc33", alert: "#ffcc33",
              ntz: "rgba(255,204,51,0.35)", font: 'VT323, ui-monospace, Menlo, Consolas, monospace', glow: 3, fs: 17 },
  };
  let theme = store.get("hap-theme") === "retro" ? "retro" : "modern";
  let T = THEMES[theme];
  function applyTheme() { T = THEMES[theme]; document.body.dataset.theme = theme; store.set("hap-theme", theme); }
  applyTheme();

  const SWEEP_SEC = 4; // 空港監視レーダーの 1 回転（目標の表示位置はこの周期で更新）
  const SEP_NM = 3, SEP_FT = 1000;
  const RULES = { land: 100, delayPerMin: 5, lateAccept: 20, goAround: 50, violation: 200, maxViolations: 3, acceptSec: 60 };
  const ATIS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(Math.random() * 26)];

  let world = null, usable = [], NOMINAL = {}, MAP_FIXES = [];
  const S = {
    ac: [], sel: null, ts: 1, paused: true, started: false, simT: 0, sweep: 0, showFix: true,
    score: 0, landed: 0, goArounds: 0, violations: 0, delaySum: 0, over: false,
    auto: true, nextSpawn: 5, view: { cx: 8, cy: -12, scale: 8 }, log: [], pairs: new Set(),
  };

  // ---- 画面サイズ ----
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * DPR; cv.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  const sx = (x) => W / 2 + (x - S.view.cx) * S.view.scale;
  const sy = (y) => H / 2 - (y - S.view.cy) * S.view.scale;
  const wx = (px) => S.view.cx + (px - W / 2) / S.view.scale;
  const wy = (py) => S.view.cy - (py - H / 2) / S.view.scale;
  function fitView() {
    if (!world) return;
    const pts = ["XAC", "AKSEL", "AROSA", "GODIN", "POLIX"].map((id) => world.fixes[id]).concat([{ x: 0, y: 0 }]);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs) - 4, x1 = Math.max(...xs) + 12, y0 = Math.min(...ys) - 3, y1 = Math.max(...ys) + 3;
    const top = $("tl").getBoundingClientRect().bottom + 8;
    const right = W > 760 ? W - 300 : W - 16; // 広い画面では右に到着順の一覧が出る
    const bottom = $("bar").getBoundingClientRect().top - 90;
    const h = Math.max(120, bottom - top), w = Math.max(200, right - 16);
    S.view.scale = Math.max(2, Math.min(w / (x1 - x0), h / (y1 - y0)));
    S.view.cx = (x0 + x1) / 2 - ((16 + right) / 2 - W / 2) / S.view.scale;
    S.view.cy = (y0 + y1) / 2 + ((top + bottom) / 2 - H / 2) / S.view.scale;
  }
  addEventListener("resize", () => { resize(); if (!S.userMoved) fitView(); });
  resize();

  // ---- 開始（天候＝運用の選択） ----
  function startGame(cfgName) {
    world = ATC.buildWorld(window.RJTT, cfgName);
    usable = Object.values(world.stars).filter((s) => s.rwy);
    NOMINAL = {};
    for (const s of usable) { // 遅延の基準: 管制介入なしで飛んだ場合の所要時間
      const a = new ATC.Aircraft(world, { callsign: "NOM", star: s.name, autoApproach: true, alt: entryAlt(s) });
      while (a.state === "AIR" && a.t < 7200) a.step(1);
      NOMINAL[s.name] = a.t;
    }
    const used = new Set(usable.flatMap((s) => s.fixes.map((f) => f.id)));
    for (const k of new Set([...Object.values(world.cfg.app), ...Object.values(world.cfg.fallback)])) {
      const ap = ATC.APPROACHES[k];
      Object.values(ap.from).flat().forEach(([id]) => used.add(id));
      used.add(ap.missed.fix);
    }
    MAP_FIXES = [...used].map((id) => world.fixes[id]).filter(Boolean);
    const starSel = $("star"); starSel.textContent = "";
    for (const s of usable) { const o = document.createElement("option"); o.value = s.name; o.textContent = `${s.name} → ${s.rwy}`; starSel.appendChild(o); }
    const a = world.cfg.app;
    $("rwyinfo").textContent = `34L ${ATC.APPROACHES[a["34L"]].name.replace(" RWY34L", "")} / 34R ${ATC.APPROACHES[a["34R"]].name.replace(" RWY34R", "")}  ${world.cfg.label}`;
    S.started = true; S.paused = false;
    $("helpbox").hidden = true;
    requestAnimationFrame(fitView);
  }
  function entryAlt(s) { return s.fixes[0].alt ? s.fixes[0].alt.ft : { XAC: 13000, AROSA: 13000, GODIN: 14000 }[s.fixes[0].id] || 13000; }

  // ---- 交通生成（方面比率は推定値） ----
  const ENTRY_W = { XAC: 0.35, AKSEL: 0.25, AROSA: 0.10, GODIN: 0.15, POLIX: 0.15 };
  const AIRLINES = ["JAL", "ANA", "SKY", "ADO", "SNJ", "SFJ", "APJ", "KAL", "AAR", "CPA", "CAL", "EVA", "UAL", "DAL", "QFA"];
  const TYPES = [["B738", "M"], ["A320", "M"], ["B763", "H"], ["B772", "H"], ["B789", "H"], ["A359", "H"], ["A321", "M"]];
  const EXCLUDED_CS = new Set(["JAL123", "JAL350", "JAL516", "ANA60"]); // 羽田に関係する過去の事故便の便名は生成しない
  const rnd = (a) => a[Math.floor(Math.random() * a.length)];
  function newCallsign() {
    for (;;) {
      const cs = rnd(AIRLINES) + (Math.floor(Math.random() * 990) + 10);
      if (!EXCLUDED_CS.has(cs) && !S.ac.some((a) => a.cs === cs)) return cs;
    }
  }
  function spawn(starName) {
    const [type, wake] = rnd(TYPES);
    const s = world.stars[starName];
    const ac = new ATC.Aircraft(world, { callsign: newCallsign(), star: starName, type, wake, alt: entryAlt(s) });
    ac.spawnT = S.simT; ac.disp = null; ac.hist = [];
    S.ac.push(ac);
    say(`東京コントロールからハンドオフ提示: ${ac.cs} ${type} ${s.fixes[0].id} ${Math.round(ac.alt / 100) * 100}ft`, "sys");
    return ac;
  }
  function autoSpawn() {
    let r = Math.random(), entry = "XAC";
    for (const [k, w] of Object.entries(ENTRY_W)) { if ((r -= w) < 0) { entry = k; break; } }
    const p = world.fixes[entry];
    if (S.ac.some((a) => ATC.dist(a, p) < 10)) return false; // 同じ入口の直前の機体がまだ近い
    const cands = usable.filter((s) => s.fixes[0].id === entry);
    if (!cands.length) return false;
    spawn(rnd(cands).name);
    return true;
  }
  const spawnInterval = () => Math.max(70, 150 - S.simT / 30) * (0.7 + Math.random() * 0.6);

  function say(t, kind) {
    S.log.push({ t, kind, at: performance.now() });
    const max = innerWidth <= 600 ? 3 : 6;
    if (S.log.length > max) S.log.splice(0, S.log.length - max);
  }
  function addScore(n, why) { S.score += n; if (why) say(`${n > 0 ? "+" : ""}${n} ${why}`, n < 0 ? "warn" : "score"); }

  // ---- シミュレーション ----
  function simStep(dt) {
    S.simT += dt;
    for (const a of S.ac) a.step(dt);
    for (const a of S.ac) {
      for (const e of a.events.splice(0)) {
        if (e.type === "CHECKIN") {
          say(`◁ ${a.checkInCall(ATIS)}`, "pilot");
          say(`▷ ${a.checkInReply()}`, "atc");
        } else if (e.type === "LANDED") {
          const delay = Math.max(0, (a.t - NOMINAL[a.star]) / 60);
          S.landed++; S.delaySum += delay;
          addScore(RULES.land - Math.round(delay * RULES.delayPerMin), `${a.cs} 着陸 RWY${a.rwy}（遅延 ${delay.toFixed(1)} 分）`);
        } else if (e.type === "GOAROUND") {
          S.goArounds++;
          const why = { NO_TWR: "タワー未移管", HIGH: "高度が高すぎる", OVERSHOOT: "滑走路を通過" }[e.reason] || e.reason;
          say(`◁ ${a.cs}, GOING AROUND（${why}）。復行方式: ${e.text}`, "warn");
          addScore(-RULES.goAround, `${a.cs} 着陸復行`);
        } else if (e.type === "HOLDING") {
          say(`◁ ${a.cs}, ENTERING HOLD OVER ${e.fix}（進入許可がない）`, "pilot");
        }
      }
      if (a.ctl === "OFFER" && !a.late && S.simT - a.spawnT > RULES.acceptSec) {
        a.late = true; addScore(-RULES.lateAccept, `${a.cs} ハンドオフ受け入れの遅れ`);
      }
    }
    S.ac = S.ac.filter((a) => a.state === "AIR");
    if (S.sel && S.sel.state !== "AIR") select(null);
    checkSeparation();
    if (S.auto && S.simT >= S.nextSpawn) S.nextSpawn = S.simT + (autoSpawn() ? spawnInterval() : 20);
  }

  // 間隔: 水平 3NM かつ 垂直 1000ft 未満で違反。同じ滑走路の最終進入では後方乱気流間隔（H→M 5NM、H→H 4NM）
  // 34L/34R に並んで最終進入中の 2 機は、NTZ 監視の下で水平間隔を適用しない（ゲーム上の簡略化）
  function checkSeparation() {
    const now = new Set();
    for (const a of S.ac) a.warn = false;
    for (let i = 0; i < S.ac.length; i++) for (let j = i + 1; j < S.ac.length; j++) {
      const a = S.ac[i], b = S.ac[j];
      if (a.mode === "LOC" && b.mode === "LOC" && a.rwy !== b.rwy) continue;
      const dAlt = Math.abs(a.alt - b.alt), d = ATC.dist(a, b);
      let need = SEP_NM, kind = "間隔違反";
      if (a.mode === "LOC" && b.mode === "LOC" && a.rwy === b.rwy) {
        const [lead, foll] = a.locGeom().along < b.locGeom().along ? [a, b] : [b, a];
        const w = ATC.wakeReq(lead.wake, foll.wake);
        if (w > need) { need = w; kind = `後方乱気流間隔不足（${lead.wake}→${foll.wake} ${w}NM）`; }
        if (d < need + 1 && foll.spd > lead.spd + 5) a.warn = b.warn = true;
      }
      if (d < need && dAlt < SEP_FT - 50) {
        const k = a.cs + "|" + b.cs; now.add(k);
        if (!S.pairs.has(k)) {
          S.violations++;
          addScore(-RULES.violation, `${kind} ${a.cs} / ${b.cs}（${d.toFixed(1)}NM, ${Math.round(dAlt)}ft）`);
          if (S.violations >= RULES.maxViolations) gameOver();
        }
        continue;
      }
      if (dAlt < SEP_FT + 500 && d < 10) { // 60 秒先を直線外挿
        const v = (o) => ({ x: o.x + (o.spd / 60) * Math.sin(o.hdg * Math.PI / 180), y: o.y + (o.spd / 60) * Math.cos(o.hdg * Math.PI / 180) });
        const altA = a.alt + Math.sign(a.tAlt - a.alt) * Math.min(Math.abs(a.tAlt - a.alt), 1800);
        const altB = b.alt + Math.sign(b.tAlt - b.alt) * Math.min(Math.abs(b.tAlt - b.alt), 1800);
        if (ATC.dist(v(a), v(b)) < need && Math.abs(altA - altB) < SEP_FT) a.warn = b.warn = true;
      }
    }
    const inPair = new Set([...now].flatMap((k) => k.split("|")));
    for (const a of S.ac) a.alert = inPair.has(a.cs);
    S.pairs = now;
  }

  function gameOver() {
    S.over = true; S.paused = true;
    $("overTitle").textContent = "間隔違反 3 回";
    $("overBody").textContent = `SCORE ${S.score}\n着陸 ${S.landed} 機 / 平均遅延 ${(S.landed ? S.delaySum / S.landed : 0).toFixed(1)} 分\n着陸復行 ${S.goArounds} 回\n管制時間 ${fmtTime(S.simT)}`;
    $("over").hidden = false;
  }

  // ---- 描画 ----
  function pen(color, blur = 0) { ctx.strokeStyle = ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = blur ? T.glow : 0; }
  const COAST = (window.COAST || []).map((l) => l.map(([la, lo]) => ATC.toXY(la, lo)));
  const KEY_FIX = new Set(["XAC", "AKSEL", "AROSA", "GODIN", "POLIX", "ARLON", "CREAM", "WEDGE", "EPSON", "KAIHO", "CACAO"]);

  function drawMap() {
    ctx.lineWidth = 1;
    pen(T.coast);
    for (const l of COAST) { ctx.beginPath(); l.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y)))); ctx.stroke(); }
    pen(T.ring);
    for (let r = 10; r <= 80; r += 10) { ctx.beginPath(); ctx.arc(sx(0), sy(0), r * S.view.scale, 0, Math.PI * 2); ctx.stroke(); }
    ctx.font = `12px ${T.font}`; pen(T.ringText);
    for (let r = 20; r <= 80; r += 20) ctx.fillText(`${r}`, sx(0) + 3, sy(r) - 3);
    ctx.setLineDash([4, 6]); pen(T.star);
    const drawn = new Set();
    for (const s of usable) for (let i = 0; i < s.fixes.length - 1; i++) {
      const a = s.fixes[i], b = s.fixes[i + 1], k = a.id + b.id;
      if (drawn.has(k)) continue; drawn.add(k);
      ctx.beginPath(); ctx.moveTo(sx(a.x), sy(a.y)); ctx.lineTo(sx(b.x), sy(b.y)); ctx.stroke();
    }
    ctx.setLineDash([]);
    // 滑走路延長線（5NM ごとの目盛り）と NTZ（IMC の同時平行 ILS 時）
    for (const rw of ["34L", "34R"]) {
      const r = world.runways[rw], back = (r.trueHdg + 180) * Math.PI / 180;
      pen(T.cl); ctx.beginPath(); ctx.moveTo(sx(r.x), sy(r.y)); ctx.lineTo(sx(r.x + 18 * Math.sin(back)), sy(r.y + 18 * Math.cos(back))); ctx.stroke();
      for (let d = 5; d <= 15; d += 5) { ctx.beginPath(); ctx.arc(sx(r.x + d * Math.sin(back)), sy(r.y + d * Math.cos(back)), 1.8, 0, 7); ctx.fill(); }
    }
    if (world.cfg.ntz) {
      const L = world.runways["34L"], R = world.runways["34R"], back = (L.trueHdg + 180) * Math.PI / 180;
      const mid = (d) => ({ x: (L.x + R.x) / 2 + d * Math.sin(back), y: (L.y + R.y) / 2 + d * Math.cos(back) });
      const off = 0.165, px = Math.cos(back) * off, py = -Math.sin(back) * off; // NTZ 幅 2000ft
      const a = mid(1.5), b = mid(15);
      ctx.fillStyle = T.ntz;
      ctx.beginPath(); ctx.moveTo(sx(a.x + px), sy(a.y + py)); ctx.lineTo(sx(b.x + px), sy(b.y + py)); ctx.lineTo(sx(b.x - px), sy(b.y - py)); ctx.lineTo(sx(a.x - px), sy(a.y - py)); ctx.closePath(); ctx.fill();
      ctx.font = `11px ${T.font}`; ctx.fillText("NTZ", sx(b.x) + 6, sy(b.y));
    }
    pen(T.rwy, 1); ctx.lineWidth = 3;
    for (const [a, b] of [["34L", "16R"], ["34R", "16L"], ["04", "22"], ["05", "23"]]) {
      const p = world.runways[a], q = world.runways[b];
      ctx.beginPath(); ctx.moveTo(sx(p.x), sy(p.y)); ctx.lineTo(sx(q.x), sy(q.y)); ctx.stroke();
    }
    ctx.lineWidth = 1; ctx.font = `12px ${T.font}`;
    for (const f of MAP_FIXES) {
      const X = sx(f.x), Y = sy(f.y), tt = /^TT\d/.test(f.id);
      pen(tt ? T.tt : T.fix);
      if (tt) { ctx.fillRect(X - 1, Y - 1, 2, 2); continue; }
      ctx.beginPath(); ctx.moveTo(X, Y - 4); ctx.lineTo(X + 4, Y + 3); ctx.lineTo(X - 4, Y + 3); ctx.closePath(); ctx.stroke();
      if (S.showFix && (S.view.scale >= 14 || KEY_FIX.has(f.id) || (S.sel && S.sel.hold && S.sel.hold.fix.id === f.id))) { pen(T.fixText); ctx.fillText(f.id, X + 6, Y + 4); }
    }
  }

  function updateBlips(prevA, a) {
    const norm = (v) => ((v % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const p = norm(prevA), q = norm(a);
    for (const ac of S.ac) {
      const az = norm(Math.atan2(ac.x, ac.y));
      const crossed = p <= q ? az > p && az <= q : az > p || az <= q;
      if (crossed || !ac.disp) {
        if (ac.disp) { ac.hist.unshift({ x: ac.disp.x, y: ac.disp.y }); if (ac.hist.length > 6) ac.hist.pop(); }
        ac.disp = { x: ac.x, y: ac.y, hdg: ac.hdg, alt: ac.alt, spd: ac.spd };
      }
    }
  }

  // データブロック: 1 行目 便名（大型機は H）、2 行目 高度↓指示高度、3 行目 対地速度（10kt 単位）・速度指示・横方向の状態
  function lateralText(ac) {
    if (ac.mode === "HDG") return "H" + String(ATC.mag(ac.tHdg)).padStart(3, "0");
    if (ac.mode === "HOLD") return "HLD " + ac.hold.fix.id;
    if (ac.mode === "MISSED") return "MISSED";
    if (ac.mode === "LOC") return ATC.APPROACHES[ac.app].short;
    const nxt = ac.route[ac.leg];
    return (ac.cleared ? ATC.APPROACHES[ac.app].short + " " : "") + (nxt ? nxt.id : "");
  }
  function drawAircraft(now) {
    const blinkOn = Math.floor(now / 450) % 2 === 0;
    const fs = T.fs, lh = fs + 2;
    ctx.font = `${fs}px ${T.font}`;
    for (const ac of S.ac) {
      const d = ac.disp; if (!d) continue;
      const X = sx(d.x), Y = sy(d.y), sel = ac === S.sel;
      const col = ac.alert ? T.alert : ac.warn ? T.warn : ac.ctl === "OFFER" || ac.ctl === "WAIT" ? T.offer : ac.ctl === "TWR" ? T.dim : T.own;
      ac.hist.forEach((h, i) => { ctx.fillStyle = `rgba(${T.hist.join(",")},${0.45 - i * 0.065})`; ctx.fillRect(sx(h.x) - 1.5, sy(h.y) - 1.5, 3, 3); });
      pen(col, 1); ctx.lineWidth = 1.2;
      ctx.strokeRect(X - 4, Y - 4, 8, 8);
      if (sel) { ctx.lineWidth = 1; ctx.strokeRect(X - 8, Y - 8, 16, 16); }
      const v = (d.spd / 60) * S.view.scale, hr = d.hdg * Math.PI / 180;
      ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X + v * Math.sin(hr), Y - v * Math.cos(hr)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X + 5, Y - 5); ctx.lineTo(X + 14, Y - 14); ctx.stroke();
      const alt = Math.round(d.alt / 100), talt = Math.round(ac.tAlt / 100);
      const arrow = talt < alt - 1 ? "↓" : talt > alt + 1 ? "↑" : "";
      const l1 = ac.cs + (ac.wake === "H" ? " H" : "") + (ac.ctl === "TWR" ? " TWR" : ac.ctl === "WAIT" ? " …" : "");
      const l2 = `${String(alt).padStart(3, "0")}${arrow ? arrow + String(talt).padStart(3, "0") : ""}`;
      const spdTxt = String(Math.round(d.spd / 10)).padStart(2, "0") + (ac.spdAssigned ? " S" + ac.spdAssigned / 10 : "");
      const latTxt = lateralText(ac);
      const tx = X + 16, y1 = Y - 16 - lh, y2 = Y - 16, y3 = Y - 16 + lh;
      ctx.shadowBlur = 0;
      if (!(ac.ctl === "OFFER" && !blinkOn)) ctx.fillText(l1, tx, y1); // ハンドオフ提示中は便名が点滅
      ctx.fillText(l2, tx, y2);
      ctx.fillText(spdTxt, tx, y3);
      const spdW = ctx.measureText(spdTxt + " ").width;
      ctx.fillText(latTxt, tx + spdW, y3);
      const box = (x, y, w) => [x - 4, y - fs - 2, w + 8, lh + 4]; // タップ判定用（余白込み）
      ac.hit = { cs: box(tx, y1, Math.max(ctx.measureText(l1).width, 50)), alt: box(tx, y2, Math.max(ctx.measureText(l2).width, 40)),
                 spd: box(tx, y3, spdW - 4), lat: box(tx + spdW, y3, Math.max(ctx.measureText(latTxt).width, 30)) };
      if (sel && ac.mode === "LNAV") {
        pen(T.own); ctx.globalAlpha = 0.5; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(X, Y);
        for (let i = ac.leg; i < ac.route.length; i++) ctx.lineTo(sx(ac.route[i].x), sy(ac.route[i].y));
        ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
    }
  }

  const fmtTime = (t) => [Math.floor(t / 3600), Math.floor(t / 60) % 60, Math.floor(t) % 60].map((n) => String(n).padStart(2, "0")).join(":");
  function drawHud() {
    $("clock").textContent = `${fmtTime(S.simT)}  x${S.ts}${S.paused && !S.over ? "  PAUSE" : ""}  ATIS ${ATIS}`;
    $("stat").textContent = `SCORE ${S.score}  着陸 ${S.landed}  違反 ${S.violations}/${RULES.maxViolations}  復行 ${S.goArounds}`;
    const now = performance.now(), logEl = $("log");
    logEl.textContent = "";
    for (const l of S.log) {
      const age = (now - l.at) / 1000; if (age > 15) continue;
      const div = document.createElement("div"); div.textContent = l.t; div.className = l.kind || "";
      div.style.opacity = String(Math.max(0.3, 1 - age / 15)); logEl.appendChild(div);
    }
    renderSeq(); renderChips(); renderPanel();
  }

  // 到着順の一覧（滑走路までの残り距離順）
  let seqKey = "";
  function renderSeq() {
    const list = [...S.ac].sort((a, b) => a.distToGo() - b.distToGo());
    const rows = list.map((a) => [a, `${a.cs.padEnd(7)}${a.wake} ${a.rwy} ${String(Math.round(a.distToGo())).padStart(3)}NM ${String(Math.round(a.alt / 100)).padStart(3, "0")}`]);
    const key = rows.map((r) => r[1] + r[0].ctl + (r[0] === S.sel) + r[0].warn).join("|");
    if (key === seqKey) return; seqKey = key;
    const body = $("seqBody"); body.textContent = "";
    for (const [a, txt] of rows) {
      const b = document.createElement("button");
      b.textContent = txt;
      b.className = [a.ctl === "OFFER" || a.ctl === "WAIT" ? "offer" : "", a.ctl === "TWR" ? "twr" : "", a === S.sel ? "on" : "", a.warn ? "warn" : ""].join(" ");
      b.onclick = () => (a.ctl === "OFFER" ? issueFor(a, "ACC") : select(a));
      body.appendChild(b);
    }
    $("seq").hidden = !rows.length;
  }
  let chipsKey = "";
  function renderChips() {
    const list = [...S.ac].sort((a, b) => (a.ctl === "OFFER" ? 0 : 1) - (b.ctl === "OFFER" ? 0 : 1));
    const key = list.map((a) => a.cs + a.ctl).join(",") + "|" + (S.sel ? S.sel.cs : "");
    if (key === chipsKey) return; chipsKey = key;
    const el = $("chips"); el.textContent = "";
    for (const a of list) {
      const b = document.createElement("button");
      b.textContent = a.ctl === "OFFER" ? `▶${a.cs} HO` : a.cs;
      b.className = (a.ctl === "OFFER" || a.ctl === "WAIT" ? "offer " : "") + (a.ctl === "TWR" ? "twr " : "") + (a === S.sel ? "on" : "");
      b.onclick = () => (a.ctl === "OFFER" ? issueFor(a, "ACC") : select(a));
      el.appendChild(b);
    }
    el.hidden = !list.length;
  }

  // ---- 選択中の機体: 下部の操作行 ----
  const panel = $("panel");
  let panelKey = "";
  function select(ac) {
    S.sel = ac; closePop();
    panel.hidden = !ac; $("fixmenu").hidden = true;
    panelKey = ""; chipsKey = ""; seqKey = "";
    if (ac) { $("cmd").placeholder = `${ac.cs}: L250 A50 S190 / D ARLON / HOLD WEDGE / C 34L`; requestAnimationFrame(() => keepVisible(ac)); }
  }
  function keepVisible(ac) {
    const top = $("tl").getBoundingClientRect().bottom + 50;
    const bottom = $("bottom").getBoundingClientRect().top - 30;
    const Y = sy(ac.y), X = sx(ac.x);
    if (Y > bottom) S.view.cy -= (Y - bottom + 20) / S.view.scale;
    else if (Y < top) S.view.cy += (top - Y + 20) / S.view.scale;
    if (X < 24) S.view.cx -= (24 - X + 20) / S.view.scale;
    else if (X > W - 150) S.view.cx += (X - (W - 150) + 20) / S.view.scale;
  }
  function issue(line) { return issueFor(null, line); }
  function issueFor(ac, line) {
    const r = ATC.runCommand(line, S.ac, ac || S.sel);
    if (r.ac && r.ac !== S.sel) select(r.ac);
    const shown = r.msgs.filter(Boolean);
    if (/(^|\s)ACC$/i.test(line.trim()) && r.ok && r.ac) say(`${r.ac.cs} ハンドオフ受け入れ。初回通信を待つ`, "sys");
    else if (shown.length) say(r.ac ? `▷ ${r.ac.cs}, ${shown.join(", ")}` : shown.join(", "), r.ok ? "atc" : "warn");
    panelKey = ""; seqKey = "";
    return r;
  }
  const STATUS = (ac) => ac.ctl === "OFFER" ? "ハンドオフ提示中" : ac.ctl === "WAIT" ? "初回通信待ち" : ac.ctl === "TWR" ? "タワー移管済み"
    : ac.mode === "HOLD" ? `待機 ${ac.hold.fix.id}` : ac.mode === "MISSED" ? "着陸復行" : ac.mode === "LOC" ? `最終進入 ${ATC.APPROACHES[ac.app].short}`
    : ac.cleared ? `進入許可 ${ATC.APPROACHES[ac.app].short}` : ac.mode === "HDG" ? "レーダー誘導" : "STAR 飛行中";
  function renderPanel() {
    const ac = S.sel; if (!ac) return;
    $("pHead").textContent = `${ac.cs} ${ac.type}/${ac.wake} ${ac.star}  ${STATUS(ac)}`;
    const key = [ac.cs, ac.ctl, ac.mode, ac.rwy, ac.cleared].join("|");
    if (key === panelKey) return; panelKey = key;
    const own = ac.ctl === "OWN";
    $("bAcc").hidden = ac.ctl !== "OFFER";
    $("bTwr").hidden = !(own && ac.mode === "LOC");
    for (const id of ["bAlt", "bSpd", "bHdg", "b34L", "b34R", "bStar"]) $(id).disabled = !own;
    $("b34L").classList.toggle("on", ac.cleared && ac.rwy === "34L");
    $("b34R").classList.toggle("on", ac.cleared && ac.rwy === "34R");
    $("bStar").classList.toggle("on", ac.mode === "LNAV" && !ac.cleared);
  }
  $("bAcc").onclick = () => issue("ACC");
  $("bTwr").onclick = () => issue("TWR");
  $("b34L").onclick = () => issue("C 34L");
  $("b34R").onclick = () => issue("C 34R");
  $("bStar").onclick = () => issue("STAR");
  $("bClose").onclick = () => select(null);
  $("bAlt").onclick = (e) => openPop("alt", S.sel, e.currentTarget.getBoundingClientRect());
  $("bSpd").onclick = (e) => openPop("spd", S.sel, e.currentTarget.getBoundingClientRect());
  $("bHdg").onclick = (e) => openPop("hdg", S.sel, e.currentTarget.getBoundingClientRect());

  // ---- データブロックから開く選択肢（高度・速度・方位） ----
  const pop = $("pop");
  const dialWrap = $("dialWrap"), dial = $("dial"), dctx = dial.getContext("2d");
  let popAc = null, popKind = null, dialDir = 0, dialVal = null;
  function closePop() { pop.hidden = true; popAc = null; popKind = null; }
  function openPop(kind, ac, anchor) {
    if (!ac) return;
    if (ac.ctl !== "OWN") { say(ac.ctl === "OFFER" ? `${ac.cs}: 先にハンドオフを受け入れる（便名をタップ）` : ac.ctl === "WAIT" ? `${ac.cs}: まだ周波数に来ていない` : `${ac.cs}: タワーへ移管済み`, "warn"); return; }
    popAc = ac; popKind = kind;
    const grid = $("popGrid"); grid.textContent = ""; grid.className = "pg " + kind;
    $("popHead").textContent = `${ac.cs}  ${{ alt: "高度（百ft）", spd: "速度（kt）", hdg: "磁方位（ドラッグして離す）" }[kind]}`;
    const add = (label, cmd, on) => { const b = document.createElement("button"); b.textContent = label; if (on) b.className = "on"; b.onclick = () => { issueFor(ac, cmd); closePop(); }; grid.appendChild(b); };
    if (kind === "alt") for (let a = 150; a >= 20; a -= 10) add(String(a).padStart(3, "0"), `A${a}`, ac.altAssigned === a * 100);
    else if (kind === "spd") { add("標準", "SN", ac.spdAssigned == null); for (let s = 280; s >= 160; s -= 10) add(String(s), `S${s}`, ac.spdAssigned === s); }
    dialWrap.hidden = kind !== "hdg";
    if (kind === "hdg") { dialDir = 0; dialVal = null; document.querySelectorAll("[data-dir]").forEach((b) => b.classList.toggle("on", +b.dataset.dir === 0)); drawDial(); }
    pop.hidden = false;
    // 機体とデータブロックを隠さない位置: 右 → 左 → 上下の順に試す
    const r = pop.getBoundingClientRect(), ax = sx(ac.x), clampY = (y) => Math.min(Math.max(8, y), H - r.height - 8);
    let left, top;
    if (anchor.left + 140 + r.width < W - 8) { left = anchor.left + 140; top = clampY(anchor.top - r.height / 2); }
    else if (ax - 30 - r.width > 8) { left = ax - 30 - r.width; top = clampY(anchor.top - r.height / 2); }
    else { left = Math.min(Math.max(8, anchor.left), W - r.width - 8); top = anchor.top - r.height - 40 > 8 ? anchor.top - r.height - 40 : clampY(anchor.bottom + 30); }
    pop.style.left = left + "px"; pop.style.top = top + "px";
  }
  function drawDial() {
    const ac = popAc; if (!ac) return;
    dial.width = dial.height = 132 * DPR; dctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const c = 66, R = 58;
    dctx.clearRect(0, 0, 132, 132);
    dctx.strokeStyle = dctx.fillStyle = T.dim; dctx.lineWidth = 1;
    dctx.beginPath(); dctx.arc(c, c, R, 0, 7); dctx.stroke();
    dctx.font = `12px ${T.font}`; dctx.textAlign = "center"; dctx.textBaseline = "middle";
    for (let h = 0; h < 360; h += 30) {
      const a = h * Math.PI / 180, r1 = h % 90 ? R - 4 : R - 8;
      dctx.beginPath(); dctx.moveTo(c + R * Math.sin(a), c - R * Math.cos(a)); dctx.lineTo(c + r1 * Math.sin(a), c - r1 * Math.cos(a)); dctx.stroke();
      if (h % 90 === 0) dctx.fillText(String(h / 10 || 36).padStart(2, "0"), c + (R - 18) * Math.sin(a), c - (R - 18) * Math.cos(a));
    }
    const cur = ac.magHdg, tgt = dialVal ?? ATC.mag(ac.tHdg);
    const needle = (h, col, w, len) => { const a = h * Math.PI / 180; dctx.strokeStyle = col; dctx.lineWidth = w; dctx.beginPath(); dctx.moveTo(c, c); dctx.lineTo(c + len * Math.sin(a), c - len * Math.cos(a)); dctx.stroke(); };
    needle(cur, T.dim, 1, R - 2);
    needle(tgt, dialVal != null ? T.offer : T.own, 2, R);
    dctx.fillStyle = dialVal != null ? T.offer : T.own; dctx.font = `18px ${T.font}`;
    dctx.fillText(String(tgt).padStart(3, "0"), c, c + 22);
  }
  function dialAngle(e) {
    const r = dial.getBoundingClientRect();
    const a = Math.atan2(e.clientX - r.left - r.width / 2, -(e.clientY - r.top - r.height / 2)) * 180 / Math.PI;
    return (Math.round(((a + 360) % 360) / 5) * 5) % 360 || 360;
  }
  dial.addEventListener("pointerdown", (e) => { if (!popAc) return; dial.setPointerCapture(e.pointerId); dialVal = dialAngle(e); drawDial(); });
  dial.addEventListener("pointermove", (e) => { if (dialVal != null) { dialVal = dialAngle(e); drawDial(); } });
  dial.addEventListener("pointerup", () => {
    if (dialVal == null || !popAc) return;
    issueFor(popAc, `${dialDir < 0 ? "L" : dialDir > 0 ? "R" : "H"}${String(dialVal).padStart(3, "0")}`);
    dialVal = null; closePop();
  });
  document.querySelectorAll("[data-dir]").forEach((b) => (b.onclick = () => {
    dialDir = +b.dataset.dir; document.querySelectorAll("[data-dir]").forEach((x) => x.classList.toggle("on", x === b));
  }));

  // ---- ループ ----
  let last = performance.now(), acc = 0;
  function frame(now) {
    const rdt = Math.min(0.1, (now - last) / 1000); last = now;
    ctx.shadowBlur = 0; ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
    if (world) {
      const prevA = (S.sweep / SWEEP_SEC) * Math.PI * 2;
      if (!S.paused) {
        acc += rdt * S.ts;
        while (acc >= 0.25) { simStep(0.25); acc -= 0.25; }
        S.sweep = (S.sweep + rdt * S.ts) % SWEEP_SEC;
      }
      drawMap();
      updateBlips(prevA, (S.sweep / SWEEP_SEC) * Math.PI * 2);
      drawAircraft(now);
      drawHud();
      if (popAc && popKind === "hdg") drawDial();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- 入力: パン・ズーム・選択・データブロック・経路点メニュー ----
  const ptrs = new Map(); let pinch0 = null, moved = false;
  cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY }); moved = false; });
  cv.addEventListener("pointermove", (e) => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    if (ptrs.size === 1) {
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 10) moved = true; // 指のわずかなズレはタップ扱い
      if (moved) { S.view.cx -= dx / S.view.scale; S.view.cy += dy / S.view.scale; S.userMoved = true; }
    }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: p.x0, y0: p.y0 });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch0) S.view.scale = Math.max(2, Math.min(80, S.view.scale * d / pinch0));
      pinch0 = d; moved = true; S.userMoved = true;
    }
  });
  const up = (e) => { if (ptrs.size === 1 && !moved) tap(e.clientX, e.clientY); ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = null; };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const bx = wx(e.clientX), by = wy(e.clientY);
    S.view.scale = Math.max(2, Math.min(80, S.view.scale * Math.exp(-e.deltaY * 0.0015)));
    S.view.cx += bx - wx(e.clientX); S.view.cy += by - wy(e.clientY); S.userMoved = true;
  }, { passive: false });

  const inBox = (b, x, y) => b && x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];
  const boxRect = (b) => ({ left: b[0], top: b[1], bottom: b[1] + b[3] });
  function tap(px, py) {
    $("fixmenu").hidden = true; closePop();
    // 1) データブロックの項目（便名: 選択・ハンドオフ受け入れ / 高度 / 速度 / 横方向）
    for (const a of S.ac) {
      const h = a.hit; if (!h) continue;
      if (inBox(h.cs, px, py)) { if (a.ctl === "OFFER") issueFor(a, "ACC"); else select(a); return; }
      if (inBox(h.alt, px, py)) { select(a); return openPop("alt", a, boxRect(h.alt)); }
      if (inBox(h.spd, px, py)) { select(a); return openPop("spd", a, boxRect(h.spd)); }
      if (inBox(h.lat, px, py)) { select(a); return openPop("hdg", a, boxRect(h.lat)); }
    }
    // 2) 機体記号
    let best = null, bd = 30;
    for (const a of S.ac) { if (!a.disp) continue; const d = Math.hypot(sx(a.disp.x) - px, sy(a.disp.y) - py); if (d < bd) { bd = d; best = a; } }
    if (best) return select(best);
    // 3) 経路点（機体を選択中のみ）: 直行・待機
    if (!S.sel) return;
    let fx = null; bd = 22;
    for (const f of MAP_FIXES) { const d = Math.hypot(sx(f.x) - px, sy(f.y) - py); if (d < bd) { bd = d; fx = f; } }
    if (!fx) return;
    const m = $("fixmenu");
    m.querySelector("[data-act=dct]").textContent = `DCT ${fx.id}`;
    m.querySelector("[data-act=hold]").textContent = `HOLD ${fx.id}`;
    m.dataset.fix = fx.id;
    m.style.left = Math.min(px + 8, W - 200) + "px"; m.style.top = Math.max(py - 50, 60) + "px";
    m.hidden = false;
  }
  $("fixmenu").onclick = (e) => {
    const b = e.target.closest("button"), m = $("fixmenu"); if (!b) return;
    if (b.dataset.act === "dct") issue(`D ${m.dataset.fix}`);
    if (b.dataset.act === "hold") issue(`HOLD ${m.dataset.fix}`);
    m.hidden = true;
  };

  // ---- ボタン・コマンド ----
  $("spawn").onclick = () => world && spawn($("star").value);
  $("auto").onclick = (e) => { S.auto = !S.auto; e.currentTarget.classList.toggle("on", S.auto); };
  $("pause").onclick = () => { if (!S.over && S.started) S.paused = !S.paused; };
  $("lbl").onclick = (e) => { S.showFix = !S.showFix; e.currentTarget.classList.toggle("on", S.showFix); };
  $("dev").onclick = (e) => { const p = $("devpanel"); p.hidden = !p.hidden; e.currentTarget.classList.toggle("on", !p.hidden); };
  $("theme").onclick = () => { theme = theme === "modern" ? "retro" : "modern"; applyTheme(); seqKey = chipsKey = ""; };
  $("help").onclick = () => { $("helpbox").hidden = false; if (S.started) { S.paused = true; $("startVMC").textContent = $("startIMC").textContent = "続ける"; } };
  $("startVMC").onclick = () => (S.started ? resume() : startGame("VMC"));
  $("startIMC").onclick = () => (S.started ? resume() : startGame("IMC"));
  function resume() { $("helpbox").hidden = true; if (!S.over) S.paused = false; }
  $("restart").onclick = () => location.reload();
  document.querySelectorAll("[data-ts]").forEach((b) => (b.onclick = () => {
    S.ts = +b.dataset.ts; document.querySelectorAll("[data-ts]").forEach((x) => x.classList.toggle("on", x === b));
  }));
  $("cmd").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { issue(e.target.value); e.target.value = ""; }
    else if (e.key === "Escape") { e.target.value = ""; e.target.blur(); }
  });
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === " ") { if (!S.over && S.started) S.paused = !S.paused; e.preventDefault(); }
    else if (e.key === "Enter" || e.key === "/") { $("cmd").focus(); e.preventDefault(); }
    else if (e.key === "Escape") { closePop(); select(null); }
  });
  document.addEventListener("pointerdown", (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest("#panel") && e.target !== cv) closePop(); });

  window.__ATC_STATE = S; // デバッグ・テスト用
  window.__ATC_START = startGame;
})();
