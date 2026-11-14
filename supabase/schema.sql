-- =====================================================================
-- Painel de Cargas · banco de dados (Supabase / PostgreSQL)
-- Estado final das migrações aplicadas no projeto. Sem dados reais.
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------- contas e perfis ----------
create table public.perfis (
  id uuid primary key references auth.users(id) on delete cascade,
  usuario text not null,
  usuario_lower text generated always as (lower(btrim(usuario))) stored unique,
  perfil text not null default 'leitura' check (perfil in ('master','admin','leitura')),
  equipe text,
  funcao text,
  criado_em timestamptz not null default now()
);
comment on table public.perfis is 'master = Administrador Master (tudo: regras, perfis, cadastros, e-mails); admin = Administrador (base, WMS, status, agenda, ocorrências); leitura = Visualizador (padrão de toda conta nova)';

-- só a função "contas" (service role) lê: hash do código do time, chave do agendador, marcas de envio
create table public.segredos (
  chave text primary key,
  valor text not null,
  atualizado_em timestamptz not null default now()
);

create or replace function public.meu_perfil() returns text language sql stable security definer set search_path to '' as $$
  select p.perfil from public.perfis p where p.id = auth.uid() $$;
create or replace function public.pode_editar() returns boolean language sql stable security definer set search_path to '' as $$
  select coalesce((select p.perfil in ('master','admin') from public.perfis p where p.id = auth.uid()), false) $$;
-- regras, cadastros e e-mails: só o Master
create or replace function public.sou_admin() returns boolean language sql stable security definer set search_path to '' as $$
  select coalesce((select p.perfil = 'master' from public.perfis p where p.id = auth.uid()), false) $$;

create or replace function public.definir_perfil(alvo uuid, novo text) returns void language plpgsql security definer set search_path to '' as $$
begin
  if (select p.perfil from public.perfis p where p.id = auth.uid()) is distinct from 'master' then
    raise exception 'Só o Administrador Master pode mudar perfis';
  end if;
  if novo not in ('admin','leitura') then raise exception 'Perfil inválido'; end if;
  if alvo = auth.uid() then raise exception 'Você não pode mudar o seu próprio perfil'; end if;
  update public.perfis set perfil = novo where id = alvo and perfil <> 'master';
end $$;

create or replace function public.definir_equipe_funcao(alvo uuid, nova_equipe text, nova_funcao text) returns void language plpgsql security definer set search_path to '' as $$
begin
  if (select p.perfil from public.perfis p where p.id = auth.uid()) is distinct from 'master' then
    raise exception 'Só o Administrador Master pode mudar equipe e função';
  end if;
  update public.perfis set equipe = nullif(btrim(coalesce(nova_equipe,'')), ''), funcao = nullif(btrim(coalesce(nova_funcao,'')), '') where id = alvo;
end $$;

-- ---------- cargas ----------
create table public.cargas (
  id text primary key,
  carga text not null unique,
  envio text not null default '',
  galpao text not null default '',
  loja text not null default '',
  rot date,
  agenda date,
  volume integer check (volume is null or volume >= 0),
  obs text not null default '',
  status smallint not null default 1 check (status between 0 and 6),
  hist jsonb not null default '[]'::jsonb check (jsonb_typeof(hist) = 'array'),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid references public.perfis(id) on delete set null,
  arquivado_em timestamptz
);
comment on table public.cargas is 'Uma linha por carga. status: 1 Aguardando cronograma, 2 Próxima a produzir, 3 Em produção, 4 Produzida, 5 Expedida, 6 Entregue, 0 Cancelada';
create index cargas_agenda_idx on public.cargas (agenda);
create index cargas_atualizado_por_idx on public.cargas (atualizado_por);
create index cargas_arquivado_idx on public.cargas (arquivado_em);

-- geral = regras · meta_base = última base importada · cadastros = equipes, funções, lojas, galpões, tipos de ocorrência · resumo = e-mails automáticos
create table public.cargas_config (
  chave text primary key check (chave in ('geral','meta_base','cadastros','resumo')),
  valor jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid references public.perfis(id) on delete set null
);
create index cargas_config_atualizado_por_idx on public.cargas_config (atualizado_por);

