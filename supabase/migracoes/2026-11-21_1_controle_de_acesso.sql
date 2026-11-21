-- Painel de Cargas · controle de acesso (perfis, permissões, bloqueio, exclusão)
-- Aplicar no dia de publicar, ANTES de subir o zip. Compatível com o site antigo enquanto o novo não sobe.

-- 1. novos perfis, bloqueio e permissões por pessoa
alter table public.perfis drop constraint if exists perfis_perfil_check;
alter table public.perfis add constraint perfis_perfil_check check (perfil in ('master','admin','operador','leitura','personalizado'));
alter table public.perfis add column if not exists bloqueado boolean not null default false;
alter table public.perfis add column if not exists permissoes jsonb;

-- 2. nomes de quem teve a conta excluída (o histórico continua mostrando o nome)
create table if not exists public.contas_excluidas (id uuid primary key, usuario text not null, excluido_em timestamptz not null default now(), excluido_por uuid);
alter table public.contas_excluidas enable row level security;
drop policy if exists time_le on public.contas_excluidas;
create policy time_le on public.contas_excluidas for select using ((select public.tem_perfil()));

-- 3. tabela de permissões por perfil (editada pelo Master)
alter table public.cargas_config drop constraint if exists cargas_config_chave_check;
alter table public.cargas_config add constraint cargas_config_chave_check check (chave in ('geral','meta_base','cadastros','resumo','paletes','permissoes'));
insert into public.cargas_config (chave, valor) values ('permissoes', '{}'::jsonb) on conflict (chave) do nothing;

-- 4. pode(permissão): a mesma regra da tela, conferida no banco
create or replace function public.pode(p text) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case
      when pf.bloqueado then false
      when pf.perfil = 'master' then true
      when pf.perfil = 'personalizado' then coalesce((pf.permissoes ->> p)::boolean, false)
      else coalesce((c.valor -> pf.perfil ->> p)::boolean,
        case pf.perfil when 'admin' then true
          when 'operador' then p in ('etapa','rf','comentar','motivo','exportar','ocorrencia','alertas')
          when 'leitura' then p = 'exportar' else false end)
    end
    from public.perfis pf left join public.cargas_config c on c.chave = 'permissoes'
    where pf.id = auth.uid()), false) $$;
create or replace function public.tem_perfil() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.perfis p where p.id = auth.uid() and not p.bloqueado) $$;
create or replace function public.sou_admin() returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select p.perfil = 'master' and not p.bloqueado from public.perfis p where p.id = auth.uid()), false) $$;
create or replace function public.pode_editar() returns boolean language sql stable security definer set search_path = '' as $$
  select public.pode('etapa') or public.pode('rf') or public.pode('editar') or public.pode('base') or public.pode('ocorrencia') $$;

-- 5. cargas: confere coluna por coluna o que mudou
create or replace function public.cargas_confere() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if; -- rotinas do servidor
  if new.status is distinct from old.status and not (public.pode('etapa') or public.pode('base')) then
    raise exception 'Seu perfil não permite mudar a etapa da carga.' using errcode = '42501'; end if;
  if new.rf_info is distinct from old.rf_info and not (public.pode('rf') or public.pode('base')) then
    raise exception 'Seu perfil não permite marcar R.F.' using errcode = '42501'; end if;
  if (new.envio, new.carga, new.galpao, new.loja, new.rot, new.agenda, new.volume, new.pbr, new.chep, new.obs)
     is distinct from (old.envio, old.carga, old.galpao, old.loja, old.rot, old.agenda, old.volume, old.pbr, old.chep, old.obs)
     and not (public.pode('editar') or public.pode('base')) then
    raise exception 'Seu perfil não permite editar os dados da carga.' using errcode = '42501'; end if;
  return new;
end $$;
drop trigger if exists cargas_confere on public.cargas;
create trigger cargas_confere before update on public.cargas for each row execute function public.cargas_confere();

