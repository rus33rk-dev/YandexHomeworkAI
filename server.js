
require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3210;

const MODEL = process.env.OPENAI_MODEL || "gpt-6.2-astra";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";

const PUBLIC_URL =
  process.env.RENDER_EXTERNAL_URL ||
  "https://yandexhomeworkayandex-homework-ai.onrender.com";

if (!process.env.OPENAI_API_KEY) {
  console.error("Не найден OPENAI_API_KEY");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ==========================================
// POSTGRESQL
// ==========================================

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

if (!pool) {
  console.error("DATABASE_URL не найден");
  process.exit(1);
}

pool.on("error", error => {
  console.error("Ошибка PostgreSQL:", error.message);
});

// ==========================================
// СОЗДАНИЕ БАЗЫ ДАННЫХ
// ==========================================

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL
        REFERENCES customers(telegram_id),
      product_code TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'RUB',
      payment_provider TEXT,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id BIGSERIAL PRIMARY KEY,
      license_key TEXT UNIQUE NOT NULL,
      telegram_id BIGINT NOT NULL
        REFERENCES customers(telegram_id),
      order_id BIGINT UNIQUE REFERENCES orders(id),
      plan_code TEXT NOT NULL,
      starts_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_orders_telegram_id
    ON orders(telegram_id);

    CREATE INDEX IF NOT EXISTS idx_licenses_telegram_id
    ON licenses(telegram_id);
  `);

  console.log("PostgreSQL: таблицы готовы");
}

// ==========================================
// MIDDLEWARE
// ==========================================

app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// ==========================================
// HEALTH
// ==========================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Yandex Homework AI"
  });
});

app.get("/db-health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected"
    });
  } catch (error) {
    console.error("DB health:", error.message);

    res.status(500).json({
      status: "error",
      database: "disconnected"
    });
  }
});

// ==========================================
// TELEGRAM API
// ==========================================

async function telegramRequest(method, data) {
  if (!TELEGRAM_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN не настроен");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    }
  );

  const result = await response.json();

  if (!result.ok) {
    throw new Error(
      result.description || "Ошибка Telegram API"
    );
  }

  return result.result;
}

// ==========================================
// РЕГИСТРАЦИЯ ПОЛЬЗОВАТЕЛЯ
// ==========================================

async function saveTelegramCustomer(user) {
  await pool.query(
    `INSERT INTO customers
      (telegram_id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id)
     DO UPDATE SET
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name`,
    [
      String(user.id),
      user.username || null,
      user.first_name || null
    ]
  );
}

// ==========================================
// МЕНЮ МАГАЗИНА
// ==========================================

function shopMenu() {
  return {
    inline_keyboard: [
      [
        {
          text: "🛍 Магазин",
          callback_data: "shop_catalog"
        }
      ],
      [
        {
          text: "👤 Мой профиль",
          callback_data: "shop_profile"
        }
      ],
      [
        {
          text: "📦 Мои покупки",
          callback_data: "shop_orders"
        }
      ],
      [
        {
          text: "💬 Поддержка",
          callback_data: "shop_support"
        }
      ]
    ]
  };
}

async function sendShopMenu(chatId) {
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text:
      "🏠 YANDEX HOMEWORK AI\n\n" +
      "Добро пожаловать в магазин приложения!\n\n" +
      "Выбери нужный раздел:",
    reply_markup: shopMenu()
  });
}

// ==========================================
// КАТАЛОГ
// ==========================================

async function showCatalog(chatId) {
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text:
      "🛍 МАГАЗИН YANDEX HOMEWORK AI\n\n" +
      "Здесь будет доступно приобретение лицензии " +
      "для мобильного приложения.\n\n" +
      "Мы готовим тарифы и подключаем безопасную оплату.\n\n" +
      "Пока можно пользоваться профилем и историей покупок.",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "👤 Мой профиль",
            callback_data: "shop_profile"
          }
        ],
        [
          {
            text: "↩️ Главное меню",
            callback_data: "shop_menu"
          }
        ]
      ]
    }
  });
}

// ==========================================
// ПРОФИЛЬ
// ==========================================

async function showProfile(chatId, user) {
  const result = await pool.query(
    `SELECT
      (SELECT COUNT(*)
       FROM orders
       WHERE telegram_id = $1) AS orders_count,

      (SELECT COUNT(*)
       FROM licenses
       WHERE telegram_id = $1
       AND status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW())
      ) AS licenses_count`,
    [String(user.id)]
  );

  const stats = result.rows[0];

  const licenses = await pool.query(
    `SELECT plan_code, license_key, expires_at
     FROM licenses
     WHERE telegram_id = $1
     AND status = 'active'
     AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC
     LIMIT 5`,
    [String(user.id)]
  );

  let licenseText = "";

  if (licenses.rows.length) {
    licenseText =
      "\n\n🔑 АКТИВНЫЕ ЛИЦЕНЗИИ\n\n" +
      licenses.rows.map(item =>
        `Тариф: ${item.plan_code}\n` +
        `Код: ${item.license_key}\n` +
        `Действует до: ${
          item.expires_at
            ? new Date(item.expires_at).toLocaleDateString("ru-RU")
            : "Без ограничения"
        }`
      ).join("\n\n");
  }

  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text:
      "👤 МОЙ ПРОФИЛЬ\n\n" +
      `Имя: ${user.first_name || "Пользователь"}\n` +
      `Username: ${
        user.username ? "@" + user.username : "не указан"
      }\n` +
      `Telegram ID: ${user.id}\n\n` +
      `📦 Заказов: ${stats.orders_count}\n` +
      `🔑 Активных лицензий: ${stats.licenses_count}` +
      licenseText,
    reply_markup: shopMenu()
  });
}

// ==========================================
// ИСТОРИЯ ПОКУПОК
// ==========================================

async function showOrders(chatId, user) {
  const result = await pool.query(
    `SELECT
      o.id,
      o.product_code,
      o.amount,
      o.currency,
      o.payment_status,
      o.created_at,
      l.license_key
     FROM orders o
     LEFT JOIN licenses l ON l.order_id = o.id
     WHERE o.telegram_id = $1
     ORDER BY o.created_at DESC
     LIMIT 10`,
    [String(user.id)]
  );

  if (!result.rows.length) {
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text:
        "📦 У тебя пока нет покупок.\n\n" +
        "Когда ты приобретёшь доступ, " +
        "информация появится здесь.",
      reply_markup: shopMenu()
    });

    return;
  }

  const text = result.rows.map(order => {
    const date = new Date(order.created_at)
      .toLocaleDateString("ru-RU");

    return (
      `📦 Заказ #${order.id}\n` +
      `Тариф: ${order.product_code}\n` +
      `Сумма: ${order.amount} ${order.currency}\n` +
      `Статус: ${order.payment_status}\n` +
      `Дата: ${date}` +
      (
        order.license_key
          ? `\n🔑 Лицензия: ${order.license_key}`
          : ""
      )
    );
  }).join("\n\n");

  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: "📦 МОИ ПОКУПКИ\n\n" + text,
    reply_markup: shopMenu()
  });
}

