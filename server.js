require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3210;
const MODEL = process.env.OPENAI_MODEL || "gpt-6.2-astra";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;

const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";

const PUBLIC_URL =
  process.env.RENDER_EXTERNAL_URL ||
  "https://yandexhomeworkayandex-homework-ai.onrender.com";

if (!process.env.OPENAI_API_KEY) {
  console.error("Не найден OPENAI_API_KEY");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("Не найден DATABASE_URL");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", error => {
  console.error("PostgreSQL:", error.message);
});

// ==========================================
// ТАРИФЫ
// ==========================================

const PLANS = {
  month: {
    code: "month",
    title: "1 месяц",
    description: "Доступ к Yandex Homework AI на 1 месяц",
    months: 1,
    rubles: 149,
    stars: 100
  },

  three_months: {
    code: "three_months",
    title: "3 месяца",
    description: "Доступ к Yandex Homework AI на 3 месяца",
    months: 3,
    rubles: 399,
    stars: 270
  },

  six_months: {
    code: "six_months",
    title: "6 месяцев",
    description: "Доступ к Yandex Homework AI на 6 месяцев",
    months: 6,
    rubles: 699,
    stars: 470
  },

  year: {
    code: "year",
    title: "12 месяцев",
    description: "Доступ к Yandex Homework AI на 12 месяцев",
    months: 12,
    rubles: 1099,
    stars: 740
  }
};