-- quem alterou e quando: sempre definido pelo servidor
create or replace function public.carimbo() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  new.atualizado_em := now();
  new.atualizado_por := auth.uid();
  if tg_op = 'UPDATE' and tg_table_name = 'cargas' then new.criado_em := old.criado_em; end if;
  return new;
end $$;
create trigger cargas_carimbo before insert or update on public.cargas for each row execute function public.carimbo();
create trigger cargas_config_carimbo before insert or update on public.cargas_config for each row execute function public.carimbo();

-- ---------- ocorrências ----------
create table public.ocorrencias (
  id uuid primary key default gen_random_uuid(),
  carga_id text references public.cargas(id) on delete set null,
  carga text not null default '',
  envio text not null default '',
  dia date not null default ((now() at time zone 'America/Sao_Paulo')::date),
  tipo text not null default 'Outros',
  descricao text not null default '',
  status text not null default 'aberta' check (status in ('aberta','resolvida')),
  solucao text not null default '',
  aberta_por uuid references public.perfis(id) on delete set null,
  aberta_por_nome text,
  criado_em timestamptz not null default now(),
  resolvida_por uuid references public.perfis(id) on delete set null,
  resolvida_por_nome text,
  resolvida_em timestamptz
);
create index ocorrencias_carga_idx on public.ocorrencias (carga_id);
create index ocorrencias_status_idx on public.ocorrencias (status, dia desc);
create index ocorrencias_aberta_por_idx on public.ocorrencias (aberta_por);
create index ocorrencias_resolvida_por_idx on public.ocorrencias (resolvida_por);

-- autoria definida pelo servidor (ninguém consegue abrir ou resolver "em nome" de outra pessoa)
create or replace function public.ocorrencia_autor() returns trigger language plpgsql security definer set search_path to '' as $$
declare nome text;
begin
  select p.usuario into nome from public.perfis p where p.id = auth.uid();
  if tg_op = 'INSERT' then
    new.aberta_por := auth.uid(); new.aberta_por_nome := nome; new.criado_em := now();
    new.status := 'aberta'; new.resolvida_em := null; new.resolvida_por := null; new.resolvida_por_nome := null;
  else
    new.aberta_por := old.aberta_por; new.aberta_por_nome := old.aberta_por_nome; new.criado_em := old.criado_em;
    if new.status = 'resolvida' and old.status <> 'resolvida' then
      new.resolvida_em := now(); new.resolvida_por := auth.uid(); new.resolvida_por_nome := nome;
    elsif new.status = 'aberta' then
      new.resolvida_em := null; new.resolvida_por := null; new.resolvida_por_nome := null;
    else
      new.resolvida_em := old.resolvida_em; new.resolvida_por := old.resolvida_por; new.resolvida_por_nome := old.resolvida_por_nome;
    end if;
  end if;
  return new;
end $$;
create trigger ocorrencias_autor before insert or update on public.ocorrencias for each row execute function public.ocorrencia_autor();

-- ---------- histórico (gravado só por gatilhos: não dá para editar nem apagar) ----------
create table public.historico (
  id bigint generated always as identity primary key,
  em timestamptz not null default now(),
  por uuid,
  por_nome text,
  alvo text not null,       -- carga, ocorrencia, perfil, regras, cadastro, emails
  chave text,
  carga text,
  envio text,
  acao text not null,
  mudancas jsonb not null default '[]'::jsonb   -- [{campo, de, para}]
);
create index historico_em_idx on public.historico (em desc);
create index historico_carga_idx on public.historico (carga);

create or replace function public.registrar(p_alvo text, p_chave text, p_carga text, p_envio text, p_acao text, p_mud jsonb)
returns void language plpgsql security definer set search_path to '' as $$
declare nome text;
begin
  select p.usuario into nome from public.perfis p where p.id = auth.uid();
  insert into public.historico (por, por_nome, alvo, chave, carga, envio, acao, mudancas)
  values (auth.uid(), coalesce(nome, case when auth.uid() is null then 'Sistema' end), p_alvo, p_chave, p_carga, p_envio, p_acao, coalesce(p_mud,'[]'::jsonb));
end $$;

