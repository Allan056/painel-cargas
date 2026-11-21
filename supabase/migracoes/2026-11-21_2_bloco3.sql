-- Painel de Cargas · bloco 3: comentários, motivo do atraso, alertas por e-mail e relatório mensal
-- Aplicado em 21/11/2026.
-- Antes de aplicar: conferir com pg_get_functiondef('public.disparar_emails'::regproc) se a versão no banco é a mesma da seção 6
-- (a seção 6 reescreve a função inteira, mantendo diário, semanal e paletes como estão hoje).

-- 1) Motivo do atraso na carga
alter table public.cargas add column if not exists motivo_atraso jsonb;
-- 1b) Detalhes da carga vindos do relatório do WMS (aba Detail): unidades da carga e lista de itens {em, lista:[{l,sku,ped,aj,p}]}
alter table public.cargas add column if not exists unidades integer check (unidades is null or unidades >= 0);
alter table public.cargas add column if not exists itens jsonb check (itens is null or pg_column_size(itens) < 200000);

create or replace function public.cargas_confere() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if; -- rotinas do servidor
  if new.status is distinct from old.status and not (public.pode('etapa') or public.pode('base')) then
    raise exception 'Seu perfil não permite mudar a etapa da carga.' using errcode = '42501'; end if;
  if new.rf_info is distinct from old.rf_info and not (public.pode('rf') or public.pode('base')) then
    raise exception 'Seu perfil não permite marcar R.F.' using errcode = '42501'; end if;
  if new.motivo_atraso is distinct from old.motivo_atraso and not (public.pode('motivo') or public.pode('editar') or public.pode('base')) then
    raise exception 'Seu perfil não permite informar o motivo do atraso.' using errcode = '42501'; end if;
  if (new.unidades, new.itens) is distinct from (old.unidades, old.itens) and not public.pode('base') then
    raise exception 'Só quem carrega a base pode atualizar os detalhes da carga.' using errcode = '42501'; end if;
  if (new.envio, new.carga, new.galpao, new.loja, new.rot, new.agenda, new.volume, new.pbr, new.chep, new.obs)
     is distinct from (old.envio, old.carga, old.galpao, old.loja, old.rot, old.agenda, old.volume, old.pbr, old.chep, old.obs)
     and not (public.pode('editar') or public.pode('base')) then
    raise exception 'Seu perfil não permite editar os dados da carga.' using errcode = '42501'; end if;
  return new;
end $$;

-- a política de UPDATE em cargas usa public.pode_editar(); passa a aceitar também quem só informa o motivo
create or replace function public.pode_editar() returns boolean language sql stable security definer set search_path = '' as $$
  select public.pode('etapa') or public.pode('rf') or public.pode('editar') or public.pode('base') or public.pode('ocorrencia') or public.pode('motivo') $$;

create or replace function public.hist_motivo() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.motivo_atraso is distinct from old.motivo_atraso then
    perform public.registrar('carga', new.id, new.carga, new.envio,
      case when new.motivo_atraso is null then 'removeu o motivo do atraso' else 'informou motivo do atraso' end,
      jsonb_build_array(jsonb_build_object('campo','motivo','de',old.motivo_atraso->>'motivo','para',new.motivo_atraso->>'motivo')));
  end if;
  return new;
end $$;
drop trigger if exists hist_motivo on public.cargas;
create trigger hist_motivo after update of motivo_atraso on public.cargas for each row execute function public.hist_motivo();

-- 2) Comentários da carga
create table if not exists public.comentarios (
  id uuid primary key default gen_random_uuid(),
  carga_id text not null references public.cargas(id) on delete cascade,
  carga text not null default '',
  envio text not null default '',
  texto text not null check (char_length(btrim(texto)) between 1 and 1000),
  autor uuid default auth.uid() references auth.users(id) on delete set null,
  autor_nome text not null default '',
  criado_em timestamptz not null default now()
);
create index if not exists comentarios_carga on public.comentarios (carga_id, criado_em);
alter table public.comentarios enable row level security;

