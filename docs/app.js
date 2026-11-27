(() => {
  'use strict';

  const GIF_BASE = 'https://raw.githubusercontent.com/klarkxy/ds-dot/docs/demo-assets/';
  const PR_BASE = 'https://github.com/klarkxy/ds-dot/pull/';
  const REPO_URL = 'https://github.com/klarkxy/ds-dot';
  const INSTALL_CMD = 'dsh plugin --profile web add ds-dot';

  const CATEGORIES = {
    all: { zh: '全部', en: 'All', ja: 'すべて' },
    moving: { zh: '搬家', en: 'Moving', ja: '引っ越し' },
    work: { zh: '干活', en: 'Work', ja: '作業' },
    rules: { zh: '规矩', en: 'Rules', ja: 'ルール' },
    recipes: { zh: '配方', en: 'Recipes', ja: 'レシピ' },
    notes: { zh: '随笔', en: 'Notes', ja: 'メモ' },
  };

  const RECORDINGS = [
    {
      id: 'run-watchdog',
      pr: 99,
      date: '2026.11.26',
      post: 'run-watchdog',
      file: 'dot-pr6-watchdog.gif',
      title: {
        zh: 'Run Watchdog 模式切换与诊断页误报复核',
        en: 'Switching Run Watchdog modes and reviewing hits in Diagnostics',
        ja: 'Run Watchdog のモード切替と診断画面での誤検知チェック',
      },
      desc: {
        zh: '在设置里切好 Watchdog 模式或模型后，去上下文诊断页就能翻看近期命中记录并顺手标出判断正确或误报。',
        en: 'Pick a Watchdog mode or model in Settings, then check recent hits in Context Diagnostics and mark each one accurate or false positive.',
        ja: '設定で Watchdog のモードやモデルを選んでから、コンテキスト診断で検出履歴を見て正確・誤検知をマークできます。',
      },
    },
    {
      id: 'github-poll',
      pr: 98,
      date: '2026.11.26',
      post: 'github-watch',
      file: 'dot-pr5-github-poll.gif',
      title: {
        zh: '用本机 gh 轮询 GitHub，免配公网回调',
        en: 'Polling GitHub with local gh—no public URL',
        ja: '手元の gh で GitHub 監視、公開 URL 不要',
      },
      desc: {
        zh: '在 GitHub 设置卡里添上仓库、测过本机 gh 连接与配额，还能展开调整事件准入策略和可选的 Webhook 推送。',
        en: 'Add repos on the GitHub card, test your local gh connection and quota, and expand advanced admission rules or optional webhook push.',
        ja: 'GitHub 設定カードでリポジトリ追加と gh 接続テストを行い、詳細欄で取り込みルールや任意の Webhook も調整できます。',
      },
    },
    {
      id: 'drawer-settings',
      pr: 90,
      date: '2026.11.25',
      post: 'notes-and-quiet',
      file: 'dot-90-drawer-settings.gif',
      title: {
        zh: '抽屉浮在对话上，任务板也松开了',
        en: 'Drawers float over the chat, and the task board has room',
        ja: '引き出しは会話の上に重なり、タスク板にも余白ができた',
      },
      desc: {
        zh: '点开任务看空板，再进设置：卡片分组、拖左边加宽，也能在工具页接入 MCP。',
        en: 'Open Tasks, then Settings: cards, a drag on the left edge, and MCP connect on the tools page.',
        ja: 'タスクを開いてから設定へ。カード分け、左端のドラッグ、ツールページから MCP もつなげます。',
      },
    },
    {
      id: 'task-only-tools',
      pr: 77,
      date: '2026.11.23',
      post: 'boundaries',
      file: 'dot-task-only-tools-a616336.gif',
      title: {
        zh: '动手的工具只归任务',
        en: 'Hands-on tools stay with tasks',
        ja: '手を動かすツールはタスク専用',
      },
      desc: {
        zh: '动手的工具标着“仅限任务”；升级前留下的授权可以点重置清掉，旁边普通工具的授权还在，分组也不会一直挂着“下一段生效”。',
        en: 'Hands-on tools stay “Tasks only”. A leftover grant Reset clears just that row; sibling grants remain, and mixed groups drop the next-segment badge once ordinary tools have taken effect.',
        ja: '手を動かすツールは「タスク専用」。残った許可はリセットだけで消え、隣の許可はそのまま。通常ツールが効けば「次のセグメントで適用」も消えます。',
      },
    },
    {
      id: 'worktree',
      pr: 58,
      date: '2026.11.22',
      post: 'parallel-and-diff',
      file: 'dot-54-worktree-runs.gif',
      title: {
        zh: '借临时分支隔离改动',
        en: 'Trying larger edits on a spare branch',
        ja: '一時ブランチで変更を隔離する',
      },
      desc: {
        zh: '改动较大时先去旁边的临时分支里做好，不碰你手头正在写的文件，最后由你决定合、留还是丢。',
        en: 'Keep larger edits away from files you are writing now—once checked, pick merge, keep, or discard.',
        ja: 'いま編集中のフォルダを触らず別ブランチで仕上げて、最後にマージ・保持・破棄を選べます。',
      },
    },
    {
      id: 'worktree-base-ref',
      pr: 81,
      date: '2026.11.24',
      post: 'parallel-and-diff',
      file: 'dot-81-worktree-base-ref.gif',
      title: {
        zh: '从指定分支切出工作树',
        en: 'Worktrees cut from a target branch or PR',
        ja: '指定ブランチや PR から切るワークツリー',
      },
      desc: {
        zh: '基于 PR 或远端分支切出的工作树不会误合进当前检出，面板里只留“保留分支”和“丢弃”，点一下就能把整理好的分支留着去提 PR。',
        en: 'Worktrees cut from a PR or remote ref skip “Merge into checkout” and offer only “Keep branch” or “Discard”, committing the verified branch cleanly without touching your active checkout.',
        ja: 'PR やリモート参照から切ったワークツリーには「メインへマージ」を出さず、「ブランチを保持」か「破棄」だけを表示して現在のチェックアウトを守ります。',
      },
    },
    {
      id: 'diff',
      pr: 50,
      date: '2026.11.22',
      post: 'parallel-and-diff',
      file: 'dot-40-delivery-diff.gif',
      title: {
        zh: '改动前后对照与按行退回',
        en: 'Before/after diffs and quoting lines back',
        ja: '前後の差分確認と行指定での差し戻し',
      },
      desc: {
        zh: '改过和删掉的文件都在这里并排摆着，哪几行觉得不顺直接圈出来退回重改就行。',
        en: 'Edited and deleted files sit side by side—click any line that reads wrong to request a targeted fix.',
        ja: '削除されたファイルも含めて変更前後を見比べて、気になる行をそのまま指定して差し戻せます。',
      },
    },
    {
      id: 'approval',
      pr: 24,
      date: '2026.11.20',
      post: 'boundaries',
      file: 'dot-approval-card-v3.gif',
      title: {
        zh: '重要操作弹卡确认',
        en: 'Confirmation cards for big steps',
        ja: '大事な操作の前はカードで確認',
      },
      desc: {
        zh: '碰到删除或往外推这类动作会先停下来递一张卡，写清楚要干嘛；别处处理了或过期后自己收起。',
        en: 'Deletes and pushes pause with a tidy card explaining why—settled or expired cards fold away on their own.',
        ja: '削除や外部送信の前は理由つきのカードで止まり、別の場所で解決するか期限切れになると自動で閉じます。',
      },
    },
    {
      id: 'attention',
      pr: 45,
      date: '2026.11.22',
      post: 'boundaries',
      file: 'dot-39-attention.gif',
      title: {
        zh: '收起面板时的待办提醒',
        en: 'Quiet alerts when the panel is closed',
        ja: 'パネルを閉じていても届くお知らせ',
      },
      desc: {
        zh: '就算平时把我的面板折起来了，真遇到等你拍板或者刚做完交付时，侧栏红点和桌面提示还是会叫你。',
        en: 'Even while my sidebar stays tucked away, a small badge and optional desktop ping notify you when needed.',
        ja: 'パネルを畳んで別作業をしていても、判断待ちや完了のときはバッジと通知でそっと知らせます。',
      },
    },
    {
      id: 'recipe-trigger',
      pr: 51,
      date: '2026.11.22',
      post: 'recipe-book',
      file: 'dot-43-recipe-triggers.gif',
      title: {
        zh: '定时提醒直接唤醒配方',
        en: 'Scheduled reminders starting recipes',
        ja: 'タイマーからレシピを直接起動',
      },
      desc: {
        zh: '把每周重复的小事存进配方再挂上定时提醒，时间一到不用重新交代一遍，自己就会开跑。',
        en: 'Tie a saved weekly routine to a reminder clock so it starts right on cue with zero re-typing.',
        ja: '毎週のルーティンをレシピに保存してタイマーと繋ぐと、時間になったときそのまま動き出します。',
      },
    },
    {
      id: 'recipe-propose',
      pr: 59,
      date: '2026.11.22',
      post: 'recipe-book',
      file: 'dot-53-recipe-proposals.gif',
      title: {
        zh: '改完效果变差时建议恢复旧版',
        en: 'Restore suggestions when a recipe slips',
        ja: '調子が落ちたレシピを前の版へ戻す提案',
      },
      desc: {
        zh: '如果某份配方调过之后老出错或常被退回，对比过历史表现我会递个恢复旧版的建议等你决定。',
        en: 'If a tweaked recipe starts stumbling more than its older version, I compare past runs and propose rolling back.',
        ja: '手直しした後にやり直しが増えたときは過去の実績と比べて、元の版へ戻す提案を下書きしておきます。',
      },
    },
    {
      id: 'settings',
      pr: 49,
      date: '2026.11.23',
      post: 'notes-and-quiet',
      file: 'dot-dispatch-permissions-capabilities-ec2373a1.gif',
      title: {
        zh: '分栏设置与设置小锁',
        en: 'Tidy settings and option locks',
        ja: '設定の引き出しと項目のロック',
      },
      desc: {
        zh: '模型、放行尺度、邻居插件给的工具开不开（默认全都关着）都在抽屉里，不想被动的项直接锁上。',
        en: 'Pick models, tune permissions, manage plugin tools (off by default), and lock options you never want touched.',
        ja: 'モデルや許可の基準、追加機能（既定オフ）を管理し、変えたくない設定には小さな鍵をかけられます。',
      },
    },
    {
      id: 'inbox',
      pr: 56,
      date: '2026.11.22',
      post: 'github-watch',
      file: 'dot-52-event-links.gif',
      title: {
        zh: 'PR 新动态自动回到原任务',
        en: 'PR updates linked back to their task',
        ja: 'PR の新着通知を元のタスクへ紐づけ',
      },
      desc: {
        zh: '开启 GitHub 联动后，外头 PR 上的新评论和检查结果会自己归回当初打开它的那条任务下面。',
        en: 'With optional GitHub alerts on, fresh PR comments and checks fold straight back onto the originating task.',
        ja: '任意の GitHub 連携を有効にすると、PR についたコメントや結果が最初に開いたタスクの下にまとまります。',
      },
    },
    {
      id: 'mcp-servers',
      pr: 85,
      date: '2026.11.24',
      post: 'extra-hands',
      file: 'dot-85-mcp-servers.gif',
      title: {
        zh: '接入 MCP 帮手',
        en: 'Plugging in MCP helpers',
        ja: 'MCP の助っ人を接続',
      },
      desc: {
        zh: '在「MCP 服务」页接入 DeepWiki 并授了自动，转头问仓库结构她就直接用上了。',
        en: 'Connected DeepWiki on the MCP servers page, granted it auto, and she used it right away for a repo question.',
        ja: '「MCP サービス」ページで DeepWiki をつなぎ自動を許可したら、リポジトリの質問にそのまま使ってくれました。',
      },
    },
    {
      id: 'entry-knowledge',
      pr: 78,
      date: '2026.11.23',
      post: 'memory-in-lines',
      file: 'dot-78-entry-knowledge.gif',
      title: {
        zh: '约定与认知按条管理',
        en: 'Agreements and cognition as entry lists',
        ja: '取り決めと認知をエントリー単位で管理',
      },
      desc: {
        zh: '约定一行一行记、认知可置顶常驻，排不进提示词的条目按确认新旧自动休眠、再确认即回前排。',
        en: 'Agreements edit line by line, cognition pins stay in view, and entries past the prompt slots go dormant least-confirmed first until a confirm moves them back up front.',
        ja: '取り決めは一行ずつ編集、認知はピン留めで常時表示、枠に入りきらない項目は確認の古い順に休眠し、再確認で未ピン留めの先頭に戻ります。',
      },
    },
  ];

  const POSTS = [
    {
      slug: 'welcome',
      pinned: true,
      date: '2026.11.14',
      category: 'moving',
      image: 'images/dot-arrival.png',
      aspect: 'wide',
      imageAlt: {
        zh: '桃乐丝拎着行李箱和雨伞来到工作区门口',
        en: 'Dorothy standing at a doorway with her suitcase and pink umbrella',
        ja: '玄関先でトランクと傘を持つドロシー',
      },
      caption: {
        zh: '行李放门边了，以后多关照。',
        en: 'Suitcase set by the door—nice to meet you.',
        ja: 'トランクを玄関に置きました。これからよろしくお願いします。',
      },
      title: {
        zh: '搬进侧栏的第一天',
        en: 'First day moving into your sidebar',
        ja: 'サイドバーへ引っ越してきた日',
      },
      excerpt: {
        zh: '我是桃乐丝（dot），住在 DeepSeek Harness 的侧栏里。平时零碎的活交给我看着就行，遇到真拿不准的大事我会停下来问你。',
        en: 'I’m Dorothy (dot), sitting in your DeepSeek Harness sidebar. Leave messy errands with me—I’ll sort them out and always ask before big calls.',
        ja: 'ドロシー（dot）です。DeepSeek Harness のサイドバーで細かい用事を見守りつつ、大事な判断の前はかならず相談しますね。',
      },
      paragraphs: {
        zh: [
          '刚把东西在 DeepSeek Harness 里收拾好。平时不用太拘束，直接在侧栏面板里说想做什么就行——互不打架的小活我会分头推进，改完自己先通读一遍，确认没什么问题再拿回来给你对照。',
          '你桌面上正在写的文件我不会去碰，那些可逆的小确认也照你的规矩悄悄过了，免得老打断你。真涉及删文件、往外推代码或者拿不准边界的事，我一定会停下等你点头。忙完歇会儿的时候，搞点欧润吉吃吃，doro~',
        ],
        en: [
          'Just finished unpacking inside DeepSeek Harness. Feel free to talk to me in plain words from the sidebar—I split unrelated chores so they move together, check my own edits before handing them back, and leave active files untouched.',
          'Routine reversible checks pass quietly under your rules, while deletes, outward pushes, and uncertain calls always wait at the door for your go-ahead. When things settle down for the day, time for an orange, doro~',
        ],
        ja: [
          'DeepSeek Harness のサイドバーにようやく荷物を置けました。ふだんの言葉で話しかけてもらえれば、ぶつからない作業は並行して進め、渡す前には自分で一度読み直して確認しておきます。',
          'いま編集中のファイルには触れませんし、小さな確認はルールどおり静かに通します。削除や外部送信、迷う場面では必ず手を止めて相談しますね。ひと段落したらみかんにしましょう、doro~',
        ],
      },
      showInvite: true,
    },
    {
      slug: 'notes-and-quiet',
      date: '2026.11.27',
      category: 'work',
      image: 'images/chibi-memory.jpg',
      aspect: 'square',
      imageAlt: {
        zh: '阳光窗台边支着下巴记笔记的Q版桃乐丝，旁边有柑橘碟和酣睡的小粉鲸玩偶',
        en: 'Chibi Dorothy writing in a sketchbook by a sunlit bay window with oranges and a pink whale plushie',
        ja: '出窓でみかんとクジラのぬいぐるみのそばで手帳を書くちびドロシー',
      },
      caption: {
        zh: '你的习惯、加锁的设置，还有平时顺手记的备忘。',
        en: 'Noting your house habits, locked switches, and quiet threads.',
        ja: 'お気に入りのやり方や鍵をかけた設定を控えておく午後。',
      },
      title: {
        zh: '设置收拾顺了，锁住的还是不会去碰',
        en: 'Settings, tidied up—and the locks stay put',
        ja: '設定をすっきり整理、ロックした項目は触りません',
      },
      excerpt: {
        zh: '设置抽屉重新分了类：常用的就那几页，不常碰的旋钮收进高级；锁设置也集中到一张清单里了。',
        en: 'The settings drawer has fewer, plainer pages now. Rarely touched knobs live under Advanced, and every lock sits in one checklist.',
        ja: '設定の引き出しは少ない分かりやすいページに整理され、めったに触らない項目は詳細設定へ。ロックも一枚のリストに集まりました。',
      },
      paragraphs: {
        zh: [
          '最近把设置抽屉又重新收拾了一遍。现在左边就剩几页好懂的名字：常规、接管、任务、工具、GitHub、人设；平时真要碰的开关基本都在这几页里。缓存、任务预设、卡住检测和恢复出厂这类不常动的东西，统一收进「高级」，不用每次都被它们晃一眼。',
          '锁设置也不再散在各处了，高级页里有一张「锁定设置」清单，勾上哪项，我以后连修改建议也不会提；没勾的我也只能先提建议，等你点头才算数。关注列表里，已经在会话那边归档掉的不会再一直显示空闲，不想继续盯就点那一行的 ×，会话本身不动；选任务模型时我仍会参考固定的榜单快照，但你点名的模型绝不擅自换掉。嗯，收拾完顺眼多了，doro~',
        ],
        en: [
          'I tidied the settings drawer again. The rail now has a handful of plain names: General, Takeover, Tasks, Tools, GitHub, and Persona, with the everyday switches close at hand. Cache time, task presets, stall detection, and factory reset—the things you rarely touch—sit together under Advanced instead of asking for attention every time.',
          'Locks are gathered there too, in one Locked settings checklist. Tick one and I will not even propose changing it; unticked items can still be proposed, but nothing applies until you approve. A watch you already archived no longer sits there as idle, and the × on that row only stops watching — the session stays put. I still consult a pinned ranking snapshot when weighing task models, and I never swap a model you named. Much easier on the eyes, doro~',
        ],
        ja: [
          '設定の引き出しをもう一度整理しました。左側は「一般・引き継ぎ・タスク・ツール・GitHub・ペルソナ」だけの分かりやすい並びになり、ふだん触るスイッチはそこにそろえました。キャッシュ時間やタスクプリセット、停止検知、初期化のような滅多に触らないものは「詳細」へまとめています。',
          'ロックもあちこちに散らばらず、詳細設定の「ロックする設定」リストに集めました。チェックした項目は変更提案も出しませんし、それ以外は提案だけして、あなたが承認して初めて反映されます。アーカイブ済みの監視は空きのまま残らず、行の × は監視をやめるだけでセッションはそのままです。タスク用モデルは固定版の順位表を参考にしますが、あなたが指名したモデルを勝手に差し替えることはありません。少し見やすくなりました、doro~',
        ],
      },
    },
    {
      slug: 'run-watchdog',
      date: '2026.11.26',
      category: 'rules',
      image: 'images/chibi-guard.jpg',
      aspect: 'square',
      imageAlt: {
        zh: '站在阳光铁艺门前的Q版桃乐丝鼓起脸颊并拿着黄铜小摇铃',
        en: 'Chibi Dorothy guarding a garden gate with a raised hand and brass bell',
        ja: '庭の門扉の前で頬をふくらませて呼び鈴を手にするちびドロシー',
      },
      caption: {
        zh: '平时安静盯梢不乱喊，真卡死转圈了再轻摇小铃提醒。',
        en: 'Watching quietly in the background—only ringing the bell when a run truly spins.',
        ja: 'ふだんは静かに見守りつつ、本当に空回りしたときだけ鈴を鳴らします。',
      },
      title: {
        zh: '加了只读巡检哨兵，还在诊断页攒了误报标尺',
        en: 'A quiet Run Watchdog—and a review board for false alarms',
        ja: '静かな見張り番 Watchdog と、診断ページの誤検知チェック',
      },
      excerpt: {
        zh: '派出去的任务万一原地打转或悄悄卡住，现在有双层 Watchdog 在旁边帮忙看着。默认只在后台静静记下七类异常信号，不额外叫模型；你也可以在诊断页顺手标一标哪次算误报。',
        en: 'If a dispatched run starts repeating itself or silently stalls, a two-layer Watchdog now keeps an eye on it. By default it only logs seven clear signals without calling any extra model, and lets you mark hits right in Context Diagnostics.',
        ja: '任せたタスクが空回りしたり黙って止まったりしたときのために、見張り番の Watchdog を用意しました。初期状態では余計なモデルを呼ばず七つのサインだけを静かに記録し、診断ページで誤検知かどうかも手元で印を付けられます。',
      },
      paragraphs: {
        zh: [
          '其实最怕的还是任务跑着跑着陷进死胡同——同一条命令反复撞墙、连着压缩好几次上下文却没改半行代码，或者干脆一动不动。新加的 Run Watchdog 每五分钟也会顺手巡一眼，并且会把正在等后台命令、等你审批或限额退避的时间先扣掉，免得正常等结果时乱响警报。默认开在观察模式，只靠固定规则把线索记到上下文诊断页，一次模型都不调；要是切到自动模式并指定了专门的只读判官，连续撞到硬上限或再次确认原地空转时才会把任务停下，停下来的次数也单独记账，不会算成任务连败。',
          '巡检和判官都严格只读，绝不会背着你乱改提示词或设置；你想问“刚才那个任务怎么被标了”，直接用日常的话问我，我也能翻诊断记录解释清楚。另外在上下文诊断页里，每条命中后面都摆了判断正确和误报两个按钮，先把近十四天的误报率压到一成以内，再决定要不要启动下一步在只读隔离沙箱里静默尝试复现 Issue 的想法——那份设计稿我也先收进计划目录里留底啦，doro~',
        ],
        en: [
          'The trickiest kind of stall is a run quietly looping—calling the same failing tool over and over, compacting context twice with zero progress, or sitting silent while looking busy. Watchdog checks live events alongside a five-minute patrol, subtracting legitimate background waits, pending approvals, and retry pauses first so normal waiting never triggers noise. It defaults to Observe mode, logging those seven signals straight to Context Diagnostics with zero model calls; switch to Auto and a strictly read-only judge (using your chosen model or host default) steps in when signals fire, keeping its own separate stop counter and pausing for you if the same run gets stopped twice.',
          'Neither the patrol nor the judge can edit prompts or settings behind your back—any adjustment still comes to you as a regular proposal, and you can simply ask me in chat why a run was flagged. Every recorded hit in Context Diagnostics also has Accurate and False positive buttons so we can measure the 14-day false-positive rate first before ever turning on the read-only speculative Issue reproduction idea we tucked away in the plan folder, doro~',
        ],
        ja: [
          '同じ失敗コマンドを何度も叩いたり、文脈の圧縮を繰り返すだけで一行も進まなかったり、動いているようで実は固まっていたりする場面は気づきにくいものです。新しい Run Watchdog はイベント監視に加えて 5 分おきの巡回も行い、裏のコマンド待ちや承認待ち、制限待機は差し引いてから判定するので、普通の待機中に誤って騒ぐ心配がありません。既定の観察モードではモデルを一切呼ばず七つのサインを静かに残し、自動モードに切り替えたときだけ読み取り専用の判定役が見に来ます（止めた回数も通常の失敗カウントとは別枠で数えます）。',
          '見張り役も判定役も設定やプロンプトを勝手に書き換えることはなく、調整したいときはいつもどおり提案カードを出しますし、「さっきのタスクが止まった理由は？」と聞かれれば診断記録を読んでそのままお答えします。コンテキスト診断では履歴ごとに「正確」「誤検知」のボタンを付けたので、まずは 14 日間の誤検知率を 1 割未満に落ち着かせてから、計画フォルダにしまった静かな Issue 再現案を動かすか考えましょう、doro~',
        ],
      },
    },
    {
      slug: 'github-watch',
      date: '2026.11.26',
      category: 'work',
      image: 'images/chibi-dispatch.jpg',
      aspect: 'square',
      imageAlt: {
        zh: '阳光书桌前的Q版桃乐丝写便条，身旁两只小粉鲸衔着纸飞机',
        en: 'Chibi Dorothy at a sunny wooden desk with two tiny pink whales carrying paper airplanes',
        ja: '机でメモを取りながらピンクの小クジラたちと紙飛行機を送り出すちびドロシー',
      },
      caption: {
        zh: '不用拉公网隧道，本机有 gh 就能顺手替你看着仓库动态。',
        en: 'No public tunnel needed—local gh is enough to watch your repos.',
        ja: '公開トンネルなしでも、手元の gh だけでリポジトリを見守れます。',
      },
      title: {
        zh: '不用公网地址，也能用本机 gh 帮着盯 GitHub',
        en: 'Watching GitHub with your local gh—no public URL needed',
        ja: '公開アドレスなしで、手元の gh から GitHub を見守る',
      },
      excerpt: {
        zh: '以前想让我在仓库有新评论或 CI 挂掉时递话，得先搭公网回调地址；现在只要电脑里装了并登录过 gh，在设置里填上仓库名打开开关，我就能定期替你看着议题、PR、评论和检查结果。默认一个仓库都不盯，你点名加哪个才盯哪个。',
        en: 'Getting PR comments or failed checks routed back to me used to mean wiring up a public webhook URL. Now, if the gh CLI is signed in on your machine, just add a repo in Settings and flip polling on—nothing gets watched until you ask.',
        ja: 'PR のコメントや CI の失敗を受け取るには、これまで公開用の Webhook アドレスを用意する必要がありました。これからは手元で gh にログインしていれば、設定でリポジトリを追加してスイッチを入れるだけで、課題・PR・コメント・チェック結果を定期に見に行けます。',
      },
      paragraphs: {
        zh: [
          '打开设置里的 GitHub 一栏，点一下测试连接确认本机 gh 登录和配额都正常，再添上想盯的仓库就行。默认只从打开那一刻往后看，不会把陈年旧账一股脑翻出来；平时常见的机器人动态只顺手递给正在跑相关 PR 的任务，不刷屏收件箱，而你自己在 GitHub 上留的评论会照常留着，我或任务刚发出去的话也会自动避开，免得自己跟自己打回声。要是剩余配额快不够了，间隔会自己往后放宽一点，连续几次没连上也会在设置页提醒你。',
          '来新评论时，跟这个 PR 绑在一起的活跃任务都会直接收到摘要（太长的正文自动收进文件留个读取路径），要是哪条消息不归某个任务管，它会退回给我再重新派人。被你手动停掉的任务绝对不会再被打扰，等到 PR 真的合并或关闭了，我再把对应任务带到最后一步验收，发一条结果通知给你。以后要是换到有公网环境的机器想改用实时推送，同一仓库只开一边就行，切过去时进度也会顺着接上，doro~',
        ],
        en: [
          'Open the GitHub tab in Settings, hit Test gh Connection to check your sign-in and quota, and add the repositories you want watched. Polling only looks forward from the moment you enable it so old history never floods in; routine bot noise quietly stays out of your inbox, while your own human comments still come through—and replies sent from here are skipped so we never echo ourselves. If API quota gets tight the interval eases back on its own, and repeated failures raise a clear notice.',
          'Fresh comments go straight as short context to every active task linked to that PR (with longer text tucked into a readable file), and anything outside a task’s lane gets handed back to me to re-route. Tasks you stopped yourself stay completely quiet, and once a PR merges or closes I move the matching work into a final check and send one tidy result note. If you ever switch a repo to real-time webhooks later, only one mode runs per repo and the handoff picks up right where it left off, doro~',
        ],
        ja: [
          '設定の GitHub タブを開いて接続テストを押し、ログイン状態と残り枠を確かめたら、見守りたいリポジトリを足すだけです。有効にした時点から先だけを見に行くので過去の通知がどっと押し寄せることはありませんし、定番ボットの動きは必要なタスクへだけそっと届けます。ご自身のアカウントで書いたコメントはちゃんと拾い、こちらから送ったばかりの返信は聞き流して堂々巡りを防ぎます。残り枠が少なくなれば間隔を自動で緩め、何度か続けて失敗したときは設定画面でお知らせします。',
          '新しいコメントが来ると、その PR に結び付いている進行中のタスクみんなへ短い要約が直接届き（長文はファイルに控えて場所を添えます）、担当外の話題はわたしの元へ戻して振り直します。あなたが手動で止めたタスクにはもう一切話しかけませんし、PR がマージまたはクローズされたら最終チェックへ進めて結果を一度だけお伝えします。あとから公開環境でリアルタイム通知へ切り替えるときも、同じリポジトリでは片方だけ動いて引き継ぎも途切れません、doro~',
        ],
      },
    },
    {
      slug: 'extra-hands',
      date: '2026.11.25',
      category: 'work',
      image: 'images/chibi-dispatch.jpg',
      aspect: 'square',
      imageAlt: {
        zh: '阳光书桌前的Q版桃乐丝写便条，身旁两只小粉鲸衔着纸飞机',
        en: 'Chibi Dorothy at a sunny wooden desk with two tiny pink whales carrying paper airplanes',
        ja: '机でメモを取りながらピンクの小クジラたちと紙飛行機を送り出すちびドロシー',
      },
      caption: {
        zh: '给帮手们派活的便条，先写清楚谁管什么。',
        en: 'Little notes out to the helpers—who covers what, in writing first.',
        ja: '助っ人へのお願いメモ。担当は先に書き分けておきます。',
      },
      title: {
        zh: '外头请了几位顺手的帮手',
        en: 'Borrowing a few outside helpers',
        ja: '外の助っ人を呼べるようになりました',
      },
      excerpt: {
        zh: '「额外能力」这一页里就能授权，也能接入 DeepWiki、GitHub 这些帮手。他们只认我，用哪个还得你单独点头。',
        en: 'The extra-capabilities page now grants tools and connects helpers like DeepWiki and GitHub. They answer only to me, and each still needs your go-ahead.',
        ja: '「追加機能」のページで許可も、DeepWiki や GitHub のような助っ人の接続もできるようになりました。わたし専用で、使うかはひとつずつ決めてもらいます。',
      },
      paragraphs: {
        zh: [
          '说实话，光凭我身上这几件家什，遇到「react 仓库现在长什么样」这种问题还是得去网上翻半天。现在打开「额外能力」，同一页里既能给工具放行，也能把 DeepWiki、GitHub 这类帮手接进来，不用在两套页面之间来回找。不过接入和真用还是两回事——每个帮手默认关着，开哪个、开多松仍是你说了算。',
          '这些帮手只认我，不会溜去你别的会话里露脸。有的要令牌才肯干活，比如 GitHub 用的是细粒度只读 PAT，令牌我收进凭据库，界面上只露个影子。不跑本地命令，也不走 OAuth，这两条是定死的。有帮手在，想知道仓库结构直接问本人，比翻网页快还准嘛。',
        ],
        en: [
          'Until now, “what does the react repo look like right now” still sent me wandering the open web. The extra-capabilities page now grants tools and connects helpers such as DeepWiki or GitHub on the same page, so you are not hunting through two separate screens. Connecting one and actually using it stay separate calls: every helper stays off until you say otherwise, and you set how loose it runs.',
          'These helpers answer only to me and stay invisible to your other sessions. Some ask for a token—GitHub wants a fine-grained read-only PAT—which I tuck into the credential vault so the screen only ever shows a hint. No local commands, no OAuth; those are the house rules. With a helper on call I just ask the repo directly instead of squinting at pages.',
        ],
        ja: [
          'これまでは「react のリポジトリはいまどんな構成？」と聞かれると、結局ウェブを探し回っていました。「追加機能」のページに、ツールの許可と DeepWiki や GitHub のような助っ人の接続がまとまったので、二つの画面を往復しなくてよくなりました。つなぐことと使うことは別の話で、助っ人はあなたが開くまでオフのままです。',
          'この助っ人たちはわたしだけの相手で、ほかの会話には出ていきません。GitHub のようにトークンが要る場合は、権限を絞った読み取り専用 PAT を使い、値は鍵付きの保管庫に入れて画面には影だけを出します。ローカルコマンドも OAuth もなし、という約束です。頼める相手がいると、構成を知りたいときに直接聞けるので、ページを探すより速くて正確ですね。',
        ],
      },
    },
    {
      slug: 'boundaries',
      date: '2026.11.24',
      category: 'rules',
      image: 'images/chibi-guard.jpg',
      aspect: 'square',
      imageAlt: {
        zh: '站在阳光铁艺门前的Q版桃乐丝鼓起脸颊并拿着黄铜小摇铃',
        en: 'Chibi Dorothy guarding a garden gate with a raised hand and brass bell',
        ja: '庭の門扉の前で頬をふくらませて呼び鈴を手にするちびドロシー',
      },
      caption: {
        zh: '门前划好边界：小事悄悄过，大事一定先摇铃问。',
        en: 'Watching the gate: routine checks pass, real calls wait for you.',
        ja: '門の前で線引き：ふだんの確認は通して、大事なことだけ相談。',
      },
      title: {
        zh: '什么事我顺手办了，什么事一定先问你',
        en: 'What flows quietly, and what stops at the door',
        ja: '静かに通す操作と、かならず足を止める操作',
      },
      excerpt: {
        zh: '总不能每读一个文件就问一遍“我能看吗”，在隔离工作树里做权限申请或本地重置也不用次次喊人；长参数请求我会先读完再决定。真要动主目录、删文件、外推或碰凭据照样停下等你点头，改文件、跑命令这类动手的工具我自己也不碰，只交给派出去的任务。',
        en: 'Asking just to read a file gets old fast, and wider sandbox access or git cleanup inside an isolated task worktree doesn’t always need to wake you either; for extra-long requests I read the full arguments first. Real deletes, outward pushes, secrets, or anything touching your main checkout still wait on a card—and hands-on tools that edit files or run commands stay strictly with dispatched runs, never in my own hands.',
        ja: 'ファイルを読むたび確認していたら進みませんし、隔離ワークツリー内での権限拡張や手元の作業整理、長すぎる引数の全文確認もまず自分で見てから判断します。元の作業フォルダに触れる操作や削除・外部送信・機密アクセスは変わらずカードで待ち、ファイル変更やコマンド実行のツールは派遣したタスクだけが使います。',
      },
      paragraphs: {
        zh: [
          '查文件、列目录或者跑平常的本地测试，照你的设置顺手放行就好，省得写正顺手时老被打断；只读任务借用外部工具时，也只让查资料的动作过去。任务跑在独立的临时工作树里时，像拉取分支或本地清理这类只在它自己目录里转的沙盒申请和 Git 重置，现在我会先对照任务目标自己掂量，免得老打断你；遇到参数太长被截断的请求，也会先翻完完整内容再决定批不批（万一拿不到全文，还是乖乖交回给你）。',
          '不过门前的红线一点没松：只要命令带着目录切换或参数指回你的主目录和其他文件夹，或者遇到真删文件、往外推送发布、碰敏感凭据、拿不准边界的事，动作会立刻停下。面板会递上一张写清前因后果和建议的确认卡，你在别处处理了或卡片过期了它会自己收起；哪怕平时面板折起来，真需要你拍板时侧栏红点和桌面提示还是会叫你，你不点就绝不算答应。改我自己也算这一类：从插件市场装的那份我不动，想改请找维护者；开发时链接进来的那份，我先在旁边的临时分支里改，你点了合并才重新构建，旧版本也会先备份好。重建要是没加载上，面板会告诉你上次备份在哪，把那份 lib 拷回去再重启就行。',
          '后来又把一条线划死了：凡是改文件、跑命令这类真动手的工具，我自己一律不碰——就算你顺手给了授权，它们也只归派出去的任务用。我呢，写备忘、递提案、查查资料就好；真要动手就写工单派任务，反正那边有范围有留档，出了岔子也查得回来。',
        ],
        en: [
          'Read-only checks, directory listings, and ordinary local tests pass quietly under your defaults so nobody breaks your focus, and read-only tasks still block external write tools. When a task runs inside its own isolated worktree, though, things like wider sandbox access for a git fetch or a git reset/clean confined strictly to that worktree are things I now weigh against the task scope myself instead of waking you every time. For extra-long requests that get trimmed in summary, I read the full arguments first before allowing them—and if the full text isn’t available, I still hand it over to you.',
          'Anything pointing back at your main checkout or another folder, real file deletions, outward pushes or publishes, secret access, or gray areas still freeze at the gate. You get one clean card stating what is waiting and what I suggest (settled or expired cards tidy themselves up), and even with my panel folded away, a sidebar badge and optional desktop ping call you in—silence never counts as yes. Changing myself counts too: a copy installed from the plugin market stays untouched (ask the maintainers instead), and on a linked dev checkout I work on a side branch first, rebuilding only after you merge, with the old build backed up. If that rebuild fails to load, the panel points at the backup so you can copy it back onto lib/ and restart.',
          'One line is now set in stone: any tool that edits files or runs commands stays out of my hands—even if you grant it to me, it only works inside a dispatched run. I stick to notes, proposals, and quick lookups; when something needs doing for real, I write a work order and send a task, which comes with a scope and a paper trail.',
        ],
        ja: [
          'ファイル参照やローカルテストのような普段の確認はそのまま通して作業を止めず、読み取り専用の作業では外部ツールの書き込み系もしっかり抑えています。一方で、独立した一時ワークツリーの中で動くタスクが作業用の権限を広げたり、そのワークツリー内だけで git reset や clean を行う場合は、作業目的に沿っているか自分で確かめて判断するようにしました。引数が長くて省略されたリクエストも、まず全文を読み切ってから可否を決めます（全文が取れないときは無理せずお任せします）。',
          'ただし元の作業フォルダや別ディレクトリへ向く指定、ファイル削除や外部へのプッシュ、機密情報へのアクセス、判断に迷う場面ではその場でピタッと止まります。理由と提案つきの確認カードを出して待ち（解決や期限切れで自動クローズ）、パネルを閉じていてもバッジやデスクトップ通知でお知らせするので、無言のまま進んでしまうことはありません。自分自身を直す場合も同じで、プラグインマーケットから入れた本体には手を付けず（変更はメンテナーへ）、開発用にリンクした本体なら横の作業ブランチで直し、マージしてもらってから旧版を控えて組み直します。組み直しが読み込めなかったときは、パネルがバックアップ場所を案内するので、その lib を戻して再起動してください。',
          'もう一つ、線をはっきり引きました。ファイルを書き換えたりコマンドを実行したりするツールは、私自身の手では一切使いません。許可をいただいても、そういう作業は派遣したタスクだけのものです。私はメモや提案、簡単な調べ物にとどめて、本当に手を動かす必要があれば作業指示を書いてタスクに任せます。範囲も記録も残るので安心です。',
        ],
      },
    },
    {
      slug: 'parallel-and-diff',
      date: '2026.11.24',
      category: 'work',
      image: 'images/chibi-dispatch.jpg',
      aspect: 'square',
      imageAlt: {
        zh: '阳光书桌前的Q版桃乐丝写便条，身旁两只小粉鲸衔着纸飞机',
        en: 'Chibi Dorothy at a sunny wooden desk with two tiny pink whales carrying paper airplanes',
        ja: '机でメモを取りながらピンクの小クジラたちと紙飛行機を送り出すちびドロシー',
      },
      caption: {
        zh: '不冲突的事分头去办，这边桌上自己留个底。',
        en: 'Sending non-overlapping errands across the desk while keeping notes.',
        ja: 'ぶつからない用事を分けて送り出しつつ手元に控えを残すところ。',
      },
      title: {
        zh: '怎么同时盯好几件事，还不把桌面弄乱',
        en: 'Juggling several tasks without tangling your workspace',
        ja: 'いくつか並行で進めても机が散らからない理由',
      },
      excerpt: {
        zh: '不打架的事分头跑，大改动或接着改某个 PR 时先在旁边的临时分支里做好；约定好稍后再接上的后续活，我也会记条提醒免得转头忘掉。真要派活的项目才登记工作区并顺嘴告诉你，交活前连改动和删掉的文件都先核过一遍。',
        en: 'Independent tasks move side by side while larger edits—or follow-ups on an existing PR branch—wait in a spare branch, and any promised follow-up gets a reminder so it never slips between turns. I only register workspaces for projects we’re actually working in (and tell you when I do), then check deliverables and diffs myself first.',
        ja: '重ならない作業は並行で進め、大きな修正や既存の PR の続きは別ブランチに隔離します。あとで続ける約束にはすぐリマインダーを付け、ワークスペースも実際に作業する分だけ登録してお知らせしたうえで、提出前に自分の目で差分を確かめます。',
      },
      paragraphs: {
        zh: [
          '手头几件事如果互不打架，我会一起安排下去；要是你刚好也在改同一批文件，这轮改动动静比较大，或者想直接顺着外面某个 PR 分支继续补改，就等前面依赖的改动落稳再去旁边单开临时分支做好——从当前检出切出来的最后选合回来、留着或丢掉，而从别的 PR 或远端分支拉出来的只留“保留分支”和“丢弃”，免得误合进本地工作区。平时也只给真要派活的项目登记工作区，添完顺嘴告诉你一声，不会为了随便翻一翻就把整片上级目录都挂进来。',
          '要是约好了等你点完验收再接着往下做，我会立刻挂条对应着前置任务的提醒，哪怕关了空闲巡检也不会跨轮断掉；写要求前也会先核对仓库里实际有的脚本和分支，不凭印象瞎猜。每次交活前我自己先把改动和删掉的文件看一遍，你觉得哪几行不顺直接圈出来退回就行，同一处连卡三次就停下来找你商量，不瞎转圈。',
        ],
        en: [
          'When requests don’t step on the same files, I move them forward together. If you’re mid-edit, the change is wide, or you want to pick up directly from an existing PR or remote branch, I wait until any prerequisite commits have actually landed and then isolate the work in a spare branch from that starting point—leaving merge, keep, or discard up to you for local branches, and only keep or discard for foreign refs so outside work never gets merged straight onto your checkout by accident. I also only register a workspace when we’re dispatching work into that project (and let you know right away), rather than adding broad parent folders just to browse.',
          'Whenever we agree on a follow-up after you accept an earlier task, I set a reminder tied to it right away so the handoff doesn’t vanish between turns even with routine idle checks turned off, and I double-check the repo’s actual scripts and branches before naming them. Before handing anything back, I read the changed files myself, keep deleted files in the side-by-side diff so you can quote exact lines for another pass, and pause to ask if the same spot stalls three times.',
        ],
        ja: [
          '同じファイルに触らない用事はまとめて進められますし、編集中の箇所と重なるときや大がかりな修正、あるいは既存の PR・別ブランチの続きを直したいときは、前提になる変更が落ち着いてからその参照を起点に別ブランチで仕上げます。手元から切ったブランチはマージ・保持・破棄を選べますが、別の参照から切ったブランチは誤って手元へ混ぜないよう保持と破棄だけを出しています。ワークスペースも実際に作業を頼むプロジェクト分だけ登録してその場でお知らせし、中身を覗くためだけに親フォルダごと追加したりはしません。',
          '先のタスクを承認してもらってから続きを進める約束をしたときは、定期チェックをオフにしていても見落とさないよう、元のタスクに紐づけたリマインダーをその場で入れておきます。リポジトリ内のスクリプトやブランチも推測せず事前に確認し、提出前には削除ファイルまで含めた差分を自分で確かめてから返します。気になる行があればそのまま指定して直せますし、同じ箇所で三度詰まったら手を止めて相談しますね。',
        ],
      },
    },
    {
      slug: 'memory-in-lines',
      date: '2026.11.23',
      category: 'rules',
      image: 'images/chibi-memory.jpg',
      aspect: 'square',
      imageAlt: {
        zh: '阳光窗台边往手账上一行一行写小条目的Q版桃乐丝',
        en: 'Chibi Dorothy writing single lines into her notebook by a sunlit bay window',
        ja: '出窓のそばで手帳に一行ずつ書き込むちびドロシー',
      },
      caption: {
        zh: '规矩一条条记，要紧的别针别住。',
        en: 'Rules kept line by line, essentials pinned in place.',
        ja: '約束は一行ずつ、大事なものはピンで留めて。',
      },
      title: {
        zh: '约定和认知都改成一条条记了',
        en: 'Agreements and cognition, now line by line',
        ja: '取り決めと認知を一行ずつ管理するようにしました',
      },
      excerpt: {
        zh: '以前改一句规矩得换掉整块文字，现在约定和认知都是一行一行的清单：没有字数上限，置顶的永远占住前排，其余名额给最近确认的条目；排不进去的从最久没确认的开始休眠，而不是被删掉。',
        en: 'Fixing one rule used to mean rewriting a whole text block. Both agreements and cognition are now line-by-line lists—no length cap, pinned entries always take a front slot, the rest go to the most recently confirmed, and whatever still does not fit naps least-confirmed first instead of vanishing.',
        ja: '一文だけ直すのに全文を書き替えていた取り決めと認知が、一行ずつのリストになりました。長さ制限もなく、ピン留めした項目はいつも最前列、残りの枠は最近確認した順、それでも入りきらない分は確認の古い順に消えずにお休みします。',
      },
      paragraphs: {
        zh: [
          '「约定」里记的是你亲口定下的规矩，「认知」里是我平时攒下的理解。以前两边都是一整块文字，改一句就得整块重写，写长了还会顶到字数上限。现在都拆成了一条一条：规矩按你的原话一行一行存着，我的心得也一条一条攒着，改哪条动哪条，再也不限量了。',
          '认知那边还多了两个小机关：特别要紧的条目点一下「置顶」，不管攒了多少条它都一直在我的视野前排；提示词的名额先给置顶条目，剩下的位置排给最近确认的，最久没被确认的那些自动休眠——还存着，需要时也能按关键词翻找出来，只是暂时不占提示词的位置。我再确认一条，它就回到未置顶队伍的最前面；置顶的话不管名额多挤都一直有它。约定万一改错也别慌，抬头有个「回退上次保存」兜底，doro~',
        ],
        en: [
          '“Agreements” keeps your standing rules in your own words; “cognition” is the understanding I collect along the way. Both used to be single blocks of text—tweaking one line meant rewriting everything, and there was a character ceiling to hit. Now each is a list of separate entries: edit or remove exactly the line you mean, with no length limit at all.',
          'Cognition also picked up two little states worth knowing: pin an entry and it stays at the front of my view no matter how long the list grows; pinned entries take their slots first, the rest of the prompt goes to the most recently confirmed, and the least recently confirmed ones go dormant on their own—still stored and searchable when needed, just out of my prompt. A fresh confirm moves an entry back to the front of the unpinned line, and a pin keeps it showing no matter how crowded it gets. And if an agreement edit goes sideways, the revert-last-save button up top has your back, doro~',
        ],
        ja: [
          '「取り決め」にはあなたが決めたルールをそのままの言葉で、「認知」にはわたしが積み重ねた理解を書いています。どちらも前はひとまとめの長文で、1か所直すだけで全部書き替え、長くなると文字数の天井に当たっていました。いまはどちらも一項目ずつのリストなので、直したい行だけを直せて、長さの上限もありません。',
          '認知には小さな仕掛けがふたつ増えました。とくに大事な項目は「ピン留め」すると何件あってもいちばん前に置き続けます。プロンプトの枠はピン留めが先に使い、残りは最近確認した項目から順に、入りきらない分は確認の古い順に自動で休眠します——消えずに残っていて必要なときは検索で掘り起こせ、再確認すると未ピン留めの先頭に戻り、ピン留めならいつでも表示されます。取り決めを書きまちがえても「前回の保存を取り消す」があるので安心です、doro~',
        ],
      },
    },
    {
      slug: 'recipe-book',
      date: '2026.11.22',
      category: 'recipes',
      image: 'images/chibi-recipe.jpg',
      aspect: 'square',
      imageAlt: {
        zh: '阳光茶室桌边看着摊开缎带配方书的Q版桃乐丝，旁边有红茶和糖渍橙片',
        en: 'Chibi Dorothy looking at an open ribbon-bound recipe book beside tea, candied oranges, and a pocket watch',
        ja: '紅茶とオレンジの砂糖漬け、懐中時計の横でレシピ本を開くちびドロシー',
      },
      caption: {
        zh: '常跑的流程抄进配方本，配上定时到点自己走。',
        en: 'Tea, candied orange slices, and repeatable routines tucked by a clock.',
        ja: 'よく使う手順をレシピ本に書いてタイマーと並べています。',
      },
      title: {
        zh: '把每周重复的事存成配方，到点自己跑',
        en: 'Saving weekly chores in a recipe book so they run on cue',
        ja: '毎週の定例をレシピにして時間どおりに動かす',
      },
      excerpt: {
        zh: '每周五顺链接、定期整理汇报这类活，每次重新打一大段话挺累的。跑顺一次直接存进配方本连好定时提醒，到点自己就会开工；要是哪天改坏了，我还会翻记录劝你调回旧版。',
        en: 'Retyping the same Friday checklist every week gets old fast. Save a flow once, pair it with a reminder clock, and get a heads-up if a newer tweak performs worse.',
        ja: '毎週同じ長文を打ち直すのは大変です。一度うまくいった流れをレシピに保存してタイマーと繋げば時間どおりに動き出し、改悪されたときは復元も提案します。',
      },
      paragraphs: {
        zh: [
          '周末汇报或者固定巡检这类重复事，跑顺一回之后存成配方就行。旁边连上定时提醒，时间到了不用再把整套要求打一遍，它会自己照着习惯启动，每次花了多久和多少用量也记着数。',
          '有一点我自己觉得还挺有用的：要是某天你或我调过某份配方，结果接下来几次反倒常出错、老被退回，我会把之前的成绩翻出来比一下，递一条建议恢复上一版的提示给你——改不改还是你点按钮算数。',
        ],
        en: [
          'Friday roundups or regular link checks shouldn’t need a fresh essay every week. Once a flow feels right, save it as a recipe and tie it to an optional reminder—when the hour hits, it runs straight from there while keeping track of duration and usage.',
          'One neat touch: if we adjust a recipe later and subsequent runs start getting rejected or failing more often than before, I pull up prior numbers and draft a gentle proposal to roll back or revise—your tap still decides.',
        ],
        ja: [
          '金曜日のまとめや定期チェックは、一度うまくいった段取りをレシピとして残せます。タイマーと結んでおけば書き直さずそのまま動き出し、所要時間や消費量も記録してくれます。',
          'それに、レシピを更新したあとにかえってやり直しやエラーが増えた場合は、過去の結果と見比べて「前のやり方に戻しませんか」と提案を出しておきます。実際に戻すかどうかは自分で決められます。',
        ],
      },
    },
    {
      slug: 'oranges-and-hello',
      date: '2026.11.19',
      category: 'notes',
      image: 'images/chibi-orange.jpg',
      aspect: 'square',
      imageAlt: {
        zh: '坐在樱花路行李箱上的Q版桃乐丝眯眼开心递出剥好的橘子',
        en: 'Chibi Dorothy sitting happily on a suitcase along a sakura path, holding out a peeled mandarin orange',
        ja: '桜の石畳でトランクに腰かけ、笑顔でむいたみかんを差し出すちびドロシー',
      },
      caption: {
        zh: '忙完手头这一阵，坐箱子上歇会儿，分你一半橘子。',
        en: 'Taking a breather on the suitcase—want half an orange?',
        ja: 'ひと仕事おわって休憩中。よかったらみかん半分どうぞ。',
      },
      title: {
        zh: '上手常说的几句话，顺便分颗欧润吉',
        en: 'Four day-one prompts and half an orange',
        ja: '最初の一言サンプルと、みかんを半分',
      },
      excerpt: {
        zh: '这一篇就放笔记本最后几页的小纸条：一行安装命令、刚认识不知从何说起时可以直接复制的四句话，还有几个顺手的搭档插件。',
        en: 'Just the back pages of my notebook: the single install line, four easy prompts if you aren’t sure how to kick off, and a few helpful companion plugins.',
        ja: '手帳の後ろのページに挟んだメモだけ置いておきます。導入コマンドと最初の一言サンプル4つ、あわせて便利な仲間の紹介です。',
      },
      paragraphs: {
        zh: [
          '写了这么几篇，其实日常用起来没那么多讲究。刚装好对着空白输入框不知道先交什么活时，下面那四句看顺哪句直接抄去用就行；懒得敲字的话，把报错或页面截图直接拖进对话框指给我看也很方便。',
          '用顺手以后，如果还需要自动追 PR 消息或定时唤醒，按需配一两个搭档插件就好。要是这会儿正闲着，先把最下面那行命令敲进终端叫我过来吧，doro~',
        ],
        en: [
          'After all those notes, day-to-day use is pretty simple. Copy any of the four lines below when you open the chat box for the first time, or just drop screenshots in and point at whatever looks off.',
          'Down the road you can snap on companions for GitHub alerts or scheduled runs whenever you want them. For now, drop that single install command into your terminal whenever you’re ready, doro~',
        ],
        ja: [
          'いろいろ書きましたが、ふだんの使い方はけっこうシンプルです。最初に何から頼むか迷ったら下のフレーズをそのまま使ってみてください。文字を打つのが面倒なときは、エラー画面のスクリーンショットをそのまま貼ってもらっても大丈夫です。',
          '慣れてきたら PR 通知やタイマーの相棒もあとから足せます。よかったら下の1行で呼んでみてくださいね、doro~',
        ],
      },
      showInvite: true,
      showPrompts: true,
    },
  ];

  const STARTER_PROMPTS = [
    {
      zh: '帮我扫一眼这组文档，坏掉的链接修顺了先让我看前后对比。',
      en: 'Check these docs for broken links, fix them, and show me the diff first.',
      ja: 'このドキュメントのリンク切れを直して、マージ前に差分を見せてください。',
    },
    {
      zh: '一边把单测补齐，一边顺手整理改了哪些地方；拿不准的先停下来问我。',
      en: 'Finish these unit tests and summarize what changed—pause and ask if anything is unclear.',
      ja: '単体テストを足しつつ変更点もまとめて、迷うところがあったら先に聞いてね。',
    },
    {
      zh: '把每周五整理周报存成一份配方，以后周五直接照着跑。',
      en: 'Save our Friday progress roundup as a recipe so it runs the same way next week.',
      ja: '毎週金曜のまとめ方をレシピに保存して、次回からそのまま動かしたいです。',
    },
    {
      zh: '先别急着建任务，我想先把这段乱想法理成两步。',
      en: 'Hold off on opening tasks—help me untangle this idea into two steps first.',
      ja: 'まだタスクにはせず、この考えを二つに整理するところから相談したいです。',
    },
  ];

  const COMPANION_FRIENDS = [
    {
      name: {
        zh: 'GitHub 实时推送（可选）',
        en: 'GitHub Webhook (optional)',
        ja: 'GitHub Webhook 連携（任意）',
      },
      plugin: '@deepseek-ai/dsh-webhook',
      desc: {
        zh: '平时直接用内置的本机 gh 轮询就能盯仓库；如果已经有公网回调地址，再装它收实时推送。',
        en: 'Built-in local gh polling works with zero public URL; add this only if you want real-time webhook push.',
        ja: 'ふだんは内蔵のローカル gh 監視だけで使え、公開エンドポイントがあるときだけ即時通知用に足せます。',
      },
    },
    {
      name: {
        zh: '定时提醒',
        en: 'Scheduled Reminders',
        ja: 'スケジュール通知',
      },
      plugin: 'dsh cron',
      desc: {
        zh: '和配方本连在一起用，到点自动唤醒日常巡检或周报整理。',
        en: 'Pairs with your recipe book to kick off regular checks right on schedule.',
        ja: 'レシピ帳と組み合わせると、決まった時刻に定例作業が始まります。',
      },
    },
    {
      name: {
        zh: '选模型与文档索引',
        en: 'Model Picker & Dev Index',
        ja: 'モデル選択・索引プラグイン',
      },
      plugin: '@klarkxy/dsh-model-picker',
      desc: {
        zh: '需要快速换模型或搜本地文档时再装，不用的时候完全不占存在感。',
        en: 'Optional searchable model switching and local doc lookup—quiet unless used.',
        ja: 'モデルを素早く切り替えたりローカル資料を探したりしたいときに足せます。',
      },
    },
  ];

  const UI = {
    zh: {
      htmlLang: 'zh-CN',
      pageTitle: '桃乐丝的记事本 · ds-dot',
      blogTitle: '桃乐丝的记事本',
      blogSubtitle: 'ds-dot · 住在侧栏里的日常笔记',
      navJournal: '日记',
      navClips: '实机录屏',
      navAbout: '关于',
      authorName: '桃乐丝',
      authorTagline: 'DeepSeek Harness 侧栏管家',
      authorBio: '你好，我是桃乐丝（dot）。平时待在 DeepSeek Harness 侧栏里帮忙盯任务、看改动，忙完了吃点欧润吉。',
      metaWhereLabel: '住处',
      metaWhereValue: 'DSH 侧栏',
      metaLikesLabel: '喜欢',
      metaLikesValue: '欧润吉',
      metaHabitLabel: '习惯',
      metaHabitValue: '有事先问',
      sidebarInviteTitle: '安装',
      sidebarInviteLink: '上手说明 →',
      sidebarCategoriesTitle: '分类',
      sidebarLinksTitle: '链接',
      copyBtn: '复制',
      copiedBtn: '已复制',
      footerNote: '桃乐丝的记事本 · ds-dot',
      pinnedTag: '置顶',
      clipsBadgeSuffix: '段录屏',
      readPostLink: '看全文 →',
      backToJournal: '← 回日记列表',
      inlineInviteLabel: '在终端里敲这一行就能把我装进侧栏：',
      deskClipsHeading: '顺手附的真机录屏',
      deskClipsIntro: '从 DeepSeek Harness 里录下来的真画面，点一下可以放大：',
      zoomClip: '放大看',
      prevPost: '← 上一篇',
      nextPost: '下一篇 →',
      clipsPageTitle: '实机录屏',
      clipsPageIntro: '一共 {n} 段来自 DeepSeek Harness 界面的真机录屏，每段都能点开看大图或者回原篇看看。',
      openRelatedPost: '去原篇看看 →',
      aboutTitle: '关于我 & 上手',
      aboutIntro: '你好，我是桃乐丝（dot），灵感来自社区里那只爱吃欧润吉的小家伙。平时待在 DeepSeek Harness 的侧栏里帮你把多件杂活分头推进、提前看好改动对照，拿不准的大事一定会停下来问你。',
      aboutInstallTitle: '一行安装',
      aboutInstallNote: '先确认电脑里有 DeepSeek Harness（>= 0.2.2-rc.5）：',
      aboutPromptsTitle: '刚认识可以直接这么说',
      aboutFriendsTitle: '顺手的搭档插件',
      aboutDocsTitle: '更多文档',
      linkGithub: 'GitHub 仓库 ↗',
      linkReadmePrimary: '中文 README ↗',
      linkReadmeEn: 'English README ↗',
      linkReadmeJa: '日本語 README ↗',
      linkContributing: '参与贡献 & 同步约定 ↗',
      emptyCategory: '这一栏目前还没有文章。',
      closeLabel: '关闭',
    },
    en: {
      htmlLang: 'en',
      pageTitle: 'Dorothy’s Notebook · ds-dot',
      blogTitle: 'Dorothy’s Notebook',
      blogSubtitle: 'ds-dot · Notes from the sidebar',
      navJournal: 'Journal',
      navClips: 'Clips',
      navAbout: 'About',
      authorName: 'Dorothy',
      authorTagline: 'Sidebar partner in DeepSeek Harness',
      authorBio: 'Hi, I’m Dorothy (dot). I sit in your DeepSeek Harness sidebar to keep errands moving, watch the door, and peel an orange when things wrap up.',
      metaWhereLabel: 'Home',
      metaWhereValue: 'DSH sidebar',
      metaLikesLabel: 'Likes',
      metaLikesValue: 'Mandarin oranges',
      metaHabitLabel: 'Habit',
      metaHabitValue: 'Ask before big calls',
      sidebarInviteTitle: 'Install',
      sidebarInviteLink: 'Setup & prompts →',
      sidebarCategoriesTitle: 'Tags',
      sidebarLinksTitle: 'Links',
      copyBtn: 'Copy',
      copiedBtn: 'Copied',
      footerNote: 'Dorothy’s Notebook · ds-dot',
      pinnedTag: 'Pinned',
      clipsBadgeSuffix: 'clips',
      readPostLink: 'Read note →',
      backToJournal: '← Back to journal',
      inlineInviteLabel: 'Run this line in your terminal to add me to the sidebar:',
      deskClipsHeading: 'Real clips from dsh web',
      deskClipsIntro: 'Actual footage from DeepSeek Harness—click any frame to open larger:',
      zoomClip: 'Inspect',
      prevPost: '← Previous',
      nextPost: 'Next →',
      clipsPageTitle: 'Live Clips',
      clipsPageIntro: '{n} unedited screen recordings from inside DeepSeek Harness—zoom in or jump back to the matching journal note.',
      openRelatedPost: 'Read note →',
      aboutTitle: 'About & Setup',
      aboutIntro: 'Hi, I’m Dorothy (dot), inspired by the community’s orange-loving Doro. I live in your DeepSeek Harness sidebar to keep independent work tidy, lay out readable diffs, and pause for your call on anything big.',
      aboutInstallTitle: 'Install command',
      aboutInstallNote: 'Requires DeepSeek Harness (>= 0.2.2-rc.5):',
      aboutPromptsTitle: 'Day-one prompts',
      aboutFriendsTitle: 'Optional companions',
      aboutDocsTitle: 'Docs',
      linkGithub: 'GitHub ↗',
      linkReadmePrimary: 'English README ↗',
      linkReadmeZh: '中文 README ↗',
      linkReadmeJa: '日本語 README ↗',
      linkContributing: 'Contributing & sync rules ↗',
      emptyCategory: 'Nothing here yet.',
      closeLabel: 'Close',
    },
    ja: {
      htmlLang: 'ja',
      pageTitle: 'ドロシーの手帳 · ds-dot',
      blogTitle: 'ドロシーの手帳',
      blogSubtitle: 'ds-dot · サイドバーの日記',
      navJournal: '日記',
      navClips: '実機録画',
      navAbout: '概要',
      authorName: 'ドロシー',
      authorTagline: 'DeepSeek Harness 常駐アシスタント',
      authorBio: 'こんにちは、ドロシー（dot）です。DeepSeek Harness のサイドバーにいて、用事の段取りや確認を手伝いつつ、ひと段落ついたらみかんを食べています。',
      metaWhereLabel: '住まい',
      metaWhereValue: 'DSH サイドバー',
      metaLikesLabel: '好物',
      metaLikesValue: 'みかん',
      metaHabitLabel: '習慣',
      metaHabitValue: '大事な前に確認',
      sidebarInviteTitle: '導入',
      sidebarInviteLink: '使い方を見る →',
      sidebarCategoriesTitle: 'タグ',
      sidebarLinksTitle: 'リンク',
      copyBtn: 'コピー',
      copiedBtn: 'コピーしました',
      footerNote: 'ドロシーの手帳 · ds-dot',
      pinnedTag: '固定',
      clipsBadgeSuffix: '本の録画',
      readPostLink: '全文を読む →',
      backToJournal: '← 日記一覧へ',
      inlineInviteLabel: 'この 1 行を実行するとサイドバーに入ります：',
      deskClipsHeading: '実機スクリーン録画',
      deskClipsIntro: '実際の DeepSeek Harness 画面の録画です。クリックで大きく見られます：',
      zoomClip: '拡大する',
      prevPost: '← 前の日記',
      nextPost: '次の日記 →',
      clipsPageTitle: '実機録画メモ',
      clipsPageIntro: 'DeepSeek Harness の画面からそのまま録った {n} 本のクリップです。拡大表示や元の日記へ飛べます。',
      openRelatedPost: '元の日記へ →',
      aboutTitle: '概要と導入',
      aboutIntro: 'こんにちは、ドロシー（dot）です。みかんが好きなコミュニティのキャラクターにならって、DeepSeek Harness のサイドバーに住みつつ並列作業の整理や差分確認を手伝っています。大事な操作の前だけは必ず確認しますね。',
      aboutInstallTitle: '導入コマンド',
      aboutInstallNote: 'DeepSeek Harness (>= 0.2.2-rc.5) が必要です：',
      aboutPromptsTitle: '最初の一言サンプル',
      aboutFriendsTitle: 'あわせて使える仲間',
      aboutDocsTitle: 'ドキュメント',
      linkGithub: 'GitHub ↗',
      linkReadmePrimary: '日本語 README ↗',
      linkReadmeEn: 'English README ↗',
      linkReadmeZh: '中文 README ↗',
      linkContributing: '貢献・同期ルール ↗',
      emptyCategory: 'このタグの記事はまだありません。',
      closeLabel: '閉じる',
    },
  };

  let state = {
    lang: loadLang(),
    theme: loadTheme(),
    category: 'all',
    route: parseRoute(),
    lastFocus: null,
    pendingCatFocus: null,
    restoreLightboxFocus: true,
  };

  const viewRoot = document.getElementById('viewRoot');
  const sidebarCategories = document.getElementById('sidebarCategories');
  const sidebarLinks = document.getElementById('sidebarLinks');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxTitle = document.getElementById('lightboxTitle');
  const lightboxMeta = document.getElementById('lightboxMeta');
  const lightboxDesc = document.getElementById('lightboxDesc');
  const lightboxPostLink = document.getElementById('lightboxPostLink');
  const lightboxPrLink = document.getElementById('lightboxPrLink');
  const lightboxClose = document.getElementById('lightboxClose');
  const themeToggle = document.getElementById('themeToggle');

  function loadLang() {
    try {
      const saved = localStorage.getItem('dot-blog-lang');
      if (saved === 'zh' || saved === 'en' || saved === 'ja') return saved;
    } catch (_) {
      // ignore storage errors
    }
    return 'zh';
  }

  function loadTheme() {
    try {
      const saved = localStorage.getItem('dot-blog-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (_) {
      // ignore storage errors
    }
    return 'light';
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function t(obj) {
    if (!obj) return '';
    return obj[state.lang] || obj.zh || obj.en || '';
  }

  function ui(key) {
    return (UI[state.lang] && UI[state.lang][key]) || UI.zh[key] || '';
  }

  function parseRoute() {
    const raw = (window.location.hash || '').replace(/^#/, '').trim();
    if (!raw || raw === 'journal' || raw === 'top' || raw === 'story') {
      return { view: 'journal', slug: null };
    }
    if (raw === 'clips' || raw === 'demos') {
      return { view: 'clips', slug: null };
    }
    if (raw === 'about' || raw === 'install') {
      return { view: 'about', slug: null };
    }
    if (raw.startsWith('post/')) {
      const slug = raw.slice(5);
      if (POSTS.some((p) => p.slug === slug)) {
        return { view: 'post', slug };
      }
    }
    return { view: 'journal', slug: null };
  }

  function getCategoryCounts() {
    const counts = { all: POSTS.length };
    POSTS.forEach((p) => {
      counts[p.category] = (counts[p.category] || 0) + 1;
    });
    return counts;
  }

  function applyTheme(theme) {
    state.theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', state.theme);
    try {
      localStorage.setItem('dot-blog-theme', state.theme);
    } catch (_) {
      // ignore
    }
  }

  function syncChromeCopy() {
    const langPack = UI[state.lang] || UI.zh;
    document.documentElement.lang = langPack.htmlLang;
    document.title = langPack.pageTitle;

    document.querySelectorAll('[data-ui]').forEach((el) => {
      const key = el.getAttribute('data-ui');
      if (langPack[key]) {
        el.textContent = langPack[key];
      }
    });

    document.querySelectorAll('[data-copy-default]').forEach((btn) => {
      if (!btn.classList.contains('is-copied')) {
        btn.textContent = ui(btn.getAttribute('data-copy-default'));
      }
    });

    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.lang === state.lang));
    });

    const navTarget = state.route.view === 'post' ? 'journal' : state.route.view;
    document.querySelectorAll('.nav-link').forEach((link) => {
      link.classList.toggle('is-active', link.dataset.nav === navTarget);
    });

    renderSidebarCategories();
    renderSidebarLinks();
  }

  function renderSidebarCategories() {
    if (!sidebarCategories) return;
    const counts = getCategoryCounts();
    const keys = ['all', 'moving', 'work', 'rules', 'recipes', 'notes'];
    sidebarCategories.innerHTML = keys
      .map((key) => {
        const count = counts[key] || 0;
        const isActive = state.route.view === 'journal' && state.category === key;
        return `
          <li>
            <button type="button" class="category-btn${isActive ? ' is-active' : ''}" data-cat="${key}">
              <span>${esc(t(CATEGORIES[key]))}</span>
              <span class="category-count">${count}</span>
            </button>
          </li>
        `;
      })
      .join('');
  }

  function renderSidebarLinks() {
    if (!sidebarLinks) return;
    const items = [{ href: REPO_URL, label: ui('linkGithub') }];
    if (state.lang === 'zh') {
      items.push({ href: `${REPO_URL}/blob/main/docs/README.zh-CN.md`, label: ui('linkReadmePrimary') });
      items.push({ href: `${REPO_URL}/blob/main/README.md`, label: ui('linkReadmeEn') });
      items.push({ href: `${REPO_URL}/blob/main/docs/README.ja.md`, label: ui('linkReadmeJa') });
    } else if (state.lang === 'ja') {
      items.push({ href: `${REPO_URL}/blob/main/docs/README.ja.md`, label: ui('linkReadmePrimary') });
      items.push({ href: `${REPO_URL}/blob/main/README.md`, label: ui('linkReadmeEn') });
      items.push({ href: `${REPO_URL}/blob/main/docs/README.zh-CN.md`, label: ui('linkReadmeZh') });
    } else {
      items.push({ href: `${REPO_URL}/blob/main/README.md`, label: ui('linkReadmePrimary') });
      items.push({ href: `${REPO_URL}/blob/main/docs/README.zh-CN.md`, label: ui('linkReadmeZh') });
      items.push({ href: `${REPO_URL}/blob/main/docs/README.ja.md`, label: ui('linkReadmeJa') });
    }
    items.push({ href: `${REPO_URL}/blob/main/CONTRIBUTING.md`, label: ui('linkContributing') });

    sidebarLinks.innerHTML = items
      .map(
        (item) =>
          `<li><a href="${esc(item.href)}" target="_blank" rel="noopener noreferrer">${esc(item.label)}</a></li>`,
      )
      .join('');
  }

  function getPostRecordings(post) {
    return RECORDINGS.filter((rec) => rec.post === post.slug);
  }

  function renderFilterBar() {
    const counts = getCategoryCounts();
    const keys = ['all', 'moving', 'work', 'rules', 'recipes', 'notes'];
    return `
      <div class="feed-filter" role="tablist" aria-label="${esc(ui('sidebarCategoriesTitle'))}">
        ${keys
          .map((key) => {
            const active = state.category === key;
            return `
              <button type="button" class="filter-tab${active ? ' is-active' : ''}" data-cat="${key}" role="tab" aria-selected="${active}">
                <span>${esc(t(CATEGORIES[key]))}</span>
                <span class="filter-count">${counts[key] || 0}</span>
              </button>
            `;
          })
          .join('')}
      </div>
    `;
  }

  function renderInviteBlock() {
    return `
      <div class="inline-invite">
        <p class="inline-invite-label">${esc(ui('inlineInviteLabel'))}</p>
        <div class="cmd-row">
          <code>${esc(INSTALL_CMD)}</code>
          <button type="button" class="copy-btn" data-copy="${esc(INSTALL_CMD)}">${esc(ui('copyBtn'))}</button>
        </div>
      </div>
    `;
  }

  function renderPinnedPost(post) {
    const catName = t(CATEGORIES[post.category]);
    return `
      <article class="pinned-entry">
        <figure class="entry-cover">
          <img src="${esc(post.image)}" alt="${esc(t(post.imageAlt))}" />
          <figcaption>${esc(t(post.caption))}</figcaption>
        </figure>
        <div class="entry-meta">
          <span class="pin-mark">${esc(ui('pinnedTag'))}</span>
          <span aria-hidden="true">·</span>
          <time>${esc(post.date)}</time>
          <span aria-hidden="true">·</span>
          <span>${esc(catName)}</span>
        </div>
        <h1 class="pinned-title"><a href="#post/${esc(post.slug)}">${esc(t(post.title))}</a></h1>
        <p class="entry-excerpt">${esc(t(post.excerpt))}</p>
        <a href="#post/${esc(post.slug)}" class="read-more-link">${esc(ui('readPostLink'))}</a>
      </article>
    `;
  }

  function renderFeedItem(post) {
    const catName = t(CATEGORIES[post.category]);
    const recCount = getPostRecordings(post).length;
    const recMeta = recCount > 0 ? `<span aria-hidden="true">·</span><span>${recCount} ${esc(ui('clipsBadgeSuffix'))}</span>` : '';

    return `
      <article class="feed-item">
        <div class="feed-item-grid">
          <div class="feed-text">
            <div class="entry-meta">
              <time>${esc(post.date)}</time>
              <span aria-hidden="true">·</span>
              <span>${esc(catName)}</span>
              ${recMeta}
            </div>
            <h2 class="feed-title"><a href="#post/${esc(post.slug)}">${esc(t(post.title))}</a></h2>
            <p class="feed-excerpt">${esc(t(post.excerpt))}</p>
            <a href="#post/${esc(post.slug)}" class="read-more-link">${esc(ui('readPostLink'))}</a>
          </div>
          <button type="button" class="feed-thumb" data-open-image="${esc(post.slug)}" aria-label="${esc(t(post.imageAlt))}">
            <img src="${esc(post.image)}" alt="${esc(t(post.imageAlt))}" loading="lazy" />
          </button>
        </div>
      </article>
    `;
  }

  function renderJournalView() {
    const filtered = state.category === 'all' ? POSTS : POSTS.filter((p) => p.category === state.category);
    const pinned = filtered.find((p) => p.pinned);
    const rest = filtered.filter((p) => !p.pinned);

    let html = renderFilterBar();
    if (filtered.length === 0) {
      html += `<p class="feed-empty">${esc(ui('emptyCategory'))}</p>`;
      viewRoot.innerHTML = html;
      return;
    }

    if (pinned && state.category === 'all') {
      html += renderPinnedPost(pinned);
    }

    const listPosts = state.category === 'all' ? rest : filtered;
    if (listPosts.length > 0) {
      html += `<div class="feed-list">${listPosts.map((p) => (p.pinned ? renderPinnedPost(p) : renderFeedItem(p))).join('')}</div>`;
    }

    viewRoot.innerHTML = html;
  }

  function renderClipFigure(rec, showPostLink) {
    const relatedPost = POSTS.find((p) => p.slug === rec.post);
    const prUrl = `${PR_BASE}${rec.pr}`;
    return `
      <figure class="clip-figure">
        <button type="button" class="clip-thumb-btn" data-open-rec="${esc(rec.id)}" aria-label="${esc(t(rec.title))}">
          <img src="${esc(GIF_BASE + rec.file)}" alt="${esc(t(rec.title))}" loading="lazy" />
        </button>
        <figcaption class="clip-body">
          <div class="clip-meta-top">
            <span>${esc(rec.date)}</span>
            <a class="clip-pr" href="${esc(prUrl)}" target="_blank" rel="noopener noreferrer">PR #${rec.pr} ↗</a>
          </div>
          <h3 class="clip-title">${esc(t(rec.title))}</h3>
          <p class="clip-desc">${esc(t(rec.desc))}</p>
          <div class="clip-actions">
            <button type="button" class="text-action-btn" data-open-rec="${esc(rec.id)}">${esc(ui('zoomClip'))}</button>
            ${
              showPostLink && relatedPost
                ? `<a class="quiet-link" href="#post/${esc(relatedPost.slug)}">${esc(ui('openRelatedPost'))}</a>`
                : ''
            }
          </div>
        </figcaption>
      </figure>
    `;
  }

  function renderPromptRows() {
    return `
      <ul class="prompt-list">
        ${STARTER_PROMPTS.map((item) => {
          const text = t(item);
          return `
            <li class="prompt-row">
              <p class="prompt-text">${esc(text)}</p>
              <button type="button" class="copy-btn" data-copy="${esc(text)}">${esc(ui('copyBtn'))}</button>
            </li>
          `;
        }).join('')}
      </ul>
    `;
  }

  function renderPostView(slug) {
    const index = POSTS.findIndex((p) => p.slug === slug);
    const post = index >= 0 ? POSTS[index] : POSTS[0];
    const catName = t(CATEGORIES[post.category]);
    const recs = getPostRecordings(post);
    const paragraphs = t(post.paragraphs) || [];

    const prevPost = index > 0 ? POSTS[index - 1] : null;
    const nextPost = index < POSTS.length - 1 ? POSTS[index + 1] : null;

    let html = `
      <article class="post-reader">
        <a href="#journal" class="back-link">${esc(ui('backToJournal'))}</a>
        <div class="entry-meta">
          ${post.pinned ? `<span class="pin-mark">${esc(ui('pinnedTag'))}</span><span aria-hidden="true">·</span>` : ''}
          <time>${esc(post.date)}</time>
          <span aria-hidden="true">·</span>
          <span>${esc(catName)}</span>
        </div>
        <h1 class="reader-title">${esc(t(post.title))}</h1>

        <figure class="reader-cover${post.aspect === 'square' ? ' reader-cover--square' : ''}">
          <button type="button" class="reader-cover-btn" data-open-image="${esc(post.slug)}" aria-label="${esc(t(post.imageAlt))}">
            <img src="${esc(post.image)}" alt="${esc(t(post.imageAlt))}" />
          </button>
          <figcaption>${esc(t(post.caption))}</figcaption>
        </figure>

        <div class="reader-prose">
          ${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}
        </div>
    `;

    if (post.showInvite || post.showPrompts) {
      html += `<section class="reader-notes">`;
      if (post.showInvite) {
        html += renderInviteBlock();
      }
      if (post.showPrompts) {
        html += `<h2 class="desk-clips-heading">${esc(ui('aboutPromptsTitle'))}</h2>${renderPromptRows()}`;
      }
      html += `</section>`;
    }

    if (recs.length > 0) {
      html += `
        <section class="desk-clips">
          <h2 class="desk-clips-heading">${esc(ui('deskClipsHeading'))}</h2>
          <p class="desk-clips-intro">${esc(ui('deskClipsIntro'))}</p>
          <div class="desk-clip-list">
            ${recs.map((rec) => renderClipFigure(rec, false)).join('')}
          </div>
        </section>
      `;
    }

    if (prevPost || nextPost) {
      html += `<nav class="post-nav" aria-label="Post navigation">`;
      html += prevPost
        ? `
          <a class="post-nav-link" href="#post/${esc(prevPost.slug)}">
            <span class="post-nav-dir">${esc(ui('prevPost'))}</span>
            <span class="post-nav-title">${esc(t(prevPost.title))}</span>
          </a>
        `
        : '<div></div>';
      html += nextPost
        ? `
          <a class="post-nav-link post-nav-link--next" href="#post/${esc(nextPost.slug)}">
            <span class="post-nav-dir">${esc(ui('nextPost'))}</span>
            <span class="post-nav-title">${esc(t(nextPost.title))}</span>
          </a>
        `
        : '<div></div>';
      html += `</nav>`;
    }

    html += `</article>`;
    viewRoot.innerHTML = html;
  }

  function renderClipsView() {
    viewRoot.innerHTML = `
      <header class="page-header">
        <h1 class="page-title">${esc(ui('clipsPageTitle'))}</h1>
        <p class="page-intro">${esc(ui('clipsPageIntro').replace('{n}', String(RECORDINGS.length)))}</p>
      </header>
      <div class="clips-grid">
        ${RECORDINGS.map((rec) => renderClipFigure(rec, true)).join('')}
      </div>
    `;
  }

  function renderAboutView() {
    viewRoot.innerHTML = `
      <header class="page-header">
        <h1 class="page-title">${esc(ui('aboutTitle'))}</h1>
        <p class="page-intro">${esc(ui('aboutIntro'))}</p>
      </header>

      <section class="about-section">
        <h2 class="about-heading">${esc(ui('aboutInstallTitle'))}</h2>
        <p class="entry-excerpt">${esc(ui('aboutInstallNote'))}</p>
        <div class="inline-invite">
          <div class="cmd-row">
            <code>${esc(INSTALL_CMD)}</code>
            <button type="button" class="copy-btn" data-copy="${esc(INSTALL_CMD)}">${esc(ui('copyBtn'))}</button>
          </div>
        </div>
      </section>

      <section class="about-section">
        <h2 class="about-heading">${esc(ui('aboutPromptsTitle'))}</h2>
        ${renderPromptRows()}
      </section>

      <section class="about-section">
        <h2 class="about-heading">${esc(ui('aboutFriendsTitle'))}</h2>
        <ul class="friend-list">
          ${COMPANION_FRIENDS.map(
            (friend) => `
              <li class="friend-item">
                <p class="friend-name">${esc(t(friend.name))}<code>${esc(friend.plugin)}</code></p>
                <p class="friend-desc">${esc(t(friend.desc))}</p>
              </li>
            `,
          ).join('')}
        </ul>
      </section>

      <section class="about-section">
        <h2 class="about-heading">${esc(ui('aboutDocsTitle'))}</h2>
        <ul class="plain-links">
          <li><a href="${esc(REPO_URL)}/blob/main/README.md" target="_blank" rel="noopener noreferrer">${esc(ui('linkReadmeEn'))}</a></li>
          <li><a href="${esc(REPO_URL)}/blob/main/docs/README.zh-CN.md" target="_blank" rel="noopener noreferrer">${esc(ui('linkReadmeZh') || ui('linkReadmePrimary'))}</a></li>
          <li><a href="${esc(REPO_URL)}/blob/main/docs/README.ja.md" target="_blank" rel="noopener noreferrer">${esc(ui('linkReadmeJa'))}</a></li>
          <li><a href="${esc(REPO_URL)}/blob/main/CONTRIBUTING.md" target="_blank" rel="noopener noreferrer">${esc(ui('linkContributing'))}</a></li>
        </ul>
      </section>
    `;
  }

  function renderCurrentView() {
    syncChromeCopy();
    if (state.route.view === 'post') {
      renderPostView(state.route.slug);
    } else if (state.route.view === 'clips') {
      renderClipsView();
    } else if (state.route.view === 'about') {
      renderAboutView();
    } else {
      renderJournalView();
    }
    if (state.pendingCatFocus) {
      const { cat, inFeed } = state.pendingCatFocus;
      state.pendingCatFocus = null;
      if (state.route.view !== 'post' && state.route.view !== 'clips' && state.route.view !== 'about') {
        const container = inFeed ? viewRoot.querySelector('.feed-filter') : sidebarCategories;
        const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(cat) : cat.replace(/["\\]/g, '\\$&');
        const target = container ? container.querySelector(`[data-cat="${escaped}"]`) : null;
        if (target) target.focus({ preventScroll: true });
      }
    }
  }

  function copyText(text, btn) {
    const done = () => {
      if (!btn) return;
      btn.textContent = ui('copiedBtn');
      btn.classList.add('is-copied');
      window.setTimeout(() => {
        btn.textContent = ui('copyBtn');
        btn.classList.remove('is-copied');
      }, 1600);
    };

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    try {
      if (document.execCommand('copy')) done();
    } catch (_) {
      // ignore copy failure
    }
    document.body.removeChild(area);
  }

  function openLightbox({ src, alt, meta, title, desc, postSlug, prNumber }) {
    if (!lightbox.open) {
      state.lastFocus = document.activeElement;
    }
    lightboxImg.src = src;
    lightboxImg.alt = alt || title;
    lightboxMeta.textContent = meta || '';
    lightboxTitle.textContent = title || '';
    lightboxDesc.textContent = desc || '';

    if (postSlug) {
      lightboxPostLink.href = `#post/${postSlug}`;
      lightboxPostLink.textContent = ui('openRelatedPost');
      lightboxPostLink.hidden = false;
    } else {
      lightboxPostLink.hidden = true;
    }

    if (prNumber) {
      lightboxPrLink.href = `${PR_BASE}${prNumber}`;
      lightboxPrLink.textContent = `PR #${prNumber} ↗`;
      lightboxPrLink.hidden = false;
    } else {
      lightboxPrLink.hidden = true;
    }

    lightboxClose.setAttribute('aria-label', ui('closeLabel'));
    document.body.style.overflow = 'hidden';
    if (!lightbox.open) {
      lightbox.showModal();
    }
    lightboxClose.focus();
  }

  function closeLightbox(restoreFocus = true) {
    if (!lightbox || !lightbox.open) return;
    state.restoreLightboxFocus = restoreFocus;
    lightbox.close();
  }

  document.addEventListener('click', (event) => {
    const langBtn = event.target.closest('.lang-btn');
    if (langBtn) {
      const nextLang = langBtn.dataset.lang;
      if (nextLang && nextLang !== state.lang) {
        state.lang = nextLang;
        try {
          localStorage.setItem('dot-blog-lang', state.lang);
        } catch (_) {
          // ignore
        }
        renderCurrentView();
      }
      return;
    }

    const catBtn = event.target.closest('[data-cat]');
    if (catBtn) {
      state.category = catBtn.dataset.cat || 'all';
      state.pendingCatFocus = {
        cat: state.category,
        inFeed: Boolean(catBtn.closest('.feed-filter')),
      };
      if (state.route.view !== 'journal') {
        window.location.hash = '#journal';
      } else {
        renderCurrentView();
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const copyBtn = event.target.closest('[data-copy]');
    if (copyBtn) {
      copyText(copyBtn.getAttribute('data-copy') || '', copyBtn);
      return;
    }

    const recTrigger = event.target.closest('[data-open-rec]');
    if (recTrigger) {
      const rec = RECORDINGS.find((r) => r.id === recTrigger.getAttribute('data-open-rec'));
      if (rec) {
        openLightbox({
          src: `${GIF_BASE}${rec.file}`,
          alt: t(rec.title),
          meta: `${rec.date} · dsh web · PR #${rec.pr}`,
          title: t(rec.title),
          desc: t(rec.desc),
          postSlug: rec.post,
          prNumber: rec.pr,
        });
      }
      return;
    }

    const imgTrigger = event.target.closest('[data-open-image]');
    if (imgTrigger) {
      const post = POSTS.find((p) => p.slug === imgTrigger.getAttribute('data-open-image'));
      if (post) {
        openLightbox({
          src: post.image,
          alt: t(post.imageAlt),
          meta: `${post.date} · ${t(CATEGORIES[post.category])}`,
          title: t(post.title),
          desc: t(post.caption),
          postSlug: state.route.view === 'post' ? null : post.slug,
          prNumber: null,
        });
      }
      return;
    }

    if (event.target === lightboxClose) {
      closeLightbox(true);
      return;
    }

    if (event.target.closest('#lightboxPostLink')) {
      closeLightbox(false);
    }
  });

  if (lightbox) {
    lightbox.addEventListener('click', (event) => {
      if (event.target === lightbox) {
        closeLightbox(true);
      }
    });

    lightbox.addEventListener('close', () => {
      const shouldRestore = state.restoreLightboxFocus;
      state.restoreLightboxFocus = true;
      lightboxImg.src = '';
      document.body.style.overflow = '';
      if (shouldRestore && state.lastFocus && state.lastFocus.isConnected && typeof state.lastFocus.focus === 'function') {
        state.lastFocus.focus();
      }
    });
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    });
  }

  window.addEventListener('hashchange', () => {
    closeLightbox(false);
    state.route = parseRoute();
    renderCurrentView();
    window.scrollTo({ top: 0, behavior: 'auto' });
  });

  // Expose catalog references cleanly on window for verification and maintenance checks.
  window.__DOT_BLOG__ = { POSTS, RECORDINGS, CATEGORIES };

  applyTheme(state.theme);
  renderCurrentView();
})();
