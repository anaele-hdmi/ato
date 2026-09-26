// コマンド解析: "JAL123 L250 A50 S190" / "D ARLON" / "C 34L" / "STAR"
(function (g) {
  const ATC = (g.ATC = g.ATC || {});

  // 戻り値: { ok, ac, msgs[] }。selected は選択中の機体（コールサイン省略時に使う）
  function runCommand(line, aircraft, selected) {
    const toks = line.trim().toUpperCase().split(/\s+/).filter(Boolean);
    if (!toks.length) return { ok: false, msgs: [] };
    let ac = selected;
    const hit = aircraft.filter((a) => a.state === "AIR" && a.cs.startsWith(toks[0]));
    if (hit.length === 1 && /^[A-Z]{2,3}\d/.test(toks[0])) { ac = hit[0]; toks.shift(); }
    else if (hit.length > 1 && /^[A-Z]{2,3}\d/.test(toks[0])) return { ok: false, msgs: [`${toks[0]}? 該当 ${hit.length} 機`] };
    if (!ac) return { ok: false, msgs: ["機体を選択するかコールサインを入力"] };

    const msgs = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      let m;
      if ((m = /^([HLR])(\d{1,3})$/.exec(t))) {
        const h = (+m[2]) % 360 || 360;
        ac.cmdHeading(h, m[1] === "L" ? -1 : m[1] === "R" ? 1 : 0);
        msgs.push(`${m[1] === "L" ? "TURN LEFT " : m[1] === "R" ? "TURN RIGHT " : "FLY "}HDG ${String(h).padStart(3, "0")}`);
      } else if ((m = /^A(\d{1,3})$/.exec(t))) {
        const ft = +m[1] * 100;
        ac.cmdAltitude(ft);
        msgs.push(`${ft < ac.alt ? "DESCEND" : "CLIMB"} ${ft}`);
      } else if ((m = /^S(\d{3})$/.exec(t))) {
        ac.cmdSpeed(+m[1]); msgs.push(`SPEED ${m[1]}`);
      } else if (t === "D" && toks[i + 1]) {
        const id = toks[++i];
        msgs.push(ac.cmdDirect(id) ? `DIRECT ${id}` : `${id}: ルート上にない`);
      } else if (t === "C" && toks[i + 1]) {
        const rw = toks[++i];
        if (!["34L", "34R"].includes(rw)) { msgs.push(`${rw}: 使用中の滑走路ではない`); continue; }
        ac.cmdClearApproach(rw); msgs.push(`CLEARED ILS ${rw}`);
      } else if (t === "STAR") {
        ac.cmdResumeStar(); msgs.push(`RESUME ${ac.star}`);
      } else msgs.push(`${t}?`);
    }
    return { ok: true, ac, msgs };
  }

  ATC.runCommand = runCommand;
  if (typeof module !== "undefined") module.exports = ATC;
})(typeof window !== "undefined" ? window : globalThis);
