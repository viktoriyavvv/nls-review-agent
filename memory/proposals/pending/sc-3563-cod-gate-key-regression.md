---
id: sc-3563-cod-gate-key-regression
type: lesson
status: proposed
confidence: high
appliesTo:
  projects:
    - SC
  repos:
    - frontend-support-center.netcore.kz
  issueKeys:
    - SC-3563
  tags:
    - connectionTickets
    - ConnectionTicketInfoCardComponent
    - isShowChangeStatusButton
    - status_internal
    - issue
    - problem
    - ChangeStatusModal
createdAt: 2026-07-02T10:21:40.913Z
updatedAt: 2026-07-02T10:21:40.913Z
source:
  issueKey: SC-3563
  repoId: frontend-support-center.netcore.kz
  outputPath: outputs/SC-3563/frontend-support-center.netcore.kz
summary: Коммит, выровнявший источник статуса в ЦОД-карточке, заодно перевёл
  гейт status_internal.key с 'problem' на 'issue', что повторно ломает SC-3563
  для ЦОД-заявок «Проблема».
---

# Регрессия SC-3563: выравнивание источника статуса в ЦОД-карточке заодно перевело гейт status_internal на 'issue'

## What happened / Context
В ЦОД-карточке `connectionTickets/ConnectionTicketInfoCardComponent.vue` initial review нашёл high-дефект: в `ChangeStatusModal` передавался `connection_status`, тогда как бейдж и гейт используют `status_internal` (рассинхрон источника). Разработчик исправил источник (модалка теперь получает `status_internal`, commit 98f6337d) — но в том же исправлении (commit 4f0582291) заодно поменял условие показа: `isShowChangeStatusButton` стал сравнивать `status_internal.key` с `'issue'` вместо `'problem'`.

Бэк переименовал ключ только в `connection_status`, поэтому `status_internal.key` с высокой вероятностью всё ещё `'problem'`. Для ЦОД-заявок «Проблема» кнопка-карандаш снова перестанет показываться — исходный баг SC-3563 воспроизведётся там же, где его «починили».

## Root cause
Фикс `problem`→`issue`, корректный для карточек на `connection_status`, распространён на карточку, читающую `status_internal`, без учёта того, что ключ переименован только в одном поле. Правку гейта ревью не запрашивало (просили только выровнять источник модалки) — она приехала «прицепом» в том же коммите.

## Pattern
Легитимное исправление одной претензии может протащить несвязанную регрессию в том же коммите/хунке. Особенно опасно, когда однотипная по виду правка (замена ключа статуса) копируется по sibling-компонентам, у которых разные исходные поля.

## Future review rule
1. В follow-up проверять не только «исправлена ли претензия», но и весь хунк исправляющего коммита на новые, не запрошенные изменения (здесь — изменение гейта).
2. Замену ключа `problem`↔`issue` сверять с полем компонента (см. отдельное repo-правило о соответствии ключ↔поле). `status_internal.key === 'issue'` — красный флаг.
3. Не считать «замену» ключа безопасной по умолчанию: смотреть, читает ли компонент то поле, где ключ реально переименован.

## Evidence
- initial review: connectionTickets/ConnectionTicketInfoCardComponent.vue — бейдж/гейт по status_internal (стр. 10-13, 79-83), модалка получала connection_status (стр. 36).
- follow-up (fixed): стр. 36 → `:status="ticket?.status_internal"` (commit 98f6337d), источник выровнен.
- follow-up newFinding (high): стр. 79-81 (commit 4f0582291) `['emergency','issue'].includes(this.ticket?.status_internal.key)` — раньше 'problem'; единственная карточка, гейтящая status_internal по 'issue'.

## Do not over-apply
Касается ЦОД-карточки и статуса «Проблема» в SC-3563. Не обобщать до «любой follow-up вносит регрессию». Переносимо: сверка всего хунка фикс-коммита и соответствие ключ↔поле; непереносимо: презумпция вины разработчика.