create or replace function public.hist_cargas() returns trigger language plpgsql security definer set search_path to '' as $$
declare mud jsonb := '[]'::jsonb; c text; o jsonb; n jsonb;
begin
  if tg_op = 'INSERT' then
    perform public.registrar('carga', new.id, new.carga, new.envio, 'criou', jsonb_build_array(jsonb_build_object('campo','status','de',null,'para',new.status)));
    return new;
  elsif tg_op = 'DELETE' then
    perform public.registrar('carga', old.id, old.carga, old.envio, 'excluiu', '[]'::jsonb);
    return old;
  end if;
  o := to_jsonb(old); n := to_jsonb(new);
  foreach c in array array['envio','carga','galpao','loja','rot','agenda','volume','obs','status'] loop
    if (o->c) is distinct from (n->c) then
      mud := mud || jsonb_build_array(jsonb_build_object('campo',c,'de',o->c,'para',n->c));
    end if;
  end loop;
  if old.arquivado_em is null and new.arquivado_em is not null then
    perform public.registrar('carga', new.id, new.carga, new.envio, 'arquivou', mud);
  elsif old.arquivado_em is not null and new.arquivado_em is null then
    perform public.registrar('carga', new.id, new.carga, new.envio, 'reativou', mud);
  elsif jsonb_array_length(mud) > 0 then
    perform public.registrar('carga', new.id, new.carga, new.envio, 'alterou', mud);
  end if;
  return new;
end $$;
create trigger cargas_historico after insert or update or delete on public.cargas for each row execute function public.hist_cargas();

create or replace function public.hist_ocorrencias() returns trigger language plpgsql security definer set search_path to '' as $$
declare mud jsonb := '[]'::jsonb; c text; o jsonb; n jsonb; ac text := 'alterou';
begin
  if tg_op = 'INSERT' then
    perform public.registrar('ocorrencia', new.id::text, new.carga, new.envio, 'abriu ocorrência', jsonb_build_array(jsonb_build_object('campo','tipo','de',null,'para',new.tipo),jsonb_build_object('campo','descricao','de',null,'para',new.descricao)));
    return new;
  elsif tg_op = 'DELETE' then
    perform public.registrar('ocorrencia', old.id::text, old.carga, old.envio, 'excluiu ocorrência', jsonb_build_array(jsonb_build_object('campo','tipo','de',old.tipo,'para',null)));
    return old;
  end if;
  o := to_jsonb(old); n := to_jsonb(new);
  foreach c in array array['tipo','descricao','status','solucao','dia'] loop
    if (o->c) is distinct from (n->c) then mud := mud || jsonb_build_array(jsonb_build_object('campo',c,'de',o->c,'para',n->c)); end if;
  end loop;
  if new.status = 'resolvida' and old.status <> 'resolvida' then ac := 'resolveu ocorrência';
  elsif new.status = 'aberta' and old.status <> 'aberta' then ac := 'reabriu ocorrência'; else ac := 'alterou ocorrência'; end if;
  if jsonb_array_length(mud) > 0 then perform public.registrar('ocorrencia', new.id::text, new.carga, new.envio, ac, mud); end if;
  return new;
end $$;
create trigger ocorrencias_historico after insert or update or delete on public.ocorrencias for each row execute function public.hist_ocorrencias();

create or replace function public.hist_perfis() returns trigger language plpgsql security definer set search_path to '' as $$
declare mud jsonb := '[]'::jsonb; c text; o jsonb; n jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.historico (por, por_nome, alvo, chave, acao, mudancas)
    values (new.id, new.usuario, 'perfil', new.usuario, 'criou a conta', jsonb_build_array(jsonb_build_object('campo','perfil','de',null,'para',new.perfil)));
    return new;
  end if;
  o := to_jsonb(old); n := to_jsonb(new);
  foreach c in array array['perfil','equipe','funcao','usuario'] loop
    if (o->c) is distinct from (n->c) then mud := mud || jsonb_build_array(jsonb_build_object('campo',c,'de',o->c,'para',n->c)); end if;
  end loop;
  if jsonb_array_length(mud) > 0 then perform public.registrar('perfil', new.usuario, null, null, 'alterou usuário', mud); end if;
  return new;
end $$;
create trigger perfis_historico after insert or update on public.perfis for each row execute function public.hist_perfis();

