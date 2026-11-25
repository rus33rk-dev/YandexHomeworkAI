
require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");

const app = express();
const PORT = 3210;

if (!process.env.OPENAI_API_KEY) {
  console.error("Не найден OPENAI_API_KEY в .env");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(express.json({ limit: "100kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/solve", async (req, res) => {
  try {
    const { task } = req.body;

    if (typeof task !== "string" || !task.trim()) {
      return res.status(400).json({
        error: "Пустое задание"
      });
    }

    if (task.length > 15000) {
      return res.status(413).json({
        error: "Слишком большой текст задания"
      });
    }

    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-6.2-astra",
      instructions: `
Ты решаешь школьные задания.

ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:
- Если задание просит написать программу — выведи ТОЛЬКО полный код.
- Запрещено писать объяснения до или после кода.
- Запрещено добавлять комментарии в код, если их не просили.
- Запрещено использовать Markdown и тройные обратные кавычки.
- Не пиши фразы «Вот решение», «Ответ», «Объяснение» и подобные.
- Используй простой школьный синтаксис.
- Не используй сложные библиотеки без необходимости.
- Соблюдай язык программирования из задания.
- Если условие неполное, задай короткий уточняющий вопрос.

Для заданий не по программированию отвечай кратко, в школьном формате.
`,
      input: task
    });

    res.json({
      answer: response.output_text
    });

  } catch (error) {
    console.error("OpenAI error:", error.message);

    res.status(500).json({
      error: "Ошибка обращения к OpenAI API"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Yandex Homework AI запущен: http://127.0.0.1:${PORT}`);
});

