require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3210;

if (!process.env.OPENAI_API_KEY) {
  console.error("Не найден OPENAI_API_KEY в переменных окружения");
  process.exit(1);
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("Не найден TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
  console.error("Не найден TELEGRAM_WEBHOOK_SECRET");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

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

// Проверка сервера
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Отправка сообщения в Telegram
async function sendTelegramMessage(chatId, message) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message
      })
    }
  );

  if (!response.ok) {
    throw new Error("Не удалось отправить сообщение в Telegram");
  }
}

// Telegram Webhook
app.post("/telegram/webhook", async (req, res) => {
  if (
    req.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET
  ) {
    return res.sendStatus(403);
  }

  const message = req.body.message;
  const chatId = message?.chat?.id;
  const text = message?.text?.trim();

  if (!chatId || !text) {
    return res.sendStatus(200);
  }

  try {
    if (text === "/start") {
      await sendTelegramMessage(
        chatId,
        "Привет! Я бот для управления Yandex Homework AI.\n\nНапиши /wake, чтобы разбудить сервер Render."
      );
    } else if (text === "/wake") {
      await sendTelegramMessage(
        chatId,
        "Сервер запущен и отвечает! Можно пользоваться Yandex Homework AI."
      );
    } else {
      await sendTelegramMessage(
        chatId,
        "Напиши /wake, чтобы проверить и разбудить сервер."
      );
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Telegram error:", error.message);
    res.sendStatus(500);
  }
});

// Решение заданий
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
  console.log(`Yandex Homework AI запущен на порту ${PORT}`);
});