create or replace function public.comentario_autor() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.autor := auth.uid(); new.criado_em := now();
  select coalesce(p.usuario, '') into new.autor_nome from public.perfis p where p.id = auth.uid();
  return new;
end $$;
drop trigger if exists comentario_autor on public.comentarios;
create trigger comentario_autor before insert on public.comentarios for each row execute function public.comentario_autor();

create or replace function public.hist_comentarios() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public.registrar('carga', new.carga_id, new.carga, new.envio, 'comentou', jsonb_build_array(jsonb_build_object('campo','comentario','de',null,'para',left(new.texto, 120))));
    return new;
  end if;
  perform public.registrar('carga', old.carga_id, old.carga, old.envio, 'apagou comentário', jsonb_build_array(jsonb_build_object('campo','comentario','de',left(old.texto, 120),'para',null)));
  return old;
end $$;
drop trigger if exists hist_comentarios on public.comentarios;
create trigger hist_comentarios after insert or delete on public.comentarios for each row execute function public.hist_comentarios();

drop policy if exists comentarios_ler on public.comentarios;
drop policy if exists comentarios_criar on public.comentarios;
drop policy if exists comentarios_apagar on public.comentarios;
create policy comentarios_ler on public.comentarios for select to authenticated using (public.tem_perfil());
create policy comentarios_criar on public.comentarios for insert to authenticated with check (public.pode('comentar'));
create policy comentarios_apagar on public.comentarios for delete to authenticated
  using (public.tem_perfil() and (autor = auth.uid() or exists (select 1 from public.perfis p where p.id = auth.uid() and p.perfil = 'master' and not p.bloqueado)));
-- sem UPDATE: comentário não se edita, só se apaga e escreve de novo
grant select, insert, delete on public.comentarios to authenticated;
alter publication supabase_realtime add table public.comentarios;

-- 3) Registro dos alertas enviados (só leitura para o Master; quem grava é a função resumo com a chave de serviço)
create table if not exists public.alertas_enviados (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('atrasada','ocorrencia','teste')),
  chave text not null,                -- id da carga (atrasada) ou da ocorrência; evita aviso repetido
  carga text not null default '',
  envio text not null default '',
  para text[] not null default '{}',
  enviado_em timestamptz not null default now(),
  unique (tipo, chave)
);
alter table public.alertas_enviados enable row level security;
drop policy if exists alertas_ler on public.alertas_enviados;
create policy alertas_ler on public.alertas_enviados for select to authenticated
  using (exists (select 1 from public.perfis p where p.id = auth.uid() and p.perfil = 'master' and not p.bloqueado));
grant select on public.alertas_enviados to authenticated;

-- 4) Configuração inicial (desligado até o Master ligar)
update public.cargas_config set valor = valor
  || jsonb_build_object('alertas', coalesce(valor->'alertas', '{"ativo":false,"atrasada":true,"ocorrencia":true,"extras":[]}'::jsonb))
  || jsonb_build_object('mensal', coalesce(valor->'mensal', jsonb_build_object('ativo', false, 'hora', '07:00', 'destinatarios', coalesce(valor->'diario'->'destinatarios', '[]'::jsonb))))
  where chave = 'resumo';

-- 5) Alerta imediato quando uma ocorrência é registrada
create or replace function public.alerta_ocorrencia() returns trigger language plpgsql security definer set search_path = '' as $$
declare cfg jsonb; k_cron text;
begin
  select c.valor->'alertas' into cfg from public.cargas_config c where c.chave = 'resumo';
  if cfg is null or not coalesce((cfg->>'ativo')::boolean, false) or not coalesce((cfg->>'ocorrencia')::boolean, true) then return new; end if;
  select g.valor into k_cron from public.segredos g where g.chave = 'cron_key';
  if k_cron is null then return new; end if;
  perform net.http_post(url := 'https://yqwlxxfwarqnvjeggvvr.supabase.co/functions/v1/resumo',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-key', k_cron),
    body := jsonb_build_object('acao','alerta_ocorrencia','id', new.id), timeout_milliseconds := 20000);
  return new;