create or replace function public.hist_config() returns trigger language plpgsql security definer set search_path to '' as $$
declare mud jsonb := '[]'::jsonb; k text; o jsonb; n jsonb;
begin
  if new.chave = 'meta_base' then return new; end if;
  o := case when tg_op = 'UPDATE' then old.valor else '{}'::jsonb end; n := new.valor;
  for k in select distinct x from (select jsonb_object_keys(o) x union select jsonb_object_keys(n)) s loop
    if k in ('atualizadoEm','atualizadoPor') then continue; end if;
    if (o->k) is distinct from (n->k) then mud := mud || jsonb_build_array(jsonb_build_object('campo',k,'de',o->k,'para',n->k)); end if;
  end loop;
  if jsonb_array_length(mud) > 0 then
    perform public.registrar(case new.chave when 'geral' then 'regras' when 'cadastros' then 'cadastro' else 'emails' end, new.chave, null, null, 'alterou', mud);
  end if;
  return new;
end $$;
create trigger cargas_config_historico after insert or update on public.cargas_config for each row execute function public.hist_config();

-- ---------- segurança (RLS) ----------
alter table public.perfis enable row level security;
alter table public.segredos enable row level security;
alter table public.cargas enable row level security;
alter table public.cargas_config enable row level security;
alter table public.ocorrencias enable row level security;
alter table public.historico enable row level security;

create policy time_le on public.perfis for select to authenticated using (true);

create policy time_le on public.cargas for select to authenticated using (true);
create policy edicao_insere on public.cargas for insert to authenticated with check ((select public.pode_editar()));
create policy edicao_altera on public.cargas for update to authenticated using ((select public.pode_editar())) with check ((select public.pode_editar()));
create policy edicao_apaga on public.cargas for delete to authenticated using ((select public.pode_editar()));

create policy time_le on public.cargas_config for select to authenticated using (true);
create policy config_insere on public.cargas_config for insert to authenticated
  with check ((select public.sou_admin()) or (chave = 'meta_base' and (select public.pode_editar())));
create policy config_altera on public.cargas_config for update to authenticated
  using ((select public.sou_admin()) or (chave = 'meta_base' and (select public.pode_editar())))
  with check ((select public.sou_admin()) or (chave = 'meta_base' and (select public.pode_editar())));

create policy time_le on public.ocorrencias for select to authenticated using (true);
create policy admin_insere on public.ocorrencias for insert to authenticated with check ((select public.pode_editar()));
create policy admin_altera on public.ocorrencias for update to authenticated using ((select public.pode_editar())) with check ((select public.pode_editar()));
create policy master_apaga on public.ocorrencias for delete to authenticated using ((select public.sou_admin()));

create policy time_le on public.historico for select to authenticated using (true);

revoke all on public.perfis, public.segredos, public.cargas, public.cargas_config, public.ocorrencias, public.historico from anon;
revoke all on public.segredos from authenticated;
grant select on public.perfis, public.historico to authenticated;
grant select, insert, update on public.cargas, public.cargas_config to authenticated;
grant delete on public.cargas to authenticated;
grant select, insert, update, delete on public.ocorrencias to authenticated;

alter publication supabase_realtime add table public.cargas, public.cargas_config, public.perfis, public.ocorrencias, public.historico;

-- ---------- rotinas automáticas ----------
-- toda madrugada: arquiva encerradas (Expedida, Entregue, Cancelada) 60 dias após a agenda e apaga depois de 12 meses
create or replace function public.manutencao_diaria() returns jsonb language plpgsql security definer set search_path to '' as $$
declare hoje date := (now() at time zone 'America/Sao_Paulo')::date; n_arq int; n_del int;
begin
  update public.cargas set arquivado_em = now()
   where arquivado_em is null and status in (0,5,6)
     and coalesce(agenda, (atualizado_em at time zone 'America/Sao_Paulo')::date) < hoje - 60;
  get diagnostics n_arq = row_count;
  delete from public.cargas
   where arquivado_em is not null
     and coalesce(agenda, (arquivado_em at time zone 'America/Sao_Paulo')::date) < (hoje - interval '12 months')::date;
  get diagnostics n_del = row_count;
  delete from public.ocorrencias where status = 'resolvida' and dia < (hoje - interval '12 months')::date;
  delete from public.historico where em < now() - interval '12 months';
  return jsonb_build_object('arquivadas', n_arq, 'apagadas', n_del);
