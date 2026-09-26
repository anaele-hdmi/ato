// シミュレーションの回帰テスト: node test/sim.test.js
const ATC = require("../src/sim.js");
const data = require("../data/rjtt_north.json");
const world = ATC.buildWorld(data);
let fail = 0;
const check = (ok, label, note = "") => { if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${label} ${note}`); };
const run = (ac, sec, onStep) => { for (let t = 0; t < sec && ac.state === "AIR"; t++) { ac.step(1); onStep && onStep(t); } };

// 1. 全 STAR 自動飛行: 着陸し、経路点通過時に高度制限を守る
for (const name of Object.keys(world.stars)) {
  const s = world.stars[name];
  if (!s.rwy) continue;
  const ac = new ATC.Aircraft(world, { callsign: "TST", star: name, autoApproach: true });
  const notes = []; let last = ac.leg;
  run(ac, 3 * 3600, () => {
    if (ac.leg !== last) {
      const f = ac.route[last], c = f.alt;
      if (c) {
        const ok = c.op === "=" ? Math.abs(ac.alt - c.ft) <= 300 : c.op === ">=" ? ac.alt >= c.ft - 100 : ac.alt <= c.ft + 100;
        if (!ok) notes.push(`${f.id} ${c.op}${c.ft} 実${Math.round(ac.alt)}`);
      }
      last = ac.leg;
    }
  });
  check(ac.state === "LANDED" && !notes.length && !ac.events.some((e) => e.type === "GOAROUND"), `auto ${name.padEnd(9)}→${ac.rwy}`, `${(ac.t / 60).toFixed(1)}分 ${notes.join(", ")}`);
}

// 2. 手動: 通信設定 → 許可なしで STAR 終点に到達すると待機 → 進入許可 → 移管 → 着陸
{
  const ac = new ATC.Aircraft(world, { callsign: "JAL1", star: "AKSEL1A" });
  check(ac.ctl === "OFFER", "manual: 初期状態は通信設定待ち");
  ac.accept();
  run(ac, 1500);
  check(ac.mode === "HOLD" && ac.hold.fix.id === "ARLON" && ac.hold.turn === -1, "manual: 許可限界 ARLON で公示の左旋回待機", ac.mode);
  let maxD = 0; run(ac, 600, () => { maxD = Math.max(maxD, ATC.dist(ac, world.fixes.ARLON)); });
  check(maxD < 8, "manual: 待機中は ARLON 付近に留まる", `最大 ${maxD.toFixed(1)}NM`);
  ac.cmdClearApproach("34L");
  run(ac, 1200, () => { if (ac.mode === "LOC" && ac.ctl === "OWN") ac.handoffTower(); });
  check(ac.state === "LANDED", "manual: 待機から進入許可・移管して着陸", ac.state);
}

// 3. タワー未移管 → 着陸復行
{
  const ac = new ATC.Aircraft(world, { callsign: "ANA2", star: "AKSEL1A", ctl: "OWN" });
  ac.cmdClearApproach("34L");
  run(ac, 3000);
  check(ac.events.some((e) => e.type === "GOAROUND" && e.reason === "NO_TWR"), "移管忘れで着陸復行");
}

// 4. レーダー誘導でローカライザーに会合
{
  const ac = new ATC.Aircraft(world, { callsign: "SKY3", star: "OSHIMA2C", ctl: "OWN" });
  run(ac, 900); // CIVIC 付近まで STAR
  ac.cmdAltitude(4000); ac.cmdHeading(300, -1); // 真方位約 292°: 34R ローカライザー（330°T）へ約 40° で会合
  run(ac, 60);
  const r = ac.cmdClearApproach("34R");
  run(ac, 1800, () => { if (ac.mode === "LOC" && ac.ctl === "OWN") ac.handoffTower(); });
  check(ac.state === "LANDED", "誘導 → 34R 会合 → 着陸", `${ac.state} ${r.msg}`);
}

// 5. 経路外の点へ直行 → 到達後に待機
{
  const ac = new ATC.Aircraft(world, { callsign: "ADO4", star: "AROSA1A", ctl: "OWN" });
  const r = ac.cmdDirect("UMUKI");
  run(ac, 1200);
  check(ac.mode === "HOLD" && ac.hold.fix.id === "UMUKI" && ATC.dist(ac, world.fixes.UMUKI) < 8, "経路外直行 → 待機", r.msg);
}
process.exit(fail ? 1 : 0);
