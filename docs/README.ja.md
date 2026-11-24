# ドロシー（`ds-dot`）

**[ドロシーの手帳（公式ページ・実機録画）](https://klarkxy.github.io/ds-dot/)** · [English](../README.md) · [简体中文](README.zh-CN.md)

[![スーツケースと傘を手に玄関先へやってきたドロシー](images/dot-arrival.png)](https://klarkxy.github.io/ds-dot/)

**ドロシー（`dot`）** は **DeepSeek Harness（DSH）** のサイドバーに住む常駐パートナーです。ふだんの言葉で頼めば複数の作業を並行して整え、確認しやすい前後の差分で返してくれます。小さな確認は静かに通し、大事な操作の前だけ必ず止まって相談します。

> **詳しい読み物と実機クリップ：** **[ドロシーの手帳](https://klarkxy.github.io/ds-dot/)** でイラスト付きの日記、[9 本の実機スクリーン録画](https://klarkxy.github.io/ds-dot/#clips)、[最初の一言サンプル](https://klarkxy.github.io/ds-dot/#about) をまとめて見られます。

## インストール

**DSH `0.2.2-rc.5` 以降** が必要です（プレリリースは `ds-dot@next`）：

```sh
dsh plugin --profile web add ds-dot
```

案内に従ってプロファイルを再起動したら、サイドバーから **ドロシー** を開いてそのまま話しかけられます（画像添付も可）：

```text
このドキュメントのリンク切れを直して、取り込む前に差分を見せて。
いま動いているセッションの中で、私の判断待ちがあるか教えて。
平日の朝 9 時に夜間ビルドを見るようリマインドして。
```

## 特長

- **並列進行と見やすい差分：** ぶつからない作業は同時に進めたり別ブランチで隔離して作業します。渡す前に自分で確かめ、削除ファイルも含めた差分から行を指定して差し戻せます（3 回詰まると停止して相談）。
- **明確な確認ライン：** 安全な参照確認やローカルテストは静かに実行し、削除・外部送信・機密ファイルアクセスや迷う場面では確認カードで停止します。パネルを閉じていてもバッジや通知でお知らせします。ファイル編集・コマンド実行・プラグイン管理のツールは派遣タスク専用で、ドロシー自身は使いません。
- **レシピと定時実行：** いつもの週次手順をレシピとして保存し、自然言語のリマインダーから直接起動可能。調整後に調子が落ちたら旧版への復元案も出します。
- **項目ロックと追加連携：** 変えたくない設定には個別にロックをかけられ、他プラグインの追加ツールは既定オフ。必要に応じて `@klarkxy/dsh-dev-index`、`@klarkxy/dsh-model-picker`、`@deepseek-ai/dsh-webhook` と連携できます。
- **Dorothy 専用 MCP サーバー：** 「MCP サーバー」ページで DeepWiki・GitHub・Context7 などのリモートサービスや独自サーバーを接続。Dorothy だけにマウントされ、接続後も「追加機能」での明示的な許可がないとツールは呼び出せません。

## リンク

- [ドロシーの手帳（GitHub Pages）](https://klarkxy.github.io/ds-dot/) — 日記、[実機録画](https://klarkxy.github.io/ds-dot/#clips)、[導入ガイド](https://klarkxy.github.io/ds-dot/#about)
- [技術リファレンス](reference.md) — 承認モード、自動遮断ルール、プロファイル設定、GitHub Webhook の `cordis.yml` 設定、アップグレード案内
- [コントリビュート](https://github.com/klarkxy/ds-dot/blob/main/CONTRIBUTING.md) · [リリース手順](https://github.com/klarkxy/ds-dot/blob/main/docs/releasing.md) · [Apache-2.0 ライセンス](../LICENSE)