end $$;
drop trigger if exists alerta_ocorrencia on public.ocorrencias;
create trigger alerta_ocorrencia after insert on public.ocorrencias for each row execute function public.alerta_ocorrencia();
revoke execute on function public.alerta_ocorrencia(), public.hist_motivo(), public.hist_comentarios(), public.comentario_autor() from public, anon, authenticated;

-- 6) Agendador (a cada 15 min): diário, semanal, paletes (iguais a hoje) + alertas de atraso (de hora em hora) + relatório mensal (dia 1)
create or replace function public.disparar_emails() returns text language plpgsql security definer set search_path to '' as $$
declare
  cfg jsonb; agora timestamp := now() at time zone 'America/Sao_Paulo';
  hoje text := to_char(agora, 'YYYY-MM-DD'); hora text := to_char(agora, 'HH24:MI');
  dow int := extract(isodow from agora)::int; mes_ant text := to_char(agora - interval '1 month', 'YYYY-MM');
  k_cron text; url text := 'https://yqwlxxfwarqnvjeggvvr.supabase.co/functions/v1/resumo'; feito text := '';
  d jsonb; s jsonb; a jsonb; m jsonb;
begin
  select c.valor into cfg from public.cargas_config c where c.chave = 'resumo';
  select g.valor into k_cron from public.segredos g where g.chave = 'cron_key';
  if cfg is null or k_cron is null then return 'sem configuração'; end if;
  d := coalesce(cfg->'diario', '{}'::jsonb); s := coalesce(cfg->'semanal', '{}'::jsonb);
  a := coalesce(cfg->'alertas', '{}'::jsonb); m := coalesce(cfg->'mensal', '{}'::jsonb);
  if coalesce((d->>'ativo')::boolean, false)
     and hora >= coalesce(d->>'hora', '07:00')
     and (coalesce((d->>'fimDeSemana')::boolean, false) or dow <= 5)
     and coalesce((select g.valor from public.segredos g where g.chave = 'diario_ultimo'), '') <> hoje
     and coalesce((select g.valor from public.segredos g where g.chave = 'diario_tentativa'), '') <> hoje || ' ' || substr(hora, 1, 2)
  then
    insert into public.segredos (chave, valor) values ('diario_tentativa', hoje || ' ' || substr(hora, 1, 2))
      on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();
    perform net.http_post(url := url, headers := jsonb_build_object('Content-Type','application/json','x-cron-key', k_cron),
                          body := '{"acao":"diario"}'::jsonb, timeout_milliseconds := 20000);
    feito := feito || 'diario ';
  end if;
  if coalesce((s->>'ativo')::boolean, false)
     and dow = coalesce((s->>'diaSemana')::int, 1)
     and hora >= coalesce(s->>'hora', '08:00')
     and coalesce((select g.valor from public.segredos g where g.chave = 'semanal_ultimo'), '') <> hoje
     and coalesce((select g.valor from public.segredos g where g.chave = 'semanal_tentativa'), '') <> hoje || ' ' || substr(hora, 1, 2)
  then
    insert into public.segredos (chave, valor) values ('semanal_tentativa', hoje || ' ' || substr(hora, 1, 2))
      on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();
    perform net.http_post(url := url, headers := jsonb_build_object('Content-Type','application/json','x-cron-key', k_cron),
                          body := '{"acao":"semanal"}'::jsonb, timeout_milliseconds := 60000);
    feito := feito || 'semanal ';
  end if;
  if exists (select 1 from public.cargas_config c where c.chave = 'paletes')
     and hora >= '07:00'
     and coalesce((select g.valor from public.segredos g where g.chave = 'paletes_ultimo'), '') <> hoje
     and coalesce((select g.valor from public.segredos g where g.chave = 'paletes_tentativa'), '') <> hoje || ' ' || substr(hora, 1, 2)
  then
    insert into public.segredos (chave, valor) values ('paletes_tentativa', hoje || ' ' || substr(hora, 1, 2))
      on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();
    perform net.http_post(url := url, headers := jsonb_build_object('Content-Type','application/json','x-cron-key', k_cron),
                          body := '{"acao":"paletes"}'::jsonb, timeout_milliseconds := 20000);
    feito := feito || 'paletes ';
  end if;
  -- cargas atrasadas: uma conferência por hora, das 06h às 22h (a função só avisa carga que ainda não foi avisada)
  if coalesce((a->>'ativo')::boolean, false) and coalesce((a->>'atrasada')::boolean, true)
     and hora between '06:00' and '22:59'
     and coalesce((select g.valor from public.segredos g where g.chave = 'alertas_tentativa'), '') <> hoje || ' ' || substr(hora, 1, 2)
  then
    insert into public.segredos (chave, valor) values ('alertas_tentativa', hoje || ' ' || substr(hora, 1, 2))
      on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();
    perform net.http_post(url := url, headers := jsonb_build_object('Content-Type','application/json','x-cron-key', k_cron),
                          body := '{"acao":"alertas"}'::jsonb, timeout_milliseconds := 20000);
    feito := feito || 'alertas ';
  end if;
  -- relatório mensal: dia 1, a partir do horário escolhido, com os números do mês anterior
  if coalesce((m->>'ativo')::boolean, false)
     and extract(day from agora) = 1
     and hora >= coalesce(m->>'hora', '07:00')
     and coalesce((select g.valor from public.segredos g where g.chave = 'mensal_ultimo'), '') <> mes_ant
     and coalesce((select g.valor from public.segredos g where g.chave = 'mensal_tentativa'), '') <> hoje || ' ' || substr(hora, 1, 2)
  then
    insert into public.segredos (chave, valor) values ('mensal_tentativa', hoje || ' ' || substr(hora, 1, 2))
      on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();
    perform net.http_post(url := url, headers := jsonb_build_object('Content-Type','application/json','x-cron-key', k_cron),
                          body := jsonb_build_object('acao','mensal','mes', mes_ant), timeout_milliseconds := 30000);
    feito := feito || 'mensal';
  end if;
  return coalesce(nullif(btrim(feito), ''), 'nada a fazer');
