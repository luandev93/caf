# caf — Central de Abastecimento Farmacêutico

Módulo de farmácia do **HMMV ERP**: estoque próprio, RT, e clientes UBS
(login/estoque por unidade). Identidade da instituição é dado de
configuração, não hardcode.

Este módulo **não é uma migração 1:1** do sistema legado (`farm`, um SPA
Vite+React sobre Firebase/Firestore em produção real em `farmhmmv.web.app`).
É uma base nova, redesenhada, que usa o legado só como referência funcional
e de dados. A recuperação do legado é deliberadamente mínima por decisão de
produto: **catálogo saneado + saldo atual + logins**. Fornecedores, NF-e,
dispensação e histórico completo de movimentações são metas de arquitetura
futuras — o schema abaixo já foi desenhado para não fechar essa porta, mas
elas não fazem parte do escopo desta fase.

O Firebase de produção permanece vivo e intocado durante toda essa fase:
nada de escrita, nada de corte.

## Arquitetura

- **Banco**: projeto Neon `hmmv-caf` (Postgres serverless). Compute
  configurado para free tier: autoscaling travado em 0.25 CU e
  `suspend_timeout_seconds = 0` (escala a zero assim que fica ocioso — custo
  de compute é zero fora de uso ativo).
- **ORM**: Prisma. `prisma/schema.prisma` é a fonte da verdade do schema.
- **API**: Express (`src/index.js`), ainda no início — só `/health` por
  enquanto.

### Schema — fundação da Fase 1

| Model | Substitui (Firestore) | Observação |
|---|---|---|
| `Institution` | — | Config de instituição, já existia antes desta fase |
| `StockLocation` | `estoques` | Unidade física de estoque, sob uma `Institution` |
| `Product` | `itens` (pós-saneamento) | `code` único e opcional — nem todo item legado tinha código estável |
| `Batch` | `lotes` | Separado de `StockBalance` porque nem todo item controla lote |
| `StockBalance` | `saldos` | Fonte da verdade do saldo atual |
| `User` | `pessoas`/`usuarios` | Só metadado de papel/contato — não reprovisiona credenciais |
| `LegacyMapping` | — | Rastreabilidade genérica e idempotente de toda decisão de importação |

## Estado real do Neon (confirmado via MCP)

```
main                — só Institution (schema base, antes desta fase)
dev/legacy-import   — schema completo + catálogo migrado:
  Institution     1
  StockLocation   6
  Product       547  (443 ativos / 104 inativos, 0 sem código)
  Batch           0  (legado não usa lote de forma consistente ainda)
  StockBalance  345
  User            0  (login ainda não recuperado)
  LegacyMapping 554  (548 itens + 6 estoques rastreados)
```

178 produtos ativos não têm registro de saldo (aceito como zero por ora,
sem reconciliar contra o Firestore ao vivo nesta rodada).

Essa branch (`dev/legacy-import`) já reflete uma migração real, executada
via `mcp__Neon__run_sql_transaction` numa sessão anterior — a aplicação do
schema e a carga de dados aconteceram direto contra o Neon (ver seção
"Por que dois caminhos de commit" abaixo). Este commit sincroniza o
repositório (schema, scripts, testes) com essa realidade, que antes só
existia no banco. **`main` não foi tocada.**

## Rodando localmente

```bash
npm install
cp .env.example .env   # preencha DATABASE_URL/DIRECT_URL com uma branch de DEV
npm run dev
npm test                # roda a suíte de saneamento (node --test, zero setup)
```

## Auditoria do legado (`scripts/legacy-audit/`)

Auditoria **somente leitura** do Firestore de produção — substitui
suposições ("549 produtos") por contagens reais e levanta flags de
qualidade (duplicata por código, item sem código, saldo/lote órfão,
divergência lote×saldo, pendente/inativo com saldo, login sem uid
correspondente no Firebase Auth).

```bash
# precisa de credencial de service account (ver .env.example) — nunca
# peça ou cole a credencial diretamente no chat.
npm run audit:legacy
```