// ==========================================
// БАЗА ДАННЫХ
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

    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS telegram_payment_charge_id TEXT;

    ALTER TABLE licenses
      ADD COLUMN IF NOT EXISTS device_id TEXT;

    ALTER TABLE licenses
      ADD COLUMN IF NOT EXISTS device_ids TEXT[] NOT NULL DEFAULT '{}';

    UPDATE licenses
    SET device_ids = ARRAY[device_id]
    WHERE device_id IS NOT NULL
      AND device_id <> ''
      AND NOT (device_ids @> ARRAY[device_id]);
  `);

  console.log("PostgreSQL: база готова");
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
    "Content-Type, Authorization, X-Device-ID"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// ==========================================
// WEB APP — СТАТИЧЕСКИЕ ФАЙЛЫ
// ==========================================

app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// ЛИЦЕНЗИИ И ЗАЩИТА API
// ==========================================

function normalizeLicenseKey(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? normalizeLicenseKey(match[1]) : "";
}

function getDeviceId(req) {
  return String(req.headers["x-device-id"] || "").trim();
}

async function findValidLicense(licenseKey, deviceId) {
  if (!licenseKey || !deviceId) {
    return {
      valid: false,
      reason: "missing_credentials"
    };
  }

  const result = await pool.query(
    `SELECT
       l.id,
       l.license_key,
       l.plan_code,
       l.starts_at,
       l.expires_at,
       l.status,
       l.device_id,
       l.device_ids,
       o.payment_provider,
       o.payment_status
     FROM licenses l
     INNER JOIN orders o ON o.id = l.order_id
     WHERE l.license_key = $1
     LIMIT 1`,
    [licenseKey]
  );

  const license = result.rows[0];

  if (!license) {
    return {
      valid: false,
      reason: "license_not_found"
    };
  }

  if (
    license.payment_provider !== "telegram_stars" ||
    license.payment_status !== "paid"
  ) {
    return {
      valid: false,
      reason: "payment_not_valid"
    };
  }

  if (license.status !== "active") {
    return {
      valid: false,
      reason: "license_inactive"
    };
  }

  const now = Date.now();
  const startsAt = license.starts_at
    ? new Date(license.starts_at).getTime()
    : 0;
  const expiresAt = license.expires_at
    ? new Date(license.expires_at).getTime()
    : 0;

  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    (startsAt && startsAt > now)
  ) {
    if (expiresAt && expiresAt <= now) {
      await pool.query(
        `UPDATE licenses
         SET status = 'expired'
         WHERE id = $1 AND status = 'active'`,
        [license.id]
      );
    }

    return {
      valid: false,
      reason: "license_expired"
    };
  }

  const allowedDevices = Array.isArray(license.device_ids)
    ? license.device_ids
    : [];
  const legacyDeviceAllowed =
    license.device_id && license.device_id === deviceId;

  if (!allowedDevices.includes(deviceId) && !legacyDeviceAllowed) {
    return {
      valid: false,
      reason: "device_mismatch"
    };
  }

  return {
    valid: true,
    license: {
      key: license.license_key,
      planCode: license.plan_code,
      expiresAt: license.expires_at
    }
  };
}

async function requireLicense(req, res, next) {
  try {
    const licenseKey = getBearerToken(req);
    const deviceId = getDeviceId(req);

    if (!licenseKey || !deviceId) {
      return res.status(401).json({
        error: "Для использования приложения нужна активная лицензия.",
        code: "LICENSE_REQUIRED"
      });
    }

    const result = await findValidLicense(licenseKey, deviceId);

    if (!result.valid) {
      const statusCode =
        result.reason === "device_mismatch" ? 409 : 403;

      const messages = {
        license_not_found: "Лицензия не найдена.",
        payment_not_valid: "Эта лицензия не подтверждена реальной оплатой.",
        license_inactive: "Лицензия отключена.",
        license_expired: "Срок действия подписки закончился.",
        device_mismatch: "Лицензия уже привязана к другому устройству.",
        missing_credentials: "Не переданы данные лицензии."
      };

      return res.status(statusCode).json({
        error: messages[result.reason] || "Нет доступа.",
        code: result.reason === "license_expired"
          ? "LICENSE_EXPIRED"
          : result.reason === "device_mismatch"
            ? "DEVICE_MISMATCH"
            : "LICENSE_INVALID"
      });
    }

    req.license = result.license;
    next();
  } catch (error) {
    console.error("Ошибка проверки лицензии:", error.message);

    return res.status(500).json({
      error: "Не удалось проверить лицензию.",
      code: "LICENSE_CHECK_ERROR"
    });
  }
}

// ==========================================
// АКТИВАЦИЯ ЛИЦЕНЗИИ
// ==========================================

app.post("/license/activate", async (req, res) => {
  const licenseKey = normalizeLicenseKey(req.body?.licenseKey);
  const deviceId = String(req.body?.deviceId || "").trim();

  if (!licenseKey || !deviceId) {
    return res.status(400).json({
      success: false,
      error: "Введи лицензионный ключ и повтори попытку.",
      code: "MISSING_DATA"
    });
  }

  if (licenseKey.length > 100 || deviceId.length > 200) {
    return res.status(400).json({
      success: false,
      error: "Некорректные данные активации.",
      code: "INVALID_DATA"
    });
  }

  const db = await pool.connect();

  try {
    await db.query("BEGIN");

    const result = await db.query(
      `SELECT
         l.id,
         l.license_key,
         l.plan_code,
         l.starts_at,
         l.expires_at,
         l.status,
         l.device_id,
         l.device_ids,
         o.payment_provider,
         o.payment_status
       FROM licenses l
       INNER JOIN orders o ON o.id = l.order_id
       WHERE l.license_key = $1
       FOR UPDATE OF l`,
      [licenseKey]
    );

    const license = result.rows[0];

    if (!license) {
      await db.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        error: "Такой лицензионный ключ не найден.",
        code: "LICENSE_NOT_FOUND"
      });
    }

    if (
      license.payment_provider !== "telegram_stars" ||
      license.payment_status !== "paid"
    ) {
      await db.query("ROLLBACK");

      return res.status(403).json({
        success: false,
        error: "Этот ключ создан для тестирования и не открывает доступ к приложению.",
        code: "TEST_LICENSE"
      });
    }

    if (license.status !== "active") {
            await db.query("ROLLBACK");

      return res.status(403).json({
        success: false,
        error: "Эта лицензия отключена.",
        code: "LICENSE_INACTIVE"
      });
    }

    const now = Date.now();
    const startsAt = license.starts_at
      ? new Date(license.starts_at).getTime()
      : 0;
    const expiresAt = license.expires_at
      ? new Date(license.expires_at).getTime()
      : 0;

    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      (startsAt && startsAt > now)
    ) {
      if (expiresAt && expiresAt <= now) {
        await db.query(
          `UPDATE licenses
           SET status = 'expired'
           WHERE id = $1`,
          [license.id]
        );
      }

      await db.query("COMMIT");

      return res.status(403).json({
        success: false,
        error: "Срок действия этой подписки закончился.",
        code: "LICENSE_EXPIRED"
      });
    }

    const registeredDevices = Array.isArray(license.device_ids)
      ? license.device_ids.filter(Boolean)
      : [];

    if (license.device_id && !registeredDevices.includes(license.device_id)) {
      registeredDevices.push(license.device_id);
    }

    const uniqueDevices = [...new Set(registeredDevices)];

    if (!uniqueDevices.includes(deviceId)) {
      if (uniqueDevices.length >= 2) {
        await db.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          error: "Эта лицензия уже активирована на двух устройствах. Обратись в поддержку, если нужно заменить устройство.",
          code: "DEVICE_LIMIT_REACHED"
        });
      }

      uniqueDevices.push(deviceId);
    }

    await db.query(
      `UPDATE licenses
       SET device_ids = $2::TEXT[],
           device_id = COALESCE(device_id, $3)
       WHERE id = $1`,
      [license.id, uniqueDevices, deviceId]
    );

    await db.query("COMMIT");

    return res.json({
      success: true,
      message: "Лицензия успешно активирована.",
      license: {
        key: license.license_key,
        planCode: license.plan_code,
        expiresAt: license.expires_at
      }
    });
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch (_) {}

    console.error("Ошибка /license/activate:", error.message);

    return res.status(500).json({
      success: false,
      error: "Не удалось активировать лицензию. Попробуй позже.",
      code: "ACTIVATION_ERROR"
    });
  } finally {
    db.release();
  }
});

// ==========================================
// ПРОВЕРКА УЖЕ АКТИВИРОВАННОЙ ЛИЦЕНЗИИ
// ==========================================

app.get("/license/verify", requireLicense, (req, res) => {
  res.json({
    success: true,
    active: true,
    license: req.license
  });
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
    console.error(error.message);

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
// ПОЛЬЗОВАТЕЛИ
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
// ГЛАВНОЕ МЕНЮ
// ==========================================

function shopMenu() {
  return {
    inline_keyboard: [
      [{ text: "🛍 Магазин", callback_data: "shop_catalog" }],
      [{ text: "👤 Мой профиль", callback_data: "shop_profile" }],
      [{ text: "📦 Мои покупки", callback_data: "shop_orders" }],
      [{ text: "💬 Поддержка", callback_data: "shop_support" }]
    ]
  };
}

async function sendShopMenu(chatId) {
  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text:
      "🏠 YANDEX HOMEWORK AI\n\n" +
      "Добро пожаловать в магазин!\n\n" +
      "Выбери нужный раздел:",
    reply_markup: shopMenu()
  });
}

// ==========================================
// КАТАЛОГ ТАРИФОВ
// ==========================================

async function showCatalog(chatId) {
  const text =
    "🛍 МАГАЗИН YANDEX HOMEWORK AI\n\n" +
    "Выбери подходящий тариф:\n\n" +
    "🔹 1 месяц — 149 ₽ / 100 ⭐\n" +
    "🔹 3 месяца — 399 ₽ / 270 ⭐\n" +
    "🔹 6 месяцев — 699 ₽ / 470 ⭐\n" +
    "🔹 12 месяцев — 1099 ₽ / 740 ⭐\n\n" +
    "Оплата банковской картой будет добавлена отдельно.\n" +
    "Сейчас доступна оплата Telegram Stars.";

  const keyboard = [
    [{ text: "1 месяц — 100 ⭐", callback_data: "buy_month" }],
    [{ text: "3 месяца — 270 ⭐", callback_data: "buy_three_months" }],
    [{ text: "6 месяцев — 470 ⭐", callback_data: "buy_six_months" }],
    [{ text: "12 месяцев — 740 ⭐", callback_data: "buy_year" }]
  ];

  if (
    ADMIN_TELEGRAM_ID &&
    String(chatId) === String(ADMIN_TELEGRAM_ID)
  ) {
    keyboard.push([
      {
        text: "🧪 ТЕСТОВАЯ ПОКУПКА (без оплаты)",
        callback_data: "admin_test_month"
      }
    ]);
  }

  keyboard.push([
    {
      text: "↩️ Главное меню",
      callback_data: "shop_menu"
    }
  ]);

  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
}

// ==========================================
// СОЗДАНИЕ СЧЁТА TELEGRAM STARS
// ==========================================

async function createStarsInvoice(chatId, user, plan) {
  const orderResult = await pool.query(
    `INSERT INTO orders (
      telegram_id,
      product_code,
      amount,
      currency,
      payment_provider,
      payment_status
    )
    VALUES ($1, $2, $3, 'XTR', 'telegram_stars', 'pending')
    RETURNING id`,
    [
      String(user.id),
      plan.code,
      plan.stars
    ]
  );

  const orderId = orderResult.rows[0].id;

  try {
    await telegramRequest("sendInvoice", {
      chat_id: chatId,
      title: `Yandex Homework AI — ${plan.title}`,
      description: plan.description,
      payload: `yhai_order_${orderId}`,
      provider_token: "",
      currency: "XTR",
      prices: [
        {
          label: plan.title,
          amount: plan.stars
        }
      ]
    });

    console.log(`Создан счёт Telegram Stars: ${orderId}`);
  } catch (error) {
    await pool.query(
      `UPDATE orders
       SET payment_status = 'failed'
       WHERE id = $1 AND payment_status = 'pending'`,
      [orderId]
    );

    throw error;
  }
}

// ==========================================
// ПРОВЕРКА ПРЕДВАРИТЕЛЬНОЙ ОПЛАТЫ
// ==========================================

async function handlePreCheckout(query) {
  const payloadMatch = /^yhai_order_(\d+)$/.exec(
    query.invoice_payload || ""
  );

  if (!payloadMatch) {
    await telegramRequest("answerPreCheckoutQuery", {
      pre_checkout_query_id: query.id,
      ok: false,
      error_message: "Некорректный номер заказа."
    });

    return;
  }

  const orderId = payloadMatch[1];

  const result = await pool.query(
    `SELECT *
     FROM orders
     WHERE id = $1
       AND telegram_id = $2
       AND payment_status = 'pending'`,
    [
      orderId,
      String(query.from.id)
    ]
  );

  const order = result.rows[0];

  if (
    !order ||
    order.currency !== "XTR" ||
    Number(order.amount) !== Number(query.total_amount) ||
    query.currency !== "XTR"
  ) {
    await telegramRequest("answerPreCheckoutQuery", {
      pre_checkout_query_id: query.id,
      ok: false,
      error_message:
        "Заказ не найден или его сумма изменилась. Создай новый заказ."
    });

    return;
  }

  await telegramRequest("answerPreCheckoutQuery", {
    pre_checkout_query_id: query.id,
    ok: true
  });
}

// ==========================================
// ГЕНЕРАЦИЯ ЛИЦЕНЗИИ
// ==========================================

function generateLicenseKey() {
  const value = crypto.randomBytes(8).toString("hex").toUpperCase();

  return (
    "YHAI-" +
    value.slice(0, 4) +
    "-" +
    value.slice(4, 8) +
    "-" +
    value.slice(8, 12) +
    "-" +
    value.slice(12, 16)
  );
}

// ==========================================
// ПОДТВЕРЖДЕНИЕ УСПЕШНОЙ ОПЛАТЫ
// ==========================================

async function handleSuccessfulPayment(message) {
  const payment = message.successful_payment;
  const user = message.from;
  const chatId = message.chat.id;

  const match = /^yhai_order_(\d+)$/.exec(
    payment.invoice_payload || ""
  );

  if (!match) {
    throw new Error("Неизвестный платёжный payload");
  }

  const orderId = match[1];
  const db = await pool.connect();

  let license;
    try {
    await db.query("BEGIN");

    const orderResult = await db.query(
      `SELECT *
       FROM orders
       WHERE id = $1 AND telegram_id = $2
       FOR UPDATE`,
      [
        orderId,
        String(user.id)
      ]
    );

    const order = orderResult.rows[0];

    if (!order) {
      throw new Error("Заказ не найден");
    }

    if (
      order.currency !== "XTR" ||
      Number(order.amount) !== Number(payment.total_amount) ||
      payment.currency !== "XTR"
    ) {
      throw new Error("Несовпадение суммы или валюты платежа");
    }

    if (order.payment_status === "paid") {
      const existingLicense = await db.query(
        `SELECT license_key, plan_code, expires_at
         FROM licenses
         WHERE order_id = $1`,
        [orderId]
      );

      license = existingLicense.rows[0];

      if (!license) {
        throw new Error("Оплаченный заказ не имеет лицензии");
      }

      await db.query("COMMIT");
    } else {
      if (order.payment_status !== "pending") {
        throw new Error("Заказ не ожидает оплату");
      }

      const plan = PLANS[order.product_code];

      if (!plan) {
        throw new Error("Тариф заказа не найден");
      }

      await db.query(
        `UPDATE orders
         SET payment_status = 'paid',
             paid_at = NOW(),
             telegram_payment_charge_id = $2
         WHERE id = $1`,
        [
          orderId,
          payment.telegram_payment_charge_id
        ]
      );

      const licenseKey = generateLicenseKey();

      const licenseResult = await db.query(
        `INSERT INTO licenses (
          license_key,
          telegram_id,
          order_id,
          plan_code,
          starts_at,
          expires_at,
          status
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          NOW(),
          NOW() + make_interval(months => $5),
          'active'
        )
        RETURNING license_key, plan_code, expires_at`,
        [
          licenseKey,
          String(user.id),
          orderId,
          plan.code,
          plan.months
        ]
      );

      license = licenseResult.rows[0];

      await db.query("COMMIT");

      console.log(`Оплата подтверждена. Заказ ${orderId}`);
    }
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch (_) {}

    throw error;
  } finally {
    db.release();
  }

  const expiration = new Date(license.expires_at)
    .toLocaleDateString("ru-RU");

  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text:
      "🎉 ОПЛАТА УСПЕШНО ПРОШЛА!\n\n" +
      "Спасибо за покупку Yandex Homework AI.\n\n" +
      "🔑 ТВОЯ ЛИЦЕНЗИЯ:\n\n" +
      `${license.license_key}\n\n` +
      `📅 Тариф: ${license.plan_code}\n` +
      `⏳ Действует до: ${expiration}\n\n` +
      "Сохрани лицензионный ключ. " +
      "Он понадобится для активации доступа в приложении.",
    reply_markup: shopMenu()
  });
}

// ==========================================
// АДМИНСКАЯ ТЕСТОВАЯ ПОКУПКА
// ==========================================

async function createAdminTestPurchase(user, chatId) {
  if (
    !ADMIN_TELEGRAM_ID ||
    String(user.id) !== String(ADMIN_TELEGRAM_ID)
  ) {
    throw new Error("Нет доступа к тестовой покупке");
  }

  const plan = PLANS.month;
  const db = await pool.connect();

  let license;

  try {
    await db.query("BEGIN");

    const customer = await db.query(
      `SELECT telegram_id
       FROM customers
       WHERE telegram_id = $1`,
      [String(user.id)]
    );

    if (!customer.rows.length) {
      throw new Error("Пользователь не найден");
    }

    const orderResult = await db.query(
      `INSERT INTO orders (
        telegram_id,
        product_code,
        amount,
        currency,
        payment_provider,
        payment_status,
        paid_at
      )
      VALUES ($1, $2, $3, 'XTR', 'admin_test', 'paid', NOW())
      RETURNING id`,
      [
        String(user.id),
        plan.code,
        plan.stars
      ]
    );

    const orderId = orderResult.rows[0].id;
    const licenseKey = generateLicenseKey();

    const licenseResult = await db.query(
      `INSERT INTO licenses (
        license_key,
        telegram_id,
        order_id,
        plan_code,
        starts_at,
        expires_at,
        status
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        NOW(),
        NOW() + make_interval(months => $5),
        'active'
      )
      RETURNING license_key, expires_at`,
      [
        licenseKey,
        String(user.id),
        orderId,
        plan.code,
        plan.months
      ]
    );

    license = licenseResult.rows[0];

    await db.query("COMMIT");

    console.log(`Тестовая покупка создана. Заказ ${orderId}`);
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch (_) {}

    throw error;
  } finally {
    db.release();
  }

  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text:
      "🧪 ТЕСТОВАЯ ПОКУПКА УСПЕШНА!\n\n" +
      "Реальные Stars не списывались.\n\n" +
      "📦 Заказ записан в Neon.\n" +
      "💳 Статус: paid\n\n" +
      "🔑 ЛИЦЕНЗИЯ:\n" +
      license.license_key + "\n\n" +
      "📅 Тариф: 1 месяц\n" +
      "⏳ Действует до: " +
      new Date(license.expires_at).toLocaleDateString("ru-RU") +
      "\n\n🧪 Это тестовая покупка. Она не открывает доступ к приложению.",
    reply_markup: shopMenu()
  });
}

// ==========================================
// ПРОФИЛЬ
// ==========================================

async function showProfile(chatId, user) {
  const result = await pool.query(
    `SELECT
      (SELECT COUNT(*) FROM orders
       WHERE telegram_id = $1) AS orders_count,

      (SELECT COUNT(*) FROM licenses
       WHERE telegram_id = $1
       AND status = 'active'
       AND expires_at > NOW()) AS licenses_count`,
    [String(user.id)]
  );

  const stats = result.rows[0];

  const licenses = await pool.query(
    `SELECT l.license_key, l.plan_code, l.expires_at,
            o.payment_provider
     FROM licenses l
     LEFT JOIN orders o ON o.id = l.order_id
     WHERE l.telegram_id = $1
       AND l.status = 'active'
       AND l.expires_at > NOW()
     ORDER BY l.created_at DESC
     LIMIT 5`,
    [String(user.id)]
  );

  let licenseText = "";

  if (licenses.rows.length) {
    licenseText =
      "\n\n🔑 АКТИВНЫЕ ЛИЦЕНЗИИ\n\n" +
      licenses.rows.map(item =>
        `${item.payment_provider === "admin_test" ? "🧪 ТЕСТОВАЯ ЛИЦЕНЗИЯ\n" : ""}` +
        `Тариф: ${item.plan_code}\n` +
        `Ключ: ${item.license_key}\n` +
        `До: ${new Date(item.expires_at).toLocaleDateString("ru-RU")}`
      ).join("\n\n");
  }

  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text:
      "👤 МОЙ ПРОФИЛЬ\n\n" +
      `Имя: ${user.first_name || "Пользователь"}\n` +
      `Username: ${user.username ? "@" + user.username : "не указан"}\n` +
      `Telegram ID: ${user.id}\n\n` +
      `📦 Заказов: ${stats.orders_count}\n` +
      `🔑 Активных лицензий: ${stats.licenses_count}` +
      licenseText,
    reply_markup: shopMenu()
  });
}

// ==========================================
// ИСТОРИЯ ЗАКАЗОВ
// ==========================================

async function showOrders(chatId, user) {
  const result = await pool.query(
    `SELECT
      o.id,
      o.product_code,
      o.amount,
      o.currency,
      o.payment_provider,
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
      text: "📦 У тебя пока нет покупок.",
      reply_markup: shopMenu()
    });

    return;
  }

  const text = result.rows.map(order =>
    `📦 Заказ #${order.id}\n` +
    `Тариф: ${order.product_code}\n` +
    `Сумма: ${order.amount} ${order.currency}\n` +
    `Статус: ${order.payment_status}` +
    (
      order.payment_provider === "admin_test"
        ? "\n🧪 Тестовая покупка"
        : ""
    ) +
    (
      order.license_key
        ? `\n🔑 Лицензия: ${order.license_key}`
        : ""
    )
  ).join("\n\n");

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
      "По вопросам работы приложения:\n\n" +
      "rus33rk@gmail.com",
    reply_markup: shopMenu()
  });
}

