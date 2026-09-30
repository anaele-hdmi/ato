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
| `?hires=0` | 高解像度 DEM を使わず、従来の粗い標高（2048x1024）だけにする |
| `?adaptive=0` | 解像度の自動調整を止める |
| `?dpr=N` | 描画解像度の上限を上書き（既定 2。デバイスの devicePixelRatio は超えない。重ければ自動で下がる） |
| `?post=0` | 仕上げ処理（光の滲み・色調・粒子）を切る |
| `?flare=0` | 太陽のグレア・レンズフレア・まぶしさによる露出の絞りを切る（太陽の円盤は残る） |
| `?dof=0` | 被写界深度（船内の窓枠のボケ／外からの視点で寄ったときの背景ボケ）を切る |

## 標高データの再生成

実行時に使う標高・水深アセット（`src/assets/dem/`）は事前変換でコミット済み。元データは含めない。作り直すとき:

```sh
npm i --no-save sharp                 # エンコーダ（この変換のときだけ）
node scripts/build-dem.mjs            # NOAA から取得（約 900 MB, 数分）→ 変換
```

プロキシ越しは `NODE_USE_ENV_PROXY=1`。取得結果は一時ディレクトリにキャッシュされる（`--cache <dir>`）。

## 設計資料

- `docs/design.md` — 設計叩き台とレビュー
- `docs/art-direction.md` — 見た目の方針

## クレジット

- 陸地形状: Natural Earth（world-atlas 経由, パブリックドメイン）
- 標高画像: three-globe（vasturiano, MIT）のサンプル画像 `earth-topology.png`。元データの出典は未確認
- 標高・水深: NOAA NCEI, ETOPO 2022 Global Relief Model の 60 arc-second 版（ice surface, EGM2008 高度）。パブリックドメイン（米国政府作品）。DOI 10.25921/fd45-gt74。`scripts/build-dem.mjs` で 0.05° の陸標高タイル（`elev_*.webp`）と 0.1° の水深＋湖マスク（`bath.webp`）に変換
- 湖沼: Natural Earth 1:50m Lakes（パブリックドメイン）。`bath.webp` の G チャンネルに焼き込み
- 夜景の灯り: NASA Earth Observatory / NASA GSFC「Black Marble」2016（Suomi NPP VIIRS、パブリックドメイン、https://earthobservatory.nasa.gov/features/NightLights ）。`scripts/build-city-lights.mjs` で 2048×1024 の単チャンネル WebP（`src/assets/city-lights.webp`）に変換
- 恒星データ: d3-celestial © 2015 Olaf Frohn, BSD-3-Clause（Hipparcos 由来）
- 月の位置・位相: Jean Meeus『Astronomical Algorithms』第47・48章の主要項のみの簡略式（自前実装、出典は式のみ）。月面の海の位置は IAU 月面座標の概略値
- 地磁気双極子: 北磁極 80.7°N 72.7°W（IGRF-13 の中心双極子近似）。オーロラの活動度は日付シードの疑似乱数（実際の宇宙天気ではない）
- 流星群の極大日・ZHR: IMO（国際流星機構）の主要流星群リストの概数
- 宇宙船は架空のもので、実在の機関・機体とは無関係