Bloqueado nesta sessão por falta da credencial — o script está pronto e
testável, mas não há conector de Firebase disponível aqui. Rode com a
credencial fornecida pelo usuário quando for a hora.

## Migração do legado (`scripts/migrate-legacy/`)

```bash
# dry-run contra a fixture ilustrativa (padrão, não escreve em lugar nenhum)
npm run migrate:legacy

# dry-run contra o Firestore de verdade (ainda sem escrita; requer credencial)
node scripts/migrate-legacy/index.mjs --dry-run --source=firebase

# commit de verdade — gera SQL idempotente pra aplicar via Neon MCP
CAF_INSTITUTION_ID=<uuid> node scripts/migrate-legacy/index.mjs --commit --target=sql
```

**Regras de saneamento** (`saneamento.mjs`, testadas em
`saneamento.test.mjs`): chave de dedup é sempre `codigo`, nunca nome
isolado.

| Situação | Destino |
|---|---|
| código único, presente, sem outra pendência | `auto` (migra direto) |
| sem código | `review` |
| código duplicado entre docs (mesmo com campos idênticos) | `review` |
| descrição igual pós-normalização, código diferente | `review` (`possivel-duplicata`) |
| `pendente=true` sem saldo | `excluido` do baseline |
| `pendente=true` com saldo > 0 | `review` (nunca some estoque real) |
| `ativo=false` com saldo > 0 | `review` (`inativo-com-saldo`) |

Toda decisão vira uma linha em `LegacyMapping` — auditável e reexecutável.
O relatório de reconciliação (`reconcile-report.mjs`) compara origem vs.
destino e exige diferença zero de saldo no balde `auto`; toda divergência
tem que estar explicada pela fila de revisão.

### Por que dois caminhos de commit (`write-prisma.mjs` e `sql-emit.mjs`)

`@prisma/client` (e `prisma db push`) precisam de conexão TCP direta com o
Postgres. Um sandbox que só sai por proxy HTTPS não consegue abrir essa
conexão — falha com `P1001` mesmo com a connection string certa. A
ferramenta Neon (MCP) não tem essa limitação: conecta por HTTPS e foi o que
aplicou o schema e o catálogo na branch `dev/legacy-import`.

- `sql-emit.mjs` gera a mesma escrita como statements SQL idempotentes
  (`ON CONFLICT` nas colunas já únicas do schema), pra rodar via
  `mcp__Neon__run_sql_transaction` dentro de uma sessão Claude — sem
  depender de "rodar na sua máquina ou no CI".
- `write-prisma.mjs` continua existindo para quando o pipeline rodar num
  lugar com TCP de verdade (CI, máquina local).

Os dois usam os mesmos ids determinísticos (`ids.mjs`, UUID v5) — reexecutar
a migração não duplica linhas nem em um caminho nem no outro.

## Free tier, de propósito

- Neon: compute travado em 0.25 CU, `suspend_timeout_seconds=0` — zero custo
  de compute fora de uso ativo.
- Firestore (Spark): a auditoria e a migração paginam as leituras
  (`firebase-admin-client.mjs`, `paginate()`) em vez de puxar coleções
  inteiras de uma vez — evita estourar a cota diária de leitura do free
  tier em coleções grandes.
- Zero dependência paga: a heurística de "possível duplicata" usa
  comparação de texto normalizada (sem API externa de NLP/fuzzy matching).

## O que falta

- Autenticação de verdade (a API ainda não valida sessão nenhuma).
- CRUD de `Product`/`StockLocation` (hoje só existe o schema + a carga
  inicial via migração).
- Rodar a auditoria e a migração contra o Firestore ao vivo (falta a
  credencial de service account).
- `Batch` está no schema mas com 0 linhas — o legado não usa lote de forma
  consistente o suficiente para migrar ainda.
- Promover `dev/legacy-import` pra `main` é uma decisão separada, que só
  faz sentido depois que a auditoria contra o Firestore ao vivo confirmar
  esses números.
