-- Phase 2: RPC functions for hybrid retrieval from the Next.js API route.
-- These join chunks → pages → issues → papers and apply optional filters,
-- keeping the heavy lifting in Postgres where the indexes live.

create or replace function match_chunks_semantic(
  query_embedding vector(1024),
  match_count int default 50,
  filter_paper_lccn text default null,
  filter_date_from date default null,
  filter_date_to date default null
)
returns table (
  chunk_id uuid,
  content text,
  page_id uuid,
  paper_lccn text,
  paper_title text,
  date_issued date,
  edition int,
  page_sequence int,
  image_url text,
  resource_url text,
  similarity float
)
language sql stable
as $$
  select
    c.id as chunk_id,
    c.content,
    p.id as page_id,
    pa.lccn as paper_lccn,
    pa.title as paper_title,
    i.date_issued,
    i.edition,
    p.sequence as page_sequence,
    p.image_url,
    coalesce(p.iiif_info_url, '') as resource_url,
    1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  join pages p on p.id = c.page_id
  join issues i on i.id = p.issue_id
  join papers pa on pa.id = i.paper_id
  where c.is_current = true
    and (filter_paper_lccn is null or pa.lccn = filter_paper_lccn)
    and (filter_date_from is null or i.date_issued >= filter_date_from)
    and (filter_date_to is null or i.date_issued <= filter_date_to)
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function match_chunks_fts(
  query text,
  match_count int default 50,
  filter_paper_lccn text default null,
  filter_date_from date default null,
  filter_date_to date default null
)
returns table (
  chunk_id uuid,
  content text,
  page_id uuid,
  paper_lccn text,
  paper_title text,
  date_issued date,
  edition int,
  page_sequence int,
  image_url text,
  resource_url text,
  rank float
)
language sql stable
as $$
  select
    c.id as chunk_id,
    c.content,
    p.id as page_id,
    pa.lccn as paper_lccn,
    pa.title as paper_title,
    i.date_issued,
    i.edition,
    p.sequence as page_sequence,
    p.image_url,
    coalesce(p.iiif_info_url, '') as resource_url,
    ts_rank_cd(c.fts, websearch_to_tsquery('english', query)) as rank
  from chunks c
  join pages p on p.id = c.page_id
  join issues i on i.id = p.issue_id
  join papers pa on pa.id = i.paper_id
  where c.is_current = true
    and c.fts @@ websearch_to_tsquery('english', query)
    and (filter_paper_lccn is null or pa.lccn = filter_paper_lccn)
    and (filter_date_from is null or i.date_issued >= filter_date_from)
    and (filter_date_to is null or i.date_issued <= filter_date_to)
  order by rank desc
  limit match_count;
$$;

-- Column for pre-resolved IIIF info.json URLs (backfilled separately).
alter table pages add column if not exists iiif_info_url text;
