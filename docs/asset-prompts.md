# 素材生成プロンプト（ChatGPT の画像生成用）

地面・轍・畑土・スレート屋根・林床・砂・雪などは CC0 の Poly Haven で調達済み／調達可能なので、ここには
**Poly Haven に無いものだけ**を載せています。

## 共通ルール（どのプロンプトにも含めてあります）
- 正方形 1024×1024（「square」）。PNG で保存。
- 真上から・遠近なし・曇天の拡散光・強い影なし・色補正なし（フィルム調やビネットは後で一括で掛けるので不要）。
- 継ぎ目なし（タイル）は ChatGPT では完全には出ないことが多いので、こちらで加工します。気にしなくて大丈夫です。
- 切り抜き素材は「transparent background」。透過が出ない場合は純白背景で可。
- ファイル名は見出しの `name` で。複数案は `_a` `_b`。

## 優先（1905年テストで使う）

### canopy_deciduous_sheet
```
Square image, 1024x1024, transparent background. Four separate deciduous tree crowns (oak, ash, lime, beech) photographed from directly above, arranged in a 2x2 grid with space between them. True top-down aerial view, no perspective, no trunks visible, no ground, no shadows cast on the ground. Soft overcast daylight, natural spring-green foliage with individual leaf clusters and small gaps showing the dark interior. Realistic aerial photograph, neutral colour, no filter, no vignette.
```

### canopy_conifer_sheet
```
Square image, 1024x1024, transparent background. Four separate conifer tree crowns (spruce, pine, fir, larch) seen from directly above in a 2x2 grid with space between them. True top-down aerial photo, no perspective, star-shaped branch tips visible, dark blue-green needles, soft overcast light, no cast shadows, no ground. Realistic, neutral colour, no filter.
```

### canopy_forest_tile
```
Square image, 1024x1024. Dense temperate mixed forest canopy photographed from directly above by a drone, filling the entire frame edge to edge with no gaps or clearings, many individual crowns of varied size and green tones, a few darker conifers. True orthographic top-down view, soft overcast light, no strong shadows, no horizon. Realistic aerial photograph, neutral colour, no filter, no vignette. Should work as a repeating texture.
```

### hedge_topdown
```
Square image, 1024x1024, transparent background. A single long old hawthorn and blackthorn hedgerow photographed from directly above, running horizontally straight across the whole width of the image, about one fifth of the image tall, irregular bushy edges, small gaps, a few white blossoms. True top-down view, soft overcast light, no ground, no cast shadow. Realistic aerial photograph, neutral colour.
```

### wall_whitewash
```
Square image, 1024x1024. Straight-on orthographic photograph of an old whitewashed wooden clapboard house wall, horizontal boards, slightly weathered paint, faint grey rain streaks, no windows, no doors, fills the entire frame. Soft overcast light, no shadows from other objects. Realistic, neutral colour, no filter. Should work as a repeating texture.
```

### reference_polaroid（素材ではなく色合わせの見本。2〜3枚）
```
An instant Polaroid photograph taken from a small low-flying aircraft around 1905: a gentle green hill with a single small white wooden house with a dark slate roof and a brick chimney, a kitchen garden with a picket fence, a stone well, a low dry-stone wall, a hawthorn hedgerow, and a faint dirt cart track passing below the house. Spring morning, long soft shadows, thin mist in the lower fields, muted instant-film colour with teal shadows and creamy highlights, slight softness, natural vignetting, quiet and nostalgic. No text, no border.
```

## 第2弾（時代が進んだら使う）

### facade_apartment
```
Square image, 1024x1024. Straight-on orthographic photograph of a plain 1970s–1990s concrete apartment block facade, regular grid of windows with small balconies, some curtains, a few air-conditioner units, rain stains under the sills, fills the entire frame edge to edge, no sky, no ground. Soft overcast light. Realistic, neutral colour, no filter. Should work as a repeating texture.
```

### facade_office
```
Square image, 1024x1024. Straight-on orthographic photograph of a mid-century office tower facade, repeating grid of windows between concrete or stone mullions, slightly reflective dark glass, weathering stains, fills the entire frame, no sky, no ground. Soft overcast light. Realistic, neutral colour. Should work as a repeating texture.
```

### facade_tower_future
```
Square image, 1024x1024. Straight-on orthographic photograph of a very tall late-21st-century residential megatower facade: dense repeating grid of small windows and recessed balconies, grey composite panels, some stains and patched panels, no logos, fills the entire frame, no sky. Soft overcast light. Realistic, understated, not glossy sci-fi, neutral colour.
```

### roof_flat_city
```
Square image, 1024x1024. City rooftops photographed from directly above: flat tar and concrete roofs with water tanks, vents, air-conditioning units, small stairwell huts, drains and puddle stains, filling the whole frame. True orthographic top-down view, soft overcast light, no strong shadows. Realistic aerial photograph, neutral colour. Should work as a repeating texture.
```

### facade_ruin_vines
```
Square image, 1024x1024. Straight-on orthographic photograph of an abandoned concrete apartment facade decades after people left: empty window openings, broken frames, dark water stains, moss, ivy and climbing plants covering the lower half, small trees growing from ledges, fills the entire frame. Soft overcast light. Realistic, quiet, not post-apocalyptic drama, neutral colour.
```

### rubble_concrete
```
Square image, 1024x1024. Collapsed concrete building rubble photographed from directly above: broken slabs, twisted rebar, bricks, dust, filling the entire frame. True top-down view, soft overcast light, no strong shadows. Realistic aerial photograph, muted neutral colour. Should work as a repeating texture.
```

### rubble_overgrown
```
Square image, 1024x1024. Old building rubble centuries later photographed from directly above: blocks and slabs half buried under grass, moss, brambles and young birch and sycamore saplings, filling the entire frame. True top-down view, soft overcast light. Realistic aerial photograph, neutral colour. Should work as a repeating texture.
```

### shallow_sea
```
Square image, 1024x1024. Very shallow calm sea over pale sand photographed from directly above by a drone: sand ripples visible through clear water, faint patches of seaweed, subtle gentle surface ripples, soft overcast light, no sun glint, no waves breaking, no shore, fills the entire frame. Realistic aerial photograph, muted slate-green and sand colour, no filter. Should work as a repeating texture.
```

### tidal_flat
```
Square image, 1024x1024. A wet tidal mudflat photographed from directly above: shallow water channels, sand ripples, puddles reflecting a grey sky, some green algae, filling the entire frame. True top-down view, soft overcast light. Realistic aerial photograph, muted colour. Should work as a repeating texture.
```

### dry_steppe
```
Square image, 1024x1024. Dry eroded steppe ground photographed from directly above: sparse tufts of pale dry grass, cracked sandy soil, scattered small stones, filling the entire frame. True top-down view, soft overcast light, no strong shadows. Realistic aerial photograph, muted ochre colour. Should work as a repeating texture.
```

### ice_patchy
```
Square image, 1024x1024. Patchy old snow and ice lying on dark wet ground and dead grass, photographed from directly above, meltwater stains, grit on the ice, filling the entire frame. True top-down view, soft overcast light. Realistic aerial photograph, cool muted colour. Should work as a repeating texture.
```
