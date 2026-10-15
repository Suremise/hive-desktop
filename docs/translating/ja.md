# 日本語 (`ja`): style for Hive

**Status:** drafted by AI (Claude, October 2026), not yet reviewed by a native speaker. Its entry in
`src/shared/i18n/languages.ts` says the same (`ai: true` until it is reviewed).

**In the language picker:** 日本語, marked (AI) while drafted by AI, with the note 「AI による翻訳です。改善を歓迎します。」

**Improving it:** every Japanese message is in `locales/ja/<area>.json`, one file per part of Hive. If a word is
wrong, stiff or unclear, change it there and open a pull request on GitHub (`Suremise/hive-desktop`):
`CONTRIBUTING.md` says how, and a small fix can be made in GitHub's web editor. If you change a term from the table
below, change it in every message and on this page in the same pull request, so Hive keeps one voice. A native
speaker's review takes the (AI) mark off.

## Voice

Hive's English is plain and direct: short sentences, everyday words, *you* for the reader, and it says what happens.
Translate the meaning, not the words, and keep the result as short and plain.

- **Politeness:** sentences end in the polite form (です／ます): descriptions, tooltips, messages, dialogs, errors
  (「エージェントを削除しました。」, 「この操作は元に戻せません。」). Never the plain form (だ／である) in a sentence,
  and never honorific or humble keigo (〜させていただきます, ご〜ください beyond the usual 「ください」).
- **Addressing the reader:** leave out the subject, as Japanese does. Never あなた. Where the English says *your*,
  usually say nothing (「プロジェクト」, not 「あなたのプロジェクト」); where it matters, 「自分の」.
- **Tone:** friendly and direct. Prefer a verb to a chain of kanji nouns (「保存できませんでした」, not
  「保存処理の実行に失敗しました」). Katakana loanwords are fine where developers use them (セッション, コミット),
  but don't invent new ones where a plain Japanese word exists.
- **Sentence length:** split a long English sentence into two. Japanese is usually shorter than English on screen,
  but it can't break inside a long katakana word gracefully, so keep labels short.

## Buttons, commands, titles

- **Buttons and menu commands:** a plain verb phrase or a noun, no です／ます: 「保存」, 「削除」, 「キャンセル」,
  「エージェントを追加…」, 「設定を開く」. The same form everywhere, including the command palette.
- **Headings, labels, column names, status words:** nouns or short plain phrases: 「設定」, 「作業中」, 「待機中」.
- **A trailing `…`** stays, with no space before it: 「エージェントを削除…」.
- **Column headings:** 保留, 未着手, 進行中, レビュー, 承認済み, 完了.

## Grammar

- **Names have no gender** in Japanese, so agreement isn't a problem. Put a particle straight after a placeholder:
  「{agent}を削除しました」, 「{project}のエージェント」.
- **Plurals:** Japanese has only the CLDR category *other*. Every plural message gives just `other`, plus any `=0`
  or `=1` case the English has: `{n, plural, other {#件のカード}}`. Never add `one`. Where the English `one` holds a
  different sentence or a placeholder the `other` lacks (`one {Remove {agent}…}`), use `=1` for it.