// ==========================================
// TELEGRAM WEBHOOK
// ==========================================

async function handleTelegramUpdate(update) {
  if (update.pre_checkout_query) {
    await handlePreCheckout(update.pre_checkout_query);
    return;
  }

  if (update.message) {
    const message = update.message;
    const user = message.from;
    const chatId = message.chat.id;

    if (!user) return;

    await saveTelegramCustomer(user);

    if (message.successful_payment) {
      await handleSuccessfulPayment(message);
      return;
    }
        const command = (message.text || "").trim();

    if (/^\/start(?:@\w+)?(?:\s|$)/i.test(command)) {
      await telegramRequest("sendMessage", {
        chat_id: chatId,
        text:
          `Привет, ${user.first_name || "друг"}! 👋\n\n` +
          "Добро пожаловать в Yandex Homework AI!\n\n" +
          "Приобретай доступ к приложению, " +
          "управляй покупками и лицензиями.",
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
      text: "Выбери нужный раздел в меню:",
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

    if (query.data === "admin_test_month") {
      if (
        !ADMIN_TELEGRAM_ID ||
        String(user.id) !== String(ADMIN_TELEGRAM_ID)
      ) {
        return;
      }

      await createAdminTestPurchase(user, chatId);
      return;
    }

    if (query.data === "shop_menu") {
      await sendShopMenu(chatId);
      return;
    }

    if (query.data === "shop_catalog") {
      await showCatalog(chatId);
      return;
    }

    if (query.data === "shop_profile") {
      await showProfile(chatId, user);
      return;
    }

    if (query.data === "shop_orders") {
      await showOrders(chatId, user);
      return;
    }

    if (query.data === "shop_support") {
      await showSupport(chatId);
      return;
    }

    if (query.data.startsWith("buy_")) {
      const planCode = query.data.replace("buy_", "");
      const plan = PLANS[planCode];

      if (!plan) {
        await telegramRequest("sendMessage", {
          chat_id: chatId,
          text: "Такой тариф не найден.",
          reply_markup: shopMenu()
        });

        return;
      }

      await createStarsInvoice(chatId, user, plan);
    }
  }
}

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
    console.error("Telegram error:", error.message);
    return res.sendStatus(500);
  }
});