-- 6. políticas
drop policy if exists edicao_insere on public.cargas;
create policy edicao_insere on public.cargas for insert with check ((select public.pode('base')));
drop policy if exists edicao_apaga on public.cargas;
create policy edicao_apaga on public.cargas for delete using ((select public.pode('base')));
drop policy if exists admin_insere on public.ocorrencias;
create policy admin_insere on public.ocorrencias for insert with check ((select public.pode('ocorrencia')));
drop policy if exists admin_altera on public.ocorrencias;
create policy admin_altera on public.ocorrencias for update using ((select public.pode('ocorrencia'))) with check ((select public.pode('ocorrencia')));
drop policy if exists config_insere on public.cargas_config;
create policy config_insere on public.cargas_config for insert with check ((select public.sou_admin()) or (chave = 'meta_base' and (select public.pode('base'))) or (chave in ('geral','cadastros') and (select public.pode('regras'))));
drop policy if exists config_altera on public.cargas_config;
create policy config_altera on public.cargas_config for update
  using ((select public.sou_admin()) or (chave = 'meta_base' and (select public.pode('base'))) or (chave in ('geral','cadastros') and (select public.pode('regras'))))
  with check ((select public.sou_admin()) or (chave = 'meta_base' and (select public.pode('base'))) or (chave in ('geral','cadastros') and (select public.pode('regras'))));
drop policy if exists time_le on public.cargas_config;
create policy time_le on public.cargas_config for select using ((select public.tem_perfil()) and (chave <> 'paletes' or (select public.sou_admin()) or (select public.pode('paletes'))));
drop policy if exists master_le on public.paletes_mov;
create policy master_le on public.paletes_mov for select using ((select public.sou_admin()) or (select public.pode('paletes')));
drop policy if exists master_registra_retorno on public.paletes_mov;
create policy master_registra_retorno on public.paletes_mov for insert with check (((select public.sou_admin()) or (select public.pode('paletes'))) and tipo = 'retorno');
drop policy if exists time_le on public.historico;
create policy time_le on public.historico for select using ((select public.tem_perfil()) and (((alvo <> 'paletes') and (coalesce(chave,'') <> 'paletes')) or (select public.sou_admin()) or (select public.pode('paletes'))));

-- 7. trocar perfil e permissões (só o Master)
create or replace function public.definir_perfil(alvo uuid, novo text) returns void language plpgsql security definer set search_path = '' as $$
declare atual text; m jsonb;
begin
  if not public.sou_admin() then raise exception 'Só o Administrador Master pode mudar perfis'; end if;
  if novo not in ('admin','operador','leitura','personalizado') then raise exception 'Perfil inválido'; end if;
  if alvo = auth.uid() then raise exception 'Você não pode mudar o seu próprio perfil'; end if;
  select p.perfil into atual from public.perfis p where p.id = alvo;
  if novo = 'personalizado' then
    select jsonb_object_agg(k, public.pode_de(atual, k)) into m from unnest(array['etapa','rf','editar','comentar','motivo','base','exportar','ocorrencia','alertas','paletes','regras']) k;
    update public.perfis set perfil = novo, permissoes = coalesce(permissoes, m) where id = alvo and perfil <> 'master';
  else
    update public.perfis set perfil = novo where id = alvo and perfil <> 'master';
  end if;
end $$;
-- permissão de um perfil (sem olhar a pessoa), usada para copiar ao virar Personalizado
create or replace function public.pode_de(perfil text, p text) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.valor -> perfil ->> p)::boolean from public.cargas_config c where c.chave = 'permissoes'),
    case perfil when 'admin' then true when 'operador' then p in ('etapa','rf','comentar','motivo','exportar','ocorrencia','alertas') when 'leitura' then p = 'exportar' else false end) $$;
create or replace function public.definir_permissoes(alvo uuid, perms jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare m jsonb;
begin
  if not public.sou_admin() then raise exception 'Só o Administrador Master pode mudar permissões'; end if;
  if alvo = auth.uid() then raise exception 'Você não pode mudar as suas próprias permissões'; end if;
  select jsonb_object_agg(k, coalesce((perms ->> k)::boolean, false)) into m from unnest(array['etapa','rf','editar','comentar','motivo','base','exportar','ocorrencia','alertas','paletes','regras']) k;
  update public.perfis set perfil = 'personalizado', permissoes = m where id = alvo and perfil <> 'master';
  perform public.registrar('perfil', (select usuario from public.perfis where id = alvo), null, null, 'alterou permissões', jsonb_build_array(jsonb_build_object('campo','permissoes','de',null,'para',m)));
end $$;
revoke all on function public.definir_permissoes(uuid, jsonb) from public, anon;
grant execute on function public.definir_permissoes(uuid, jsonb) to authenticated;
