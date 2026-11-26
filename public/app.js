(() => {
  const API = location.origin;
  const $ = id => document.getElementById(id);
  const state = {
    key: localStorage.getItem("yhai_license_key") || "",
    device: localStorage.getItem("yhai_device_id") || crypto.randomUUID(),
    history: [],
    chatMode: "Как учитель",
    activePersonal: "sheets",
    editingNoteId: null,
    notes: JSON.parse(localStorage.getItem("yhai_notes") || "[]"),
    autoSolve: localStorage.getItem("yhai_auto_solve") !== "false",
    autoSpeak: localStorage.getItem("yhai_auto_speak") !== "false",
    voiceSpeed: Number(localStorage.getItem("yhai_voice_speed") || 1),
    voiceVolume: Number(localStorage.getItem("yhai_voice_volume") || 1)
  };
  localStorage.setItem("yhai_device_id", state.device);

  const sheets = [
    ["Математика","Основные действия, дроби и проценты","Сложение: a + b = сумма\nВычитание: a − b = разность\nУмножение: a × b = произведение\nДеление: a : b = частное\n\nДРОБИ\nДля сложения дробей приведи их к общему знаменателю. При умножении умножь числители и знаменатели."],
    ["Русский язык","Части речи, орфография и пунктуация","ЧАСТИ РЕЧИ\nИмя существительное — предмет.\nИмя прилагательное — признак предмета.\nГлагол — действие или состояние.\n\nПРЕДЛОЖЕНИЕ\nПодлежащее отвечает на вопросы кто? что?\nСказуемое — что делает предмет?"],
    ["Физика","Величины и основные формулы","Скорость: v = s / t\nПуть: s = v · t\nВремя: t = s / v\nПлотность: ρ = m / V\nСила тяжести: F = m · g"],
    ["Химия","Основные понятия и формулы","Количество вещества: n = m / M\nМассовая доля: ω = m(вещества) / m(раствора)\nВода: H₂O\nУглекислый газ: CO₂"],
    ["История","Как работать с историческими датами","При разборе события укажи дату, место, участников, причины, ход событий и последствия. Различай причины и повод."]
  ];

  function show(id) { $(id).classList.remove("hidden"); }
  function hide(id) { $(id).classList.add("hidden"); }
  function message(id, text, ok=false) { $(id).textContent = text; $(id).style.color = ok ? "#55d69b" : ""; }
  function headers() { return { "Content-Type":"application/json", "Authorization":`Bearer ${state.key}`, "X-Device-ID":state.device }; }

  async function request(path, options={}) {
    const response = await fetch(API + path, { ...options, headers:{...headers(), ...(options.headers||{})} });
    const data = await response.json().catch(()=>({error:"Некорректный ответ сервера"}));
    if (!response.ok) {
      const err = new Error(data.error || "Ошибка запроса");
      err.status = response.status; err.code = data.code; throw err;
    }
    return data;
  }

  async function verifyLicense() {
    if (!state.key) return false;
    try {
      const data = await request("/license/verify");
      $("license-state").textContent = "Активна";
      $("license-expiry").textContent = data.license?.expiresAt ? `Действует до: ${new Date(data.license.expiresAt).toLocaleDateString("ru-RU")}` : "Подписка активна";
      return true;
    } catch (e) {
      if (e.code === "DEVICE_MISMATCH") message("activation-message", "Ключ уже привязан к другому устройству.");
      if (e.code === "LICENSE_EXPIRED") message("activation-message", "Срок действия подписки закончился.");
      localStorage.removeItem("yhai_license_key"); state.key = ""; return false;
    }
  }

  async function activate(event) {
    event.preventDefault();
    const key = $("license-key").value.trim().toUpperCase();
    if (!key) return;
    const button = $("activate-button"); button.disabled = true; button.textContent = "Проверяем...";
    try {
      const response = await fetch(API + "/license/activate", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({licenseKey:key, deviceId:state.device})
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Не удалось активировать лицензию");
      state.key = key; localStorage.setItem("yhai_license_key", key);
      await enterWorkspace();
    } catch(e) { message("activation-message", e.message); }
    finally { button.disabled = false; button.textContent = "Активировать доступ"; }
  }

  async function enterWorkspace() {
    hide("activation"); show("workspace");
    await verifyLicense();
    renderPersonal();
    checkHealth();
  }

  async function checkHealth() {
    try { const r=await fetch(API+"/health"); if(!r.ok) throw 0; }
    catch { $("license-state").textContent = "Сервер недоступен"; }
  }

  function switchScreen(name) {
    ["home","personal","profile"].forEach(s => $("screen-"+s).classList.toggle("hidden",s!==name));
    document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.screen===name));
  }
  document.querySelectorAll(".nav-item").forEach(b=>b.addEventListener("click",()=>switchScreen(b.dataset.screen)));

  async function solve() {
    const task=$("task-input").value.trim();
    if(!task) { message("solve-message","Сначала введи условие задания."); return; }
    const btn=$("solve-button"); btn.disabled=true; btn.textContent="✦ Решаем...";
    message("solve-message",""); hide("answer-wrap");
    try {
      const data=await request("/solve",{method:"POST",body:JSON.stringify({task:`Режим: ${$("solve-mode").value}\n\nЗадание:\n${task}`})});
      $("answer").textContent=data.answer||"Ответ отсутствует.";
      if(data.visual) { $("visual").textContent=[data.visual.title,data.visual.description,data.visual.scheme].filter(Boolean).join("\n\n"); show("visual"); } else hide("visual");
      show("answer-wrap"); message("solve-message","Готово",true);
    } catch(e) { message("solve-message",e.message); if(e.code==="LICENSE_EXPIRED"||e.code==="DEVICE_MISMATCH") { localStorage.removeItem("yhai_license_key"); state.key=""; hide("workspace"); show("activation"); } }
    finally { btn.disabled=false; btn.textContent="✦ Решить задание"; }
  }
  $("solve-button").addEventListener("click",solve);
  $("manual-button").addEventListener("click",()=>{ $("task-input").focus(); $("task-input").scrollIntoView({behavior:"smooth",block:"center"}); });
  $("copy-answer").addEventListener("click",()=>navigator.clipboard.writeText($("answer").textContent).then(()=>message("solve-message","Ответ скопирован",true)));

  async function recognizeFile(file) {
    if(!file) return;
    message("solve-message","Распознаём текст на изображении...");
    try {
      if(!window.Tesseract) throw new Error("Модуль распознавания не загрузился. Проверь подключение к интернету.");
      const result=await Tesseract.recognize(file,"rus+eng");
      const text=result.data.text.trim();
      if(!text) throw new Error("Не удалось распознать текст. Попробуй другое фото.");
      $("task-input").value=text; message("solve-message","Текст распознан",true);
      $("task-input").scrollIntoView({behavior:"smooth",block:"center"});
      if(state.autoSolve) await solve();
    } catch(e) { message("solve-message",e.message); }
  }
  $("camera-card").addEventListener("click",()=>$("camera-input").click());
  $("camera-input").addEventListener("change",e=>recognizeFile(e.target.files[0]));
  $("gallery-input").addEventListener("change",e=>recognizeFile(e.target.files[0]));

  function addBubble(role,text) {
    const el=document.createElement("div"); el.className="bubble "+role; el.textContent=text;
    $("chat-messages").appendChild(el); $("chat-messages").scrollTop=$("chat-messages").scrollHeight;
  }
  async function sendChat(text) {
    text=text.trim(); if(!text) return;
    addBubble("user",text); $("chat-input").value=""; $("chat-status").textContent="Думаю...";
    const btn=$("chat-form").querySelector("button"); btn.disabled=true;
    try {
      const data=await request("/chat",{method:"POST",body:JSON.stringify({message:text,mode:state.chatMode,history:state.history})});
      const answer=data.answer||"Не удалось сформировать ответ.";
      state.history.push({role:"user",content:text},{role:"assistant",content:answer}); state.history=state.history.slice(-12);
      addBubble("assistant",answer); $("chat-status").textContent="";
      if(state.autoSpeak) speak(answer);
    } catch(e) { $("chat-status").textContent=e.message; }
    finally { btn.disabled=false; }
  }
  $("voice-card").addEventListener("click",()=>$("voice-dialog").showModal());
  $("chat-form").addEventListener("submit",e=>{e.preventDefault();sendChat($("chat-input").value);});
  document.querySelectorAll(".mode-choice").forEach(b=>b.addEventListener("click",()=>{state.chatMode=b.dataset.mode;document.querySelectorAll(".mode-choice").forEach(x=>x.classList.toggle("selected",x===b));}));
  function speak(text) {
    if(!("speechSynthesis" in window)) return;
    speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(text); u.lang="ru-RU"; u.rate=state.voiceSpeed; u.volume=state.voiceVolume;
    const selected=$("voice-select").value; const voice=speechSynthesis.getVoices().find(v=>v.name===selected); if(voice)u.voice=voice; speechSynthesis.speak(u);
  }
  function loadVoices() {
    const select=$("voice-select"); const voices=speechSynthesis?.getVoices?.()||[];
    select.innerHTML=""; voices.filter(v=>v.lang.toLowerCase().startsWith("ru")).forEach(v=>{const o=document.createElement("option");o.value=v.name;o.textContent=v.name;select.append(o);});
  }
  if("speechSynthesis" in window) { loadVoices(); speechSynthesis.onvoiceschanged=loadVoices; }
  let recognition=null;
  $("listen-button").addEventListener("click",()=>{
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR){$("chat-status").textContent="Распознавание речи не поддерживается этим браузером. Используй поле ввода.";return;}
    if(recognition){recognition.stop();return;}
    recognition=new SR(); recognition.lang="ru-RU"; recognition.interimResults=true; recognition.continuous=false;
    $("listen-button").classList.add("listening");
    recognition.onresult=e=>{let t="";for(let i=e.resultIndex;i<e.results.length;i++)t+=e.results[i][0].transcript;if(e.results[e.results.length-1].isFinal)sendChat(t);};
    recognition.onerror=e=>$("chat-status").textContent="Ошибка микрофона: "+e.error;
    recognition.onend=()=>{$("listen-button").classList.remove("listening");recognition=null;};
    recognition.start();
  });
  $("voice-settings-button").addEventListener("click",()=>{$("voice-settings-dialog").showModal();});
  $("voice-speed").value=state.voiceSpeed; $("voice-volume").value=state.voiceVolume;
  $("voice-speed").addEventListener("input",e=>{state.voiceSpeed=Number(e.target.value);$("speed-value").textContent=Math.round(state.voiceSpeed*100)+"%";localStorage.setItem("yhai_voice_speed",state.voiceSpeed);});
  $("voice-volume").addEventListener("input",e=>{state.voiceVolume=Number(e.target.value);$("volume-value").textContent=Math.round(state.voiceVolume*100)+"%";localStorage.setItem("yhai_voice_volume",state.voiceVolume);});

  function renderPersonal() {
    const root=$("personal-content"), query=$("personal-search").value.toLowerCase(); root.innerHTML="";
    if(state.activePersonal==="sheets") {
      sheets.filter(x=>x[0].toLowerCase().includes(query)||x[1].toLowerCase().includes(query)).forEach(s=>{
        const card=document.createElement("button");card.className="sheet-card";card.style.width="100%";card.style.textAlign="left";card.innerHTML=`<b>📘 ${s[0]}</b><p>${s[1]}</p>`;
        card.addEventListener("click",()=>{const d=document.createElement("dialog");d.className="dialog";d.innerHTML=`<div class="dialog-head"><h2>${s[0]}</h2><button class="icon-btn">×</button></div><p style="white-space:pre-wrap;line-height:1.6"></p>`;d.querySelector("p").textContent=s[2];d.querySelector("button").onclick=()=>d.close();document.body.append(d);d.showModal();d.addEventListener("close",()=>d.remove());});root.append(card);
      });
    } else {
      const add=document.createElement("button");add.className="primary full add-note";add.textContent="+ Новая заметка";add.onclick=()=>openNote();root.append(add);
      state.notes.filter(n=>(n.title+n.content).toLowerCase().includes(query)).forEach(n=>{
        const card=document.createElement("button");card.className="note-card";card.style.width="100%";card.style.textAlign="left";card.innerHTML=`<b></b><p></p>`;card.querySelector("b").textContent=n.title;card.querySelector("p").textContent=n.content.slice(0,150);
        card.onclick=()=>openNote(n);root.append(card);
      });
      if(!state.notes.length){const p=document.createElement("p");p.className="muted";p.textContent="Пока нет заметок. Создай свою первую!";root.append(p);}
    }
  }
  document.querySelectorAll(".segment").forEach(b=>b.addEventListener("click",()=>{state.activePersonal=b.dataset.personal;document.querySelectorAll(".segment").forEach(x=>x.classList.toggle("active",x===b));$("personal-search").placeholder=state.activePersonal==="sheets"?"Поиск предмета...":"Поиск заметки...";renderPersonal();}));
  $("personal-search").addEventListener("input",renderPersonal);
  function openNote(note=null) {state.editingNoteId=note?.id||null;$("note-dialog-title").textContent=note?"Редактировать заметку":"Новая заметка";$("note-title").value=note?.title||"";$("note-content").value=note?.content||"";$("note-dialog").showModal();}
  $("save-note").addEventListener("click",()=>{const title=$("note-title").value.trim();if(!title)return;if(state.editingNoteId){const n=state.notes.find(x=>x.id===state.editingNoteId);if(n){n.title=title;n.content=$("note-content").value;}}else state.notes.unshift({id:crypto.randomUUID(),title,content:$("note-content").value,date:new Date().toISOString()});localStorage.setItem("yhai_notes",JSON.stringify(state.notes));$("note-dialog").close();renderPersonal();});

  $("settings-open").addEventListener("click",()=>$("settings-dialog").showModal());
  $("about-open").addEventListener("click",()=>$("about-dialog").showModal());
  $("change-license").addEventListener("click",()=>{if(confirm("Выйти из текущей лицензии на этом браузере?")){localStorage.removeItem("yhai_license_key");state.key="";hide("workspace");show("activation");}});
  document.querySelectorAll(".close-dialog").forEach(b=>b.addEventListener("click",()=>b.closest("dialog").close()));
  document.querySelectorAll("dialog").forEach(d=>d.addEventListener("click",e=>{if(e.target===d)d.close();}));
  $("theme-toggle").addEventListener("click",toggleTheme);
  $("dark-setting").addEventListener("change",e=>setTheme(e.target.checked));
  function setTheme(dark){document.documentElement.classList.toggle("light",!dark);localStorage.setItem("yhai_theme",dark?"dark":"light");$("dark-setting").checked=dark;}
  function toggleTheme(){setTheme(document.documentElement.classList.contains("light"));}
  $("auto-solve-setting").checked=state.autoSolve;
  $("auto-solve-setting").addEventListener("change",e=>{state.autoSolve=e.target.checked;localStorage.setItem("yhai_auto_solve",state.autoSolve);});
  $("auto-speak-setting").checked=state.autoSpeak;
  $("auto-speak-setting").addEventListener("change",e=>{state.autoSpeak=e.target.checked;localStorage.setItem("yhai_auto_speak",state.autoSpeak);});

  $("activate-form").addEventListener("submit",activate);
  setTheme(localStorage.getItem("yhai_theme")!=="light");
  (async()=>{if(state.key&&await verifyLicense())await enterWorkspace();else{show("activation");hide("workspace");}})();
  if("serviceWorker" in navigator) window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>{}));
})();
