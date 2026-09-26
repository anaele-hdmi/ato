// 描画・ループ・入力
(function () {
  const ATC = window.ATC;
  const world = ATC.buildWorld(window.RJTT);
  const cv = document.getElementById("scope");
  const ctx = cv.getContext("2d");
  const $ = (id) => document.getElementById(id);

  const C = { coast: "rgba(51,255,102,0.28)", ph: "#33ff66", dim: "rgba(51,255,102,0.45)", faint: "rgba(51,255,102,0.18)", amber: "#ffcc33" };
  const SWEEP_SEC = 4; // 空港監視レーダーの 1 回転（目標の表示位置はこの周期で更新）

  const S = {
    ac: [], sel: null, ts: 1, paused: false, simT: 0, landed: 0, auto: false, nextSpawn: 0,
    showFix: true, sweep: 0,
    view: { cx: 8, cy: -12, scale: 8 }, // 中心（NM）と px/NM
    log: [],
  };

  // ---- 画面サイズ ----
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * DPR; cv.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    S.view.scale = Math.max(3, Math.min(W, H) / 95);
  }
  addEventListener("resize", resize);
  resize();

  const sx = (x) => W / 2 + (x - S.view.cx) * S.view.scale;
  const sy = (y) => H / 2 - (y - S.view.cy) * S.view.scale;
  const wx = (px) => S.view.cx + (px - W / 2) / S.view.scale;
  const wy = (py) => S.view.cy - (py - H / 2) / S.view.scale;

  // ---- STAR 選択肢 ----
  const starSel = $("star");
  const usable = Object.values(world.stars).filter((s) => s.rwy);
  for (const s of usable) {
    const o = document.createElement("option");
    o.value = s.name; o.textContent = `${s.name} → ${s.rwy}`;
    starSel.appendChild(o);
  }
  starSel.value = "AKSEL1A";

  // ---- 交通生成（設計書 §7 の比率。推定値） ----
  const ENTRY_W = { XAC: 0.35, AKSEL: 0.25, AROSA: 0.10, GODIN: 0.15, POLIX: 0.15 };
  const AIRLINES = ["JAL", "ANA", "SKY", "ADO", "SNJ", "SFJ", "APJ", "KAL", "AAR", "CPA", "CAL", "EVA", "UAL", "DAL", "QFA"];
  const TYPES = [["B738", "M"], ["A320", "M"], ["B763", "H"], ["B772", "H"], ["B789", "H"], ["A359", "H"], ["A321", "M"]];
  const rnd = (a) => a[Math.floor(Math.random() * a.length)];
  function newCallsign() {
    for (;;) {
      const cs = rnd(AIRLINES) + (Math.floor(Math.random() * 990) + 10);
      if (!S.ac.some((a) => a.cs === cs)) return cs;
    }
  }
  function spawn(starName) {
    const [type, wake] = rnd(TYPES);
    const s = world.stars[starName];
    const entry = s.fixes[0];
    const alt = entry.alt ? entry.alt.ft : { XAC: 13000, AROSA: 13000, GODIN: 14000 }[entry.id] || 13000;
    const ac = new ATC.Aircraft(world, { callsign: newCallsign(), star: starName, type, wake, alt, autoApproach: true });
    ac.disp = { x: ac.x, y: ac.y }; ac.hist = [];
    S.ac.push(ac);
    say(`${ac.cs} ${type}/${wake} ${starName} 出現`);
    return ac;
  }
  function autoSpawn() {
    let r = Math.random(), entry = "XAC";
    for (const [k, w] of Object.entries(ENTRY_W)) { if ((r -= w) < 0) { entry = k; break; } }
    const cands = usable.filter((s) => s.fixes[0].id === entry && /[AC]$/.test(s.name));
    spawn(rnd(cands).name);
  }

  function say(t, warn) {
    S.log.push({ t, warn, at: performance.now() });
    if (S.log.length > 5) S.log.shift();
  }

  // ---- シミュレーション ----
  function simStep(dt) {
    S.simT += dt;
    for (const a of S.ac) a.step(dt);
    for (const a of S.ac) {
      if (a.state === "LANDED") { S.landed++; say(`${a.cs} 着陸 RWY${a.rwy}`); }
      if (a.state === "GONE") say(`${a.cs} 滑走路を通過（着陸失敗）`, true);
    }
    S.ac = S.ac.filter((a) => a.state === "AIR");
    if (S.sel && S.sel.state !== "AIR") S.sel = null;
    if (S.auto && S.simT >= S.nextSpawn) { autoSpawn(); S.nextSpawn = S.simT + 90 + Math.random() * 90; }
  }

  // ---- 描画 ----
  function glow(color, blur) { ctx.strokeStyle = ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = blur; }

  // 海岸線（ビデオマップ）: Natural Earth 1:10m
  const COAST = (window.COAST || []).map((l) => l.map(([la, lo]) => ATC.toXY(la, lo)));
  function drawCoast() {
    glow(C.coast, 0); ctx.lineWidth = 1;
    for (const l of COAST) {
      ctx.beginPath(); l.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y)))); ctx.stroke();
    }
  }

  const KEY_FIX = new Set(["XAC", "AKSEL", "AROSA", "GODIN", "POLIX", "ARLON", "CREAM", "WEDGE", "EPSON"]);
  function drawMap() {
    // 距離環（ARP 中心、10NM ごと）
    glow(C.faint, 0); ctx.lineWidth = 1;
    for (let r = 10; r <= 80; r += 10) {
      ctx.beginPath(); ctx.arc(sx(0), sy(0), r * S.view.scale, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.font = "14px VT323, monospace";
    for (let r = 20; r <= 80; r += 20) ctx.fillText(`${r}`, sx(0) + 3, sy(r) - 3);

    // STAR（点線）
    ctx.setLineDash([4, 6]); glow(C.dim, 0);
    const drawn = new Set();
    for (const s of usable) {
      for (let i = 0; i < s.fixes.length - 1; i++) {
        const a = s.fixes[i], b = s.fixes[i + 1], k = a.id + b.id;
        if (drawn.has(k)) continue; drawn.add(k);
        ctx.beginPath(); ctx.moveTo(sx(a.x), sy(a.y)); ctx.lineTo(sx(b.x), sy(b.y)); ctx.stroke();
      }
    }
    // 進入経路と延長線（最終進入 15NM）
    ctx.setLineDash([]);
    for (const ap of Object.values(world.approaches)) {
      glow(C.dim, 0); ctx.beginPath();
      ap.legs.forEach((f, i) => (i ? ctx.lineTo(sx(f.x), sy(f.y)) : ctx.moveTo(sx(f.x), sy(f.y))));
      ctx.stroke();
      const r = world.runways[ap.rwy], back = (r.trueHdg + 180) * Math.PI / 180;
      glow(C.faint, 0); ctx.beginPath(); ctx.moveTo(sx(r.x), sy(r.y));
      ctx.lineTo(sx(r.x + 18 * Math.sin(back)), sy(r.y + 18 * Math.cos(back))); ctx.stroke();
      for (let d = 5; d <= 15; d += 5) { // 5NM ごとの目盛り
        const px = r.x + d * Math.sin(back), py = r.y + d * Math.cos(back);
        ctx.beginPath(); ctx.arc(sx(px), sy(py), 2, 0, 7); ctx.fill();
      }
    }
    // 滑走路（着陸端と反対側の端を結ぶ）
    glow(C.ph, 3); ctx.lineWidth = 3;
    for (const [a, b] of [["34L", "16R"], ["34R", "16L"], ["04", "22"], ["05", "23"]]) {
      const p = world.runways[a], q = world.runways[b];
      ctx.beginPath(); ctx.moveTo(sx(p.x), sy(p.y)); ctx.lineTo(sx(q.x), sy(q.y)); ctx.stroke();
    }
    ctx.lineWidth = 1;
    // 経路点（△）
    const used = new Set(usable.flatMap((s) => s.fixes.map((f) => f.id)));
    Object.values(world.approaches).forEach((ap) => ap.legs.forEach((f) => used.add(f.id)));
    for (const id of used) {
      const f = world.fixes[id]; if (!f) continue;
      const X = sx(f.x), Y = sy(f.y), tt = /^TT\d/.test(id);
      glow(tt ? C.faint : C.dim, 0);
      if (tt) { ctx.fillRect(X - 1, Y - 1, 2, 2); continue; }
      ctx.beginPath(); ctx.moveTo(X, Y - 4); ctx.lineTo(X + 4, Y + 3); ctx.lineTo(X - 4, Y + 3); ctx.closePath(); ctx.stroke();
      if (S.showFix && (S.view.scale >= 14 || KEY_FIX.has(id))) ctx.fillText(id, X + 6, Y + 4);
    }
  }

  function sweepAngle() { return (S.sweep / SWEEP_SEC) * Math.PI * 2; }

  function updateBlips(prevA, a) {
    // 掃引が機体の方位を通過したときだけ表示位置を更新（レーダー更新の再現）
    const norm = (v) => ((v % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    for (const ac of S.ac) {
      const az = norm(Math.atan2(ac.x, ac.y));
      const p = norm(prevA), q = norm(a);
      const crossed = p <= q ? az > p && az <= q : az > p || az <= q;
      if (crossed || !ac.disp) {
        if (ac.disp) { ac.hist.unshift({ ...ac.disp }); if (ac.hist.length > 6) ac.hist.pop(); }
        ac.disp = { x: ac.x, y: ac.y, hdg: ac.hdg, alt: ac.alt, tAlt: ac.tAlt, spd: ac.spd };
      }
    }
  }

  function drawAircraft() {
    ctx.font = "17px VT323, monospace";
    for (const ac of S.ac) {
      const d = ac.disp; if (!d) continue;
      const X = sx(d.x), Y = sy(d.y);
      const sel = ac === S.sel;
      const col = ac.warn ? C.amber : C.ph;
      // 航跡（過去位置）
      ac.hist.forEach((h, i) => { glow(`rgba(51,255,102,${0.5 - i * 0.07})`, 0); ctx.fillRect(sx(h.x) - 1.5, sy(h.y) - 1.5, 3, 3); });
      // 機体シンボルと 1 分後予測線
      glow(col, 3);
      ctx.strokeRect(X - 4, Y - 4, 8, 8);
      const v = (d.spd / 60) * S.view.scale, hr = d.hdg * Math.PI / 180;
      ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X + v * Math.sin(hr), Y - v * Math.cos(hr)); ctx.stroke();
      // データブロック
      const alt = Math.round(d.alt / 100), talt = Math.round(ac.tAlt / 100);
      const arrow = talt < alt - 1 ? "↓" : talt > alt + 1 ? "↑" : " ";
      const l1 = ac.cs + (sel ? " ◀" : "");
      const l2 = `${String(alt).padStart(3, "0")}${arrow === " " ? "" : arrow + String(talt).padStart(3, "0")} ${String(Math.round(d.spd / 10)).padStart(2, "0")}`;
      const l3 = sel ? `${ac.type} ${ac.star} ${ac.rwy}${ac.mode === "LOC" ? " LOC" : ""}` : null;
      ctx.shadowBlur = 2;
      ctx.beginPath(); ctx.moveTo(X + 5, Y - 5); ctx.lineTo(X + 16, Y - 16); ctx.stroke();
      ctx.fillText(l1, X + 18, Y - 26); ctx.fillText(l2, X + 18, Y - 12);
      if (l3) ctx.fillText(l3, X + 18, Y + 2);
      // 選択中は残りのルートを表示
      if (sel) {
        glow(C.ph, 4); ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(X, Y);
        for (let i = ac.leg; i < ac.route.length; i++) ctx.lineTo(sx(ac.route[i].x), sy(ac.route[i].y));
        ctx.stroke(); ctx.setLineDash([]);
      }
    }
  }

  function drawHud() {
    const t = S.simT, hh = String(Math.floor(t / 3600)).padStart(2, "0"), mm = String(Math.floor(t / 60) % 60).padStart(2, "0"), ss = String(Math.floor(t) % 60).padStart(2, "0");
    $("clock").textContent = `${hh}:${mm}:${ss}  x${S.ts}${S.paused ? " PAUSE" : ""}`;
    $("stat").textContent = `ARR ${S.ac.length}  LANDED ${S.landed}`;
    $("strips").textContent = S.ac.map((a) =>
      `${a.cs.padEnd(7)}${String(Math.round(a.alt / 100)).padStart(3, "0")} ${String(Math.round(a.spd)).padStart(3)} ${a.star.padEnd(8)}${a.rwy}`).join("\n");
    const now = performance.now();
    const logEl = $("log"); logEl.innerHTML = "";
    for (const l of S.log) {
      const age = (now - l.at) / 1000; if (age > 12) continue;
      const div = document.createElement("div"); div.textContent = l.t; if (l.warn) div.className = "warn";
      div.style.opacity = String(Math.max(0.2, 1 - age / 12)); logEl.appendChild(div);
    }
  }

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
    drawCoast();
    drawMap();
    const a = sweepAngle();
    updateBlips(prevA, a);
    drawAircraft();
    drawHud();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- 入力: パン・ズーム・選択 ----
  const ptrs = new Map(); let pinch0 = null, moved = false;
  cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = false; });
  cv.addEventListener("pointermove", (e) => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    if (ptrs.size === 1) {
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      S.view.cx -= dx / S.view.scale; S.view.cy += dy / S.view.scale;
    }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch0) S.view.scale = Math.max(2, Math.min(80, S.view.scale * d / pinch0));
      pinch0 = d; moved = true;
    }
  });
  const up = (e) => {
    if (ptrs.size === 1 && !moved) pick(e.clientX, e.clientY);
    ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = null;
  };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const bx = wx(e.clientX), by = wy(e.clientY);
    S.view.scale = Math.max(2, Math.min(80, S.view.scale * Math.exp(-e.deltaY * 0.0015)));
    S.view.cx += bx - wx(e.clientX); S.view.cy += by - wy(e.clientY);
  }, { passive: false });

  function pick(px, py) {
    let best = null, bd = 28;
    for (const a of S.ac) {
      if (!a.disp) continue;
      const d = Math.hypot(sx(a.disp.x) - px, sy(a.disp.y) - py);
      if (d < bd) { bd = d; best = a; }
    }
    S.sel = best;
    if (best) $("cmd").placeholder = `${best.cs}: L250 A50 S190 / D ARLON / C 34L / STAR`;
  }

  // ---- ボタン・コマンド ----
  $("spawn").onclick = () => { S.sel = spawn(starSel.value); };
  $("auto").onclick = (e) => { S.auto = !S.auto; e.currentTarget.classList.toggle("on", S.auto); if (S.auto) S.nextSpawn = S.simT; };
  $("dev").onclick = (e) => { const p = $("devpanel"); p.hidden = !p.hidden; e.currentTarget.classList.toggle("on", !p.hidden); };
  $("help").onclick = () => { $("helpbox").hidden = !$("helpbox").hidden; };
  $("helpbox").onclick = () => { $("helpbox").hidden = true; };
  $("pause").onclick = () => { S.paused = !S.paused; };
  $("lbl").onclick = (e) => { S.showFix = !S.showFix; e.currentTarget.classList.toggle("on", S.showFix); };
  document.querySelectorAll("[data-ts]").forEach((b) => (b.onclick = () => {
    S.ts = +b.dataset.ts; document.querySelectorAll("[data-ts]").forEach((x) => x.classList.toggle("on", x === b));
  }));
  $("cmd").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const r = ATC.runCommand(e.target.value, S.ac, S.sel);
      if (r.ac) S.sel = r.ac;
      say(r.ac ? `${r.ac.cs} ${r.msgs.join(", ")}` : r.msgs.join(", "), !r.ok);
      e.target.value = "";
    } else if (e.key === "Escape") { e.target.value = ""; e.target.blur(); }
  });
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === " ") { S.paused = !S.paused; e.preventDefault(); }
    else if (e.key === "Enter" || e.key === "/") { $("cmd").focus(); e.preventDefault(); }
  });

  window.__ATC_STATE = S; // デバッグ・テスト用
})();
