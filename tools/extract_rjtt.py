"""AIP Japan (RJTT) から北風運用の STAR・経路点・滑走路データを抽出して data/rjtt_north.json を生成する。

手順:
  1. AIP RJTT 全文 PDF を取得してテキスト化（Shift された私用領域文字を ASCII に戻す）
  2. 各 RNAV STAR の表形式記述から「経路点列・真方位・区間距離」を抽出
  3. AIP に座標が明記された始点（XAC/AKSEL/AROSA/POLIX）から推測航法で全経路点の座標を計算
     （複数 STAR で同じ点に到達する場合は平均し、ばらつき spread[NM] を記録）
  4. 滑走路端座標は AIP AD2.12 の値を使用

使い方: pip install pypdf cffi && python tools/extract_rjtt.py
"""
import json, math, re, statistics as S, urllib.request, io, os

AIP_URL = "https://nagodede.github.io/aip/japan/documents/RJTT_full.pdf"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "rjtt_north.json")
R_NM = 3440.065

def dms(s):
    s = s.rstrip("NE")
    d, m, x = (s[:2], s[2:4], s[4:]) if len(s.split(".")[0]) == 6 else (s[:3], s[3:5], s[5:])
    return float(d) + float(m) / 60 + float(x) / 3600

def dest(lat, lon, brg, d):
    p1, l1, b = map(math.radians, (lat, lon, brg)); a = d / R_NM
    p2 = math.asin(math.sin(p1) * math.cos(a) + math.cos(p1) * math.sin(a) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(a) * math.cos(p1), math.cos(a) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2)

def dist(a, b):
    p1, l1, p2, l2 = map(math.radians, (*a, *b))
    return R_NM * 2 * math.asin(math.sqrt(math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin((l2 - l1) / 2) ** 2))

def load_text():
    from pypdf import PdfReader
    raw = urllib.request.urlopen(AIP_URL).read()
    pages = []
    for p in PdfReader(io.BytesIO(raw)).pages:
        t = p.extract_text() or ""
        pages.append("".join(chr(ord(c) - 0x3A57) if 0x3A77 <= ord(c) <= 0x3AD6 else c for c in t))
    return pages

def parse_star(p):
    m = re.search(r"([A-Z]+ ?\d[A-Z]) +ARRIVAL", p)
    if not m or "From" not in p or "RWY34R/34L" not in p:
        return None
    seg = p[p.find("From"):]
    desc = " ".join(seg[:seg.find(".") + 1].split())
    seg = seg[:seg.find("Hold")] if "Hold" in seg else seg
    ids = [i for i in re.findall(r"^(?:[A-Z]{5}|[A-Z]{2}\d{3}|[A-Z]{3})\s*$", seg, re.M) if i != "FL150"]
    tc = re.findall(r"^\((\d{3}\.\d)\)\s*$", seg, re.M)
    dd = re.findall(r"^(\d{1,2}\.\d)\s*$", seg, re.M)
    n = len(dd) + 1
    eff = re.findall(r"EFF:([^)]*)", p)
    return m.group(1).replace(" ", ""), dict(fixes=ids[:n], trueCourse=[float(x) for x in tc[:n - 1]],
                                            distNm=[float(x) for x in dd[:n - 1]], description=desc,
                                            effective=eff[0] if eff else None)

def alt_constraints(desc):
    out = {}
    for m in re.finditer(r"to ([A-Z0-9]{3,5}) at (or above |or below )?(FL\d+|\d+FT)", desc.replace("SALL Y", "SALLY")):
        v = m.group(3); ft = int(v[2:]) * 100 if v.startswith("FL") else int(v[:-2])
        out[m.group(1)] = {"or above ": ">=", "or below ": "<="}.get(m.group(2), "=") + str(ft)
    m = re.match(r"From ([A-Z]+) at (FL\d+|\d+FT)", desc)
    if m:
        v = m.group(2); out[m.group(1)] = "=" + str(int(v[2:]) * 100 if v.startswith("FL") else int(v[:-2]))
    return out