// ==========================================
// НАСТРОЙКА WEBHOOK
// ==========================================

async function configureTelegramWebhook() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_SECRET) {
    console.warn("Telegram не настроен");
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
        "callback_query",
        "pre_checkout_query"
      ],
      drop_pending_updates: false
    });

    console.log("Telegram webhook настроен");
  } catch (error) {
    console.error("Webhook error:", error.message);
  }
}

// ==========================================
// РЕШЕНИЕ ЗАДАНИЙ
// ==========================================

app.post("/solve", requireLicense, async (req, res) => {
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

Помогай ученикам по школьным предметам.

ОБЩИЕ ПРАВИЛА:
1. Внимательно прочитай условие.
2. Не выдумывай отсутствующие данные.
3. Объясняй решение последовательно.
4. Проверяй вычисления.
5. Отвечай на русском языке, если не попросили другой.

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

Не используй эти разделы, если они не подходят.

Если задание требует схемы, графика,
чертежа или диаграммы, передай информацию
в поле visual.

Верни СТРОГО JSON без Markdown:

{
  "answer": "Подробное решение задания",
  "visual": null
}

Если нужна схема:

{
  "answer": "Решение",
  "visual": {
    "type": "geometry",
    "title": "Название схемы",
    "description": "Описание",
    "scheme": "Текстовая схема",
    "labels": []
  }
}
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
    console.error("Ошибка /solve:", error.message);

    return res.status(500).json({
      error: "Ошибка при решении задания"
    });
  }
});