- **Counters:** cards, sessions, files, messages, events, items: 件 (「#件のカード」, 「カード#件」). Agents: 個
  (「#個のエージェント」). Lines: 行. Steps: ステップ. Use the counter, not a bare number, wherever a noun is counted.
- **Placeholders:** a placeholder like `{project}` or `{agent}` is a name inserted as it is. A placeholder that holds a
  sentence or a status is placed after a colon (：), so it can stand on its own.
- **Lists:** Hive joins lists itself (「One、Two、Three」). Never write 「と」 or 「または」 into a message around a list
  placeholder.

## Punctuation and typography

- **Sentence punctuation:** full-width 。 and 、. A message that is a single label or button has no 。.
- **Quotation marks:** 「…」, and 『…』 inside them. Never " in the text. A command, setting or tab named in a
  sentence goes in 「」 too: 「設定」→「詳細」, 「エージェントを追加…」.
- **Colon and parentheses:** full-width ：and （） in Japanese text; half-width : and () only around code, numbers or
  English alone (「Ctrl+K」, 「(--lang)」).
- **Spaces:** no space between Japanese and Latin letters or numbers (「Claude Codeのセッション」, 「5分」), except where
  the English already has one inside a name or command.
- **Apostrophe:** Japanese has none. Before `{`, `}` or `#`, a straight apostrophe starts an ICU quotation: keep the
  English's `'{'` exactly as it is.
- **Numbers, dates, money, durations:** formatted by Hive in the Japanese way. Never write them into a message.

## Terms

The words Japanese uses for Hive's terms ([glossary.md](glossary.md)). Use them every time.

| English | 日本語 | Notes |
|---|---|---|
| workspace | ワークスペース | |
| project | プロジェクト | |
| agent | エージェント | |
| provider | プロバイダー | Claude Code, Codex or Copilot. |
| session | セッション | |
| the Assistant | アシスタント | The full name *Hive Assistant* stays in English. |
| persona | ペルソナ | |
| task board / board | タスクボード / ボード | The *Tasks* tab is 「タスク」. |
| card | カード | Never 「タスク」 for a card in running text. |
| On Hold / Todo / Doing / Review / Passed / Done | 保留 / 未着手 / 進行中 / レビュー / 承認済み / 完了 | *完了* means merged; *承認済み* means it passed its review but isn't merged. Agents' tool text keeps the English ids. |
| decision | 決定事項 | |
| blocked / stalled | ブロック中 / 停滞 | |
| builder / reviewer | ビルダー / レビュアー | |
| review (the act) | レビュー | |
| card loop / lane / round | カードループ / レーン / ラウンド | |
| merge slot | マージ枠 | |
| inbox / message / wake | 受信箱 / メッセージ / ウェイク（起こす） | |
| handover / shared notes | 引き継ぎ（引き継ぎメモ） / 共有ノート | |
| skill / template | スキル / テンプレート | A skill's own name (`work-on-card`) stays as it is. |
| worktree / branch / commit / merge | ワークツリー / ブランチ / コミット / マージ | *remote*: リモート. |
| uncommitted | 未コミット | |
| staged / fetch / pull / push | ステージ済み / フェッチ / プル / プッシュ | |
| Progress panel / run | 進捗パネル / 実行 | |
| Workspace Overview | ワークスペース概要 | |
| permission mode (Manual, Accept edits, Plan, Auto, Don't ask) | 権限モード（手動、編集を承認、プラン、自動、確認しない） | The CLIs' own screens stay in English. |
| effort / usage / cost / tokens | エフォート / 使用量 / コスト / トークン | Effort levels: 低、中、高、最高… *API-equivalent cost*: 「API換算コスト」. |
| banner / notification / tip | バナー / 通知 / ヒント | A *notification* is Windows'; a *banner* is inside Hive's window. |
| sign in / sign out | サインイン / サインアウト | |
| tab / settings | タブ / 設定 | |
| conversation / transcript | 会話 / トランスクリプト | |
| status line (a CLI's) / status bar (Hive's) | ステータスライン / ステータスバー | |
| compact / compaction | コンパクト化 | |
| prompt / prompt cache | プロンプト / プロンプトキャッシュ | |
| archive / unarchive | アーカイブ / アーカイブから戻す | |
| Start New (a session) / Archive and Start New | 新規開始 / アーカイブして新規開始 | |
| Hand Over to… | 引き継ぐ… | |
| watch (a card watch) | 監視 | |
| verdict | 判定 | |
| redacted / masked | 機密情報を伏せた / マスク済み | Never 「編集済み」, which means edited. |
| Storage (a project's) / Clean Up… | ストレージ / クリーンアップ… | |
| Repair (a moved workspace) | 修復 | |
| Recycle Bin / File Explorer | ごみ箱 / エクスプローラー | |
| Agent Setup | エージェントのセットアップ | |
| Mark idle | アイドルにする | |
| layouts | 1つずつ、2列、3列、2×2グリッド、3×2グリッド | |
| the Assistant's modes | コーディネーター、プランナー、QAトリアージ担当、リリースマネージャー | |
| hook / timeout | フック / タイムアウト | |
| Session tab / Sessions tab | 「セッション」タブ / 「セッション履歴」タブ | Japanese has no plural, so the Sessions tab (past conversations) is セッション履歴. |
| Agent Settings / Project Settings | エージェント設定 / プロジェクト設定 | |
| Settings sections | 全般、外観、通知、セッション、エージェントとワークツリー、プロバイダー、アシスタント、ボード、ワークスペース、キーボードショートカット、更新、詳細、Agent API | Cited as 「設定」→「全般」→「…」. |
| menus | ファイル、編集、表示、プロジェクト、セッション、ヘルプ | |
| Finished (an agent's status) | 作業終了 | Never 完了, which is the Done column. |
| Working on (the sidebar's marking) | 作業対象 | 作業中 is the Working status. |
| Copy Diagnostics / Developer Console / Agent Setup | 診断情報をコピー / 開発者コンソール / エージェントのセットアップ | |
| run states (Progress panel) | 実行中、失敗、成功、停止、待機中 | A run that passed is 成功, not 承認済み. |

## Examples

| English | 日本語 |
|---|---|
| Remove agent… | エージェントを削除… |
| {name} has {n, plural, one {# open card} other {# open cards}} | {name}：未完了のカード{n, plural, other {#件}} |
| {agent} was removed. Its sessions stay in the Sessions tab. | {agent}を削除しました。セッションは「セッション」タブに残ります。 |
| Hive was started in {language} (--lang): this setting applies from its next start. | Hiveは{language}で起動されています（--lang）。この設定は次回の起動から適用されます。 |
| Could not load {what}: {error} | {what}を読み込めませんでした：{error} |

## Checking

- `npm run i18n:check` passes, and `npm run i18n:coverage` shows what is still missing or outdated.
- Look at the screenshots: `npm run e2e -- --lang ja --build`, in both themes, for text that is cut off, a font that
  doesn't fall back to a Japanese one, or line breaks in odd places.
- A reviewer should look first at the polite form in sentences, the counters, and that no plural has a `one` case.
