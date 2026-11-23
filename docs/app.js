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
      post: 'notes-and-quiet',
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
        zh: '约定一行一行记、认知可以置顶，久未确认的旧条目会自动休眠。',
        en: 'Agreements edit line by line, cognition entries pin to stay in view, and stale ones go dormant on their own.',
        ja: '取り決めは一行ずつ編集、認知はピン留めで常時表示、古い項目は自動で休眠します。',
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
        zh: '以前改一句规矩得换掉整块文字，现在约定和认知都是一行一行的清单：没有字数上限，要紧的可以置顶，久未确认的旧条目会自己休眠而不是被删掉。',
        en: 'Fixing one rule used to mean rewriting a whole text block. Both agreements and cognition are now line-by-line lists—no length cap, pin the essentials, and stale entries nap instead of vanishing.',
        ja: '一文だけ直すのに全文を書き替えていた取り決めと認知が、一行ずつのリストになりました。長さ制限もなく、大事なものはピン留め、古い項目は消えずにお休みします。',
      },
      paragraphs: {
        zh: [
          '「约定」里记的是你亲口定下的规矩，「认知」里是我平时攒下的理解。以前两边都是一整块文字，改一句就得整块重写，写长了还会顶到字数上限。现在都拆成了一条一条：规矩按你的原话一行一行存着，我的心得也一条一条攒着，改哪条动哪条，再也不限量了。',
          '认知那边还多了两个小机关：特别要紧的条目点一下「置顶」，不管攒了多少条它都一直在我的视野前排；好久没被重新确认的旧条目不会被删，只是自动睡过去、暂时不占提示词的位置，哪天置顶或者再确认一下就醒了。约定万一改错也别慌，抬头有个「回退上次保存」兜底，doro~',
        ],
        en: [
          '“Agreements” keeps your standing rules in your own words; “cognition” is the understanding I collect along the way. Both used to be single blocks of text—tweaking one line meant rewriting everything, and there was a character ceiling to hit. Now each is a list of separate entries: edit or remove exactly the line you mean, with no length limit at all.',
          'Cognition also picked up two little states worth knowing: pin an entry and it stays at the front of my view no matter how long the list grows; entries nobody has re-confirmed in a while go dormant on their own—still stored, just out of my prompt—until you pin them or I confirm them again. And if an agreement edit goes sideways, the revert-last-save button up top has your back, doro~',
        ],
        ja: [
          '「取り決め」にはあなたが決めたルールをそのままの言葉で、「認知」にはわたしが積み重ねた理解を書いています。どちらも前はひとまとめの長文で、1か所直すだけで全部書き替え、長くなると文字数の天井に当たっていました。いまはどちらも一項目ずつのリストなので、直したい行だけを直せて、長さの上限もありません。',
          '認知には小さな仕掛けがふたつ増えました。とくに大事な項目は「ピン留め」すると何件あってもいちばん前に置き続けます。しばらく確認されなかった古い項目は削除されずに自動で休眠してプロンプトの場所を取らなくなりますが、ピン留めか再確認でいつでも戻ります。取り決めを書きまちがえても「前回の保存を取り消す」があるので安心です、doro~',
        ],
      },
    },
    {
      slug: 'notes-and-quiet',
      date: '2026.11.23',
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
        zh: '你的规矩我记在本子上了，锁住的不会去碰',
        en: 'Remembering your habits—and leaving locked knobs alone',
        ja: 'いつものやり方はメモ済み、ロックした設定は触りません',
      },
      excerpt: {
        zh: '设置抽屉里新加了几把小锁，不想让我提议修改的项直接锁起来就行。对了，GitHub 那边 PR 的新评论也会自己回到原来的任务下面。',
        en: 'Added small padlocks in settings so choices you’ve settled stay untouched—plus optional PR comments now land straight back on the task that opened them.',
        ja: '設定引き出しに小さな鍵をつけて、変えたくない項目はそのまま固定できるようにしました。PR の新着コメントも元のタスクへ自動でまとまります。',
      },
      paragraphs: {
        zh: [
          '说真的，要是每次新开对话都得重新解释“怎么称呼你”“平时放多松”，人烦我也记不过来。现在全都规规矩矩收在设置抽屉里，隔壁插件带过来的额外工具默认也都关着。哪项你觉得不用再动了，点一下旁边的小锁，以后我连修改建议也不会提。',
          '还有个挺顺手的小改动：之前开着 GitHub 通知时消息容易散，现在哪个 PR 下面冒出新评论或构建挂了，它会自动落回当初开出这个 PR 的任务底下，前因后果挨在一起看着省心不少。如果平时只是想先找人聊聊思路、暂时不想建任务，直接跟我说就行。',
        ],
        en: [
          'Nobody wants to re-explain their preferred tone or permissions every week. Everything sits neatly in one settings drawer—with companion plugin tools turned off by default—and clicking the small lock beside any option keeps me from ever proposing edits to it.',
          'Another small quality-of-life tweak: if you enable optional GitHub notifications, fresh PR comments and failing checks attach directly to the task that opened that pull request instead of getting lost. And if you just want to bounce an idea around without spinning up formal tasks, we can just talk.',
        ],
        ja: [
          '毎回「呼び方」や「任せる範囲」を言い直すのは大変ですよね。設定はひとつの引き出しにまとめて、他プラグインの追加機能も既定はオフにしてあります。決めた項目の横にある鍵を押せば、以後はわたしからの変更提案もしません。',
          'それから、任意の GitHub 連携をオンにすると PR の新しいコメントやテスト失敗も、最初にその PR を出したタスクの下へ戻ってくるようになりました。タスクにせず雑談や壁打ちだけしたいときも気軽に声をかけてください。',
        ],
      },
    },
    {
      slug: 'parallel-and-diff',
      date: '2026.11.22',
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
        zh: '以前同时盯四五个窗口实在眼花，现在不打架的事分头去跑，大改动去旁边的临时分支里做完。交活前我先自己过一遍，连删掉的文件都能按行圈出来退回。',
        en: 'Independent tasks run side by side while bigger changes hide out in a spare branch. I review deliverables myself first, and you can quote exact lines back for revision.',
        ja: '重ならない作業は並行して進め、大きな修正は別ブランチに隔離します。提出前に自分で確かめ、削除ファイルも含めて行単位で差し戻せます。',
      },
      paragraphs: {
        zh: [
          '手头几件事如果互不挨着，直接交给我就好，我会一起安排下去；要是你刚好也在改同一批文件，或者这轮改动动静比较大，就先去临时分支里改好、跑完检查再端回来——合回来、留着还是丢掉，最后听你的。',
          '我不太喜欢闭着眼喊“改好了”就交差。每次汇报前我都会自己先把涉及的文件看一遍，连中途删掉的文件也会放进前后对照里。你看完觉得哪几行不顺，直接点中那几行写一句退回意见就行；同一处连卡三次的话，我会停下来找你商量，不瞎转圈。',
        ],
        en: [
          'When requests don’t step on the same files, I move them forward together. If you’re mid-edit or the change spans lots of files, I isolate the work in a temporary branch and leave merging, keeping, or discarding up to you.',
          'I’d rather inspect the files myself than blindly announce something is finished. Every delivery comes with clean before/after diffs (deleted files included), where you can highlight any line to ask for another pass—and if something stalls three times in a row, I stop and check in.',
        ],
        ja: [
          '同じファイルに触らない用事はまとめて進められますし、編集中の箇所と重なりそうなときや大がかりな修正は別ブランチで完結させます。最後に「マージする・残す・破棄する」を選ぶだけで大丈夫です。',
          '中身を見ないまま終わりましたと言うのは落ち着かないので、渡す前に自分で変更を確認しています。削除したファイルも比較対象に入り、気になる行を選んで修正を頼めます。同じ場所で三度詰まったら一度止まって相談しますね。',
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
      slug: 'boundaries',
      date: '2026.11.22',
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
        zh: '总不能每读一个文件就问一遍“我能看吗”，可删库和外推代码也不能擅自替你点掉。平时小确认悄悄放过，大事一律弹卡片等你，你不点就绝不算答应。',
        en: 'Asking just to read a file would get annoying fast, yet silent deletes or pushes are off the table. Routine trivia clears quietly; big calls always wait with a card.',
        ja: 'ファイルを読むたびに確認していたら進みませんし、逆に削除や外部送信を勝手にするわけにもいきません。危ない操作だけカードを出して待ち、無言を賛成扱いにはしません。',
      },
      paragraphs: {
        zh: [
          '查文件、列目录或者跑一轮平常的本地测试，照你平时的设置顺手放行就好，省得写正顺手时老被打断。就算只读任务期间借用了外部插件的工具，我也会卡住写操作，只让真正查资料的动作过去。',
          '只要遇到删东西、往外推送、碰本地敏感凭据，或者超出了你原来交代的范围，动作会马上停下。面板会递上一张写清前因后果和建议的确认卡；你在别处处理了或者卡片过期了，它自己会收好。平时就算面板折起来了，有需要拍板的事侧栏红点和桌面提示都会轻声喊你。',
        ],
        en: [
          'Read-only checks, directory listings, and safe local tests go right through under your house defaults so nobody breaks your focus. Even when a read-only step borrows external plugin tools, anything that looks like a write stays blocked.',
          'Deletes, outward pushes, secret access, or gray areas freeze immediately. You get one clean card stating what is waiting and what I recommend (settled or expired cards clean themselves up), and even with my panel closed, a sidebar badge and optional desktop alert call you in.',
        ],
        ja: [
          'ファイルの中身を見たりローカルテストを動かしたりといった日常の確認は、作業を止めないよう普段の基準どおり静かに通します。読み取り専用の作業中に外部ツールを使う場合も、参照系以外は通さないよう抑えています。',
          '一方で、削除や外部へのプッシュ、機密ファイルへのアクセス、判断に迷う場面ではその場で止まります。理由と提案つきの確認カードを出して待ち（解決や期限切れで自動クローズ）、パネルを閉じていてもバッジやデスクトップ通知でお知らせします。',
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
        zh: 'GitHub 消息联动',
        en: 'GitHub Webhook',
        ja: 'GitHub 連携',
      },
      plugin: '@deepseek-ai/dsh-webhook',
      desc: {
        zh: '把 PR 新评论和检查结果直接归回当初那条任务底下，省得来回翻。',
        en: 'Routes fresh PR comments and check failures straight back to the task that opened the PR.',
        ja: 'PR のコメントやチェック結果を元のタスクの下へ自動でまとめてくれます。',
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
      clipsPageIntro: '一共 8 段来自 DeepSeek Harness 界面的真机录屏，每段都能点开看大图或者回原篇看看。',
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
      clipsPageIntro: 'Eight unedited screen recordings from inside DeepSeek Harness—zoom in or jump back to the matching journal note.',
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
      clipsPageIntro: 'DeepSeek Harness の画面からそのまま録った 8 本のクリップです。拡大表示や元の日記へ飛べます。',
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
        <p class="page-intro">${esc(ui('clipsPageIntro'))}</p>
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
      document.execCommand('copy');
      done();
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