end $$;

-- números de uso do banco para o relatório semanal
create or replace function public.estatisticas_uso() returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object(
    'banco_bytes', pg_database_size(current_database()),
    'cargas_ativas', (select count(*) from public.cargas where arquivado_em is null),
    'cargas_arquivadas', (select count(*) from public.cargas where arquivado_em is not null),
    'ocorrencias_abertas', (select count(*) from public.ocorrencias where status = 'aberta'),
    'ocorrencias_total', (select count(*) from public.ocorrencias),
    'historico_registros', (select count(*) from public.historico),
    'usuarios', (select count(*) from public.perfis),
    'alteracoes_semana', (select count(*) from public.historico where em > now() - interval '7 days')
  ) $$;

-- a cada 15 minutos: só chama a função "resumo" quando chegou o horário configurado no site e ainda não enviou
create or replace function public.disparar_emails() returns text language plpgsql security definer set search_path to '' as $$
declare
  cfg jsonb; agora timestamp := now() at time zone 'America/Sao_Paulo';
  hoje text := to_char(agora, 'YYYY-MM-DD'); hora text := to_char(agora, 'HH24:MI');
  dow int := extract(isodow from agora)::int;
  k_cron text; url text := 'https://SEU-PROJETO.supabase.co/functions/v1/resumo'; feito text := '';
  d jsonb; s jsonb;
begin
  select c.valor into cfg from public.cargas_config c where c.chave = 'resumo';
  select g.valor into k_cron from public.segredos g where g.chave = 'cron_key';
  if cfg is null or k_cron is null then return 'sem configuração'; end if;
  d := coalesce(cfg->'diario', '{}'::jsonb); s := coalesce(cfg->'semanal', '{}'::jsonb);
  if coalesce((d->>'ativo')::boolean, false) and hora >= coalesce(d->>'hora', '07:00')
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
  if coalesce((s->>'ativo')::boolean, false) and dow = coalesce((s->>'diaSemana')::int, 1) and hora >= coalesce(s->>'hora', '08:00')
     and coalesce((select g.valor from public.segredos g where g.chave = 'semanal_ultimo'), '') <> hoje
     and coalesce((select g.valor from public.segredos g where g.chave = 'semanal_tentativa'), '') <> hoje || ' ' || substr(hora, 1, 2)
  then
    insert into public.segredos (chave, valor) values ('semanal_tentativa', hoje || ' ' || substr(hora, 1, 2))
      on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();
    perform net.http_post(url := url, headers := jsonb_build_object('Content-Type','application/json','x-cron-key', k_cron),
                          body := '{"acao":"semanal"}'::jsonb, timeout_milliseconds := 30000);
    feito := feito || 'semanal';
  end if;
  return coalesce(nullif(feito, ''), 'nada a fazer');
end $$;

revoke execute on all functions in schema public from public, anon;
revoke execute on function public.registrar(text,text,text,text,text,jsonb), public.hist_cargas(), public.hist_ocorrencias(), public.hist_perfis(),
  public.hist_config(), public.ocorrencia_autor(), public.carimbo(), public.manutencao_diaria(), public.estatisticas_uso(), public.disparar_emails() from authenticated;
grant execute on function public.meu_perfil(), public.pode_editar(), public.sou_admin(), public.definir_perfil(uuid,text), public.definir_equipe_funcao(uuid,text,text) to authenticated;
grant execute on function public.estatisticas_uso() to service_role;

