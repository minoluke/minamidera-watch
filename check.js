#!/usr/bin/env node
'use strict';

/*
 * ベネッセアートサイト直島 家プロジェクト「南寺」 キャンセル待ちウォッチャー
 *
 * ■ なぜこの作りなのか
 *   - 南寺のチケットは eventos（benesse-artsite.eventos.tokyo）で売られている。
 *     予約ページ自体はログイン必須だが、ページが裏で叩いている在庫 API
 *     `web_api/v2/ticket/{portal}/{event}/{content}` は **ログインなし・素の HTTP で通る**。
 *     Cloudflare のチャレンジも UA チェックもないので、ブラウザは要らない（e5489 と違い patchright 不要）。
 *   - チケットは 大分類（施設×月）→ 中分類（日付）→ 小分類（15分刻みの時間枠）→ チケット の4階層。
 *     中分類を指定して List を叩くと、その日の全枠の remaining_status（enough/few/none）が1回で取れる。
 *     小分類を指定すると remaining_count（残り枚数）まで取れるので、監視枠だけ追加で1回叩く。
 *
 * ■ 通知の判断
 *   前回状態(state.json)と比べ、監視枠が × → △/○ に変わった瞬間だけメールする。
 *   キャンセルは予約時間の30分前まで受け付けられるので、当日朝まで空きが出る可能性がある。
 */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');
const LOG_PATH = path.join(DIR, 'watch.log');

const ARGS = process.argv.slice(2);
const FLAG_TEST_EMAIL = ARGS.includes('--test-email');
const FLAG_NO_EMAIL = ARGS.includes('--no-email');

const API_BASE = 'https://benesse-artsite.eventos.tokyo';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// eventos の remaining_status → 表示記号 / 空き度合い
//   enough … 購入可能（残り11枚以上）  few … 残りわずか（1〜10枚）  none … 売り切れ
const STATUS = {
  enough: { mark: '○', level: 2, label: '購入可能' },
  few:    { mark: '△', level: 1, label: '残りわずか' },
  none:   { mark: '×', level: 0, label: '売り切れ' },
};

// ---------- ユーティリティ ----------
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (_) {}
}

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}

function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// 日本時間の「今」を {ymd, hhmm} で返す（マシンのTZに依存しない）
function nowJst() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { ymd: `${p.year}${p.month}${p.day}`, hhmm: Number(p.hour) * 60 + Number(p.minute) };
}

// "09:50" / "9:50" → "9:50"（eventos の枠名は時の先頭ゼロなし）
function normTime(t) {
  const [h, m] = String(t).trim().split(':');
  return `${Number(h)}:${String(m).padStart(2, '0')}`;
}
function toMinutes(t) {
  const [h, m] = normTime(t).split(':').map(Number);
  return h * 60 + m;
}

// ---------- メール ----------
/*
 * メール設定の置き場所は2通り。上から順に探す。
 *   1. 環境変数 GMAIL_USER / MAIL_TO / GMAIL_APP_PASSWORD … GitHub Actions ではこれ（Secrets から渡す）
 *   2. secrets.json … ローカル実行用。gitignore 済み
 * MAIL_TO はカンマ区切りで複数指定できる。
 * メールアドレスもアプリパスワードもリポジトリには置かない（公開リポジトリのため）。
 */
function resolveMail() {
  const sec = loadJson(path.join(DIR, 'secrets.json'), {}) || {};
  const pick = (env, key) => (process.env[env] ? process.env[env].trim() : sec[key]);

  const user = pick('GMAIL_USER', 'gmailUser');
  const to = pick('MAIL_TO', 'to') || user;
  const pass = pick('GMAIL_APP_PASSWORD', 'gmailAppPassword');

  const missing = [];
  if (!user) missing.push('送信元Gmail (GMAIL_USER)');
  if (!pass) missing.push('アプリパスワード (GMAIL_APP_PASSWORD)');
  if (missing.length) {
    throw new Error(`${missing.join(' / ')} が見つかりません。環境変数か secrets.json に設定してください`);
  }
  return { user, to, from: sec.from || user, pass };
}

