# Yandex Homework AI — Web/PWA starter

## Что внутри
- Главная с умной камерой/загрузкой фото, распознаванием OCR, вводом задания и решением через существующий `/solve`.
- Голосовой помощник через `/chat`, Web Speech API и системное озвучивание браузера.
- Профиль, лицензия, переключение темы, заметки и шпаргалки.
- PWA manifest и service worker.

## Установка в текущий Node/Express сервер

1. Распакуй папку `public` в корень проекта сервера так, чтобы получилось:
   `project-root/public/index.html`
   `project-root/public/app.js`
   `project-root/public/styles.css`
   `project-root/public/manifest.webmanifest`
   `project-root/public/sw.js`

2. В `server.js` добавь рядом с остальными require:
   ```js
   const path = require("path");
   ```

3. После CORS middleware (после блока `app.use((req,res,next)=>{...})`) и до объявления маршрутов добавь:
   ```js
   app.use(express.static(path.join(__dirname, "public")));
   ```

4. Остальной `server.js` не меняй. Текущие `/license/activate`, `/license/verify`, `/solve`, `/chat` остаются прежними.

5. Закоммить папку `public` и `server.js` в тот же GitHub-репозиторий, откуда Render разворачивает сервер. После деплоя открой:
   `https://yandexhomeworkayandex-homework-ai.onrender.com`

## Важно
- Это первый рабочий веб-каркас, не полная 1:1 копия всех SwiftUI экранов.
- Веб-версия хранит ключ и ID браузера в localStorage. Это не такой защищённый механизм, как iOS Keychain; очистка данных браузера может потерять привязанный ID. Не очищай данные сайта после активации.
- Браузерная камера/распознавание речи зависят от браузера и разрешений. Safari поддерживает системное озвучивание, но распознавание речи может быть недоступно; в таком случае можно писать сообщение текстом.
- OCR использует Tesseract.js с CDN и требует интернет для загрузки библиотеки/языковых данных.
- PWA устанавливается через меню Safari «Поделиться» → «На экран Домой» (iPhone) или меню браузера «Установить приложение» (поддерживаемые браузеры).
