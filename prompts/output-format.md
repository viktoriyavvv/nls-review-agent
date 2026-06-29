# Output format

Верни СТРОГО валидный JSON одним объектом. Без markdown-обёртки, без ```json,
без текста до или после объекта.

Схема (ReviewResult):

{
  "verdict": "APPROVE | HOLD | DECLINE | STOP",
  "summary": "Краткий вывод, 2-5 предложений",
  "checkedHead": {
    "repoId": "string",
    "branch": "string",
    "head": "git sha",
    "lastCommit": "string",
    "syncStatus": "string (optional)"
  },
  "blockers": [
    {
      "title": "string",
      "file": "path (optional)",
      "evidence": "конкретный diff/файл/условие",
      "whyItMatters": "почему это важно"
    }
  ],
  "risks": [
    {
      "title": "string",
      "level": "low | medium | high",
      "evidence": "конкретное доказательство"
    }
  ],
  "questionsForDeveloper": ["string"],
  "bitbucketComment": "Готовый текст комментария для Bitbucket (markdown)"
}

Правила:
- Только ОДИН JSON-объект.
- Никаких комментариев внутри JSON.
- Если данных нет — пустой массив [] или пустая строка "".
- Поля checkedHead будут перезаписаны фактическими git-данными,
  но всё равно заполни их по своему пониманию.