async function sendMail(subject, text) {
  const m = resolveMail();
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: m.user, pass: m.pass },
  });
  await transporter.sendMail({ from: m.from, to: m.to, subject, text });
}

// ---------- eventos API ----------
/*
 * GET /web_api/v2/ticket/{portalId}/{eventId}/{contentId}
 *   パラメータなし                                  … 大分類（施設×月）の一覧
 *   ?type=List&ticket_category_type=Large&ticket_category_id=…  … その施設の中分類（日付）一覧
 *   ?type=List&ticket_category_type=Middle&ticket_category_id=… … その日の小分類（時間枠）一覧
 *   ?type=List&ticket_category_type=Small&ticket_category_id=…  … その枠のチケット（remaining_count 付き）
 */
async function apiList(cfg, type, id) {
  const { portalId, eventId, contentId } = cfg.eventos;
  const url = new URL(`${API_BASE}/web_api/v2/ticket/${portalId}/${eventId}/${contentId}`);
  if (type) {
    url.searchParams.set('type', 'List');
    url.searchParams.set('ticket_category_type', type);
    url.searchParams.set('ticket_category_id', String(id));
  }
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Language: 'jpn', 'App-Type': 'Portal', 'User-Agent': UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.pathname}${url.search}`);
  const json = await res.json();
  if (json.code !== 200 || !json.data) {
    throw new Error(`API エラー: ${JSON.stringify(json.error || json).slice(0, 200)}`);
  }
  return json.data;
}

// 設定の施設名・日付から 大分類ID / 中分類ID を引く（日付ごとに ID が違うため）
async function resolveIds(cfg) {
  const [y, m, d] = cfg.date.split('-').map(Number);
  const top = await apiList(cfg);
  const larges = top.ticket_large_categories || [];
  const large = larges.find((c) => c.title.includes(cfg.facility) && c.title.includes(`${y}年${m}月分`));
  if (!large) {
    throw new Error(`大分類「${cfg.facility} ${y}年${m}月分」が見つかりません（候補: ${larges.map((c) => c.title).join(' / ')}）`);
  }
  const mids = (await apiList(cfg, 'Large', large.ticket_large_category_id)).ticket_middle_categories || [];
  const middle = mids.find((c) => c.title === `${y}/${m}/${d}`);
  if (!middle) {
    throw new Error(`${y}/${m}/${d} の枠がありません（休館日または販売前。販売中の日: ${mids.map((c) => c.title).join(' ')}）`);
  }
  return {
    large: large.ticket_large_category_id, largeTitle: large.title,
    middle: middle.ticket_middle_category_id, middleTitle: middle.title,
  };
}

// 予約ページ（ログイン後にこの日の時間枠一覧が出る）
function purchaseUrl(cfg, ids) {
  const { portalId, eventId, contentId } = cfg.eventos;
  return `${API_BASE}/web/portal/${portalId}/event/${eventId}/module/ticket/${contentId}` +
    `?ticketLargeCategoryId=${ids.large}&ticketMiddleCategoryId=${ids.middle}`;
}

// ---------- メイン ----------
async function main() {
  const cfg = loadJson(CONFIG_PATH, null);
  if (!cfg) { log('ERROR: config.json が読めません'); process.exit(1); }

  if (FLAG_TEST_EMAIL) {
    log('テストメールを送信します…');
    await sendMail('【テスト】南寺 キャンセル待ちウォッチャー', 'これはテストメールです。届いていれば設定OKです。');
    log('テストメール送信完了。受信を確認してください。');
    return;
  }

  const watchTimes = (cfg.watchTimes || []).map(normTime);
  if (!watchTimes.length) { log('ERROR: watchTimes が空です'); process.exit(1); }
  const partySize = Number(cfg.partySize) > 0 ? Number(cfg.partySize) : 1;
  const [y, m, d] = cfg.date.split('-').map(Number);
  const dateLabel = `${y}/${m}/${d}`;

  // 監視する最後の枠の時刻を過ぎたら終了コード9で抜ける。GitHub Actions 側がこれを見て
  // スケジュールを自動で無効化する（ループが空回りし続けないように）。
  // 販売は各枠の開始時刻ちょうどまで、キャンセル受付はその30分前まで。
  const now = nowJst();
  const ymd = cfg.date.replace(/-/g, '');
  const lastSlot = Math.max(...watchTimes.map(toMinutes));
  if (ymd < now.ymd || (ymd === now.ymd && now.hhmm >= lastSlot)) {
    log(`${dateLabel} ${watchTimes.join('/')} の枠の時刻を過ぎたので監視を終了します`);
    process.exit(9);
  }

  // 施設名や日付を変えたら過去の状態もIDキャッシュも無関係になるので捨てる
  const scope = `${cfg.facility}|${cfg.date}`;
  const state = loadJson(STATE_PATH, {});
  const sameScope = state.scope === scope;
  const prev = sameScope ? (state.statuses || {}) : {};
  let ids = sameScope && state.ids && state.ids.large && state.ids.middle ? state.ids : null;

  // その日の全枠を取る。キャッシュしたIDで別の日が返ってきたら引き直す
  let slots = null;
  for (let attempt = 1; attempt <= 2 && !slots; attempt++) {
    if (!ids) {
      ids = await resolveIds(cfg);
      log(`ID を解決: ${ids.largeTitle} (${ids.large}) / ${ids.middleTitle} (${ids.middle})`);
    }
    const data = await apiList(cfg, 'Middle', ids.middle);
    const cur = data.current_ticket_categories || {};
    const gotDate = cur.ticket_middle_category && cur.ticket_middle_category.title;
    const gotFacility = cur.ticket_large_category && cur.ticket_large_category.title;
    if (gotDate === dateLabel && gotFacility && gotFacility.includes(cfg.facility)) {
      slots = data.ticket_small_categories || [];
    } else {
      log(`WARN: キャッシュしたIDが「${gotFacility} ${gotDate}」を指していたので引き直します`);
      ids = null;
    }
  }
  if (!slots) { log('ERROR: 対象日の枠一覧を取得できませんでした'); process.exit(1); }
  if (!slots.length) { log('ERROR: 枠一覧が空です（サイト構造の変更の可能性）'); process.exit(1); }

  // 監視枠の状態を拾う。空きがある枠は残り枚数まで取る
  const observed = {};   // "9:50" -> {status, mark, level, remaining, enough, smallId}
  const failures = [];
  for (const want of watchTimes) {
    const s = slots.find((x) => normTime(x.title) === want);
    if (!s) {
      log(`WARN: ${want} の枠がありません（この日の枠: ${slots.map((x) => x.title).join(' ')}）`);
      failures.push(want);
      continue;
    }
    // 未知の remaining_status は「売り切れではない」側に倒す。見逃すほうが損失が大きい
    const st = STATUS[s.remaining_status] || { mark: '?', level: 1, label: String(s.remaining_status) };
    let remaining = st.level === 0 ? 0 : null;
    if (st.level > 0) {
      try {
        const tk = ((await apiList(cfg, 'Small', s.ticket_small_category_id)).tickets || [])[0];
        if (tk && typeof tk.remaining_count === 'number') remaining = tk.remaining_count;
      } catch (e) {
        log(`WARN: ${want} の残り枚数を取得できず: ${e.message}`);
      }
    }
    // 残り枚数が分かれば人数と突き合わせる。分からなければ記号で判断する
    const enough = remaining !== null ? remaining >= partySize : st.level === 2;
    const level = (remaining !== null ? remaining === 0 : st.level === 0) ? 0 : (enough ? 2 : 1);
    observed[want] = {
      status: s.remaining_status, mark: st.mark, label: st.label, level, enough, remaining,
      smallId: s.ticket_small_category_id, saleStatus: s.sale_status,
    };
  }

  const keys = watchTimes.filter((t) => observed[t]);
  if (!keys.length) {
    log('ERROR: 監視枠の状態を1件も取得できませんでした');
    process.exitCode = 1;
    return;
  }
  const summary = slots.map((x) => `${(STATUS[x.remaining_status] || { mark: '?' }).mark}${normTime(x.title)}`).join(' ');
  log(`${dateLabel} ${partySize}名で照会。監視枠: ` + keys.map((t) => {
    const o = observed[t];
    const n = o.remaining !== null ? `残${o.remaining}` : o.label;
    return `${t}=${o.mark}(${n})`;
  }).join('  ') + `  | 全枠: ${summary}`);

  // 前回 × → 今回 △/○ になったものだけ通知する（空きが増えた方向にだけ）
  const newly = keys.filter((t) => {
    const nowLv = observed[t].level;
    const before = (prev[t] && prev[t].level) || 0;
    return nowLv >= 1 && nowLv > before;
  });

  if (newly.length && !FLAG_NO_EMAIL) {
    const fmt = (t) => {
      const o = observed[t];
      const n = o.remaining !== null ? `残り ${o.remaining} 枚` : o.label;
      return `  ${o.mark} ${t}　${n}${o.enough ? '' : `（${partySize}名分あるか要確認）`}`;
    };
    const first = observed[newly[0]];
    const count = first.remaining !== null ? `残り${first.remaining}枚` : first.label;
    const subject = `🏯 南寺 ${m}/${d} ${newly.join('・')} に空きが出ました（${count}）`;
    const body =
      `家プロジェクト「南寺」 ${dateLabel} の枠に空きが出ました。\n\n` +
      newly.map(fmt).join('\n') +
      `\n\n購入 → ${purchaseUrl(cfg, ids)}\n` +
      `（ログイン後、この日の時間枠一覧が出るので ${newly.join('・')} を選んでください）\n` +
      `\n── ${dateLabel} の全枠 ──\n` +
      slots.map((x) => {
        const st = STATUS[x.remaining_status] || { mark: '?', label: x.remaining_status };
        const t = normTime(x.title);
        const o = observed[t];
        const n = o && o.remaining !== null ? `残り${o.remaining}枚` : st.label;
        return `  ${st.mark} ${t}　${n}${o ? '　← 監視中' : ''}`;
      }).join('\n') +
      `\n\n※ キャンセルは予約時間の30分前まで受け付けられるため、当日朝まで空きが出ることがあります。\n` +
      `空きは早い者勝ちです。すぐ確保してください。\n` +
      (failures.length ? `\n※ 取得できなかった枠: ${failures.join(', ')}\n` : '') +
      `\n（同じ枠の状態が変わらないあいだは繰り返し通知しません）`;
    try {
      await sendMail(subject, body);
      log(`★ メール通知: ${newly.join(', ')}`);
    } catch (e) {
      log(`ERROR: メール送信失敗: ${e.message}`);
      process.exitCode = 1;
      return; // 送れていないので state は更新しない（次回また通知させる）
    }
  } else if (newly.length) {
    log(`[--no-email] 新規の空き ${newly.length} 件: ${newly.join(', ')}`);
  } else {
    log('新規の空きなし（通知なし）');
  }

  // 取得できた枠だけ更新する。取りこぼした枠の状態は前回値を残す。
  // 毎回変わる値（実行時刻など）は入れない。GitHub Actions は state.json に差分があるときだけコミットするため。
  saveJson(STATE_PATH, { scope, ids, statuses: { ...prev, ...observed } });
}

main().catch((e) => {
  log(`ERROR: ${e.stack || e.message}`);
  process.exit(1);
});