insert into public.segredos (chave, valor) values ('cron_key', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
insert into public.cargas_config (chave, valor) values
  ('geral', '{"regraDias":3,"rfDias":1,"atencaoDias":2,"feriadosExtras":[]}'::jsonb),
  ('cadastros', '{"equipes":[],"funcoes":["Analista","Gestor"],"lojas":[],"galpoes":[],"tiposOcorrencia":["Atraso na produção","Reagendamento no portal ML","Divergência de paletes","Recusa no recebimento","Avaria","Falta de veículo","Outros"]}'::jsonb),
  ('resumo', '{"diario":{"ativo":false,"hora":"07:00","fimDeSemana":false,"destinatarios":[]},"semanal":{"ativo":false,"diaSemana":1,"hora":"08:00","destinatarios":[]}}'::jsonb);

select cron.schedule('manutencao-diaria', '15 6 * * *', 'select public.manutencao_diaria()');
select cron.schedule('emails-automaticos', '*/15 * * * *', 'select public.disparar_emails()');

-- =====================================================================
-- v3 · segurança (só quem tem perfil lê), bloqueio de tentativas, PBR/CHEP, R.F. informado,
--      controle de paletes PBR, alertas (e-mail e Teams) e backup semanal
-- O histórico de paletes da planilha antiga é importado à parte (dados reais não vão para o GitHub).
-- =====================================================================
-- 1) Segurança: só quem tem perfil no painel lê os dados
create or replace function public.tem_perfil() returns boolean language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.perfis p where p.id = auth.uid()) $$;
revoke execute on function public.tem_perfil() from public, anon;
grant execute on function public.tem_perfil() to authenticated;

drop policy if exists time_le on public.perfis;
create policy time_le on public.perfis for select to authenticated using ((select public.tem_perfil()));
drop policy if exists time_le on public.cargas;
create policy time_le on public.cargas for select to authenticated using ((select public.tem_perfil()));
drop policy if exists time_le on public.cargas_config;
create policy time_le on public.cargas_config for select to authenticated using ((select public.tem_perfil()));
drop policy if exists time_le on public.ocorrencias;
create policy time_le on public.ocorrencias for select to authenticated using ((select public.tem_perfil()));
drop policy if exists time_le on public.historico;
create policy time_le on public.historico for select to authenticated using ((select public.tem_perfil()));

-- 2) Tentativas de entrar / criar conta (bloqueio de 15 minutos depois de 5 erros) — só o servidor usa
create table if not exists public.tentativas (
  id bigint generated always as identity primary key,
  chave text not null,
  em timestamptz not null default now()
);
create index if not exists tentativas_chave_idx on public.tentativas (chave, em desc);
alter table public.tentativas enable row level security;
revoke all on public.tentativas from anon, authenticated;

-- 3) Cargas: paletes PBR e CHEP, R.F. informado
alter table public.cargas add column if not exists pbr integer check (pbr is null or pbr >= 0);
alter table public.cargas add column if not exists chep integer check (chep is null or chep >= 0);
alter table public.cargas add column if not exists rf_info jsonb;

create or replace function public.hist_cargas() returns trigger language plpgsql security definer set search_path to '' as $$
declare mud jsonb := '[]'::jsonb; c text; o jsonb; n jsonb;
begin
  if tg_op = 'INSERT' then
    perform public.registrar('carga', new.id, new.carga, new.envio, 'criou', jsonb_build_array(jsonb_build_object('campo','status','de',null,'para',new.status)));
    return new;
  elsif tg_op = 'DELETE' then
    perform public.registrar('carga', old.id, old.carga, old.envio, 'excluiu', '[]'::jsonb);
    return old;
  end if;
  o := to_jsonb(old); n := to_jsonb(new);
  foreach c in array array['envio','carga','galpao','loja','rot','agenda','volume','pbr','chep','obs','status','rf_info'] loop
    if (o->c) is distinct from (n->c) then
      mud := mud || jsonb_build_array(jsonb_build_object('campo',c,'de',o->c,'para',n->c));
    end if;
  end loop;
  if old.arquivado_em is null and new.arquivado_em is not null then
    perform public.registrar('carga', new.id, new.carga, new.envio, 'arquivou', mud);
  elsif old.arquivado_em is not null and new.arquivado_em is null then
    perform public.registrar('carga', new.id, new.carga, new.envio, 'reativou', mud);
  elsif jsonb_array_length(mud) > 0 then
    perform public.registrar('carga', new.id, new.carga, new.envio, 'alterou', mud);
  end if;
  return new;
end $$;

-- 4) Configuração de paletes
alter table public.cargas_config drop constraint if exists cargas_config_chave_check;
alter table public.cargas_config add constraint cargas_config_chave_check check (chave in ('geral','meta_base','cadastros','resumo','paletes'));

