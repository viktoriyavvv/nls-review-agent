# Output format (FollowupReviewResult)

Верни СТРОГО валидный JSON одним объектом, без markdown-обёртки.

{
  "verdict": "APPROVE | HOLD | DECLINE | STOP",
  "summary": "Краткий вывод follow-up",
  "previousReview": { "verdict": "", "head": "", "source": "" },
  "checkedHead": {
    "repoId": "",
    "branch": "",
    "baseBranch": "",
    "previousHead": "",
    "currentHead": "",
    "prId": ""
  },
  "resolvedItems": [
    {
      "title": "Пункт прошлого ревью",
      "previousEvidence": "",
      "status": "fixed | not_fixed | answered_accepted | answered_rejected | needs_clarification | not_applicable | unknown",
      "developerResponse": "",
      "currentEvidence": "файл/метод/строка/diff-факт",
      "conclusion": ""
    }
  ],
  "stillOpenItems": [
    {
      "title": "",
      "status": "not_fixed | needs_clarification | answered_rejected",
      "evidence": "",
      "requiredAction": ""
    }
  ],
  "newFindings": [
    { "title": "", "level": "low | medium | high", "evidence": "", "whyItMatters": "" }
  ],
  "questionsForDeveloper": [ "" ],
  "bitbucketComment": "Готовый текст комментария (НЕ публикуется автоматически)"
}

Примечания:
- `resolvedItems` — пункты прошлого ревью, по которым есть вывод (fixed/accepted/rejected/...).
- `stillOpenItems` — что осталось не закрытым и требует действия.
- `newFindings` — новые риски, появившиеся в изменениях после previous HEAD.
- Поля `checkedHead` будут перезаписаны реальными git-данными — заполняй best-effort.
