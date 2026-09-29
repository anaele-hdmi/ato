# 引き継ぎ：デザイン言語「one-limb」のスキル化

## 目的
「低軌道旅行」のホーム画面アイコン（黒地に地球の縁の弧1本）に表れたデザイン言語を、再利用できる Claude スキルとして確立する。用途は、アプリアイコン、ZINE表紙、音楽ジャケット、サムネイルなど「一枚で世界観を伝える」静止デザイン。

## これまでの経緯（事実）
- アイコンの出どころ：`anaele-hdmi/ato` の `public/icon.svg`（コミット d706503）。Opus が「黒地に惑星の縁の細い弧」と1行だけ指示し、Sonnet のサブエージェントが描いた。仮置きのつもりで作り、その後は一度も手を入れていない。
- ユーザーの評価：「この曲線一本ですべてを雄弁に語っている」。
- 叩き台：同リポジトリの `docs/design-language-skill/` にある（ブランチ `claude/sleepy-goodall-nvs3ja`）。
  - `SKILL.md`：スキルの叩き台 v0.1。原則5つ、数値テンプレート、作り方の手順、チェックリスト、弱点、検証計画、例。
  - `examples/limb-icon.svg`：基準の例（アイコンのコピー）。

## 不確実な点
- 原則は、完成したアイコン1点を**後から分解して言語化したもの**。別の主題で再現できるかは未検証。
- 「線の太さ ≒ 大気の厚みの比率」は偶然の一致で、意図した設計ではない。

## ローカル環境への取り込み（最初に一度だけ・ユーザーが手元で実行）
クラウドのセッションは終了すると消えるため、ファイルは GitHub から手元に持ってくる。

1. ファイルを取得する（どちらか）
   - git を使う場合：
     ```sh
     git clone -b claude/sleepy-goodall-nvs3ja https://github.com/anaele-hdmi/ato.git
     ```
     （リポジトリが非公開なら GitHub へのログインが必要）
   - git を使わない場合：GitHub の Web 画面でブランチ `claude/sleepy-goodall-nvs3ja` に切り替え、`docs/design-language-skill/` の3ファイル（`SKILL.md`、`HANDOFF.md`、`examples/limb-icon.svg`）をダウンロードする。
2. 作業用フォルダを作り、3ファイルを置く（例：`~/work/one-limb/`）。ato リポジトリとは切り離して扱う。
3. そのフォルダで Claude Code を起動し、次の文を渡す：
   > `HANDOFF.md` を読んで、「次のセッションでやること」から進めて。

スキルとして有効にするのは v1.0 が固まってから（手順5）。叩き台の段階で有効にすると、未検証の原則が他の作業に混ざるため。

## 次のセッションでやること（ローカルの Claude Code で実施）
前提：作業フォルダに `SKILL.md`、`HANDOFF.md`、`examples/limb-icon.svg` がある。

1. `SKILL.md` を読む。
2. 検証計画（§6）に沿って、同じ原則で別主題を2〜3点試作する（SVG）。
   - 候補：別アプリのアイコン、ZINE表紙、音楽ジャケット。
   - 試作は作業フォルダの `trials/` に SVG で保存する。
3. 試作をユーザーに見せ、「原則だけで同じ質に届いたか」を判定してもらう。
   - ユーザーは SVG をブラウザにドラッグして確認できる。
   - 小サイズの確認：同じ SVG を 60px・180px 表示にした比較用 HTML（`trials/preview.html`）を作ると早い。
4. 結果に応じて原則・数値を修正し、`SKILL.md` を v1.0 にする。
5. スキルとして有効にする。置き場所は次のどちらか（ユーザーが選ぶ）。
   | 置き場所 | パス | 効く範囲 |
   |---|---|---|
   | 個人スキル | `~/.claude/skills/one-limb/`（Windows は `%USERPROFILE%\.claude\skills\one-limb\`） | そのPCのすべてのプロジェクト |
   | プロジェクトスキル | `<作業フォルダ>/.claude/skills/one-limb/` | そのフォルダ内だけ |
   - フォルダには `SKILL.md` と `examples/` を入れる。`HANDOFF.md` と `trials/` は入れない。
   - Claude Code を再起動し、スキル一覧に one-limb が出るかを確認する。
   - 版の管理が必要なら、作業フォルダを git 管理にする（任意）。

## ユーザーの嗜好（このテーマに関係するもの）
- 静かで知的、過剰でない表現。フィルムライク、記憶感、物語性。
- 構造化・表・叩き台を好む。根拠のない推測、ポエム、一般論は嫌う。
- 回答は日本語で簡潔に。不確実な点は明示する。質問で締めない。

## 参考：アイコンの SVG 全文
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#000000"/>
  <defs>
    <linearGradient id="limb" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="#0b2b4a"/>
      <stop offset="45%" stop-color="#1c6a9a"/>
      <stop offset="100%" stop-color="#cdeeff"/>
    </linearGradient>
  </defs>
  <circle cx="256" cy="640" r="420" fill="none" stroke="url(#limb)" stroke-width="8"/>
</svg>
```
