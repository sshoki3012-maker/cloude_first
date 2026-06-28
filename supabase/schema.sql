-- =============================================================
-- 同窓会「未来予想」投票アプリ  スキーマ
-- Supabase (Postgres) の SQL Editor にこのファイルを貼り付けて実行してください。
-- =============================================================

-- ------- 既存を作り直したいときだけコメントを外す -------
-- drop view  if exists vote_results;
-- drop table if exists votes;
-- drop table if exists settings;
-- drop table if exists awards;
-- drop table if exists participants;

-- 名簿（投票者でも候補者でもある 約40名）
create table if not exists participants (
  id          bigint generated always as identity primary key,
  name        text   not null,
  sort_order  int    not null default 0
);

-- お題 / 賞
create table if not exists awards (
  id          bigint generated always as identity primary key,
  title       text   not null,
  description text   not null default '',
  sort_order  int    not null default 0,
  is_active   boolean not null default true
);

-- イベント設定（年度ごとに1行）
create table if not exists settings (
  event_id     text primary key,
  voting_open  boolean not null default true,
  label        text    not null default ''
);

-- 投票（1お題につき投票者あたり最大3件）
-- point: 選んだ順の配点（1番目=3, 2番目=2, 3番目=1）
create table if not exists votes (
  id            bigint generated always as identity primary key,
  event_id      text   not null,
  voter_id      bigint not null references participants(id) on delete cascade,
  award_id      bigint not null references awards(id)       on delete cascade,
  candidate_id  bigint not null references participants(id) on delete cascade,
  point         int    not null default 0,
  created_at    timestamptz not null default now(),
  unique (event_id, voter_id, award_id, candidate_id)
);

create index if not exists idx_votes_event_award on votes (event_id, award_id);

-- 集計ビュー（お題×候補ごとの得票数と合計ポイント）
create or replace view vote_results as
  select event_id, award_id, candidate_id,
         count(*)::int             as votes,
         coalesce(sum(point), 0)::int as points
  from votes
  group by event_id, award_id, candidate_id;

-- 1お題あたり最大3票を担保するトリガ
create or replace function check_max_votes() returns trigger as $$
begin
  if (select count(*) from votes
        where event_id = new.event_id
          and voter_id  = new.voter_id
          and award_id  = new.award_id) >= 3 then
    raise exception 'この賞では最大3人までしか選べません';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_max_votes on votes;
create trigger trg_max_votes before insert on votes
  for each row execute function check_max_votes();

-- =============================================================
-- RLS（行レベルセキュリティ）
--   認証なし運用なので anon ロールに必要な操作だけ許可します。
--   ※ 管理操作（名簿/お題編集・締切切替・リセット）も anon に開いています。
--     これは「同窓会の余興」用の割り切りです。会場限定URL＋管理画面の
--     合言葉（config.js の ADMIN_PASSCODE）で軽く保護します。
--     より厳密にしたい場合は Supabase Auth + service_role に置き換えてください。
-- =============================================================
alter table participants enable row level security;
alter table awards       enable row level security;
alter table settings     enable row level security;
alter table votes        enable row level security;

-- 参照は全員可
create policy "read participants" on participants for select using (true);
create policy "read awards"       on awards       for select using (true);
create policy "read settings"     on settings     for select using (true);
create policy "read votes"        on votes        for select using (true);

-- 投票の挿入は「受付中」のときだけ
create policy "insert votes when open" on votes for insert
  with check (exists (select 1 from settings s
                      where s.event_id = votes.event_id and s.voting_open));

-- 投票の削除は常に可（本人の修正＝delete→insert、および管理リセットに使用）
create policy "delete votes" on votes for delete using (true);

-- 管理操作（名簿・お題・設定の編集）。割り切って anon に開放。
create policy "write participants" on participants for all using (true) with check (true);
create policy "write awards"       on awards       for all using (true) with check (true);
create policy "write settings"     on settings     for all using (true) with check (true);
