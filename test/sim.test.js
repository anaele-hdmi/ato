// 全 STAR を自動で飛ばし、着陸・高度制限の遵守を確認する: node test/sim.test.js
const ATC = require("../src/sim.js");
const data = require("../data/rjtt_north.json");
const world = ATC.buildWorld(data);
let fail = 0;
for (const name of Object.keys(world.stars)) {
  const s = world.stars[name];
  if (!s.rwy) { console.log(`SKIP ${name} (終点 ${s.fixes.at(-1).id}: M4 で対応)`); continue; }
  const ac = new ATC.Aircraft(world, { callsign: "TST", star: name, autoApproach: true });
  const notes = [];
  let last = ac.leg;
  for (let t = 0; t < 3 * 3600 && ac.state === "AIR"; t += 1) {
    ac.step(1);
    if (ac.leg !== last) { // 経路点を通過した瞬間の高度を制限と照合
      const f = ac.route[last], c = f.alt;
      if (c) {
        const ok = c.op === "=" ? Math.abs(ac.alt - c.ft) <= 300 : c.op === ">=" ? ac.alt >= c.ft - 100 : ac.alt <= c.ft + 100;
        if (!ok) notes.push(`${f.id} ${c.op}${c.ft} 実${Math.round(ac.alt)}`);
      }
      last = ac.leg;
    }
    if (!Number.isFinite(ac.x + ac.y + ac.alt)) { notes.push("NaN"); break; }
  }
  const ok = ac.state === "LANDED" && notes.length === 0;
  if (!ok) fail++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name.padEnd(9)} → ${ac.rwy} ${ac.state.padEnd(6)} ${(ac.t / 60).toFixed(1)}分 ${notes.join(", ")}`);
}
process.exit(fail ? 1 : 0);