// ==========================================
// ЧАТ И ГОЛОСОВОЙ ПОМОЩНИК
// ==========================================

app.post("/chat", requireLicense, async (req, res) => {
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
Общайся как дружелюбный друг.
Объясняй простыми словами.
Будь непринуждённым.
`
        : `
Общайся как спокойный и терпеливый учитель.
Объясняй понятно и последовательно.
`;

    const instructions = `
Ты — голосовой и текстовый помощник
приложения Yandex Homework AI.

${styleInstructions}

Отвечай на русском, если не попросили другой язык.
Учитывай историю диалога.
Не используй Markdown-таблицы для голосового общения.
Не утверждай, что выполнил действие, если не выполнял.
`;

    const response = await client.responses.create({
      model: MODEL,
      instructions,
      input: [
        ...history,
        {
          role: "user",
          content: message
        }
      ]
    });

    return res.json({
      answer: String(
        response.output_text || "Не удалось сформировать ответ."
      ).trim()
    });

  } catch (error) {
    console.error("Ошибка /chat:", error.message);

    return res.status(500).json({
      error: "Не удалось получить ответ помощника"
    });
  }
});

// ==========================================
// ЗАПУСК
// ==========================================

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Yandex Homework AI запущен на порту ${PORT}`);

  try {
    await initializeDatabase();
    await configureTelegramWebhook();

    console.log("Сервер полностью готов к работе");
  } catch (error) {
    console.error("Ошибка запуска:", error.message);
  }
});
