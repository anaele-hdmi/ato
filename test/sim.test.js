// シミュレーションの回帰テスト: node test/sim.test.js
const ATC = require("../src/sim.js");
const data = require("../data/rjtt_north.json");
let fail = 0;
const check = (ok, label, note = "") => { if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${label} ${note}`); };
const run = (ac, sec, onStep) => { for (let t = 0; t < sec && ac.state === "AIR"; t++) { ac.step(1); onStep && onStep(t); } };

// 1. 運用ごとに、使用する全 STAR を自動飛行: 着陸し、経路点通過時に高度制限を守る
for (const cfg of ["VMC", "IMC"]) {
  const world = ATC.buildWorld(data, cfg);
  for (const name of Object.keys(world.stars)) {
    if (!world.stars[name].rwy) continue;
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
    check(ac.state === "LANDED" && !notes.length && !ac.events.some((e) => e.type === "GOAROUND"),
      `${cfg} auto ${name.padEnd(9)}→ ${ATC.APPROACHES[ac.app].name}`, `${(ac.t / 60).toFixed(1)}分 ${notes.join(", ")}`);
  }
}

const imc = ATC.buildWorld(data, "IMC");
// 2. 手動: ハンドオフ受け入れ → 初回通信 → 許可なしで STAR 終点に到達すると待機 → 進入許可 → 移管 → 着陸
{
  const ac = new ATC.Aircraft(imc, { callsign: "SKY1", star: "AKSEL1A" });
  check(ac.ctl === "OFFER", "manual: 初期状態はハンドオフ提示中");
  ac.accept();
  check(ac.ctl === "WAIT", "manual: 受け入れ直後は初回通信待ち");
  run(ac, 30);
  check(ac.ctl === "OWN" && ac.events.some((e) => e.type === "CHECKIN"), "manual: 数秒後に初回通信");
  run(ac, 1500);
  check(ac.mode === "HOLD" && ac.hold.fix.id === "ARLON" && ac.hold.turn === -1, "manual: 許可限界 ARLON で公示の左旋回待機", ac.mode);
  let maxD = 0; run(ac, 600, () => { maxD = Math.max(maxD, ATC.dist(ac, imc.fixes.ARLON)); });
  check(maxD < 8, "manual: 待機中は ARLON 付近に留まる", `最大 ${maxD.toFixed(1)}NM`);
  ac.cmdClearApproach("34L");
  run(ac, 1200, () => { if (ac.mode === "LOC" && ac.ctl === "OWN") ac.handoffTower(); });
  check(ac.state === "LANDED", "manual: 待機から進入許可・移管して着陸", ac.state);
}
// 3. タワー未移管 → AIP の復行方式（34L: 左旋回で UTIBO、5000ft で待機）
{
  const ac = new ATC.Aircraft(imc, { callsign: "SKY2", star: "AKSEL1A", ctl: "OWN" });
  ac.cmdClearApproach("34L");
  run(ac, 3000, () => { if (ac.events.some((e) => e.type === "GOAROUND")) {} });
  const ga = ac.events.find((e) => e.type === "GOAROUND");
  check(ga && ga.reason === "NO_TWR", "移管忘れで着陸復行");
  run(ac, 1800);
  check(ac.mode === "HOLD" && ac.hold.fix.id === "UTIBO" && Math.abs(ac.alt - 5000) < 50, "復行後 UTIBO 5000ft で待機", `${ac.mode} ${ac.hold && ac.hold.fix.id} ${Math.round(ac.alt)}`);
}
// 4. レーダー誘導でローカライザーに会合
{
  const ac = new ATC.Aircraft(imc, { callsign: "SKY3", star: "OSHIMA2C", ctl: "OWN" });
  run(ac, 900);
  ac.cmdAltitude(4000); ac.cmdHeading(300, -1); // 真方位約 292°: 34R ローカライザー（330°T）へ約 40° で会合
  run(ac, 60);
  const r = ac.cmdClearApproach("34R");
  run(ac, 1800, () => { if (ac.mode === "LOC" && ac.ctl === "OWN") ac.handoffTower(); });
  check(ac.state === "LANDED", "誘導 → 34R 会合 → 着陸", `${ac.state} ${r.msg}`);
}
// 5. 経路外の点へ直行 → 到達後に待機
{
  const ac = new ATC.Aircraft(imc, { callsign: "SKY4", star: "AROSA1A", ctl: "OWN" });
  const r = ac.cmdDirect("UMUKI");
  run(ac, 1200);
  check(ac.mode === "HOLD" && ac.hold.fix.id === "UMUKI" && ATC.dist(ac, imc.fixes.UMUKI) < 8, "経路外直行 → 待機", r.msg);
}
// 6. VMC: A 系 STAR の機体に 34L 許可 → ILS X に接続できず ILS Z にフォールバック
{
  const vmc = ATC.buildWorld(data, "VMC");
  const ac = new ATC.Aircraft(vmc, { callsign: "SKY5", star: "AKSEL2H", ctl: "OWN" });
  ac.cmdResumeStar();
  const r = ac.cmdClearApproach("34L");
  check(r.ok && ac.app === "ILSZ34L", "VMC: ILS X に繋がらない経路は ILS Z 34L", r.msg);
}
// 7. 後方乱気流間隔の表
check(ATC.wakeReq("H", "M") === 5 && ATC.wakeReq("H", "H") === 4 && ATC.wakeReq("M", "H") === 3, "後方乱気流間隔 H→M 5 / H→H 4 / M→H 3");
process.exit(fail ? 1 : 0);
