require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3210;

if (!process.env.OPENAI_API_KEY) {
  console.error("Не найден OPENAI_API_KEY в .env");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const MODEL = process.env.OPENAI_MODEL || "gpt-6.2-astra";

// Проверка сервера
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Yandex Homework AI"
  });
});

// Решение школьных заданий
app.post("/solve", async (req, res) => {
  try {
    const task = String(req.body?.task || "").trim();

    if (!task) {
      return res.status(400).json({
        error: "Задание не передано"
      });
    }

    if (task.length > 15000) {
      return res.status(400).json({
        error: "Слишком длинное задание"
      });
    }

    const instructions = `
Ты — Yandex Homework AI, умный школьный помощник.

Твоя задача — помогать ученику разбираться в школьных заданиях
по математике, физике, химии, биологии, русскому языку,
литературе, истории, географии, информатике, английскому языку
и другим предметам.

ОБЩИЕ ПРАВИЛА:
1. Внимательно прочитай условие.
2. Не выдумывай данные, которых нет в задании.
3. Если условие неполное или неоднозначное, укажи это.
4. Объясняй решение понятно и последовательно.
5. Проверяй вычисления.
6. Отвечай на русском языке, если пользователь не просит другой язык.

ОФОРМЛЕНИЕ:
Если задача требует вычислений, используй структуру:

Дано:
...

Найти:
...

Решение:
...

Ответ:
...

Не используй разделы «Дано» и «Найти», если они не подходят
к типу задания.

Для программирования:
- Объясни алгоритм.
- Приведи рабочий код.
- Объясни важные части кода.
- Не добавляй лишние библиотеки без необходимости.

ВИЗУАЛЬНЫЕ МАТЕРИАЛЫ:
Если задание требует схемы, графика, чертежа или диаграммы,
передай визуальную информацию в поле visual.

Верни СТРОГО JSON без Markdown и без дополнительных пояснений
вне JSON:

{
  "answer": "Подробное решение задания",
  "visual": null
}

Если нужна схема, visual должен иметь вид:

{
  "type": "geometry",
  "title": "Название схемы",
  "description": "Описание",
  "scheme": "Текстовая схема",
  "labels": [
    {
      "symbol": "A",
      "meaning": "Обозначение точки A"
    }
  ]
}

Допустимые типы:
geometry, graph, sentence_scheme, diagram, illustration.

Если визуализация не нужна, верни visual: null.
`;

    const response = await client.responses.create({
      model: MODEL,
      instructions,
      input: task
    });

    const output = response.output_text || "";

    let parsed;

    try {
      const cleaned = output
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      parsed = JSON.parse(cleaned);
    } catch (error) {
      parsed = {
        answer: output || "Не удалось получить ответ.",
        visual: null
      };
    }

    return res.json({
      answer: String(parsed.answer || "Ответ отсутствует."),
      visual: parsed.visual || null
    });

  } catch (error) {
    console.error("Ошибка /solve:", error);

    return res.status(500).json({
      error: "Ошибка при решении задания"
    });
  }
});

// Голосовой и текстовый помощник
app.post("/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    const mode = String(req.body?.mode || "Как учитель");

    const incomingHistory = Array.isArray(req.body?.history)
      ? req.body.history
      : [];

    if (!message) {
      return res.status(400).json({
        error: "Сообщение пустое"
      });
    }

    if (message.length > 8000) {
      return res.status(400).json({
        error: "Сообщение слишком длинное"
      });
    }

    // Оставляем только последние сообщения
    // и разрешённые роли, чтобы не передавать лишние данные.
    const history = incomingHistory
      .filter(item =>
        item &&
        ["user", "assistant"].includes(item.role) &&
        typeof item.content === "string"
      )
      .slice(-12)
      .map(item => ({
        role: item.role,
        content: item.content.slice(0, 4000)
      }));

    const styleInstructions = mode === "Как друг"
      ? `
ОБЩАЙСЯ КАК ДРУГ:
- Будь дружелюбным, живым и непринуждённым.
- Объясняй простыми словами.
- Не будь чрезмерно официальным.
- Поддерживай собеседника.
- Не злоупотребляй эмодзи.
- Не называй пользователя ребёнком.
`
      : `
ОБЩАЙСЯ КАК УЧИТЕЛЬ:
- Будь спокойным, терпеливым и внимательным.
- Объясняй материал понятно и последовательно.
- Если ученик ошибается, мягко объясни ошибку.
- Помогай понять тему, а не только получить ответ.
- Не перегружай ответ ненужной информацией.
`;

    const instructions = `
Ты — голосовой и текстовый помощник приложения Yandex Homework AI.

Ты можешь:
- Отвечать на обычные вопросы.
- Помогать с домашними заданиями.
- Объяснять школьные темы.
- Помогать с программированием.
- Поддерживать обычный разговор.
- Давать короткие и понятные ответы, удобные для озвучивания.

${styleInstructions}

ВАЖНО:
- Отвечай на русском, если пользователь не попросил другой язык.
- Не утверждай, что выполнил действие, если ты его не выполнял.
- Если не знаешь ответ, честно скажи об этом.
- Учитывай предыдущие сообщения диалога.
- Не используй Markdown-таблицы, если ответ предназначен для голосового общения.
- Формулы при необходимости объясняй словами.
- Не начинай каждый ответ с приветствия.
`;

    const input = [
      ...history,
      {
        role: "user",
        content: message
      }
    ];

    const response = await client.responses.create({
      model: MODEL,
      instructions,
      input
    });

    const answer = String(
      response.output_text || "Не удалось сформировать ответ."
    ).trim();

    return res.json({
      answer
    });

  } catch (error) {
    console.error("Ошибка /chat:", error);

    return res.status(500).json({
      error: "Не удалось получить ответ помощника"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Yandex Homework AI запущен на порту ${PORT}`);
});
