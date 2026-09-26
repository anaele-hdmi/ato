// 機体モデル・STAR 追従・待機・ILS・管制権限。ブラウザ（window.ATC）と node（テスト）の両方で動く。
(function (g) {
  const ATC = (g.ATC = g.ATC || {});
  const D2R = Math.PI / 180;
  const MAG_VAR = 7.9; // 西偏 7.9°: 磁方位 = 真方位 + 7.9
  const FT_PER_NM_3DEG = 318.4; // tan(3°) × 6076ft
  const TURN_RATE = 3; // deg/s
  const DESCENT_FPM = 1800, CLIMB_FPM = 2000, ACCEL = 1; // kt/s
  const MIN_VECTOR_ALT = 2000; // ゲーム上のレーダー誘導最低高度（簡略化）
  const HANDOFF_LIMIT_NM = 2; // この距離までにタワーへ移管しないと着陸復行

  // ---- 座標系: ARP 基準の平面近似（NM, x=東, y=北） ----
  const ARP = { lat: 35 + 33 / 60 + 12 / 3600, lon: 139 + 46 / 60 + 52 / 3600 };
  const COSLAT = Math.cos(ARP.lat * D2R);
  const toXY = (lat, lon) => ({ x: (lon - ARP.lon) * 60 * COSLAT, y: (lat - ARP.lat) * 60 });
  const norm360 = (a) => ((a % 360) + 360) % 360;
  const angDiff = (a, b) => ((b - a + 540) % 360) - 180; // a→b の最短差（-180..180）
  const brgTo = (a, b) => norm360(Math.atan2(b.x - a.x, b.y - a.y) / D2R);
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const mag = (trueDeg) => Math.round(norm360(trueDeg + MAG_VAR)) || 360;
  const pad3 = (n) => String(n).padStart(3, "0");

  function parseAlt(c) {
    if (!c) return null;
    const m = /^(=|>=|<=)(\d+)$/.exec(c);
    return m ? { op: m[1], ft: +m[2] } : null;
  }

  // 進入方式（AIP ILS Z RWY34L / 34R, EFF 2 OCT 2025）: 経路上のどの点から入れるか
  const APP_PATHS = {
    "34L": { alt: 5000, faf: "APOLO", name: "ILS Z RWY34L",
             from: { ARLON: ["ARLON", "APOLO"], CREAM: ["CREAM", "ARLON", "APOLO"] } },
    "34R": { alt: 4000, faf: "CACAO", name: "ILS Z RWY34R",
             from: { CREAM: ["CREAM", "CLOAK", "CAMEL", "CACAO"], CLOAK: ["CLOAK", "CAMEL", "CACAO"],
                     ARLON: ["ARLON", "CAMEL", "CACAO"], CAMEL: ["CAMEL", "CACAO"], CACAO: ["CACAO"] } },
  };

  // ---- 空港データを平面座標へ ----
  function buildWorld(data) {
    const fixes = {};
    for (const [id, f] of Object.entries(data.fixes)) fixes[id] = { id, ...toXY(f.lat, f.lon), src: f.src };
    const runways = {};
    for (const [id, r] of Object.entries(data.runways))
      runways[id] = { id, ...toXY(r.lat, r.lon), trueHdg: r.trueHdg, elev: r.thrElevFt };
    const stars = {};
    for (const [name, s] of Object.entries(data.stars)) {
      const last = s.fixes[s.fixes.length - 1];
      // A 系（ARLON 終点）→ 34L、C/H 系（CREAM/CACAO 終点）→ 34R、K 系（KAIHO）は ILS Y 実装まで除外
      const rwy = last === "ARLON" ? "34L" : last === "CREAM" || last === "CACAO" ? "34R" : null;
      stars[name] = { name, rwy, fixes: s.fixes.map((id) => ({ id, ...fixes[id], alt: parseAlt(s.altitude[id]) })) };
    }
    const approaches = {};
    for (const [rw, a] of Object.entries(APP_PATHS)) approaches[rw] = { rwy: rw, ...a, legs: a.from[rw === "34L" ? "ARLON" : "CREAM"].map((id) => fixes[id]) };
    return { fixes, runways, stars, approaches, holds: data.holds || {} };
  }

  class Aircraft {
    constructor(world, opts) {
      this.world = world;
      this.cs = opts.callsign;
      this.type = opts.type || "B738";
      this.wake = opts.wake || "M";
      this.star = opts.star;
      const s = world.stars[opts.star];
      this.rwy = s.rwy;
      this.route = s.fixes.map((f) => ({ ...f }));
      this.leg = 1; // route[leg] に向かって飛ぶ
      this.auto = !!opts.autoApproach; // テスト・デモ用: 進入許可とタワー移管を自動で行う
      this.cleared = false;
      if (this.auto) this.cmdClearApproach(this.rwy);
      const p0 = this.route[0], p1 = this.route[1];
      this.x = p0.x; this.y = p0.y;
      this.hdg = brgTo(p0, p1);
      this.alt = opts.alt ?? (p0.alt ? p0.alt.ft : 13000);
      this.spd = opts.spd ?? 280;
      this.tHdg = this.hdg; this.tAlt = this.alt; this.tSpd = this.spd; this.turnDir = 0;
      this.mode = "LNAV"; // LNAV（経路追従） / HDG（方位指示） / HOLD（待機） / LOC（ローカライザー追従）
      this.altAssigned = null; // 管制指示高度（null = 経路の高度制限に従う）
      this.spdAssigned = null;
      this.gsCaptured = false;
      this.ctl = opts.ctl || (this.auto ? "OWN" : "OFFER"); // OFFER（通信設定待ち） / OWN（自分の管轄） / TWR（タワーへ移管済み）
      this.state = "AIR"; // AIR / LANDED
      this.t = 0;
      this.events = [];
    }

    get rwyObj() { return this.world.runways[this.rwy]; }
    get magHdg() { return mag(this.hdg); }
    get fafId() { return APP_PATHS[this.rwy].faf; }
    distToThr() { return dist(this, this.rwyObj); }
    emit(type, extra) { this.events.push({ type, ...extra }); }

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
      if (this.mode === "LOC" || (this.cleared && d < 20)) {
        if (d < 3) return 140;
        if (d < 5) return 160;
        if (d < 10) return 180;
        return 210;
      }
      return this.alt > 10000 ? 280 : 250;
    }

    locGeom() {
      const r = this.rwyObj, crs = r.trueHdg;
      const dx = this.x - r.x, dy = this.y - r.y;
      const along = -(dx * Math.sin(crs * D2R) + dy * Math.cos(crs * D2R)); // 滑走路手前が正
      const xtk = dx * Math.cos(crs * D2R) - dy * Math.sin(crs * D2R); // 進入方向に対し右が正
      return { crs, along, xtk };
    }

    // 経路（または待機点）から進入経路をつなぐ。成功したら true
    joinApproach(rwy) {
      const ap = APP_PATHS[rwy];
      const alt = { op: "=", ft: ap.alt };
      const fx = (id) => ({ ...this.world.fixes[id], alt });
      if (this.mode === "HOLD" && ap.from[this.hold.fix.id]) {
        this.route = ap.from[this.hold.fix.id].map(fx);
        this.leg = 0; this.mode = "LNAV"; this.hold = null;
        return true;
      }
      for (let i = this.route.length - 1; i >= Math.max(0, this.leg - 1); i--) {
        const path = ap.from[this.route[i].id];
        if (!path) continue;
        const orig = this.route[i]; // 接続点では STAR 側の高い制限を優先
        this.route = [...this.route.slice(0, i), ...path.map(fx)];
        if (orig.alt && orig.alt.ft > ap.alt) this.route[i] = { ...this.route[i], alt: orig.alt };
        return true;
      }
      return false;
    }

    enterHold(fix) {
      const pub = this.world.holds[fix.id];
      const inbound = pub ? pub.inboundTrue : brgTo(this, fix);
      this.hold = { fix, inbound, turn: pub ? (pub.turn === "L" ? -1 : 1) : 1, pub: !!pub, phase: "TO", t: 0 };
      this.mode = "HOLD"; this.turnDir = 0;
      return this.hold;
    }

    goAround(reason) {
      const r = this.rwyObj;
      this.mode = "HDG"; this.tHdg = r.trueHdg; this.turnDir = 0;
      this.altAssigned = 3000; this.spdAssigned = null;
      this.cleared = false; this.gsCaptured = false; this.ctl = "OWN";
      this.leg = this.route.length; // 経路は使い切り。再誘導が必要
      this.emit("GOAROUND", { reason });
    }

    stepHold(dt) {
      const h = this.hold;
      const legSec = this.alt > 14000 ? 90 : 60;
      const outb = norm360(h.inbound + 180);
      if (h.phase === "TO") {
        this.tHdg = brgTo(this, h.fix);
        if (dist(this, h.fix) < 0.4) h.phase = "OUTTURN";
      } else if (h.phase === "OUTTURN") {
        this.turnDir = h.turn; this.tHdg = outb;
        if (Math.abs(angDiff(this.hdg, outb)) < 3) { h.phase = "OUT"; h.t = 0; this.turnDir = 0; }
      } else if (h.phase === "OUT") {
        this.tHdg = outb; h.t += dt;
        if (h.t >= legSec) h.phase = "INTURN";
      } else if (h.phase === "INTURN") {
        this.turnDir = h.turn; this.tHdg = h.inbound;
        if (Math.abs(angDiff(this.hdg, h.inbound)) < 20) { h.phase = "IN"; this.turnDir = 0; }
      } else if (h.phase === "IN") {
        const b = brgTo(this, h.fix), d = angDiff(h.inbound, b);
        this.tHdg = norm360(h.inbound + Math.max(-30, Math.min(30, d * 2)));
        if (dist(this, h.fix) < 0.4) h.phase = "OUTTURN";
      }
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
        const prev = this.route[this.leg - 1] || this;
        const lead = after ? Math.min(turnR * Math.tan(Math.abs(angDiff(brgTo(prev, nxt), brgTo(nxt, after))) * D2R / 2), 3) : 0;
        if (dist(this, nxt) < Math.max(0.3, lead)) {
          if (nxt.id === this.fafId && this.cleared) this.mode = "LOC";
          else if (after) this.leg++;
          else { this.enterHold(nxt); this.hold.phase = "OUTTURN"; this.emit("HOLDING", { fix: nxt.id }); } // 許可限界に到達: 待機
        }
      } else if (this.mode === "HOLD") {
        this.stepHold(dt);
      }
      if (this.mode === "HDG" && this.cleared) {
        // 方位指示中に進入許可済み → ローカライザーに会合したら LOC へ
        const gm = this.locGeom();
        if (gm.along > 0 && gm.along < 25 && Math.abs(gm.xtk) < 0.6 && Math.abs(angDiff(this.hdg, gm.crs)) < 60) { this.mode = "LOC"; this.turnDir = 0; }
      }
      if (this.mode === "LOC") {
        const gm = this.locGeom();
        const corr = Math.max(-30, Math.min(30, -gm.xtk * 40));
        this.tHdg = norm360(gm.crs + corr);
        const gpAlt = r.elev + 50 + gm.along * FT_PER_NM_3DEG;
        if (!this.gsCaptured && this.alt >= gpAlt - 100) { this.gsCaptured = true; this.altAssigned = null; }
        if (this.gsCaptured) this.tAlt = gpAlt;
        if (this.auto && this.ctl === "OWN") this.ctl = "TWR";
        if (gm.along < HANDOFF_LIMIT_NM && this.ctl !== "TWR") return this.goAround("NO_TWR");
        if (gm.along < 1.0 && this.alt > gpAlt + 300) return this.goAround("HIGH");
        if (gm.along < 0.3 && this.alt < r.elev + 200) { this.state = "LANDED"; this.emit("LANDED"); return; }
        if (gm.along < -0.5) return this.goAround("OVERSHOOT");
      }

      // ---- 高度・速度の目標 ----
      if (!(this.mode === "LOC" && this.gsCaptured)) {
        if (this.altAssigned != null) this.tAlt = this.altAssigned;
        else if (this.mode === "LNAV") this.tAlt = this.vnavAlt();
      }
      this.tSpd = this.spdAssigned ?? this.scheduleSpd();
      if (this.mode === "LOC") this.tSpd = Math.min(this.tSpd, this.scheduleSpd());
      if (this.mode === "HOLD") this.tSpd = Math.min(this.tSpd, 230);

      // ---- 運動 ----
      if (this.turnDir) {
        const rem = norm360(this.turnDir > 0 ? this.tHdg - this.hdg : this.hdg - this.tHdg);
        this.hdg = norm360(this.hdg + this.turnDir * Math.min(rem, TURN_RATE * dt));
        if (rem < 0.5) this.turnDir = 0;
      } else {
        const dh = angDiff(this.hdg, this.tHdg);
        this.hdg = norm360(this.hdg + Math.sign(dh) * Math.min(Math.abs(dh), TURN_RATE * dt));
      }
      const da = this.tAlt - this.alt;
      const vmax = ((this.mode === "LOC" && this.gsCaptured ? 1500 : da > 0 ? CLIMB_FPM : DESCENT_FPM) / 60) * dt;
      this.alt += Math.sign(da) * Math.min(Math.abs(da), vmax);
      const ds = this.tSpd - this.spd;
      this.spd += Math.sign(ds) * Math.min(Math.abs(ds), ACCEL * dt);
      const d = (this.spd / 3600) * dt;
      this.x += d * Math.sin(this.hdg * D2R);
      this.y += d * Math.cos(this.hdg * D2R);
    }

    // ---- 通信・管制指示。戻り値 { ok, msg }（msg はパイロットの復唱） ----
    checkInCall(atis) {
      const a = Math.round(this.alt / 100) * 100;
      return `TOKYO APP, ${this.cs}, ${a >= 14000 ? "FL" + a / 100 : a}, ${this.star.replace(/(\d)/, " $1")} ARRIVAL, INFO ${atis}`;
    }
    accept() {
      if (this.ctl !== "OFFER") return { ok: false, msg: "既に通信設定済み" };
      this.ctl = "OWN";
      return { ok: true, msg: `TOKYO APP, RADAR CONTACT, EXPECT ${APP_PATHS[this.rwy].name}` };
    }
    handoffTower() {
      if (this.ctl !== "OWN") return { ok: false, msg: this.ctl === "OFFER" ? "まだ通信設定していない" : "移管済み" };
      if (this.mode !== "LOC") return { ok: false, msg: "ローカライザー会合前は移管できない" };
      this.ctl = "TWR";
      return { ok: true, msg: `CONTACT TOKYO TOWER 124.35, ${this.cs}` };
    }
    cmdHeading(magHdg, dir = 0) {
      if (this.mode === "LOC") { this.cleared = false; this.gsCaptured = false; } // 進入を中止してレーダー誘導
      this.mode = "HDG"; this.hold = null;
      this.tHdg = norm360(magHdg - MAG_VAR); this.turnDir = dir;
      return { ok: true, msg: `${dir < 0 ? "TURN LEFT " : dir > 0 ? "TURN RIGHT " : "FLY "}HEADING ${pad3(magHdg)}` };
    }
    cmdAltitude(ft) {
      if (this.mode === "LOC" && this.gsCaptured) return { ok: false, msg: "UNABLE, ESTABLISHED ON GLIDESLOPE" };
      if (ft < MIN_VECTOR_ALT) return { ok: false, msg: `UNABLE, 誘導最低高度 ${MIN_VECTOR_ALT}ft` };
      if (ft > 15000) return { ok: false, msg: "UNABLE, 管轄上限 15000ft" };
      this.altAssigned = ft;
      return { ok: true, msg: `${ft < this.alt ? "DESCEND AND MAINTAIN" : "CLIMB AND MAINTAIN"} ${ft}` };
    }
    cmdSpeed(kt) {
      if (kt < 160 || kt > 280) return { ok: false, msg: "UNABLE, 160〜280kt" };
      this.spdAssigned = kt;
      return { ok: true, msg: `SPEED ${kt}` };
    }
    cmdDirect(id) {
      const i = this.route.findIndex((f, k) => k >= Math.max(0, this.leg - 1) && f.id === id);
      if (i >= 0) { this.leg = Math.max(i, 0); this.mode = "LNAV"; this.hold = null; this.turnDir = 0; return { ok: true, msg: `DIRECT ${id}` }; }
      const f = this.world.fixes[id];
      if (!f) return { ok: false, msg: `${id}: 不明な地点` };
      this.enterHold(f); // 経路外: その点を許可限界として直行し、到達後は待機
      return { ok: true, msg: `DIRECT ${id}, HOLD ${this.holdDesc()}` };
    }
    cmdHold(id) {
      const f = this.world.fixes[id];
      if (!f) return { ok: false, msg: `${id}: 不明な地点` };
      if (this.mode === "LOC") return { ok: false, msg: "UNABLE, ESTABLISHED" };
      this.enterHold(f);
      return { ok: true, msg: `HOLD AT ${id} ${this.holdDesc()}` };
    }
    holdDesc() {
      const h = this.hold;
      return `${h.pub ? "AS PUBLISHED" : ""} INBOUND ${pad3(mag(h.inbound))} ${h.turn < 0 ? "LEFT" : "RIGHT"} TURNS`.trim();
    }
    cmdResumeStar() {
      // 残りの経路点のうち、前方にある最も近い点へ戻る
      let best = -1, bd = Infinity;
      for (let i = Math.max(1, this.leg); i < this.route.length; i++) {
        const f = this.route[i], d = dist(this, f);
        if (Math.abs(angDiff(this.hdg, brgTo(this, f))) < 100 && d < bd) { bd = d; best = i; }
      }
      if (best < 0) return { ok: false, msg: "UNABLE, 戻れる経路点がない（誘導して進入許可を）" };
      this.leg = best; this.mode = "LNAV"; this.hold = null; this.altAssigned = null; this.turnDir = 0;
      return { ok: true, msg: `RESUME ${this.star.replace(/(\d)/, " $1")} VIA ${this.route[best].id}` };
    }
    cmdClearApproach(rwy) {
      if (!APP_PATHS[rwy]) return { ok: false, msg: `${rwy}: 使用中の滑走路ではない` };
      this.rwy = rwy;
      this.cleared = true; this.gsCaptured = false;
      const name = APP_PATHS[rwy].name;
      if ((this.mode === "LNAV" || this.mode === "HOLD" || this.mode === undefined) && this.joinApproach(rwy))
        return { ok: true, msg: `CLEARED ${name} APPROACH` };
      if (this.mode === "HOLD") this.mode = "HDG";
      if (this.mode === "HDG") {
        const gm = this.locGeom();
        const hint = gm.along < 0 ? "（滑走路を過ぎている）" : Math.abs(angDiff(this.hdg, gm.crs)) > 60 ? "（会合角が大きい）" : "";
        return { ok: true, msg: `CLEARED ${name} APPROACH, WILL INTERCEPT${hint}` };
      }
      return { ok: true, msg: `CLEARED ${name} APPROACH` };
    }
  }

  Object.assign(ATC, { MAG_VAR, HANDOFF_LIMIT_NM, APP_PATHS, toXY, brgTo, dist, angDiff, norm360, mag, buildWorld, Aircraft });
  if (typeof module !== "undefined") module.exports = ATC;
})(typeof window !== "undefined" ? window : globalThis);