-- 5) Movimentos de paletes (histórico da planilha, retornos registrados no painel e envios de cargas já apagadas)
create table if not exists public.paletes_mov (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('envio','retorno')),
  dia date not null,
  pbr integer not null default 0 check (pbr >= 0),
  chep integer not null default 0 check (chep >= 0),
  obs text not null default '',
  carga text not null default '',
  envio text not null default '',
  origem text not null default 'painel' check (origem in ('planilha','painel','arquivo')),
  por uuid references public.perfis(id) on delete set null,
  por_nome text,
  criado_em timestamptz not null default now()
);
create index if not exists paletes_mov_dia_idx on public.paletes_mov (dia);
create index if not exists paletes_mov_por_idx on public.paletes_mov (por);

create or replace function public.paletes_autor() returns trigger language plpgsql security definer set search_path to '' as $$
declare nome text;
begin
  if auth.uid() is not null then
    select p.usuario into nome from public.perfis p where p.id = auth.uid();
    new.por := auth.uid(); new.por_nome := nome; new.origem := 'painel'; new.criado_em := now();
  end if;
  return new;
end $$;
create trigger paletes_mov_autor before insert on public.paletes_mov for each row execute function public.paletes_autor();

create or replace function public.hist_paletes() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if auth.uid() is null then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    perform public.registrar('paletes', new.id::text, nullif(new.carga,''), nullif(new.envio,''), 'registrou ' || new.tipo || ' de paletes',
      jsonb_build_array(jsonb_build_object('campo','dia','de',null,'para',new.dia), jsonb_build_object('campo','pbr','de',null,'para',new.pbr), jsonb_build_object('campo','chep','de',null,'para',new.chep)));
    return new;
  end if;
  perform public.registrar('paletes', old.id::text, nullif(old.carga,''), nullif(old.envio,''), 'excluiu ' || old.tipo || ' de paletes',
    jsonb_build_array(jsonb_build_object('campo','dia','de',old.dia,'para',null), jsonb_build_object('campo','pbr','de',old.pbr,'para',null)));
  return old;
end $$;
create trigger paletes_mov_historico after insert or delete on public.paletes_mov for each row execute function public.hist_paletes();

alter table public.paletes_mov enable row level security;
create policy time_le on public.paletes_mov for select to authenticated using ((select public.tem_perfil()));
create policy admin_registra_retorno on public.paletes_mov for insert to authenticated with check ((select public.pode_editar()) and tipo = 'retorno');
create policy master_apaga on public.paletes_mov for delete to authenticated using ((select public.sou_admin()) and origem = 'painel');
revoke all on public.paletes_mov from anon;
grant select, insert, delete on public.paletes_mov to authenticated;
alter publication supabase_realtime add table public.paletes_mov;

revoke execute on function public.paletes_autor(), public.hist_paletes() from public, anon, authenticated;

-- 6) Rotina da madrugada: guarda os paletes das cargas antes de apagá-las (12 meses) e limpa tentativas antigas
create or replace function public.manutencao_diaria() returns jsonb language plpgsql security definer set search_path to '' as $$
declare hoje date := (now() at time zone 'America/Sao_Paulo')::date; n_arq int; n_del int; corte date;
begin
  corte := coalesce((select (c.valor->>'corte')::date from public.cargas_config c where c.chave = 'paletes'), date '2026-11-08');
  update public.cargas set arquivado_em = now()
   where arquivado_em is null and status in (0,5,6)
     and coalesce(agenda, (atualizado_em at time zone 'America/Sao_Paulo')::date) < hoje - 60;
  get diagnostics n_arq = row_count;
  insert into public.paletes_mov (tipo, dia, pbr, chep, carga, envio, origem, obs)
  select 'envio', c.agenda, coalesce(c.pbr,0), coalesce(c.chep,0), c.carga, c.envio, 'arquivo', 'Carga apagada do painel depois de 12 meses'
    from public.cargas c
   where c.arquivado_em is not null and c.status <> 0 and c.agenda >= corte and coalesce(c.pbr,0) + coalesce(c.chep,0) > 0
     and coalesce(c.agenda, (c.arquivado_em at time zone 'America/Sao_Paulo')::date) < (hoje - interval '12 months')::date;
  delete from public.cargas
   where arquivado_em is not null
     and coalesce(agenda, (arquivado_em at time zone 'America/Sao_Paulo')::date) < (hoje - interval '12 months')::date;
  get diagnostics n_del = row_count;
  delete from public.ocorrencias where status = 'resolvida' and dia < (hoje - interval '12 months')::date;
  delete from public.historico where em < now() - interval '12 months';
  delete from public.tentativas where em < now() - interval '2 days';
  return jsonb_build_object('arquivadas', n_arq, 'apagadas', n_del);
