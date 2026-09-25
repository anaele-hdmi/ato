"""作品ファイルを GitHub Pages 用の完全な HTML に包んで docs/ に書き出す。

作品ファイル（kaeru/index.html など）は <title>・<style>・本文だけを持つ形式で、
Claude のアーティファクトとしても公開できるようにしてある。Pages では doctype と
viewport の指定が要るため、ここで補う。

使い方: python3 tools/build_pages.py
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
WORKS = [
    ("kaeru", "還る部屋", "1926年から閉ざされた部屋に、光と水と時間が植物を呼び戻していく。"),
    ("dust-floor", "塵の床", "東京の実際の太陽の位置で光が差し込む、100年分の塵が積もった床。"),
]

HEAD = """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<style>:root{{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0}}[hidden]{{display:none!important}}</style>
</head>
<body>
{body}
</body>
</html>
"""

INDEX = """<title>ato</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@400;600&display=swap">
<style>
  :root {{ --ground: #07080a; --ink: #ebe5da; --dim: #a39d92; --line: rgba(235,229,218,.16); }}
  body {{ background: var(--ground); color: var(--ink); font-family: "Shippori Mincho", "Hiragino Mincho ProN", "Yu Mincho", serif; }}
  main {{ max-width: 560px; margin: 0 auto; padding-inline: 16px; padding-block: 72px 48px; }}
  h1 {{ font-weight: 400; font-size: 16px; letter-spacing: .5em; margin: 0 0 40px; }}
  a {{ color: inherit; text-decoration: none; display: block; border-top: 1px solid var(--line); padding: 18px 0; }}
  a:hover h2, a:focus-visible h2 {{ text-decoration: underline; text-underline-offset: 4px; }}
  h2 {{ font-weight: 600; font-size: 15px; letter-spacing: .2em; margin: 0 0 6px; }}
  p {{ margin: 0; color: var(--dim); font-size: 13px; line-height: 1.9; }}
</style>
<main>
  <h1>ato</h1>
{items}
</main>
"""


def main():
    DOCS.mkdir(exist_ok=True)
    (DOCS / ".nojekyll").write_text("")
    for name, _, _ in WORKS:
        body = (ROOT / name / "index.html").read_text(encoding="utf-8")
        out = DOCS / name / "index.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(HEAD.format(body=body), encoding="utf-8")
    items = "\n".join(
        f'  <a href="{name}/"><h2>{title}</h2><p>{desc}</p></a>' for name, title, desc in WORKS
    )
    (DOCS / "index.html").write_text(HEAD.format(body=INDEX.format(items=items)), encoding="utf-8")
    print("docs/ に書き出しました:", ", ".join(n for n, _, _ in WORKS))


if __name__ == "__main__":
    main()