// ==========================================
// ПОДДЕРЖКА
// ==========================================

async function showSupport(chatId) {
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text:
      "💬 ПОДДЕРЖКА\n\n" +
      "Если возникли вопросы по приложению, " +
      "напиши нам на почту:\n\n" +
      "rus33rk@gmail.com\n\n" +
      "Опиши проблему и приложи необходимые подробности.",
    reply_markup: shopMenu()
  });
}

// ==========================================
// ОБРАБОТКА TELEGRAM СООБЩЕНИЙ
// ==========================================

async function handleTelegramUpdate(update) {
  if (update.message) {
    const message = update.message;
    const user = message.from;
    const chatId = message.chat.id;
    const command = (message.text || "").trim();

    if (!user) return;

    await saveTelegramCustomer(user);

    if (/^\/start(?:@\w+)?(?:\s|$)/i.test(command)) {
      await telegramRequest("sendMessage", {
        chat_id: chatId,
        text:
          `Привет, ${user.first_name || "друг"}! 👋\n\n` +
          "Добро пожаловать в Yandex Homework AI!\n\n" +
          "Это официальный магазин мобильного приложения.\n\n" +
          "Здесь можно будет приобретать доступ, " +
          "управлять лицензиями и просматривать покупки.",
        reply_markup: shopMenu()
      });

      return;
    }

    if (/^\/menu(?:@\w+)?$/i.test(command)) {
      await sendShopMenu(chatId);
      return;
    }

    if (/^\/help(?:@\w+)?$/i.test(command)) {
      await showSupport(chatId);
      return;
    }

    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text:
        "Я помогу управлять покупками и лицензиями.\n\n" +
        "Используй кнопки меню:",
      reply_markup: shopMenu()
    });

    return;
  }

  if (update.callback_query) {
    const query = update.callback_query;
    const user = query.from;
    const chatId = query.message?.chat?.id;

    await telegramRequest("answerCallbackQuery", {
      callback_query_id: query.id
    });

    if (!user || !chatId) return;

    await saveTelegramCustomer(user);

    switch (query.data) {
      case "shop_menu":
        await sendShopMenu(chatId);
        break;

      case "shop_catalog":
        await showCatalog(chatId);
        break;

      case "shop_profile":
        await showProfile(chatId, user);
        break;

      case "shop_orders":
        await showOrders(chatId, user);
        break;

      case "shop_support":
        await showSupport(chatId);
        break;

      default:
        await sendShopMenu(chatId);
    }
  }
}

// ==========================================
// TELEGRAM WEBHOOK
// ==========================================

