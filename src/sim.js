// 機体モデル・STAR 追従・待機・進入・着陸復行・管制権限。ブラウザ（window.ATC）と node（テスト）の両方で動く。
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
  const spoken = (star) => star.replace(/(\d)/, " $1");

  function parseAlt(c) {
    if (!c) return null;
    const m = /^(=|>=|<=)(\d+)$/.exec(c);
    return m ? { op: m[1], ft: +m[2] } : null;
  }

  // 進入方式（AIP Japan RJTT AD2.24, EFF 2 OCT 2025）。from: 経路上のどの点から入れるか → [点, 高度]
  const APPROACHES = {
    ILSX34L: { rwy: "34L", name: "ILS X RWY34L", short: "X34L", faf: "AZURE",
      from: { KAIHO: [["KAIHO", 4000], ["AVION", null], ["ALLIE", 2000], ["AZURE", 1500]],
              AVION: [["AVION", null], ["ALLIE", 2000], ["AZURE", 1500]] },
      missed: { turnAtFt: 800, dir: 1, fix: "KASGA", alt: 4000, text: "HDG337 → 右旋回 KASGA 4000ft 待機" } },
    ILSZ34L: { rwy: "34L", name: "ILS Z RWY34L", short: "Z34L", faf: "APOLO",
      from: { ARLON: [["ARLON", 5000], ["APOLO", 5000]], CREAM: [["CREAM", 5000], ["ARLON", 5000], ["APOLO", 5000]] },
      missed: { turnAtFt: 500, dir: -1, fix: "UTIBO", alt: 5000, text: "HDG337 → 左旋回 UTIBO 5000ft 待機" } },
    ILSZ34R: { rwy: "34R", name: "ILS Z RWY34R", short: "Z34R", faf: "CACAO",
      from: { CREAM: [["CREAM", 4000], ["CLOAK", 4000], ["CAMEL", 4000], ["CACAO", 4000]], CLOAK: [["CLOAK", 4000], ["CAMEL", 4000], ["CACAO", 4000]],
              ARLON: [["ARLON", 4000], ["CAMEL", 4000], ["CACAO", 4000]], CAMEL: [["CAMEL", 4000], ["CACAO", 4000]], CACAO: [["CACAO", 4000]] },
      missed: { turnAtFt: 800, dir: 1, fix: "KASGA", alt: 4000, text: "HDG337 → 右旋回 KASGA 4000ft 待機" } },
    // 視認進入。AIP の注記「許可後も CACAO までは許可済みの経路を飛ぶ」に従い、CACAO から滑走路延長線に沿って 3° で降下（簡略化）
    HWY34R: { rwy: "34R", name: "HIGHWAY VISUAL RWY34R", short: "HWY34R", faf: "CACAO", visual: true,
      from: { CREAM: [["CREAM", null], ["CLOAK", null], ["CAMEL", null], ["CACAO", 4000]], CLOAK: [["CLOAK", null], ["CAMEL", null], ["CACAO", 4000]],
              CAMEL: [["CAMEL", null], ["CACAO", 4000]], CACAO: [["CACAO", 4000]] },
      missed: { turnAtFt: 800, dir: 1, fix: "KASGA", alt: 4000, text: "HDG337 → 右旋回 KASGA 4000ft 待機" } },
  };

  // 運用（北風・昼間）。VMC は AIP で「優先的に使用」とされる方式、IMC は同時平行 ILS（国交省資料）
  const CONFIGS = {
    VMC: { label: "VMC", desc: "好天", app: { "34L": "ILSX34L", "34R": "HWY34R" }, fallback: { "34L": "ILSZ34L", "34R": "ILSZ34R" },
           star: (name) => (/K$/.test(name) ? "34L" : /H$/.test(name) ? "34R" : null), ntz: false },
    IMC: { label: "IMC", desc: "悪天", app: { "34L": "ILSZ34L", "34R": "ILSZ34R" }, fallback: {},
           star: (name) => (/A$/.test(name) ? "34L" : /[CH]$/.test(name) ? "34R" : null), ntz: true },
  };

  // 後方乱気流間隔（ICAO PANS-ATM の距離基準。H=Heavy, M=Medium）。それ以外はレーダー間隔 3NM
  const WAKE_NM = { HH: 4, HM: 5 };
  const wakeReq = (lead, foll) => WAKE_NM[lead + foll] || 3;

  // ---- 空港データを平面座標へ ----
  function buildWorld(data, configName = "IMC") {
    const fixes = {};
    for (const [id, f] of Object.entries(data.fixes)) fixes[id] = { id, ...toXY(f.lat, f.lon), src: f.src };
    const runways = {};
    for (const [id, r] of Object.entries(data.runways))
      runways[id] = { id, ...toXY(r.lat, r.lon), trueHdg: r.trueHdg, elev: r.thrElevFt };
    const cfg = CONFIGS[configName];
    const stars = {};
    for (const [name, s] of Object.entries(data.stars))
      stars[name] = { name, rwy: cfg.star(name), fixes: s.fixes.map((id) => ({ id, ...fixes[id], alt: parseAlt(s.altitude[id]) })) };
    return { fixes, runways, stars, holds: data.holds || {}, config: configName, cfg };
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
      this.app = world.cfg.app[this.rwy];
      this.route = s.fixes.map((f) => ({ ...f }));
      this.leg = 1; // route[leg] に向かって飛ぶ
      this.auto = !!opts.autoApproach; // テスト・デモ用: 進入許可とタワー移管を自動で行う
      this.cleared = false;
      const p0 = this.route[0], p1 = this.route[1];
      this.x = p0.x; this.y = p0.y;
      this.hdg = brgTo(p0, p1);
      this.alt = opts.alt ?? (p0.alt ? p0.alt.ft : 13000);
      this.spd = opts.spd ?? 280;
      this.tHdg = this.hdg; this.tAlt = this.alt; this.tSpd = this.spd; this.turnDir = 0;
      this.mode = "LNAV"; // LNAV（経路） / HDG（方位指示） / HOLD（待機） / LOC（最終進入） / MISSED（着陸復行の上昇）
      this.altAssigned = null; this.spdAssigned = null;
      this.gsCaptured = false;
      // OFFER: 東京コントロールからハンドオフ提示中 / WAIT: 受け入れ済み・機体の初回通信待ち / OWN: 担当中 / TWR: タワーへ移管済み
      this.ctl = opts.ctl || (this.auto ? "OWN" : "OFFER");
      this.state = "AIR"; // AIR / LANDED
      this.t = 0;
      this.events = [];
      if (this.auto) this.cmdClearApproach(this.rwy);
    }

    get rwyObj() { return this.world.runways[this.rwy]; }
    get magHdg() { return mag(this.hdg); }
    get apObj() { return APPROACHES[this.app]; }
    distToThr() { return dist(this, this.rwyObj); }
    emit(type, extra) { this.events.push({ type, ...extra }); }

    alongTo(i) {
      let d = dist(this, this.route[this.leg]);
      for (let k = this.leg; k < i; k++) d += dist(this.route[k], this.route[k + 1]);
      return d;
    }
    // 滑走路までの残り距離（経路どおりに飛んだ場合）。到着順の一覧に使う
    distToGo() {
      if (this.mode === "LNAV" && this.leg < this.route.length) {
        const last = this.route.length - 1;
        return this.alongTo(last) + dist(this.route[last], this.rwyObj);
      }
      return this.distToThr() + (this.mode === "HOLD" ? 8 : 0);
    }
    ftPerNm() { return (DESCENT_FPM * 60) / Math.max(this.spd, 120); }

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

    // 経路（または待機点）から進入経路をつなぐ
    joinApproach(apKey) {
      const ap = APPROACHES[apKey];
      const fx = ([id, ft]) => ({ ...this.world.fixes[id], alt: ft ? { op: "=", ft } : null });
      if (this.mode === "HOLD" && ap.from[this.hold.fix.id]) {
        this.route = ap.from[this.hold.fix.id].map(fx);
        this.leg = 0; this.mode = "LNAV"; this.hold = null;
        return true;
      }
      if (this.mode !== "LNAV" && this.mode !== undefined && this.mode !== "HOLD") return false;
      for (let i = this.route.length - 1; i >= Math.max(0, this.leg - 1); i--) {
        const path = ap.from[this.route[i].id];
        if (!path) continue;
        const orig = this.route[i]; // 接続点では STAR 側の高い制限を優先
        this.route = [...this.route.slice(0, i), ...path.map(fx)];
        if (orig.alt && (!this.route[i].alt || orig.alt.ft > this.route[i].alt.ft)) this.route[i] = { ...this.route[i], alt: orig.alt };
        return true;
      }
      return false;
    }

    enterHold(fix) {
      const pub = this.world.holds[fix.id];
      const inbound = pub ? pub.inboundTrue : brgTo(this, fix);
      this.hold = { fix, inbound, turn: pub ? (pub.turn === "L" ? -1 : 1) : 1, pub: !!pub, phase: "TO", t: 0 };
      this.mode = "HOLD";
      return this.hold;
    }

    // 着陸復行: AIP の復行方式（簡略化）。滑走路方位で上昇 → 規定高度で旋回 → 復行待機点で待機
    goAround(reason) {
      const r = this.rwyObj, m = this.apObj.missed;
      this.mode = "MISSED"; this.missed = m;
      this.tHdg = r.trueHdg; this.turnDir = 0;
      this.altAssigned = m.alt; this.spdAssigned = null;
      this.cleared = false; this.gsCaptured = false; this.ctl = "OWN";
      this.leg = this.route.length;
      this.emit("GOAROUND", { reason, text: m.text });
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

      if (this.ctl === "WAIT" && this.t >= this.callAt) { this.ctl = "OWN"; this.emit("CHECKIN"); }

      // ---- 横方向 ----
      if (this.mode === "LNAV") {
        const nxt = this.route[this.leg];
        this.tHdg = brgTo(this, nxt);
        const after = this.route[this.leg + 1];
        const turnR = this.spd / (60 * Math.PI);
        const prev = this.route[this.leg - 1] || this;
        const lead = after ? Math.min(turnR * Math.tan(Math.abs(angDiff(brgTo(prev, nxt), brgTo(nxt, after))) * D2R / 2), 3) : 0;
        if (dist(this, nxt) < Math.max(0.3, lead)) {
          if (nxt.id === this.apObj.faf && this.cleared) this.mode = "LOC";
          else if (after) this.leg++;
          else { this.enterHold(nxt); this.hold.phase = "OUTTURN"; this.emit("HOLDING", { fix: nxt.id }); }
        }
      } else if (this.mode === "HOLD") {
        this.stepHold(dt);
      } else if (this.mode === "MISSED") {
        if (this.alt >= r.elev + this.missed.turnAtFt) {
          this.enterHold(this.world.fixes[this.missed.fix]);
          this.turnDir = this.missed.dir; // 最初の旋回方向は復行方式どおり
        }
      }
      if (this.mode === "HDG" && this.cleared) {
        const gm = this.locGeom();
        if (gm.along > 0 && gm.along < 25 && Math.abs(gm.xtk) < 0.6 && Math.abs(angDiff(this.hdg, gm.crs)) < 60) { this.mode = "LOC"; this.turnDir = 0; }
      }
      if (this.mode === "LOC") {
        const gm = this.locGeom();
        this.tHdg = norm360(gm.crs + Math.max(-30, Math.min(30, -gm.xtk * 40)));
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
      if (this.mode === "MISSED") this.tSpd = 200;

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

    // ---- 通信・管制指示。戻り値 { ok, msg } ----
    // ハンドオフの受け入れ（画面上の移送機能）。機体は数秒後に周波数を変えて呼んでくる
    accept() {
      if (this.ctl !== "OFFER") return { ok: false, msg: "ハンドオフは提示されていない" };
      this.ctl = "WAIT"; this.callAt = this.t + 6 + Math.random() * 8;
      return { ok: true, msg: "ハンドオフ受け入れ", silent: true };
    }
    checkInCall(atis) {
      const a = Math.round(this.alt / 100) * 100;
      return `TOKYO APPROACH, ${this.cs}, ${a >= 14000 ? "FL" + a / 100 : a}, ${spoken(this.star)} ARRIVAL, INFORMATION ${atis}`;
    }
    checkInReply() { return `${this.cs}, TOKYO APPROACH, EXPECT ${this.apObj.name} APPROACH`; }
    handoffTower() {
      if (this.ctl !== "OWN") return { ok: false, msg: this.ctl === "TWR" ? "移管済み" : "まだ担当していない" };
      if (this.mode !== "LOC") return { ok: false, msg: "最終進入に入る前は移管できない" };
      this.ctl = "TWR";
      return { ok: true, msg: `CONTACT TOKYO TOWER 124.35` };
    }
    cmdHeading(magHdg, dir = 0) {
      if (this.mode === "LOC") { this.cleared = false; this.gsCaptured = false; }
      this.mode = "HDG"; this.hold = null;
      this.tHdg = norm360(magHdg - MAG_VAR); this.turnDir = dir;
      return { ok: true, msg: `${dir < 0 ? "TURN LEFT " : dir > 0 ? "TURN RIGHT " : "FLY "}HEADING ${pad3(magHdg)}` };
    }
    cmdAltitude(ft) {
      if (this.mode === "LOC" && this.gsCaptured) return { ok: false, msg: "UNABLE, ESTABLISHED ON FINAL" };
      if (ft < MIN_VECTOR_ALT) return { ok: false, msg: `UNABLE（誘導最低高度 ${MIN_VECTOR_ALT}ft）` };
      if (ft > 15000) return { ok: false, msg: "UNABLE（管轄上限 15000ft）" };
      this.altAssigned = ft;
      return { ok: true, msg: `${ft < this.alt ? "DESCEND AND MAINTAIN" : "CLIMB AND MAINTAIN"} ${ft}` };
    }
    cmdSpeed(kt) {
      if (kt == null) { this.spdAssigned = null; return { ok: true, msg: "RESUME NORMAL SPEED" }; }
      if (kt < 160 || kt > 280) return { ok: false, msg: "UNABLE（160〜280kt）" };
      this.spdAssigned = kt;
      return { ok: true, msg: `SPEED ${kt}` };
    }
    cmdDirect(id) {
      const i = this.route.findIndex((f, k) => k >= Math.max(0, this.leg - 1) && f.id === id);
      if (i >= 0 && this.mode !== "MISSED") { this.leg = Math.max(i, 0); this.mode = "LNAV"; this.hold = null; this.turnDir = 0; return { ok: true, msg: `PROCEED DIRECT ${id}` }; }
      const f = this.world.fixes[id];
      if (!f) return { ok: false, msg: `${id}: 不明な地点` };
      this.enterHold(f); this.turnDir = 0;
      return { ok: true, msg: `PROCEED DIRECT ${id}, HOLD ${this.holdDesc()}` };
    }
    cmdHold(id) {
      const f = this.world.fixes[id];
      if (!f) return { ok: false, msg: `${id}: 不明な地点` };
      if (this.mode === "LOC") return { ok: false, msg: "UNABLE, ESTABLISHED" };
      this.enterHold(f); this.turnDir = 0;
      return { ok: true, msg: `HOLD AT ${id} ${this.holdDesc()}` };
    }
    holdDesc() {
      const h = this.hold;
      return `${h.pub ? "AS PUBLISHED" : ""} INBOUND ${pad3(mag(h.inbound))} ${h.turn < 0 ? "LEFT" : "RIGHT"} TURNS`.trim();
    }
    cmdResumeStar() {
      let best = -1, bd = Infinity;
      for (let i = Math.max(1, this.leg); i < this.route.length; i++) {
        const f = this.route[i], d = dist(this, f);
        if (Math.abs(angDiff(this.hdg, brgTo(this, f))) < 100 && d < bd) { bd = d; best = i; }
      }
      if (best < 0) return { ok: false, msg: "UNABLE（戻れる経路点がない。誘導して進入許可を）" };
      this.leg = best; this.mode = "LNAV"; this.hold = null; this.altAssigned = null; this.turnDir = 0;
      return { ok: true, msg: `RESUME ${spoken(this.star)} ARRIVAL VIA ${this.route[best].id}` };
    }
    cmdClearApproach(rwy) {
      const cfg = this.world.cfg;
      if (!cfg.app[rwy]) return { ok: false, msg: `${rwy}: 使用中の滑走路ではない` };
      this.rwy = rwy;
      // 運用中の方式でつながらなければ、同じ滑走路のもう一方の方式（ILS Z）を試す
      const cands = [cfg.app[rwy], cfg.fallback[rwy]].filter(Boolean);
      for (const k of cands) {
        if (this.joinApproach(k)) {
          this.app = k; this.cleared = true; this.gsCaptured = false;
          return { ok: true, msg: `CLEARED ${APPROACHES[k].name} APPROACH` };
        }
      }
      // レーダー誘導中: ローカライザー（視認進入では滑走路延長線）に会合させる
      this.app = cands[cands.length - 1]; this.cleared = true; this.gsCaptured = false;
      if (this.mode === "HOLD" || this.mode === "MISSED") this.mode = "HDG";
      const gm = this.locGeom();
      const hint = gm.along < 0 ? "（滑走路を過ぎている）" : Math.abs(angDiff(this.hdg, gm.crs)) > 60 ? "（会合角が大きい）" : "";
      return { ok: true, msg: `CLEARED ${this.apObj.name} APPROACH${hint}` };
    }
  }

  Object.assign(ATC, { MAG_VAR, HANDOFF_LIMIT_NM, APPROACHES, CONFIGS, WAKE_NM, wakeReq, toXY, brgTo, dist, angDiff, norm360, mag, buildWorld, Aircraft });
  if (typeof module !== "undefined") module.exports = ATC;
})(typeof window !== "undefined" ? window : globalThis);
