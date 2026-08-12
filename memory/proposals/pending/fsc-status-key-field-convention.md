---
id: fsc-status-key-field-convention
type: repo_rule
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
    - connection_status
    - status_internal
    - issue
    - problem
    - ChangeStatusModal
    - isShowChangeStatusButton
    - statusColorByKey
createdAt: 2026-07-02T10:21:40.913Z
updatedAt: 2026-07-02T10:21:40.913Z
source:
  issueKey: SC-3563
  repoId: frontend-support-center.netcore.kz
  outputPath: outputs/SC-3563/frontend-support-center.netcore.kz
summary: "Один логический статус «Проблема» имеет разные ключи в разных полях:
  connection_status.key='issue', status_internal.key='problem'. Ключ в условии
  должен соответствовать полю, которое читает компонент."
---

# Конвенция ключей статуса «Проблема»: connection_status.key = 'issue', status_internal.key = 'problem'

## What happened / Context
В SC-3563 бэкенд переименовал ключ статуса «Проблема» с `problem` на `issue`, но только в поле `connection_status`. Поле `status_internal` для того же логического статуса продолжает использовать ключ `problem`. В репозитории сложились ДВА разных ключа для одного статуса «Проблема» — в зависимости от того, какое поле читает компонент.

Сверка по `src/` (в рамках follow-up) подтвердила устойчивую конвенцию:
- `connection_status.key === 'issue'` → «Проблема» (6 карточек гейтят по 'issue');
- `status_internal.key === 'problem'` → «Проблема» (10 карточек гейтят по 'problem').
Дополнительно: в `statusColorByKey` есть ключ `problem`, но НЕТ `issue`.

## Root cause
Бэкенд переименовал ключ статуса «Проблема» только в поле `connection_status`. Поле `status_internal` осталось на `problem`. Единое логическое понятие статуса оказалось разнесено по двум ключам.

## Pattern
Компонент должен сравнивать ключ статуса со значением, соответствующим полю, которое он реально читает:
- читает `connection_status` → сравнивать с `'issue'`;
- читает `status_internal` → сравнивать с `'problem'`.
Смешение (`status_internal.key === 'issue'` или `connection_status.key === 'problem'`) — почти всегда баг: условие срабатывает никогда либо неверно.

## Future review rule
В любом diff, затрагивающем показ/гейт «Проблема» (`isShowChangeStatusButton`, смена статуса, `ChangeStatusModal`, `statusColorByKey`): проверить, что ключ (`'issue'`/`'problem'`) соответствует полю (`connection_status`/`status_internal`), которое компонент отображает и гейтит. Рассинхрон поля и ключа — флагать high. `connection_status.key === 'issue'` — корректно, НЕ флагать как ошибку. Помнить: `statusColorByKey` не знает ключ `issue`, цвет для connection_status-«Проблемы» может не находиться.

## Evidence
- Комментарий Даньковой Виктории (2026-05-28): бэк начал возвращать `issue` вместо `problem` именно в `connection_status`.
- follow-up сверка src/: connection_status.key→'issue' в 6 карточках (ConnectionDetailsComponent:1180, upsells:660, simDelivery:270, disassembly:456, servicesTransfer:531, connection/ConnectionTicketInfoCardComponent:186-188); status_internal.key→'problem' в 10 карточках (serviceTickets:110, emergencyTickets/EmergencyTicketInfoCardComponent:128 и др.).
- `statusColorByKey` содержит 'problem' и не содержит 'issue'.

## Do not over-apply
Конвенция действует для логического статуса «Проблема» в репозитории frontend-support-center на момент SC-3563. Не распространять механически на другие статусы/поля и не считать 'issue'/'problem' взаимозаменяемыми. Если бэк позже унифицирует ключи — правило устаревает, проверять актуальность по коду.
