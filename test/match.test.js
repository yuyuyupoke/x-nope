// content.js から照合ロジックだけを切り出して検証する
const fs = require('fs');
const path = require('path');
const target = process.argv[2] || path.join(__dirname, '..', 'content.js');
const src = fs.readFileSync(target, 'utf8');

function grab(re, name) {
  const m = src.match(re);
  if (!m) throw new Error('抽出失敗: ' + name);
  return m[0];
}
const parts = [
  grab(/const TARGET_LABELS = \[[\s\S]*?\];/, 'TARGET_LABELS'),
  grab(/const DANGER_LABELS = \[[\s\S]*?\];/, 'DANGER_LABELS'),
  'const conf = { labels: () => [] };',
  grab(/const norm = [^\n]*\n/, 'norm'),
  grab(/function isNotInterested\(text\) \{[\s\S]*?\n  \}/, 'isNotInterested'),
  'return isNotInterested;',
].join('\n');
const isNotInterested = new Function(parts)();

// 実際の X のメニュー構成を再現
const CASES = [
  // [ラベル, 押してよいか]
  ['この投稿に興味がない', true],
  ['興味がない', true],
  ['Not interested in this post', true],
  ['Not interested', true],

  // 以下はすべて false でなければならない
  ['@example さんをフォロー解除', false],
  ['@example さんをミュート', false],
  ['@example さんをブロック', false],
  ['この投稿を報告する', false],
  ['埋め込み投稿', false],
  ['エンゲージメントを表示', false],
  ['アナリティクスを表示', false],
  ['投稿へのリンクをコピー', false],
  ['コミュニティノートをリクエスト', false],
  ['リストに追加または削除', false],
  ['ブックマークに追加', false],
  ['この投稿を削除', false],
  ['固定する', false],
  ['返信できるユーザーを変更', false],
  ['Unfollow @example', false],
  ['Mute @example', false],
  ['Block @example', false],
  ['Report post', false],
  ['Embed post', false],
  ['View post engagements', false],
  ['View post analytics', false],
  ['Copy link to post', false],
  ['Request Community Note', false],
  ['Add/remove @example from Lists', false],
  ['Bookmark', false],
  ['Delete post', false],
  ['Pin to your profile', false],
  ['Change who can reply', false],
  ['', false],
  ['   ', false],
];

let fail = 0;
for (const [label, want] of CASES) {
  const got = isNotInterested(label);
  const ok = got === want;
  if (!ok) fail++;
  const mark = ok ? '  ok  ' : ' FAIL ';
  const risk = (!ok && got === true) ? '  ← 誤爆！' : '';
  console.log(`${mark} ${got ? '押す  ' : '押さない'}  ${JSON.stringify(label)}${risk}`);
}

// 実メニュー1式を通したときに「ちょうど1件」だけ選ばれるか
for (const [name, menu] of [
  ['日本語・他人の投稿', ['この投稿に興味がない','@example さんをフォロー解除','@example さんをミュート','@example さんをブロック','この投稿を報告する','埋め込み投稿','エンゲージメントを表示','投稿へのリンクをコピー','リストに追加または削除']],
  ['英語・他人の投稿',   ['Not interested in this post','Unfollow @example','Mute @example','Block @example','Report post','Embed post','View post engagements','Copy link to post']],
  ['自分の投稿（該当なしが正解）', ['この投稿を削除','固定する','アナリティクスを表示','埋め込み投稿','返信できるユーザーを変更']],
]) {
  const hits = menu.filter(isNotInterested);
  const expect = name.includes('該当なし') ? 0 : 1;
  const ok = hits.length === expect;
  if (!ok) fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}: ${hits.length}件選択 ${JSON.stringify(hits)}`);
}

console.log(fail === 0 ? '\n全' + (CASES.length + 3) + '件 パス' : '\n' + fail + '件 失敗');
process.exit(fail ? 1 : 0);