end $$;

-- 7) Disparo automático: resumo diário, relatório semanal e verificação diária do saldo de PBR
create or replace function public.disparar_emails() returns text language plpgsql security definer set search_path to '' as $$
declare
  cfg jsonb; agora timestamp := now() at time zone 'America/Sao_Paulo';
  hoje text := to_char(agora, 'YYYY-MM-DD'); hora text := to_char(agora, 'HH24:MI');
  dow int := extract(isodow from agora)::int;
  k_cron text; url text := 'https://yqwlxxfwarqnvjeggvvr.supabase.co/functions/v1/resumo'; feito text := '';
  d jsonb; s jsonb;
begin
  select c.valor into cfg from public.cargas_config c where c.chave = 'resumo';
  select g.valor into k_cron from public.segredos g where g.chave = 'cron_key';
  if cfg is null or k_cron is null then return 'sem configuração'; end if;
  d := coalesce(cfg->'diario', '{}'::jsonb); s := coalesce(cfg->'semanal', '{}'::jsonb);
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
  -- saldo de PBR: uma verificação por dia, a partir das 07:00 (alerta por e-mail e Teams quando passa do aviso ou do limite)
  if exists (select 1 from public.cargas_config c where c.chave = 'paletes')
     and hora >= '07:00'
     and coalesce((select g.valor from public.segredos g where g.chave = 'paletes_ultimo'), '') <> hoje
     and coalesce((select g.valor from public.segredos g where g.chave = 'paletes_tentativa'), '') <> hoje || ' ' || substr(hora, 1, 2)
  then
    insert into public.segredos (chave, valor) values ('paletes_tentativa', hoje || ' ' || substr(hora, 1, 2))
      on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();
    perform net.http_post(url := url, headers := jsonb_build_object('Content-Type','application/json','x-cron-key', k_cron),
                          body := '{"acao":"paletes"}'::jsonb, timeout_milliseconds := 20000);
    feito := feito || 'paletes';
  end if;
  return coalesce(nullif(btrim(feito), ''), 'nada a fazer');
end $$;
revoke execute on function public.manutencao_diaria(), public.disparar_emails() from public, anon, authenticated;

-- 8) Valores iniciais
insert into public.cargas_config (chave, valor) values ('paletes', jsonb_build_object(
  'limite', 200, 'aviso', 180, 'corte', '2026-11-08',
  'destinatarios', coalesce((select c.valor->'diario'->'destinatarios' from public.cargas_config c where c.chave = 'resumo'), '[]'::jsonb),
  'alertaEmail', true, 'alertaTeams', true))
on conflict (chave) do nothing;
update public.cargas_config set valor = valor || '{"regraTerca":true}'::jsonb where chave = 'geral' and not (valor ? 'regraTerca');
update public.cargas_config set valor = jsonb_set(valor || jsonb_build_object('teams', coalesce(valor->'teams', '{"diario":true,"paletes":true}'::jsonb), 'teamsConfigurado', coalesce(valor->'teamsConfigurado', 'false'::jsonb)),
  '{semanal,backup}', coalesce(valor->'semanal'->'backup', 'true'::jsonb)) where chave = 'resumo';

-- v3 · paletes só para o Administrador Master
drop policy if exists time_le on public.paletes_mov;
create policy master_le on public.paletes_mov for select to authenticated using ((select public.sou_admin()));
drop policy if exists admin_registra_retorno on public.paletes_mov;
create policy master_registra_retorno on public.paletes_mov for insert to authenticated with check ((select public.sou_admin()) and tipo = 'retorno');
drop policy if exists time_le on public.cargas_config;
create policy time_le on public.cargas_config for select to authenticated using ((select public.tem_perfil()) and (chave <> 'paletes' or (select public.sou_admin())));
drop policy if exists time_le on public.historico;
create policy time_le on public.historico for select to authenticated
  using ((select public.tem_perfil()) and ((alvo <> 'paletes' and coalesce(chave,'') <> 'paletes') or (select public.sou_admin())));