end $$;
revoke execute on function public.disparar_emails() from public, anon, authenticated;

-- 7) Base de SKUs (código → descrição). Sem DELETE: a base só cresce ou é corrigida.
create table if not exists public.skus (
  sku text primary key check (char_length(sku) between 1 and 30),
  descricao text not null check (char_length(btrim(descricao)) between 1 and 200),
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid default auth.uid()
);
alter table public.skus enable row level security;
create or replace function public.skus_carimbo() returns trigger language plpgsql security definer set search_path = '' as $$
begin new.atualizado_em := now(); new.atualizado_por := auth.uid(); return new; end $$;
drop trigger if exists skus_carimbo on public.skus;
create trigger skus_carimbo before insert or update on public.skus for each row execute function public.skus_carimbo();
revoke execute on function public.skus_carimbo() from public, anon, authenticated;
drop policy if exists skus_ler on public.skus;
drop policy if exists skus_criar on public.skus;
drop policy if exists skus_alterar on public.skus;
create policy skus_ler on public.skus for select to authenticated using ((select public.tem_perfil()));
create policy skus_criar on public.skus for insert to authenticated with check ((select public.pode('base')));
create policy skus_alterar on public.skus for update to authenticated using ((select public.pode('base'))) with check ((select public.pode('base')));
grant select, insert, update on public.skus to authenticated;
alter publication supabase_realtime add table public.skus;

-- 8) Limpeza: comentários e alertas acompanham a carga; alertas com mais de 180 dias saem
-- (rodar dentro de manutencao_diaria se quiser; por ora fica só a instrução)
-- delete from public.alertas_enviados where enviado_em < now() - interval '180 days';