def main():
    pages = load_text()
    stars = {}
    for p in pages:
        r = parse_star(p)
        if r and len(r[1]["fixes"]) >= 3:
            r[1]["altitude"] = alt_constraints(r[1]["description"])
            stars[r[0]] = r[1]
    anchors = {"XAC": ("344244.1N", "1392450.5E"), "AKSEL": ("344039.5N", "1395126.9E"),
               "AROSA": ("344201.7N", "1404157.3E"), "POLIX": ("361237.1N", "1402622.5E")}
    anchors = {k: (dms(a), dms(b)) for k, (a, b) in anchors.items()}
    est = {}
    for s in stars.values():
        if s["fixes"][0] not in anchors:
            continue
        pos = anchors[s["fixes"][0]]
        for w, tc, d in zip(s["fixes"][1:], s["trueCourse"], s["distNm"]):
            pos = dest(*pos, tc, d); est.setdefault(w, []).append(pos)
    fixes = {k: dict(lat=v[0], lon=v[1], src="AIP", spreadNm=0.0) for k, v in anchors.items()}
    for k, v in est.items():
        m = (S.mean(p[0] for p in v), S.mean(p[1] for p in v))
        fixes[k] = dict(lat=m[0], lon=m[1], src="AIP-DR", spreadNm=round(max(dist(m, p) for p in v), 3))
    # GODIN: AIP 表で GODIN→CHIPS 189.1°T 11.8NM, CHIPS→COLOR 189.1°T 11.7NM
    c = fixes["COLOR"]; g = dest(c["lat"], c["lon"], 9.1, 23.5)
    fixes["GODIN"] = dict(lat=g[0], lon=g[1], src="AIP-DR(back)", spreadNm=0.0)
    # 進入方式図（ILS Z RWY34L, EFF 2 OCT 2025）に座標記載のある点は AIP 値で上書き（推測航法値との差は 0.05NM 以内）
    for k, (a, b) in {"CREAM": ("351743.4N", "1400612.4E"), "ARLON": ("351525.3N", "1395859.8E"),
                      "APOLO": ("351919.32N", "1395614.78E")}.items():
        drv = fixes.get(k)
        fixes[k] = dict(lat=dms(a), lon=dms(b), src="AIP", spreadNm=0.0)
        if drv:
            fixes[k]["drDiffNm"] = round(dist((dms(a), dms(b)), (drv["lat"], drv["lon"])), 3)
    # 図中に座標記載のない点は opennav 値（滑走路延長線上にあることを検算済み）
    for k, (la, lo) in {"ACTOR": (35.4594444, 139.8403556), "CECIL": (35.4497167, 139.868875),
                        "CREST": (35.4786167, 139.8484222), "UTIBO": (34.9463944, 139.8955278)}.items():
        fixes[k] = dict(lat=la, lon=lo, src="opennav", spreadNm=None)
    rw = {"34L": ("353211.76N", "1394708.41E", 329.88, 18.2), "34R": ("353233.02N", "1394811.34E", 329.88, 19.7),
          "16L": ("353346.27N", "1394719.34E", 149.88, 19.2), "16R": ("353322.47N", "1394618.19E", 149.88, 16.4),
          "04": ("353256.47N", "1394540.60E", 35.01, 19.0), "22": ("353402.88N", "1394637.61E", 215.01, 35.0),
          "05": ("353126.41N", "1394812.47E", 42.56, 45.5), "23": ("353226.15N", "1394919.61E", 222.56, 54.7)}
    runways = {k: dict(lat=dms(a), lon=dms(b), trueHdg=h, thrElevFt=e) for k, (a, b, h, e) in rw.items()}
    data = dict(
        meta=dict(airport="RJTT", config="north (34L/34R arrivals)", magVar=-7.9,
                  source=AIP_URL, note="AIP Japan RJTT AD2 (STAR EFF 31 OCT 2024 / IAC EFF 2 OCT 2025). Not for navigation."),
        runways=runways, fixes=dict(sorted(fixes.items())), stars=stars,
        approaches={
            # ILS Z RWY34L: CREAM(IAF)/ARLON(IF) 5000, APOLO(FAF) D15.1 IHA, LOC 111.7 IHA
            "34L": dict(name="ILS Z RWY34L", legs=[["ARLON", "=5000"], ["APOLO", "=5000"]], faf="APOLO", gpDeg=3.0),
            # ILS Z RWY34R: CREAM(IAF) 4000 - CLOAK - CAMEL(IF) 4000 - CACAO(FAF) D12.1 ITC, LOC 108.9 ITC
            "34R": dict(name="ILS Z RWY34R", legs=[["CREAM", "=4000"], ["CLOAK", "=4000"], ["CAMEL", "=4000"], ["CACAO", "=4000"]],
                        faf="CACAO", gpDeg=3.0)},
        speeds=dict(note="ILS Z 34L/34R: 180KIAS at D10.0, 160KIAS at D5.0"))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(data, open(OUT, "w"), indent=1, ensure_ascii=False)
    with open(OUT[:-5] + ".js", "w") as f:  # file:// で開いても読めるよう JS として同梱
        f.write("window.RJTT = " + json.dumps(data, ensure_ascii=False) + ";\n")
    print(f"stars={len(stars)} fixes={len(fixes)} -> {OUT}")

if __name__ == "__main__":
    main()