app.post(TELEGRAM_WEBHOOK_PATH, async (req, res) => {
  if (!TELEGRAM_TOKEN || !TELEGRAM_SECRET) {
    return res.sendStatus(503);
  }

  const receivedSecret =
    req.get("X-Telegram-Bot-Api-Secret-Token");

  if (receivedSecret !== TELEGRAM_SECRET) {
    return res.sendStatus(403);
  }

  try {
    await handleTelegramUpdate(req.body);
    return res.sendStatus(200);
  } catch (error) {
    console.error(
      "Ошибка обработки Telegram:",
      error.message
    );

    return res.sendStatus(500);
  }
});

// ==========================================
// АВТОМАТИЧЕСКАЯ НАСТРОЙКА WEBHOOK
// ==========================================

async function configureTelegramWebhook() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_SECRET) {
    console.warn(
      "Telegram не настроен: отсутствуют переменные окружения"
    );
    return;
  }

  const webhookUrl =
    PUBLIC_URL.replace(/\/+$/, "") + TELEGRAM_WEBHOOK_PATH;

  try {
    await telegramRequest("setWebhook", {
      url: webhookUrl,
      secret_token: TELEGRAM_SECRET,
      allowed_updates: [
        "message",
        "callback_query"
      ],
      drop_pending_updates: false
    });

    console.log("Telegram webhook успешно настроен");
    console.log("Webhook URL:", webhookUrl);
  } catch (error) {
    console.error(
      "Не удалось настроить Telegram webhook:",
      error.message
    );
  }
}

// ==========================================
// РЕШЕНИЕ ШКОЛЬНЫХ ЗАДАНИЙ
// ==========================================

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

Помогай ученикам по математике, физике, химии,
биологии, русскому языку, литературе, истории,
географии, информатике, английскому языку
и другим школьным предметам.

ОБЩИЕ ПРАВИЛА:
1. Внимательно прочитай условие.
2. Не выдумывай отсутствующие данные.
3. Если условие неполное, укажи это.
4. Объясняй решение последовательно.
5. Проверяй вычисления.
6. Отвечай на русском языке, если не попросили другой язык.

ОФОРМЛЕНИЕ:
Если задача требует вычислений, используй:

Дано:
...

Найти:
...

Решение:
...

Ответ:
...

Не используй разделы Дано и Найти,
если они не подходят к заданию.

Для программирования:
- Объясни алгоритм.
- Приведи рабочий код.
- Объясни важные части кода.

ВИЗУАЛЬНЫЕ МАТЕРИАЛЫ:
Если задание требует схемы, графика,
чертежа или диаграммы, передай информацию
в поле visual.

Верни СТРОГО JSON без Markdown:

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
geometry, graph, sentence_scheme,
diagram, illustration.

Если визуализация не нужна,
верни visual: null.
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
    } catch {
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

// ==========================================
// ГОЛОСОВОЙ И ТЕКСТОВЫЙ ПОМОЩНИК
// ==========================================

app.post("/chat", async (req, res) => {
  try {
    const message = String(
      req.body?.message || ""
    ).trim();

    const mode = String(
      req.body?.mode || "Как учитель"
    );

    const incomingHistory =
      Array.isArray(req.body?.history)
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

    const styleInstructions =
      mode === "Как друг"
        ? `
ОБЩАЙСЯ КАК ДРУГ:
- Будь дружелюбным и непринуждённым.
- Объясняй простыми словами.
- Не будь чрезмерно официальным.
- Поддерживай собеседника.
- Не злоупотребляй эмодзи.
- Не называй пользователя ребёнком.
`
        : `
ОБЩАЙСЯ КАК УЧИТЕЛЬ:
- Будь спокойным и терпеливым.
- Объясняй понятно и последовательно.
- Мягко объясняй ошибки.
- Помогай понять тему.
- Не перегружай ответ.
`;

    const instructions = `
Ты — голосовой и текстовый помощник
приложения Yandex Homework AI.

Ты можешь:
- Отвечать на обычные вопросы.
- Помогать с домашними заданиями.
- Объяснять школьные темы.
- Помогать с программированием.
- Поддерживать разговор.
- Давать понятные ответы для озвучивания.

${styleInstructions}

ВАЖНО:
- Отвечай на русском, если не попросили другой язык.
- Не утверждай, что выполнил действие, если не выполнял.
- Если не знаешь ответ, честно скажи об этом.
- Учитывай историю диалога.
- Не используй Markdown-таблицы для голосового общения.
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

    return res.json({ answer });

  } catch (error) {
    console.error("Ошибка /chat:", error);

    return res.status(500).json({
      error: "Не удалось получить ответ помощника"
    });
  }
});

// ==========================================
// ЗАПУСК СЕРВЕРА
// ==========================================

app.listen(PORT, "0.0.0.0", async () => {
  console.log(
    `Yandex Homework AI запущен на порту ${PORT}`
  );

  try {
    await initializeDatabase();
    await configureTelegramWebhook();

    console.log("Сервер полностью готов к работе");
  } catch (error) {
    console.error(
      "Ошибка подготовки сервера:",
      error.message
    );
  }
});
