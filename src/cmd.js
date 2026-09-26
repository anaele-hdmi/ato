// コマンド解析: "JAL123 L250 A50 S190" / "D ARLON" / "HOLD WEDGE" / "C 34L" / "ACC" / "TWR" / "STAR"
(function (g) {
  const ATC = (g.ATC = g.ATC || {});

  // 1 つの指示を機体に適用。戻り値 { ok, msg }
  function apply(ac, verb, arg) {
    if (verb === "ACC") return ac.accept();
    if (ac.ctl === "OFFER") return { ok: false, msg: "先に通信設定（ACC）" };
    if (ac.ctl === "TWR") return { ok: false, msg: "タワーへ移管済み" };
    switch (verb) {
      case "H": case "L": case "R": return ac.cmdHeading((+arg % 360) || 360, verb === "L" ? -1 : verb === "R" ? 1 : 0);
      case "A": return ac.cmdAltitude(+arg * 100);
      case "S": return ac.cmdSpeed(+arg);
      case "D": return ac.cmdDirect(arg);
      case "HOLD": return ac.cmdHold(arg);
      case "C": return ac.cmdClearApproach(arg);
      case "STAR": return ac.cmdResumeStar();
      case "TWR": return ac.handoffTower();
    }
    return { ok: false, msg: `${verb}?` };
  }

  // 1 行を解析して適用。戻り値 { ok, ac, msgs[] }。selected は選択中の機体（便名省略時に使う）
  function runCommand(line, aircraft, selected) {
    const toks = line.trim().toUpperCase().split(/\s+/).filter(Boolean);
    if (!toks.length) return { ok: false, msgs: [] };
    let ac = selected;
    if (/^[A-Z]{2,3}\d/.test(toks[0])) {
      const hit = aircraft.filter((a) => a.state === "AIR" && a.cs.startsWith(toks[0]));
      if (hit.length !== 1) return { ok: false, msgs: [`${toks[0]}: ${hit.length ? `該当 ${hit.length} 機` : "該当なし"}`] };
      ac = hit[0]; toks.shift();
    }
    if (!ac) return { ok: false, msgs: ["機体をタップして選ぶか、便名から入力"] };

    const msgs = []; let ok = true;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]; let m, r;
      if ((m = /^([HLR])(\d{1,3})$/.exec(t))) r = apply(ac, m[1], m[2]);
      else if ((m = /^A(\d{1,3})$/.exec(t))) r = apply(ac, "A", m[1]);
      else if ((m = /^S(\d{3})$/.exec(t))) r = apply(ac, "S", m[1]);
      else if ((t === "D" || t === "HOLD" || t === "C") && toks[i + 1]) r = apply(ac, t, toks[++i]);
      else if (t === "ACC" || t === "TWR" || t === "STAR") r = apply(ac, t);
      else r = { ok: false, msg: `${t}?` };
      if (!r.ok) ok = false;
      msgs.push(r.msg);
    }
    return { ok, ac, msgs };
  }

  Object.assign(ATC, { runCommand, applyCommand: apply });
  if (typeof module !== "undefined") module.exports = ATC;
})(typeof window !== "undefined" ? window : globalThis);
