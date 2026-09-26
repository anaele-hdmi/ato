// 機体モデル・STAR 追従・ILS。ブラウザ（window.ATC）と node（テスト）の両方で動く。
(function (g) {
  const ATC = (g.ATC = g.ATC || {});
  const D2R = Math.PI / 180;
  const MAG_VAR = 7.9; // 西偏 7.9°: 磁方位 = 真方位 + 7.9
  const FT_PER_NM_3DEG = 318.4; // tan(3°) × 6076ft
  const TURN_RATE = 3; // deg/s
  const DESCENT_FPM = 1800, CLIMB_FPM = 2000, ACCEL = 1; // kt/s

  // ---- 座標系: ARP 基準の平面近似（NM, x=東, y=北） ----
  const ARP = { lat: 35 + 33 / 60 + 12 / 3600, lon: 139 + 46 / 60 + 52 / 3600 };
  const COSLAT = Math.cos(ARP.lat * D2R);
  const toXY = (lat, lon) => ({ x: (lon - ARP.lon) * 60 * COSLAT, y: (lat - ARP.lat) * 60 });
  const norm360 = (a) => ((a % 360) + 360) % 360;
  const angDiff = (a, b) => ((b - a + 540) % 360) - 180; // a→b の最短差（-180..180）
  const brgTo = (a, b) => norm360(Math.atan2(b.x - a.x, b.y - a.y) / D2R);
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

  function parseAlt(c) {
    if (!c) return null;
    const m = /^(=|>=|<=)(\d+)$/.exec(c);
    return m ? { op: m[1], ft: +m[2] } : null;
  }

  // ---- 空港データを平面座標へ ----
  function buildWorld(data) {
    const fixes = {};
    for (const [id, f] of Object.entries(data.fixes)) fixes[id] = { id, ...toXY(f.lat, f.lon), src: f.src };
    const runways = {};
    for (const [id, r] of Object.entries(data.runways))
      runways[id] = { id, ...toXY(r.lat, r.lon), trueHdg: r.trueHdg, elev: r.thrElevFt };
    const approaches = {};
    for (const [rw, a] of Object.entries(data.approaches)) {
      approaches[rw] = { rwy: rw, name: a.name, faf: a.faf, gp: a.gpDeg,
        legs: a.legs.map(([id, c]) => ({ id, ...fixes[id], alt: parseAlt(c) })) };
    }
    const stars = {};
    for (const [name, s] of Object.entries(data.stars)) {
      const last = s.fixes[s.fixes.length - 1];
      // A 系（ARLON 終点）→ 34L、C/H 系（CREAM/CACAO 終点）→ 34R、K 系（KAIHO）は M4 で ILS Y を実装するまで除外
      const rwy = last === "ARLON" ? "34L" : last === "CREAM" || last === "CACAO" ? "34R" : null;
      stars[name] = { name, rwy, fixes: s.fixes.map((id) => ({ id, ...fixes[id], alt: parseAlt(s.altitude[id]) })) };
    }
    return { fixes, runways, approaches, stars, arp: { x: 0, y: 0 } };
  }

  // STAR ＋ 進入経路を 1 本のルートにつなぐ（重複点は後ろの制限を優先）
  function buildRoute(world, starName) {
    const s = world.stars[starName];
    const ap = world.approaches[s.rwy];
    const route = s.fixes.map((f) => ({ ...f }));
    for (const leg of ap.legs) {
      const i = route.findIndex((f) => f.id === leg.id);
      if (i >= 0) route[i] = { ...route[i], alt: leg.alt || route[i].alt };
      else route.push({ ...leg });
    }
    return { route, rwy: s.rwy, faf: ap.faf };
  }

  class Aircraft {
    constructor(world, opts) {
      this.world = world;
      this.cs = opts.callsign;
      this.type = opts.type || "B738";
      this.wake = opts.wake || "M";
      const { route, rwy, faf } = buildRoute(world, opts.star);
      this.star = opts.star;
      this.route = route;
      this.rwy = rwy;
      this.faf = faf;
      this.leg = 1; // route[leg] に向かって飛ぶ
      const p0 = route[0], p1 = route[1];
      this.x = p0.x; this.y = p0.y;
      this.hdg = brgTo(p0, p1);
      this.alt = opts.alt ?? (p0.alt ? p0.alt.ft : 13000);
      this.spd = opts.spd ?? 280;
      this.tHdg = this.hdg; this.tAlt = this.alt; this.tSpd = this.spd;
      this.mode = "LNAV"; // LNAV（経路追従） / HDG（方位指示） / LOC（ローカライザー追従）
      this.cleared = !!opts.autoApproach; // 進入許可（M2 では自動）
      this.altAssigned = null; // 管制指示高度（null = 経路の高度制限に従う）
      this.spdAssigned = null;
      this.gsCaptured = false;
      this.state = "AIR"; // AIR / LANDED / GONE
      this.t = 0;
    }

    get rwyObj() { return this.world.runways[this.rwy]; }
    get magHdg() { return norm360(this.hdg + MAG_VAR); }
    distToThr() { return dist(this, this.rwyObj); }

    // ルート上の残距離（現在位置→route[i]）
    alongTo(i) {
      let d = dist(this, this.route[this.leg]);
      for (let k = this.leg; k < i; k++) d += dist(this.route[k], this.route[k + 1]);
      return d;
    }

    ftPerNm() { return (DESCENT_FPM * 60) / Math.max(this.spd, 120); }

    // 経路の高度制限から現在の目標高度を決める（簡易 VNAV）
    vnavAlt() {
      let desired = Infinity, floor = -Infinity, floorSet = false;
      for (let i = this.leg; i < this.route.length; i++) {
        const c = this.route[i].alt;
        if (!c) continue;
        const d = this.alongTo(i);
        if (c.op === "=" || c.op === "<=") desired = Math.min(desired, c.ft + Math.max(0, d - 3) * this.ftPerNm() * 0.8); // 旋回の先読み分（最大 3NM）早めに降下
        if (!floorSet && (c.op === "=" || c.op === ">=")) { floor = c.ft; floorSet = true; }
      }
      return Math.max(floor, Math.min(this.alt, desired));
    }

    // 最終進入の速度スケジュール（ILS Z 34L/34R: D10 で 180kt, D5 で 160kt）
    scheduleSpd() {
      const d = this.distToThr();
      if (this.mode === "LOC" || d < 20) {
        if (d < 3) return 140;
        if (d < 5) return 160;
        if (d < 10) return 180;
        return 210;
      }
      return this.alt > 10000 ? 280 : 250;
    }

    locGeom() {
      const r = this.rwyObj;
      const crs = r.trueHdg; // 着陸方向
      const dx = this.x - r.x, dy = this.y - r.y;
      const along = -(dx * Math.sin(crs * D2R) + dy * Math.cos(crs * D2R)); // 滑走路手前が正
      const xtk = dx * Math.cos(crs * D2R) - dy * Math.sin(crs * D2R); // 進入方向に対し右が正
      return { crs, along, xtk };
    }

    step(dt) {
      if (this.state !== "AIR") return;
      this.t += dt;
      const r = this.rwyObj;

      // ---- 横方向 ----
      if (this.mode === "LNAV") {
        const nxt = this.route[this.leg];
        this.tHdg = brgTo(this, nxt);
        const after = this.route[this.leg + 1];
        const turnR = this.spd / (60 * Math.PI);
        const lead = after ? Math.min(turnR * Math.tan(Math.abs(angDiff(brgTo(this.route[this.leg - 1] || this, nxt), brgTo(nxt, after))) * D2R / 2), 3) : 0;
        if (dist(this, nxt) < Math.max(0.3, lead)) {
          if (nxt.id === this.faf && this.cleared) this.mode = "LOC";
          else if (after) this.leg++;
          else this.mode = "HDG"; // ルート終端: その方位を維持
        }
      }
      if (this.mode === "HDG" && this.cleared) {
        // 方位指示中に進入許可済み → ローカライザーに会合したら LOC へ
        const g = this.locGeom();
        if (g.along > 0 && Math.abs(g.xtk) < 0.5 && Math.abs(angDiff(this.hdg, g.crs)) < 45) this.mode = "LOC";
      }
      if (this.mode === "LOC") {
        const g = this.locGeom();
        const corr = Math.max(-30, Math.min(30, -g.xtk * 40));
        this.tHdg = norm360(g.crs + corr);
        // グライドパス
        const gpAlt = r.elev + 50 + g.along * FT_PER_NM_3DEG;
        if (!this.gsCaptured && this.alt >= gpAlt - 100) this.gsCaptured = true;
        if (this.gsCaptured) this.tAlt = gpAlt;
        if (g.along < 0.3 && this.alt < r.elev + 200) { this.state = "LANDED"; return; }
        if (g.along < -1) this.state = "GONE"; // 通過してしまった（M3 で着陸復行に置換）
      }

      // ---- 高度・速度の目標 ----
      if (!(this.mode === "LOC" && this.gsCaptured)) {
        if (this.altAssigned != null) this.tAlt = this.altAssigned;
        else if (this.mode === "LNAV") this.tAlt = this.vnavAlt();
      }
      this.tSpd = this.spdAssigned ?? this.scheduleSpd();
      if (this.mode === "LOC") this.tSpd = Math.min(this.tSpd, this.scheduleSpd());

      // ---- 運動 ----
      const dh = angDiff(this.hdg, this.tHdg);
      const turn = this.turnDir ? this.turnDir * Math.min(Math.abs(norm360(this.turnDir > 0 ? this.tHdg - this.hdg : this.hdg - this.tHdg)), TURN_RATE * dt)
                                : Math.sign(dh) * Math.min(Math.abs(dh), TURN_RATE * dt);
      this.hdg = norm360(this.hdg + turn);
      if (this.turnDir && Math.abs(angDiff(this.hdg, this.tHdg)) < 0.5) this.turnDir = 0;

      const da = this.tAlt - this.alt;
      const vmax = (this.mode === "LOC" && this.gsCaptured ? 1500 : da > 0 ? CLIMB_FPM : DESCENT_FPM) / 60 * dt;
      this.alt += Math.sign(da) * Math.min(Math.abs(da), vmax);

      const ds = this.tSpd - this.spd;
      this.spd += Math.sign(ds) * Math.min(Math.abs(ds), ACCEL * dt);

      const d = (this.spd / 3600) * dt;
      this.x += d * Math.sin(this.hdg * D2R);
      this.y += d * Math.cos(this.hdg * D2R);
    }

    // ---- 管制指示（M3 で UI から使う） ----
    cmdHeading(magHdg, dir = 0) { this.mode = this.mode === "LOC" ? "LOC" : "HDG"; this.tHdg = norm360(magHdg - MAG_VAR); this.turnDir = dir; }
    cmdAltitude(ft) { this.altAssigned = ft; }
    cmdSpeed(kt) { this.spdAssigned = kt; }
    cmdDirect(id) {
      const i = this.route.findIndex((f, k) => k >= 1 && f.id === id);
      if (i < 0) return false;
      this.leg = i; this.mode = "LNAV"; this.turnDir = 0; return true;
    }
    cmdResumeStar() { this.mode = "LNAV"; this.altAssigned = null; this.turnDir = 0; }
    cmdClearApproach(rwy) { if (rwy) this.rwy = rwy; this.cleared = true; }
  }

  Object.assign(ATC, { MAG_VAR, toXY, brgTo, dist, angDiff, norm360, buildWorld, buildRoute, Aircraft });
  if (typeof module !== "undefined") module.exports = ATC;
})(typeof window !== "undefined" ? window : globalThis);
