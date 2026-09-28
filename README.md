# 低軌道旅行

地球低軌道（ISS 相当）を周回する宇宙船から、地球・大気・雲・夜の闇を眺めるカジュアルゲームの試作。
スマホ横画面が主対象。Three.js + Vite + TypeScript。

## 開発

```sh
npm ci
npm run dev      # 開発サーバ
npm run build    # dist/ に静的ビルド
npm test         # 軌道計算のテスト
```

`main` への push で GitHub Actions が GitHub Pages へ公開する（Settings → Pages → Source を「GitHub Actions」にしておく）。

## URL パラメータ（検証用）

| パラメータ | 内容 |
|---|---|
| `?t=2026-09-28T05:00:00Z` | 開始時刻を固定 |
| `?stats=1` | fps・描画三角形数・描画呼び出し数を表示 |
| `?detail=7` / `?detail=9` | 地形の細かさ（既定 8） |
| `?adaptive=0` | 解像度の自動調整を止める |
| `?post=0` | 仕上げ処理（光の滲み・色調・粒子）を切る |

## 設計資料

- `docs/design.md` — 設計叩き台とレビュー
- `docs/art-direction.md` — 見た目の方針

## クレジット

- 陸地形状: Natural Earth（world-atlas 経由, パブリックドメイン）
- 標高画像: three-globe（vasturiano, MIT）のサンプル画像 `earth-topology.png`。元データの出典は未確認
- 宇宙船は架空のもので、実在の機関・機体とは無関係
