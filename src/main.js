// 描画・ループ・入力・交通・採点
(function () {
  const ATC = window.ATC;
  const world = ATC.buildWorld(window.RJTT);
  const cv = document.getElementById("scope");
  const ctx = cv.getContext("2d");
  const $ = (id) => document.getElementById(id);

  const C = { coast: "rgba(51,255,102,0.28)", ph: "#33ff66", dim: "rgba(51,255,102,0.45)", faint: "rgba(51,255,102,0.18)", amber: "#ffcc33" };
  const SWEEP_SEC = 4; // 空港監視レーダーの 1 回転（目標の表示位置はこの周期で更新）
  const SEP_NM = 3, SEP_FT = 1000;
  const RULES = { land: 100, delayPerMin: 5, lateCheckIn: 20, goAround: 50, violation: 200, maxViolations: 3, checkInSec: 60 };
  const ATIS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(Math.random() * 26)];

  const S = {
    ac: [], sel: null, ts: 1, paused: true, simT: 0, sweep: 0, showFix: true,
    score: 0, landed: 0, goArounds: 0, violations: 0, delaySum: 0, over: false,
    auto: true, nextSpawn: 5, lastEntrySpawn: {},
    view: { cx: 8, cy: -12, scale: 8 }, log: [], pairs: new Set(),
  };

  // ---- 画面サイズ ----
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * DPR; cv.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    S.view.scale = Math.max(3, Math.min(W, H) / 95);
  }
  function fitView() {
    const pts = ["XAC", "AKSEL", "AROSA", "GODIN", "POLIX"].map((id) => world.fixes[id]).concat([{ x: 0, y: 0 }]);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs) - 4, x1 = Math.max(...xs) + 12, y0 = Math.min(...ys) - 3, y1 = Math.max(...ys) + 3;
    const top = $("tl").getBoundingClientRect().bottom + 8;
    const bottom = $("bar").getBoundingClientRect().top - 90; // ログと便名列の分を空けておく
    const h = Math.max(120, bottom - top);
    S.view.scale = Math.max(2, Math.min((W - 32) / (x1 - x0), h / (y1 - y0)));
    S.view.cx = (x0 + x1) / 2;
    S.view.cy = (y0 + y1) / 2 + ((top + bottom) / 2 - H / 2) / S.view.scale;
  }
  addEventListener("resize", () => { resize(); if (!S.userMoved) fitView(); });
  resize();
  const sx = (x) => W / 2 + (x - S.view.cx) * S.view.scale;
  const sy = (y) => H / 2 - (y - S.view.cy) * S.view.scale;
  const wx = (px) => S.view.cx + (px - W / 2) / S.view.scale;
  const wy = (py) => S.view.cy - (py - H / 2) / S.view.scale;

  // ---- STAR ----
  const usable = Object.values(world.stars).filter((s) => s.rwy);
  const starSel = $("star");
  for (const s of usable) {
    const o = document.createElement("option");
    o.value = s.name; o.textContent = `${s.name} → ${s.rwy}`; starSel.appendChild(o);
  }
  starSel.value = "AKSEL1A";

  // 遅延の基準: 各 STAR を管制介入なしで飛んだ場合の所要時間
  const NOMINAL = {};
  for (const s of usable) {
    const a = new ATC.Aircraft(world, { callsign: "NOM", star: s.name, autoApproach: true, alt: entryAlt(s) });
    while (a.state === "AIR" && a.t < 7200) a.step(1);
    NOMINAL[s.name] = a.t;
  }
  function entryAlt(s) { return s.fixes[0].alt ? s.fixes[0].alt.ft : { XAC: 13000, AROSA: 13000, GODIN: 14000 }[s.fixes[0].id] || 13000; }

  // ---- 交通生成（設計書 §7 の比率。推定値） ----
  const ENTRY_W = { XAC: 0.35, AKSEL: 0.25, AROSA: 0.10, GODIN: 0.15, POLIX: 0.15 };
  const AIRLINES = ["JAL", "ANA", "SKY", "ADO", "SNJ", "SFJ", "APJ", "KAL", "AAR", "CPA", "CAL", "EVA", "UAL", "DAL", "QFA"];
  const TYPES = [["B738", "M"], ["A320", "M"], ["B763", "H"], ["B772", "H"], ["B789", "H"], ["A359", "H"], ["A321", "M"]];
  const rnd = (a) => a[Math.floor(Math.random() * a.length)];
  // 羽田に関係する過去の事故便の便名は生成しない
  const EXCLUDED_CS = new Set(["JAL123", "JAL350", "JAL516", "ANA60"]);
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
    S.lastEntrySpawn[s.fixes[0].id] = S.simT;
    say(`◁ ${ac.checkInCall(ATIS)}`, "pilot");
    return ac;
  }
  function autoSpawn() {
    let r = Math.random(), entry = "XAC";
    for (const [k, w] of Object.entries(ENTRY_W)) { if ((r -= w) < 0) { entry = k; break; } }
    // 同じ入口に直前の機体がまだ近くにいる場合は見送る（出現直後の間隔違反を防ぐ）
    const p = world.fixes[entry];
    if (S.ac.some((a) => ATC.dist(a, p) < 10)) return false;
    const cands = usable.filter((s) => s.fixes[0].id === entry && /[AC]$/.test(s.name));
    spawn(rnd(cands).name);
    return true;
  }
  const spawnInterval = () => Math.max(70, 150 - S.simT / 30) * (0.7 + Math.random() * 0.6); // 150 秒から 40 分かけて 70 秒へ

  function say(t, kind) {
    S.log.push({ t, kind, at: performance.now() });
    if (S.log.length > 6) S.log.shift();
    if (innerWidth <= 600 && S.log.length > 3) S.log.splice(0, S.log.length - 3);
  }
  function addScore(n, why) { S.score += n; if (why) say(`${n > 0 ? "+" : ""}${n} ${why}`, n < 0 ? "warn" : "score"); }

  // ---- シミュレーション ----
  function simStep(dt) {
    S.simT += dt;
    for (const a of S.ac) a.step(dt);
    for (const a of S.ac) {
      for (const e of a.events.splice(0)) {
        if (e.type === "LANDED") {
          const delay = Math.max(0, (a.t - NOMINAL[a.star]) / 60);
          S.landed++; S.delaySum += delay;
          addScore(RULES.land - Math.round(delay * RULES.delayPerMin), `${a.cs} 着陸 RWY${a.rwy}（遅延 ${delay.toFixed(1)} 分）`);
        } else if (e.type === "GOAROUND") {
          S.goArounds++;
          const why = { NO_TWR: "タワー未移管", HIGH: "高度が高すぎる", OVERSHOOT: "滑走路を通過" }[e.reason] || e.reason;
          say(`◁ ${a.cs}, GOING AROUND（${why}）。滑走路方位・3000ft で上昇中`, "warn");
          addScore(-RULES.goAround, `${a.cs} 着陸復行`);
        } else if (e.type === "HOLDING") {
          say(`◁ ${a.cs}, ENTERING HOLD OVER ${e.fix}（進入許可がない）`, "pilot");
        }
      }
      if (a.ctl === "OFFER" && !a.late && S.simT - a.spawnT > RULES.checkInSec) {
        a.late = true; addScore(-RULES.lateCheckIn, `${a.cs} 通信設定の遅れ`);
      }
    }
    S.ac = S.ac.filter((a) => a.state === "AIR");
    if (S.sel && S.sel.state !== "AIR") select(null);
    checkSeparation();
    if (S.auto && S.simT >= S.nextSpawn) S.nextSpawn = S.simT + (autoSpawn() ? spawnInterval() : 20);
  }

  // 間隔: 水平 3NM かつ 垂直 1000ft 未満で違反。34L/34R に並んで最終進入中の 2 機は除外（ゲーム上の簡略化）
  function checkSeparation() {
    const now = new Set();
    for (const a of S.ac) a.warn = false;
    for (let i = 0; i < S.ac.length; i++) for (let j = i + 1; j < S.ac.length; j++) {
      const a = S.ac[i], b = S.ac[j];
      if (a.mode === "LOC" && b.mode === "LOC" && a.rwy !== b.rwy) continue;
      const dAlt = Math.abs(a.alt - b.alt);
      const d = ATC.dist(a, b);
      if (d < SEP_NM && dAlt < SEP_FT - 50) {
        const k = a.cs + "|" + b.cs; now.add(k); a.warn = b.warn = true;
        if (!S.pairs.has(k)) {
          S.violations++;
          addScore(-RULES.violation, `間隔違反 ${a.cs} / ${b.cs}（${d.toFixed(1)}NM, ${Math.round(dAlt)}ft）`);
          if (S.violations >= RULES.maxViolations) gameOver();
        }
        continue;
      }
      // 衝突予測（60 秒先を直線外挿）
      if (dAlt < SEP_FT + 500 && d < 10) {
        const v = (o) => ({ x: o.x + (o.spd / 60) * Math.sin(o.hdg * Math.PI / 180), y: o.y + (o.spd / 60) * Math.cos(o.hdg * Math.PI / 180) });
        const pa = v(a), pb = v(b);
        const altA = a.alt + Math.sign(a.tAlt - a.alt) * Math.min(Math.abs(a.tAlt - a.alt), 1800);
        const altB = b.alt + Math.sign(b.tAlt - b.alt) * Math.min(Math.abs(b.tAlt - b.alt), 1800);
        if (ATC.dist(pa, pb) < SEP_NM && Math.abs(altA - altB) < SEP_FT) a.warn = b.warn = true;
      }
    }
    S.pairs = now;
  }

  function gameOver() {
    S.over = true; S.paused = true;
    $("overTitle").textContent = "間隔違反 3 回";
    $("overBody").textContent = `SCORE ${S.score}\n着陸 ${S.landed} 機 / 平均遅延 ${(S.landed ? S.delaySum / S.landed : 0).toFixed(1)} 分\n着陸復行 ${S.goArounds} 回\n管制時間 ${fmtTime(S.simT)}`;
    $("over").hidden = false;
  }

  // ---- 描画 ----
  function glow(color, blur) { ctx.strokeStyle = ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = blur; }
  const COAST = (window.COAST || []).map((l) => l.map(([la, lo]) => ATC.toXY(la, lo)));
  const KEY_FIX = new Set(["XAC", "AKSEL", "AROSA", "GODIN", "POLIX", "ARLON", "CREAM", "WEDGE", "EPSON"]);
  const MAP_FIXES = (() => {
    const used = new Set(usable.flatMap((s) => s.fixes.map((f) => f.id)));
    Object.values(ATC.APP_PATHS).forEach((a) => Object.values(a.from).flat().forEach((id) => used.add(id)));
    return [...used].map((id) => world.fixes[id]).filter(Boolean);
  })();

  function drawMap() {
    glow(C.coast, 0); ctx.lineWidth = 1;
    for (const l of COAST) { ctx.beginPath(); l.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y)))); ctx.stroke(); }
    glow(C.faint, 0);
    for (let r = 10; r <= 80; r += 10) { ctx.beginPath(); ctx.arc(sx(0), sy(0), r * S.view.scale, 0, Math.PI * 2); ctx.stroke(); }
    ctx.font = "14px VT323, monospace";
    for (let r = 20; r <= 80; r += 20) ctx.fillText(`${r}`, sx(0) + 3, sy(r) - 3);
    ctx.setLineDash([4, 6]); glow(C.dim, 0);
    const drawn = new Set();
    for (const s of usable) for (let i = 0; i < s.fixes.length - 1; i++) {
      const a = s.fixes[i], b = s.fixes[i + 1], k = a.id + b.id;
      if (drawn.has(k)) continue; drawn.add(k);
      ctx.beginPath(); ctx.moveTo(sx(a.x), sy(a.y)); ctx.lineTo(sx(b.x), sy(b.y)); ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const ap of Object.values(world.approaches)) {
      const r = world.runways[ap.rwy], back = (r.trueHdg + 180) * Math.PI / 180;
      glow(C.faint, 0); ctx.beginPath(); ctx.moveTo(sx(r.x), sy(r.y));
      ctx.lineTo(sx(r.x + 18 * Math.sin(back)), sy(r.y + 18 * Math.cos(back))); ctx.stroke();
      for (let d = 5; d <= 15; d += 5) { ctx.beginPath(); ctx.arc(sx(r.x + d * Math.sin(back)), sy(r.y + d * Math.cos(back)), 2, 0, 7); ctx.fill(); }
    }
    glow(C.ph, 3); ctx.lineWidth = 3;
    for (const [a, b] of [["34L", "16R"], ["34R", "16L"], ["04", "22"], ["05", "23"]]) {
      const p = world.runways[a], q = world.runways[b];
      ctx.beginPath(); ctx.moveTo(sx(p.x), sy(p.y)); ctx.lineTo(sx(q.x), sy(q.y)); ctx.stroke();
    }
    ctx.lineWidth = 1;
    for (const f of MAP_FIXES) {
      const X = sx(f.x), Y = sy(f.y), tt = /^TT\d/.test(f.id);
      glow(tt ? C.faint : C.dim, 0);
      if (tt) { ctx.fillRect(X - 1, Y - 1, 2, 2); continue; }
      ctx.beginPath(); ctx.moveTo(X, Y - 4); ctx.lineTo(X + 4, Y + 3); ctx.lineTo(X - 4, Y + 3); ctx.closePath(); ctx.stroke();
      if (S.showFix && (S.view.scale >= 14 || KEY_FIX.has(f.id) || (S.sel && S.sel.hold && S.sel.hold.fix.id === f.id))) ctx.fillText(f.id, X + 6, Y + 4);
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

  function drawAircraft(now) {
    ctx.font = "17px VT323, monospace";
    const blinkOn = Math.floor(now / 450) % 2 === 0;
    for (const ac of S.ac) {
      const d = ac.disp; if (!d) continue;
      const X = sx(d.x), Y = sy(d.y), sel = ac === S.sel;
      const col = ac.warn ? C.amber : ac.ctl === "TWR" ? C.dim : C.ph;
      ac.hist.forEach((h, i) => { glow(`rgba(51,255,102,${0.5 - i * 0.07})`, 0); ctx.fillRect(sx(h.x) - 1.5, sy(h.y) - 1.5, 3, 3); });
      glow(col, 3);
      ctx.strokeRect(X - 4, Y - 4, 8, 8);
      if (sel) ctx.strokeRect(X - 8, Y - 8, 16, 16);
      const v = (d.spd / 60) * S.view.scale, hr = d.hdg * Math.PI / 180;
      ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X + v * Math.sin(hr), Y - v * Math.cos(hr)); ctx.stroke();
      if (ac.ctl === "OFFER" && !blinkOn) continue; // 通信設定待ちはデータブロックを点滅
      const alt = Math.round(d.alt / 100), talt = Math.round(ac.tAlt / 100);
      const arrow = talt < alt - 1 ? "↓" : talt > alt + 1 ? "↑" : "";
      const l1 = ac.cs + (ac.ctl === "OFFER" ? " CHK" : ac.ctl === "TWR" ? " TWR" : "");
      const l2 = `${String(alt).padStart(3, "0")}${arrow ? arrow + String(talt).padStart(3, "0") : ""} ${String(Math.round(d.spd / 10)).padStart(2, "0")}`;
      const l3 = sel ? `${ac.type} ${ac.mode === "HOLD" ? "HOLD " + ac.hold.fix.id : ac.mode === "LOC" ? "LOC " + ac.rwy : ac.mode === "HDG" ? "H" + String(ATC.mag(ac.tHdg)).padStart(3, "0") : ac.star}` : null;
      ctx.shadowBlur = 1;
      ctx.beginPath(); ctx.moveTo(X + 5, Y - 5); ctx.lineTo(X + 16, Y - 16); ctx.stroke();
      ctx.fillText(l1, X + 18, Y - 26); ctx.fillText(l2, X + 18, Y - 12);
      if (l3) ctx.fillText(l3, X + 18, Y + 2);
      if (sel && ac.mode === "LNAV") {
        glow(C.ph, 0); ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(X, Y);
        for (let i = ac.leg; i < ac.route.length; i++) ctx.lineTo(sx(ac.route[i].x), sy(ac.route[i].y));
        ctx.stroke(); ctx.setLineDash([]);
      }
    }
  }

  const fmtTime = (t) => [Math.floor(t / 3600), Math.floor(t / 60) % 60, Math.floor(t) % 60].map((n) => String(n).padStart(2, "0")).join(":");
  function drawHud() {
    $("clock").textContent = `${fmtTime(S.simT)}  x${S.ts}${S.paused && !S.over ? "  PAUSE" : ""}  ATIS ${ATIS}`;
    $("stat").textContent = `SCORE ${S.score}  着陸 ${S.landed}  違反 ${S.violations}/${RULES.maxViolations}  復行 ${S.goArounds}`;
    $("strips").textContent = S.ac.map((a) =>
      `${a.ctl === "OFFER" ? "▶" : " "}${a.cs.padEnd(7)}${String(Math.round(a.alt / 100)).padStart(3, "0")} ${String(Math.round(a.spd)).padStart(3)} ${a.star.padEnd(8)}${a.rwy}`).join("\n");
    const now = performance.now(), logEl = $("log");
    logEl.textContent = "";
    for (const l of S.log) {
      const age = (now - l.at) / 1000; if (age > 15) continue;
      const div = document.createElement("div"); div.textContent = l.t; div.className = l.kind || "";
      div.style.opacity = String(Math.max(0.25, 1 - age / 15)); logEl.appendChild(div);
    }
    renderChips();
    renderPanel();
  }

  let chipsKey = "";
  function renderChips() {
    const list = [...S.ac].sort((a, b) => (a.ctl === "OFFER" ? 0 : 1) - (b.ctl === "OFFER" ? 0 : 1));
    const key = list.map((a) => a.cs + a.ctl).join(",") + "|" + (S.sel ? S.sel.cs : "");
    if (key === chipsKey) return; chipsKey = key;
    const el = $("chips"); el.textContent = "";
    for (const a of list) {
      const b = document.createElement("button");
      b.textContent = a.ctl === "OFFER" ? `▶${a.cs} CHK` : a.cs;
      b.className = (a.ctl === "OFFER" ? "offer " : "") + (a.ctl === "TWR" ? "twr " : "") + (a === S.sel ? "on" : "");
      b.onclick = () => select(a);
      el.appendChild(b);
    }
    el.hidden = !list.length;
  }

  // ---- 操作パネル（選択中の機体） ----
  const panel = $("panel");
  const ALTS = [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150];
  const SPDS = [160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 260, 270, 280];
  let dialDir = 0, dialVal = null, panelKey = "";
  (function buildPanel() {
    const altRow = $("altRow"), spdRow = $("spdRow");
    for (const a of ALTS) { const b = document.createElement("button"); b.textContent = String(a).padStart(3, "0"); b.dataset.alt = a; altRow.appendChild(b); }
    const sa = document.createElement("button"); sa.textContent = "標準"; sa.dataset.spd = "auto"; sa.title = "速度指示を解除"; spdRow.appendChild(sa);
    for (const s of SPDS) { const b = document.createElement("button"); b.textContent = s; b.dataset.spd = s; spdRow.appendChild(b); }
  })();
  function select(ac) {
    S.sel = ac; dialVal = null; dialDir = 0;
    panel.hidden = !ac; $("fixmenu").hidden = true;
    panelKey = "";
    if (ac) $("cmd").placeholder = `${ac.cs}: L250 A50 S190 / D ARLON / HOLD WEDGE / C 34L`;
    chipsKey = "";
    if (ac) requestAnimationFrame(() => keepVisible(ac));
  }

  // 選んだ機体が操作パネルや HUD に隠れないよう画面をずらす
  function keepVisible(ac) {
    const top = $("tl").getBoundingClientRect().bottom + 50;
    const bottom = $("bottom").getBoundingClientRect().top - 30;
    const Y = sy(ac.y), X = sx(ac.x);
    if (Y > bottom) S.view.cy -= (Y - bottom + 20) / S.view.scale;
    else if (Y < top) S.view.cy += (top - Y + 20) / S.view.scale;
    if (X < 24) S.view.cx -= (24 - X + 20) / S.view.scale;
    else if (X > W - 150) S.view.cx += (X - (W - 150) + 20) / S.view.scale;
  }
  function issue(line) {
    const r = ATC.runCommand(line, S.ac, S.sel);
    if (r.ac && r.ac !== S.sel) select(r.ac);
    if (r.msgs.length) say(r.ac ? `▷ ${r.ac.cs}, ${r.msgs.join(", ")}` : r.msgs.join(", "), r.ok ? "atc" : "warn");
    panelKey = "";
  }
  function renderPanel() {
    const ac = S.sel; if (!ac) return;
    const key = [ac.cs, ac.ctl, ac.mode, ac.rwy, ac.cleared, ac.altAssigned, ac.spdAssigned, dialDir, dialVal].join("|");
    $("pHead").textContent = `${ac.cs} ${ac.type}/${ac.wake} ${ac.star}  ${String(Math.round(ac.alt / 100)).padStart(3, "0")} ${Math.round(ac.spd)}kt HDG${String(ac.magHdg).padStart(3, "0")}  ${
      ac.ctl === "OFFER" ? "通信設定待ち" : ac.ctl === "TWR" ? "タワー移管済み" : ac.mode === "HOLD" ? `待機 ${ac.hold.fix.id}` : ac.mode === "LOC" ? `LOC ${ac.rwy}` : ac.cleared ? `進入許可 ${ac.rwy}` : ac.mode === "HDG" ? "レーダー誘導" : "STAR 走行"}`;
    drawDial(ac);
    if (key === panelKey) return; panelKey = key;
    $("bAcc").hidden = ac.ctl !== "OFFER";
    $("bTwr").hidden = !(ac.ctl === "OWN" && ac.mode === "LOC");
    for (const id of ["b34L", "b34R", "bStar"]) $(id).disabled = ac.ctl !== "OWN";
    $("b34L").classList.toggle("on", ac.cleared && ac.rwy === "34L");
    $("b34R").classList.toggle("on", ac.cleared && ac.rwy === "34R");
    $("bStar").classList.toggle("on", ac.mode === "LNAV" && !ac.cleared);
    document.querySelectorAll("#altRow button").forEach((b) => b.classList.toggle("on", ac.altAssigned === +b.dataset.alt * 100));
    document.querySelectorAll("#spdRow button").forEach((b) => b.classList.toggle("on", b.dataset.spd === "auto" ? ac.spdAssigned == null : ac.spdAssigned === +b.dataset.spd));
    document.querySelectorAll("[data-dir]").forEach((b) => b.classList.toggle("on", +b.dataset.dir === dialDir));
    panel.classList.toggle("locked", ac.ctl !== "OWN");
  }
  $("altRow").onclick = (e) => { const b = e.target.closest("button"); if (b) issue(`A${b.dataset.alt}`); };
  $("spdRow").onclick = (e) => {
    const b = e.target.closest("button"); if (!b || !S.sel) return;
    if (b.dataset.spd === "auto") { if (S.sel.ctl !== "OWN") return; S.sel.spdAssigned = null; say(`▷ ${S.sel.cs} RESUME NORMAL SPEED`, "atc"); panelKey = ""; }
    else issue(`S${b.dataset.spd}`);
  };
  $("bAcc").onclick = () => issue("ACC");
  $("bTwr").onclick = () => issue("TWR");
  $("b34L").onclick = () => issue("C 34L");
  $("b34R").onclick = () => issue("C 34R");
  $("bStar").onclick = () => issue("STAR");
  $("bClose").onclick = () => select(null);
  document.querySelectorAll("[data-dir]").forEach((b) => (b.onclick = () => { dialDir = +b.dataset.dir; panelKey = ""; }));

  // 方位ダイヤル: ドラッグで方位（5° 刻み）を選び、指を離すと指示
  const dial = $("dial"), dctx = dial.getContext("2d");
  function drawDial(ac) {
    const s = dial.width = dial.height = 112 * DPR; dctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const c = 56, R = 48;
    dctx.clearRect(0, 0, 112, 112);
    dctx.strokeStyle = dctx.fillStyle = C.dim; dctx.lineWidth = 1;
    dctx.beginPath(); dctx.arc(c, c, R, 0, 7); dctx.stroke();
    dctx.font = "13px VT323, monospace"; dctx.textAlign = "center"; dctx.textBaseline = "middle";
    for (let h = 0; h < 360; h += 30) {
      const a = h * Math.PI / 180, r1 = h % 90 ? R - 4 : R - 8;
      dctx.beginPath(); dctx.moveTo(c + R * Math.sin(a), c - R * Math.cos(a)); dctx.lineTo(c + r1 * Math.sin(a), c - r1 * Math.cos(a)); dctx.stroke();
      if (h % 90 === 0) dctx.fillText(String(h / 10 || 36).padStart(2, "0"), c + (R - 16) * Math.sin(a), c - (R - 16) * Math.cos(a));
    }
    const cur = ac.magHdg, tgt = dialVal ?? ATC.mag(ac.tHdg);
    const needle = (h, col, w, len) => { const a = h * Math.PI / 180; dctx.strokeStyle = col; dctx.lineWidth = w; dctx.beginPath(); dctx.moveTo(c, c); dctx.lineTo(c + len * Math.sin(a), c - len * Math.cos(a)); dctx.stroke(); };
    needle(cur, C.dim, 1, R - 2);
    needle(tgt, dialVal != null ? C.amber : C.ph, 2, R);
    dctx.fillStyle = dialVal != null ? C.amber : C.ph; dctx.font = "20px VT323, monospace";
    dctx.fillText(String(tgt).padStart(3, "0"), c, c + 20);
  }
  function dialAngle(e) {
    const r = dial.getBoundingClientRect();
    const a = Math.atan2(e.clientX - r.left - r.width / 2, -(e.clientY - r.top - r.height / 2)) * 180 / Math.PI;
    return (Math.round(((a + 360) % 360) / 5) * 5) % 360 || 360;
  }
  dial.addEventListener("pointerdown", (e) => { if (!S.sel || S.sel.ctl !== "OWN") return; dial.setPointerCapture(e.pointerId); dialVal = dialAngle(e); });
  dial.addEventListener("pointermove", (e) => { if (dialVal != null) dialVal = dialAngle(e); });
  dial.addEventListener("pointerup", () => {
    if (dialVal == null) return;
    issue(`${dialDir < 0 ? "L" : dialDir > 0 ? "R" : "H"}${String(dialVal).padStart(3, "0")}`);
    dialVal = null; dialDir = 0;
  });

  // ---- ループ ----
  let last = performance.now(), acc = 0;
  function frame(now) {
    const rdt = Math.min(0.1, (now - last) / 1000); last = now;
    const prevA = (S.sweep / SWEEP_SEC) * Math.PI * 2;
    if (!S.paused) {
      acc += rdt * S.ts;
      while (acc >= 0.25) { simStep(0.25); acc -= 0.25; }
      S.sweep = (S.sweep + rdt * S.ts) % SWEEP_SEC;
    }
    ctx.shadowBlur = 0; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    drawMap();
    updateBlips(prevA, (S.sweep / SWEEP_SEC) * Math.PI * 2);
    drawAircraft(now);
    drawHud();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  requestAnimationFrame(fitView);

  // ---- 入力: パン・ズーム・選択・経路点メニュー ----
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
  const up = (e) => {
    if (ptrs.size === 1 && !moved) tap(e.clientX, e.clientY);
    ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = null;
  };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const bx = wx(e.clientX), by = wy(e.clientY);
    S.view.scale = Math.max(2, Math.min(80, S.view.scale * Math.exp(-e.deltaY * 0.0015)));
    S.view.cx += bx - wx(e.clientX); S.view.cy += by - wy(e.clientY);
  }, { passive: false });

  function tap(px, py) {
    $("fixmenu").hidden = true;
    // 機体記号の周囲 32px、またはデータブロック（便名・高度の文字）の上なら選択
    let best = null, bd = Infinity;
    for (const a of S.ac) {
      if (!a.disp) continue;
      const X = sx(a.disp.x), Y = sy(a.disp.y);
      const d = Math.hypot(X - px, Y - py);
      const onBlock = px >= X + 12 && px <= X + 130 && py >= Y - 44 && py <= Y + 8;
      const score = d < 32 ? d : onBlock ? 32 + Math.abs(py - (Y - 20)) : Infinity;
      if (score < bd) { bd = score; best = a; }
    }
    if (best) return select(best);
    if (!S.sel) return;
    let fx = null; bd = 22;
    for (const f of MAP_FIXES) { const d = Math.hypot(sx(f.x) - px, sy(f.y) - py); if (d < bd) { bd = d; fx = f; } }
    if (!fx) return;
    const m = $("fixmenu");
    m.querySelector("[data-act=dct]").textContent = `DCT ${fx.id}`;
    m.querySelector("[data-act=hold]").textContent = `HOLD ${fx.id}`;
    m.dataset.fix = fx.id;
    m.style.left = Math.min(px + 8, W - 190) + "px"; m.style.top = Math.max(py - 50, 60) + "px";
    m.hidden = false;
  }
  $("fixmenu").onclick = (e) => {
    const b = e.target.closest("button"), m = $("fixmenu"); if (!b) return;
    if (b.dataset.act === "dct") issue(`D ${m.dataset.fix}`);
    if (b.dataset.act === "hold") issue(`HOLD ${m.dataset.fix}`);
    m.hidden = true;
  };

  // ---- ボタン・コマンド ----
  $("spawn").onclick = () => select(spawn(starSel.value));
  $("auto").onclick = (e) => { S.auto = !S.auto; e.currentTarget.classList.toggle("on", S.auto); };
  $("pause").onclick = () => { if (!S.over) S.paused = !S.paused; };
  $("lbl").onclick = (e) => { S.showFix = !S.showFix; e.currentTarget.classList.toggle("on", S.showFix); };
  $("dev").onclick = (e) => { const p = $("devpanel"); p.hidden = !p.hidden; e.currentTarget.classList.toggle("on", !p.hidden); };
  $("help").onclick = () => { $("helpbox").hidden = false; S.paused = true; };
  $("helpbox").onclick = (e) => { if (e.target.closest("#start")) return; $("helpbox").hidden = true; };
  $("start").onclick = () => { $("helpbox").hidden = true; $("start").textContent = "続ける"; if (!S.over) S.paused = false; };
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
    if (e.key === " ") { if (!S.over) S.paused = !S.paused; e.preventDefault(); }
    else if (e.key === "Enter" || e.key === "/") { $("cmd").focus(); e.preventDefault(); }
    else if (e.key === "Escape") select(null);
  });

  window.__ATC_STATE = S; // デバッグ・テスト用
})();
