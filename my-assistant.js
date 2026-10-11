/* My Assistant — an employee's own DCR assistant, on their phone.

   Today, tomorrow and the week (their normal hours, their job sites, their
   open tasks, shoots, events, reminders and to-dos), a chat with the
   assistant, their reminders, to-dos and events, and what the assistant
   keeps about them with their settings.

   The answers come from the office PC (DCR Agents), which polls the portal
   for waiting messages and writes the answer back; this page shows
   "thinking…" and asks again every 5 seconds while a message waits (20
   seconds after the first two minutes, 3 minutes while the office PC is
   offline, and not at all after 15 minutes — Refresh asks again), and says
   when the office PC is offline. The server's refusals are shown in the
   employee's language. Reminders, to-dos and events are added here without the
   assistant (?action=assistant, op item.add …), so they work while the PC is
   off; the PC fires the reminders to the phone.

   Everything drawn from the server goes through DCR.esc. What is typed in
   the chat box is kept on this phone, per account, with the id of its send
   (clientId) until the server says it has it — a dropped signal loses
   nothing, and a second tap never asks twice. Events go into the phone's own
   calendar as an .ics file made here; a drafted email opens in the phone's
   own mail app (mailto:) — the assistant never sends anything itself. */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var EP = "/api/portal?action=assistant";
  var DRAFT_KEY = "dcr.myAssistant.draft.v1";
  var LANG_KEY = "dcr.myAssistant.lang.v1";
  var PANELS = ["today", "tomorrow", "week", "chat", "items", "me"];
  /* The same rule the server applies to a link card: a page of this portal. */
  var LINK_RE = /^[a-z0-9-]{1,40}\.html(\?[\w=&%.-]{0,200})?(#[\w-]{0,40})?$/;
  var MAP_RE = /^https:\/\/www\.google\.com\/maps\//;
  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  var STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  var FAST_MS = 5000, SLOW_MS = 20000, FAST_FOR_MS = 120000;
  /* While the office PC is shown offline an answer cannot come: ask every
     three minutes. After fifteen minutes of waiting the page stops asking
     and offers Refresh (and asks again when the phone shows it again). */
  var OFFLINE_MS = 180000, STOP_AFTER_MS = 15 * 60000;
  /* When a briefing may go (lib/assistant.js BRIEFING_EARLIEST / LATEST). */
  var BRIEF_FROM = "12:00", BRIEF_TO = "20:45";
  /* A reminder more than six hours late is not sent (the push service drops
     it after that), so the page shows it as missed. */
  var MISSED_MIN = 6 * 60;
  var MAILTO_MAX = 1800;

  /* ── words ───────────────────────────────────────────────────────────── */

  var T = {
    en: {
      title: "My assistant", hi: "Hi {name}", loading: "Loading your assistant…",
      tabToday: "Today", tabTomorrow: "Tomorrow", tabWeek: "Week", tabChat: "Chat", tabItems: "To-dos", tabMe: "Me",
      tabsLabel: "Your assistant", dueToday: "{n} due today", dueTodayOne: "1 due today", nothingToday: "Nothing due today",
      today: "Today", tomorrow: "Tomorrow", thisWeek: "The next 7 days",
      hours: "Work hours", hoursNone: "No normal hours on file — ask the office.", sites: "Your jobs",
      fromTimesheet: "you filed hours here lately", directions: "Directions", status: "Status",
      events: "Events", reminders: "Reminders", todos: "To-dos", tasks: "Your open tasks", shoots: "Photo & video shoots",
      needsUpdate: "Needs an update", shootOn: "Shoot {day}", openTask: "Open task", nothingDay: "Nothing planned.",
      addCal: "Add to my phone calendar", addWeek: "Add this week's events to my phone calendar ({n})",
      noWeekEvents: "No events in the next 7 days to add to your calendar.",
      chatIntro: "Ask about your day and your jobs, or ask me to remind you of something.",
      you: "You", assistant: "Assistant", office: "Office", thinking: "Your assistant is thinking…",
      failed: "No answer this time.", resend: "Send again", placeholder: "Ask your assistant…", chatLabel: "Message to your assistant",
      send: "Send", sending: "Sending…", sent: "Sent ✓ — your assistant is on it.", writeFirst: "Write a message first.",
      noSignal: "No signal — your message is kept here. Tap Send again when you have signal.",
      draftRestored: "Draft restored — it hasn't been sent yet.",
      suggest: ["What do I have tomorrow?", "Remind me at 3 pm to call the lumber yard", "How is my job going?", "What's on my week?"],
      suggestLabel: "Ideas — each one goes into the box",
      emailDraft: "Email draft", openMail: "Open in Mail", to: "To", subject: "Subject", copy: "Copy text", copied: "Copied ✓",
      deleted: "(deleted)", openItem: "Open",
      addReminder: "+ Reminder", addTodo: "+ To-do", addEvent: "+ Event",
      comingUp: "Coming up", missed: "Missed", missedNote: "These came due while the office PC couldn't send them.",
      reminded: "Reminded", doneRecent: "Done (last 30 days)", noItems: "No reminders or to-dos yet. Add one, or ask your assistant.",
      byOffice: "Added by the office", byAssistant: "Added by your assistant", edit: "Edit", del: "Delete",
      markDone: "Mark “{text}” done", markOpen: "Mark “{text}” not done", noDate: "No date", due: "Due {day}", overdue: "Overdue",
      newReminder: "New reminder", newTodo: "New to-do", newEvent: "New event", editItem: "Change it",
      what: "What should I remind you about?", day: "Day", time: "Time", todoWhat: "What needs doing?", dueDay: "Due (optional)",
      notes: "Notes (optional)", eventTitle: "What is it?", start: "Starts at", end: "Ends at (optional)", location: "Where (optional)",
      remindBefore: "Remind me", remindNone: "No reminder", remindAt: "At the start", remindMin: "{n} minutes before",
      remindHour: "1 hour before", remindHours: "2 hours before", remindDay: "1 day before",
      save: "Save", cancel: "Cancel", add: "Add", delete: "Delete",
      needText: "Write what it's about.", needDay: "Pick a day.", needTime: "Pick a time.", endBefore: "It ends before it starts.",
      tooLong: "Keep it under 300 characters.", confirmDelete: "Delete “{text}”?", saved: "Saved ✓", notSaved: "Not saved: {why}",
      memTitle: "What my assistant knows about me",
      memNone: "Nothing yet. Tell it things like when you start, or how you like your reminders.",
      memPlaceholder: "e.g. I start at 6 am", memLabel: "Something your assistant should remember", memBy: "noted by your assistant",
      memDelete: "Forget “{text}”", settings: "Settings", evening: "Evening briefing about tomorrow",
      weekly: "Sunday briefing about the week", at: "at", language: "Language", emailCopy: "Also email me the briefings",
      privacyOffice: "The office can read your conversations with the assistant to help it improve.",
      privacyNoOffice: "The office does not read your conversations with the assistant.",
      privacyScope: "Your assistant only works with your own tasks, hours and jobs and what you tell it — never pay, prices or anyone else's information. It never sends a message for you: an email draft opens in your own mail app.",
      offline: "Your assistant is offline — the office PC was last seen {ago}. Your messages are saved and will be answered when it is back. Reminders wait too.",
      paused: "Your assistant is paused by the office right now. Your messages are saved.",
      waitingOffline: "Saved — the answer comes when the office PC is back.",
      online: "Assistant online", never: "never", justNow: "just now", minAgo: "{n} min ago", hAgo: "{n} h ago", daysAgo: "{n} days ago",
      refresh: "Refresh", loadFail: "Couldn't load your assistant.", offlineLoad: "No signal — your assistant will load when you're back online.",
      tryAgain: "Try again", itemOpened: "Here it is.", itemMissing: "That item is gone — it may have been deleted.",
      unread: "{n} new", logs: "Latest from the job log", busy: "One moment — still saving.",
      pushHint: "Your reminders and your assistant's answers reach this phone when phone reminders are on.",
      briefWindow: "Briefings go out between 12:00 pm and 8:45 pm.",
      pollStopped: "Still waiting for the answer — tap Refresh to look again.",
      srvUnlinked: "Your account isn’t linked to an employee yet — ask an admin.",
      srvNotOn: "Your assistant isn’t turned on yet — ask the office.",
      srvDisabled: "That account has been disabled.",
      srvChanged: "Your assistant changed while saving - please try again.",
      srvWaitFirst: "Wait for your assistant to answer first.",
      srvListFull: "Your list is full - delete some old items first.",
      srvOfficeItem: "The office added this one.",
      srvItemGone: "That item is gone - it may have been deleted.",
      srvTooMuch: "That is too much to keep - shorten the notes.",
      srvBriefTime: "Pick a briefing time between 12:00 pm and 8:45 pm.",
      srvMemoryFull: "Your assistant already keeps {n} notes - delete one first.",
      srvMessageLong: "Keep your message under {n} characters.",
    },
    es: {
      title: "Mi asistente", hi: "Hola {name}", loading: "Cargando tu asistente…",
      tabToday: "Hoy", tabTomorrow: "Mañana", tabWeek: "Semana", tabChat: "Chat", tabItems: "Pendientes", tabMe: "Yo",
      tabsLabel: "Tu asistente", dueToday: "{n} para hoy", dueTodayOne: "1 para hoy", nothingToday: "Nada pendiente para hoy",
      today: "Hoy", tomorrow: "Mañana", thisWeek: "Los próximos 7 días",
      hours: "Horario", hoursNone: "No hay horario normal registrado — pregunta en la oficina.", sites: "Tus obras",
      fromTimesheet: "registraste horas aquí hace poco", directions: "Cómo llegar", status: "Estado",
      events: "Eventos", reminders: "Recordatorios", todos: "Pendientes", tasks: "Tus tareas abiertas", shoots: "Sesiones de foto y video",
      needsUpdate: "Necesita actualización", shootOn: "Sesión {day}", openTask: "Abrir tarea", nothingDay: "Nada planeado.",
      addCal: "Agregar al calendario del teléfono", addWeek: "Agregar los eventos de la semana al calendario ({n})",
      noWeekEvents: "No hay eventos en los próximos 7 días para agregar al calendario.",
      chatIntro: "Pregúntame por tu día y tus obras, o pídeme que te recuerde algo.",
      you: "Tú", assistant: "Asistente", office: "Oficina", thinking: "Tu asistente está pensando…",
      failed: "Esta vez no hubo respuesta.", resend: "Enviar de nuevo", placeholder: "Pregúntale a tu asistente…",
      chatLabel: "Mensaje para tu asistente", send: "Enviar", sending: "Enviando…", sent: "Enviado ✓ — tu asistente ya lo está viendo.",
      writeFirst: "Escribe un mensaje primero.",
      noSignal: "Sin señal — tu mensaje se guarda aquí. Toca Enviar otra vez cuando tengas señal.",
      draftRestored: "Borrador recuperado — todavía no se ha enviado.",
      suggest: ["¿Qué tengo mañana?", "Recuérdame a las 3 pm llamar a la maderería", "¿Cómo va mi obra?", "¿Qué tengo esta semana?"],
      suggestLabel: "Ideas — cada una se pone en la caja",
      emailDraft: "Borrador de correo", openMail: "Abrir en Correo", to: "Para", subject: "Asunto", copy: "Copiar texto", copied: "Copiado ✓",
      deleted: "(borrado)", openItem: "Abrir",
      addReminder: "+ Recordatorio", addTodo: "+ Pendiente", addEvent: "+ Evento",
      comingUp: "Próximos", missed: "Perdidos", missedNote: "Llegaron a su hora cuando la PC de la oficina no podía enviarlos.",
      reminded: "Avisado", doneRecent: "Hechos (últimos 30 días)", noItems: "Todavía no hay recordatorios ni pendientes. Agrega uno o pídeselo a tu asistente.",
      byOffice: "Agregado por la oficina", byAssistant: "Agregado por tu asistente", edit: "Editar", del: "Borrar",
      markDone: "Marcar “{text}” como hecho", markOpen: "Marcar “{text}” como no hecho", noDate: "Sin fecha", due: "Para el {day}",
      overdue: "Atrasado", newReminder: "Nuevo recordatorio", newTodo: "Nuevo pendiente", newEvent: "Nuevo evento", editItem: "Cambiarlo",
      what: "¿De qué te recuerdo?", day: "Día", time: "Hora", todoWhat: "¿Qué hay que hacer?", dueDay: "Para cuándo (opcional)",
      notes: "Notas (opcional)", eventTitle: "¿Qué es?", start: "Empieza a las", end: "Termina a las (opcional)", location: "Dónde (opcional)",
      remindBefore: "Recordarme", remindNone: "Sin recordatorio", remindAt: "A la hora", remindMin: "{n} minutos antes",
      remindHour: "1 hora antes", remindHours: "2 horas antes", remindDay: "1 día antes",
      save: "Guardar", cancel: "Cancelar", add: "Agregar", delete: "Borrar",
      needText: "Escribe de qué se trata.", needDay: "Elige un día.", needTime: "Elige una hora.", endBefore: "Termina antes de empezar.",
      tooLong: "Que sea de menos de 300 letras.", confirmDelete: "¿Borrar “{text}”?", saved: "Guardado ✓", notSaved: "No se guardó: {why}",
      memTitle: "Lo que mi asistente sabe de mí",
      memNone: "Nada todavía. Dile cosas como a qué hora entras o cómo te gustan los recordatorios.",
      memPlaceholder: "p. ej. Entro a las 6 am", memLabel: "Algo que tu asistente debe recordar", memBy: "anotado por tu asistente",
      memDelete: "Olvidar “{text}”", settings: "Ajustes", evening: "Resumen en la tarde sobre mañana",
      weekly: "Resumen del domingo sobre la semana", at: "a las", language: "Idioma", emailCopy: "También mandarme los resúmenes por correo",
      privacyOffice: "La oficina puede leer tus conversaciones con el asistente para ayudarlo a mejorar.",
      privacyNoOffice: "La oficina no lee tus conversaciones con el asistente.",
      privacyScope: "Tu asistente solo trabaja con tus propias tareas, horas y obras y lo que tú le dices — nunca con pagos, precios ni información de otras personas. Nunca manda mensajes por ti: un borrador de correo se abre en tu propia app de correo.",
      offline: "Tu asistente está desconectado — la PC de la oficina se vio por última vez {ago}. Tus mensajes se guardan y se contestan cuando regrese. Los recordatorios también esperan.",
      paused: "La oficina pausó a tu asistente por ahora. Tus mensajes se guardan.",
      waitingOffline: "Guardado — la respuesta llega cuando regrese la PC de la oficina.",
      online: "Asistente en línea", never: "nunca", justNow: "hace un momento", minAgo: "hace {n} min", hAgo: "hace {n} h", daysAgo: "hace {n} días",
      refresh: "Actualizar", loadFail: "No se pudo cargar tu asistente.", offlineLoad: "Sin señal — tu asistente se carga cuando vuelvas a tener conexión.",
      tryAgain: "Intentar de nuevo", itemOpened: "Aquí está.", itemMissing: "Ese pendiente ya no está — tal vez se borró.",
      unread: "{n} nuevo(s)", logs: "Lo último en la bitácora de la obra", busy: "Un momento — todavía se está guardando.",
      pushHint: "Tus recordatorios y las respuestas de tu asistente llegan a este teléfono cuando los avisos del teléfono están activados.",
      briefWindow: "Los resúmenes salen entre las 12:00 p.m. y las 8:45 p.m.",
      pollStopped: "Todavía esperando la respuesta — toca Actualizar para revisar de nuevo.",
      srvUnlinked: "Tu cuenta todavía no está ligada a un empleado — pregúntale a un administrador.",
      srvNotOn: "Tu asistente todavía no está activado — pregúntale a la oficina.",
      srvDisabled: "Esa cuenta está desactivada.",
      srvChanged: "Tu asistente cambió mientras se guardaba — inténtalo de nuevo.",
      srvWaitFirst: "Espera a que tu asistente conteste primero.",
      srvListFull: "Tu lista está llena — borra algunos pendientes viejos primero.",
      srvOfficeItem: "Este lo agregó la oficina.",
      srvItemGone: "Ese pendiente ya no está — tal vez se borró.",
      srvTooMuch: "Es demasiado para guardar — acorta las notas.",
      srvBriefTime: "Elige una hora para el resumen entre las 12:00 p.m. y las 8:45 p.m.",
      srvMemoryFull: "Tu asistente ya guarda {n} notas — borra una primero.",
      srvMessageLong: "Que tu mensaje sea de menos de {n} letras.",
    },
  };

  var S = {
    lang: "en", data: null, agenda: null, off: null, panel: "today", sending: false, waitSince: 0, pollTimer: null,
    highlight: "", meSig: "", busy: false, reading: false, pollStopped: false,
  };

  function t(key, vars) {
    var dict = T[S.lang] || T.en;
    var s = dict[key] !== undefined ? dict[key] : T.en[key];
    if (typeof s !== "string") return s;
    return s.replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] !== undefined ? String(vars[k]) : m; });
  }

  /* The server's refusals in the employee's language. The server speaks
     English; its known sentences are matched by their words and said from
     the table above, anything else is shown as it came. */
  var SERVER_WORDS = {
    "Your account isn’t linked to an employee yet — ask an admin.": "srvUnlinked",
    "Your assistant isn’t turned on yet — ask the office.": "srvNotOn",
    "That account has been disabled.": "srvDisabled",
    "Your assistant changed while saving - please try again.": "srvChanged",
    "Wait for your assistant to answer first.": "srvWaitFirst",
    "Your list is full - delete some old items first.": "srvListFull",
    "The office added this one.": "srvOfficeItem",
    "That item is gone - it may have been deleted.": "srvItemGone",
    "That is too much to keep - shorten the notes.": "srvTooMuch",
    "Pick a briefing time between 12:00 and 20:45.": "srvBriefTime",
  };
  function serverText(message) {
    var m = String(message || "");
    if (SERVER_WORDS[m]) return t(SERVER_WORDS[m]);
    var full = /^Your assistant already keeps (\d+) notes - delete one first\.$/.exec(m);
    if (full) return t("srvMemoryFull", { n: full[1] });
    var tooLong = /^Keep your message under ([\d,]+) characters\.$/.exec(m);
    if (tooLong) return t("srvMessageLong", { n: tooLong[1] });
    return m;
  }

  /* ── small helpers ───────────────────────────────────────────────────── */

  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function store(k, v) {
    try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private window */ }
  }

  /* Whose phone this is, from the session token, so a draft typed by one
     person never shows up for another on a shared phone. */
  function account() {
    try {
      var p = DCR.getToken().split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      while (p.length % 4) p += "=";
      var c = JSON.parse(atob(p));
      return String(c.email || c.sub || "");
    } catch (e) { return ""; }
  }
  function draftKey() { return DRAFT_KEY + ":" + account(); }
  /* The chat box's words, and the clientId of the send they went out with
     (kept until the server answers, so a retry after a lost answer is the
     same message, not a second one). */
  function getDraft() {
    var raw = read(draftKey());
    if (!raw) return null;
    try {
      var d = JSON.parse(raw);
      if (!d || Date.now() - d.at > 30 * 86400000) { store(draftKey(), null); return null; }
      return { t: String(d.t || ""), clientId: String(d.clientId || ""), sent: String(d.sent || "") };
    } catch (e) { return null; }
  }
  function setDraft(text, clientId, sent) {
    if (!text || !String(text).trim()) { store(draftKey(), null); return; }
    store(draftKey(), JSON.stringify({ t: text, at: Date.now(), clientId: clientId || "", sent: sent || "" }));
  }
  function newClientId() {
    var s = "c" + Date.now().toString(36);
    for (var i = 0; i < 6; i++) s += Math.floor(Math.random() * 36).toString(36);
    return s;
  }

  var WD = { en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], es: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] };
  var MO = { en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    es: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] };
  /* Days are the company's (the server's `today`), read at UTC noon so the
     phone's own zone can never move one. */
  function addDays(key, n) {
    if (!DAY_RE.test(key || "")) return "";
    var d = new Date(key + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function dayText(key) {
    if (!DAY_RE.test(key || "")) return "";
    var d = new Date(key + "T12:00:00Z");
    var w = WD[S.lang] || WD.en, m = MO[S.lang] || MO.en;
    return S.lang === "es" ? w[d.getUTCDay()] + " " + d.getUTCDate() + " " + m[d.getUTCMonth()]
      : w[d.getUTCDay()] + " " + m[d.getUTCMonth()] + " " + d.getUTCDate();
  }
  function dayWord(key) {
    var today = S.data && S.data.today;
    if (key === today) return t("today");
    if (key === addDays(today, 1)) return t("tomorrow");
    return dayText(key);
  }
  function clockText(hm) {
    var m = /^(\d{2}):(\d{2})$/.exec(hm || "");
    if (!m) return "";
    var h = Number(m[1]);
    if (S.lang === "es") return h + ":" + m[2];
    return (h % 12 || 12) + ":" + m[2] + (h < 12 ? " am" : " pm");
  }
  function whenText(stamp) {
    if (!STAMP_RE.test(stamp || "")) return "";
    return dayWord(stamp.slice(0, 10)) + " " + clockText(stamp.slice(11));
  }
  /* Minutes between two company-local stamps ("YYYY-MM-DDTHH:MM"). */
  function minutesBetween(a, b) {
    var at = function (s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16)); };
    if (!STAMP_RE.test(a || "") || !STAMP_RE.test(b || "")) return null;
    return Math.round((at(b) - at(a)) / 60000);
  }
  function agoText(iso) {
    var gen = Date.parse((S.data && S.data.generatedAt) || "") || Date.now();
    var then = Date.parse(iso || "");
    if (!then) return t("never");
    var mins = Math.max(0, Math.round((gen - then) / 60000));
    if (mins < 1) return t("justNow");
    if (mins < 60) return t("minAgo", { n: mins });
    if (mins < 1440) return t("hAgo", { n: Math.round(mins / 60) });
    return t("daysAgo", { n: Math.round(mins / 1440) });
  }
  /* A message's time on screen, in the company's zone. */
  function msgTime(iso) {
    var d = new Date(iso || "");
    if (isNaN(d.getTime())) return "";
    try {
      return new Intl.DateTimeFormat(S.lang === "es" ? "es-MX" : "en-US", {
        timeZone: (S.data && S.data.tz) || undefined, weekday: "short", hour: "numeric", minute: "2-digit",
      }).format(d);
    } catch (e) { return ""; }
  }

  /* ── the phone calendar (.ics) ───────────────────────────────────────── */

  /* RFC 5545 text: backslash, semicolon and comma escaped, line breaks as \n. */
  function icsEscape(s) {
    return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
  }
  function utf8Length(ch) {
    var c = ch.codePointAt(0);
    return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  /* A content line folded at 75 octets (not characters: an "ñ" is two), each
     continuation starting with one space, never inside a character. */
  function icsFold(line) {
    var out = [], cur = "", bytes = 0;
    Array.from(String(line)).forEach(function (ch) {
      var b = utf8Length(ch);
      if (bytes + b > 75) { out.push(cur); cur = " " + ch; bytes = 1 + b; }
      else { cur += ch; bytes += b; }
    });
    out.push(cur);
    return out.join("\r\n");
  }
  /* "2026-10-10T09:00" → "20261010T090000": a floating local time, no zone —
     the crew's phones are in the company's zone, and a floating time is
     shown at the same clock time wherever the phone is. */
  function icsLocal(stamp) { return stamp.slice(0, 4) + stamp.slice(5, 7) + stamp.slice(8, 10) + "T" + stamp.slice(11, 13) + stamp.slice(14, 16) + "00"; }
  function icsUtc(date) { return new Date(date).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
  function plusHour(stamp) {
    var d = new Date(Date.UTC(+stamp.slice(0, 4), +stamp.slice(5, 7) - 1, +stamp.slice(8, 10), +stamp.slice(11, 13) + 1, +stamp.slice(14, 16)));
    return d.toISOString().slice(0, 16);
  }
  /* One VEVENT's lines for an event item: its own UID (so importing it again
     updates it), the reminder before it as a VALARM. */
  function icsEventLines(it, now) {
    if (!it || !STAMP_RE.test(it.at || "")) return [];
    var end = STAMP_RE.test(it.end || "") && it.end >= it.at ? it.end : plusHour(it.at);
    var lines = [
      "BEGIN:VEVENT",
      "UID:" + String(it.id || "item") + "@dcr-portal",
      "DTSTAMP:" + icsUtc(now || new Date()),
      "DTSTART:" + icsLocal(it.at),
      "DTEND:" + icsLocal(end),
      "SUMMARY:" + icsEscape(it.text),
    ];
    if (it.location) lines.push("LOCATION:" + icsEscape(it.location));
    if (it.notes) lines.push("DESCRIPTION:" + icsEscape(it.notes));
    if (it.remind !== null && it.remind !== undefined && Number(it.remind) >= 0) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEscape(it.text), "TRIGGER:-PT" + Math.round(Number(it.remind)) + "M", "END:VALARM");
    }
    lines.push("END:VEVENT");
    return lines;
  }
  function icsCalendar(items, now) {
    var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DCR Framing//DCR Portal My Assistant//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
    (items || []).forEach(function (it) { lines = lines.concat(icsEventLines(it, now)); });
    lines.push("END:VCALENDAR");
    return lines.map(icsFold).join("\r\n") + "\r\n";
  }
  function downloadIcs(name, text) {
    try {
      var url = URL.createObjectURL(new Blob([text], { type: "text/calendar;charset=utf-8" }));
      var a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
    } catch (e) { /* an old browser: nothing to offer */ }
  }

  /* ── a drafted email (mailto:) ───────────────────────────────────────── */

  /* The draft as a mailto: link for the phone's own mail app. Line breaks
     travel as %0D%0A; the whole link stays under 1,800 characters (some
     mail apps refuse longer ones), the body cut with "…" when it has to be. */
  function mailtoUrl(to, subject, body) {
    var safe = function (s) { return String(s == null ? "" : s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1"); };
    var head = "mailto:" + encodeURIComponent(safe(to)) + "?subject=" + encodeURIComponent(safe(subject)) + "&body=";
    var b = safe(body).replace(/\r\n|\r|\n/g, "\r\n");
    var whole = head + encodeURIComponent(b);
    if (whole.length <= MAILTO_MAX) return whole;
    var lo = 0, hi = b.length;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      var cut = b.slice(0, mid).replace(/[\uD800-\uDBFF]$/, "").replace(/\r$/, "");
      if ((head + encodeURIComponent(cut + "…")).length <= MAILTO_MAX) lo = mid; else hi = mid - 1;
    }
    var kept = b.slice(0, lo).replace(/[\uD800-\uDBFF]$/, "").replace(/\r$/, "");
    return head + encodeURIComponent(kept + "…");
  }

  /* ── what is on a day ────────────────────────────────────────────────── */

  function items() { return (S.data && S.data.items) || []; }
  function findItem(id) {
    var list = items();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function byAt(a, b) { return String(a.at || a.due || "9999").localeCompare(String(b.at || b.due || "9999")); }
  function onDay(key, todayPanel) {
    var list = items().filter(function (it) { return !it.done; });
    var tasks = (S.agenda && S.agenda.tasks) || [];
    return {
      events: list.filter(function (it) { return it.kind === "event" && String(it.at).slice(0, 10) === key; }).sort(byAt),
      reminders: list.filter(function (it) { return it.kind === "reminder" && String(it.at).slice(0, 10) === key; }).sort(byAt),
      todos: list.filter(function (it) {
        if (it.kind !== "todo") return false;
        return todayPanel ? (!it.due || it.due <= key) : it.due === key;
      }).sort(byAt),
      shoots: tasks.filter(function (x) { return x.shootDate === key; }),
    };
  }
  function isMissed(it) {
    if (it.done || it.kind === "todo" || !S.data) return false;
    if (it.firedFor && it.firedFor === it.at) return false;
    var due = it.kind === "event" && it.remind !== null && it.remind !== undefined ? it.at : it.kind === "reminder" ? it.at : "";
    if (!due) return false;
    var late = minutesBetween(due, S.data.now);
    return late !== null && late > MISSED_MIN;
  }

  /* ── drawing ─────────────────────────────────────────────────────────── */

  function mapHref(url) { return MAP_RE.test(url || "") ? url : ""; }
  function dirLink(site) {
    var href = mapHref(site.mapLink) ||
      (site.address ? "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent([site.address, site.city].filter(Boolean).join(", ")) : "");
    return href ? '<a class="ma-dir" target="_blank" rel="noopener" href="' + esc(href) + '">' + esc(t("directions")) + " ↗</a>" : "";
  }

  function itemLine(it, opts) {
    opts = opts || {};
    var when = it.kind === "todo" ? (it.due ? t("due", { day: dayWord(it.due) }) : t("noDate")) : whenText(it.at) +
      (it.kind === "event" && it.end ? " – " + clockText(String(it.end).slice(11)) : "");
    var overdue = it.kind === "todo" && it.due && S.data && it.due < S.data.today && !it.done;
    var missed = isMissed(it);
    var icon = it.kind === "event" ? "📅" : it.kind === "reminder" ? "⏰" : "📝";
    var by = it.by === "office" ? '<span class="ma-chip office">' + esc(t("byOffice")) + "</span>"
      : it.by === "assistant" ? '<span class="ma-chip">' + esc(t("byAssistant")) + "</span>" : "";
    var tools = opts.tools === false ? "" :
      '<div class="ma-itools">' +
        (it.kind === "event" ? '<button type="button" class="ma-lbtn" data-act="ics" data-id="' + esc(it.id) + '">' + esc(t("addCal")) + "</button>" : "") +
        (it.by !== "office" ? '<button type="button" class="ma-lbtn" data-act="edit" data-id="' + esc(it.id) + '">' + esc(t("edit")) + "</button>" +
          '<button type="button" class="ma-lbtn warn" data-act="delete" data-id="' + esc(it.id) + '">' + esc(t("del")) + "</button>" : "") +
      "</div>";
    return '<li class="ma-item' + (it.done ? " done" : "") + (S.highlight === it.id ? " sel" : "") + '" id="item-' + esc(it.id) + '">' +
      '<label class="ma-check"><input type="checkbox" data-act="done" data-id="' + esc(it.id) + '"' + (it.done ? " checked" : "") +
        ' aria-label="' + esc(t(it.done ? "markOpen" : "markDone", { text: it.text })) + '" /></label>' +
      '<div class="ma-ibody"><div class="ma-itext"><span aria-hidden="true">' + icon + "</span> " + esc(it.text) + "</div>" +
        '<div class="ma-iwhen' + (overdue || missed ? " warn" : "") + '">' + esc(when) + (overdue ? " · " + esc(t("overdue")) : "") +
          (missed ? " · " + esc(t("missed")) : "") +
          (it.firedAt && it.firedFor === it.at ? " · " + esc(t("reminded")) : "") + "</div>" +
        (it.location ? '<div class="ma-iloc">' + esc(it.location) + "</div>" : "") +
        (it.notes ? '<div class="ma-inotes">' + esc(it.notes) + "</div>" : "") +
        (by ? '<div class="ma-iby">' + by + "</div>" : "") + tools +
      "</div></li>";
  }

  function taskLine(task) {
    return '<li class="ma-task' + (task.needsUpdate ? " needs" : "") + '">' +
      '<a class="ma-tlink" href="my-tasks.html?task=' + encodeURIComponent(task.id) + '">' +
        '<span class="ma-tname">' + esc(task.name) + "</span>" +
        (task.project ? '<span class="ma-tproj">' + esc(task.project) + "</span>" : "") +
        '<span class="ma-tmeta">' +
          (task.needsUpdate ? '<span class="ma-chip warn">' + esc(t("needsUpdate")) + "</span>" : "") +
          (task.shootDate ? '<span class="ma-chip photo">📷 ' + esc(t("shootOn", { day: dayWord(task.shootDate) })) + "</span>" : "") +
        "</span>" +
      "</a></li>";
  }

  function group(title, inner, cls) {
    return inner ? '<section class="ma-group' + (cls ? " " + cls : "") + '"><h3 class="ma-gh">' + esc(title) + "</h3>" + inner + "</section>" : "";
  }
  function list(arr, fn) { return arr.length ? '<ul class="ma-list">' + arr.map(fn).join("") + "</ul>" : ""; }

  function hoursHtml() {
    var h = (S.agenda && S.agenda.hours) || {};
    var text = h.start && h.end ? clockText(h.start) + " – " + clockText(h.end) : h.start ? clockText(h.start) : "";
    return '<div class="ma-hours"><span class="ma-hlabel">' + esc(t("hours")) + "</span> " +
      (text ? "<b>" + esc(text) + "</b>" : '<span class="ma-muted">' + esc(t("hoursNone")) + "</span>") + "</div>";
  }

  function sitesHtml() {
    var projects = (S.agenda && S.agenda.projects) || [];
    var sites = (S.agenda && S.agenda.sites) || [];
    if (!projects.length && !sites.length) return "";
    var seen = {};
    var rows = projects.map(function (p) {
      seen[String(p.label).toLowerCase()] = 1;
      var logs = (p.logs || []).slice(0, 2).map(function (l) {
        return '<li><span class="ma-ldate">' + esc(dayText(l.date)) + "</span> " + esc(l.text) + "</li>";
      }).join("");
      return '<li class="ma-site"><div class="ma-sname">' + esc(p.label) + "</div>" +
        '<div class="ma-smeta">' + esc([p.address, p.city].filter(Boolean).join(", ")) +
          (p.status ? ' · <span class="ma-muted">' + esc(t("status")) + ": " + esc(p.status) + "</span>" : "") +
          (p.from === "timesheet" ? ' · <span class="ma-muted">' + esc(t("fromTimesheet")) + "</span>" : "") + "</div>" +
        dirLink(p) +
        (logs ? '<div class="ma-logs"><div class="ma-ltitle">' + esc(t("logs")) + '</div><ul>' + logs + "</ul></div>" : "") + "</li>";
    });
    sites.forEach(function (s) {
      if (seen[String(s.label).toLowerCase()]) return;
      rows.push('<li class="ma-site"><div class="ma-sname">' + esc(s.label) + '</div><div class="ma-smeta">' +
        esc([s.address, s.city].filter(Boolean).join(", ")) + "</div>" + dirLink(s) + "</li>");
    });
    return group(t("sites"), '<ul class="ma-list">' + rows.join("") + "</ul>");
  }

  function dayPanel(which) {
    var today = S.data.today;
    var key = which === "today" ? today : addDays(today, 1);
    var d = onDay(key, which === "today");
    var tasks = which === "today" ? ((S.agenda && S.agenda.tasks) || []) : [];
    var html = '<h2 class="ma-ph" tabindex="-1">' + esc(t(which)) + ' <span class="ma-muted">' + esc(dayText(key)) + "</span></h2>" +
      hoursHtml() +
      group(t("events"), list(d.events, itemLine)) +
      group(t("reminders"), list(d.reminders, itemLine)) +
      group(t("todos"), list(d.todos, itemLine)) +
      group(t("shoots"), which === "tomorrow" ? list(d.shoots, taskLine) : "") +
      group(t("tasks"), list(tasks, taskLine)) +
      sitesHtml();
    var empty = !d.events.length && !d.reminders.length && !d.todos.length && !tasks.length && !(which === "tomorrow" && d.shoots.length);
    if (empty) html += '<p class="ma-empty">' + esc(t("nothingDay")) + "</p>";
    if (!S.agenda) html += '<p class="ma-muted ma-small">' + esc(t("loading")) + "</p>";
    return html;
  }

  function weekPanel() {
    var today = S.data.today;
    var events = [];
    var html = '<h2 class="ma-ph" tabindex="-1">' + esc(t("thisWeek")) + "</h2>";
    for (var i = 0; i < 7; i++) {
      var key = addDays(today, i);
      var d = onDay(key, false);
      events = events.concat(d.events);
      var rows = d.events.map(itemLine).concat(d.reminders.map(itemLine)).concat(d.todos.map(itemLine)).concat(d.shoots.map(taskLine));
      html += '<section class="ma-group ma-day"><h3 class="ma-gh">' + esc(dayWord(key)) + (i > 1 ? "" : ' <span class="ma-muted">' + esc(dayText(key)) + "</span>") + "</h3>" +
        (rows.length ? '<ul class="ma-list">' + rows.join("") + "</ul>" : '<p class="ma-muted ma-small">' + esc(t("nothingDay")) + "</p>") + "</section>";
    }
    html += events.length
      ? '<button type="button" class="ma-wide" data-act="week-ics">' + esc(t("addWeek", { n: events.length })) + "</button>"
      : '<p class="ma-muted ma-small">' + esc(t("noWeekEvents")) + "</p>";
    return html;
  }

  function cardHtml(c) {
    if (!c || typeof c !== "object") return "";
    if (c.type === "item") {
      var it = findItem(c.itemId);
      if (!it) return '<div class="ma-card muted">' + esc(t("deleted")) + "</div>";
      return '<div class="ma-card"><ul class="ma-list">' + itemLine(it, { tools: false }) + "</ul>" +
        '<button type="button" class="ma-lbtn" data-act="open-item" data-id="' + esc(it.id) + '">' + esc(t("openItem")) + "</button></div>";
    }
    if (c.type === "email") {
      var href = mailtoUrl(c.to, c.subject, c.body);
      return '<div class="ma-card mail"><div class="ma-ctitle">✉️ ' + esc(t("emailDraft")) + "</div>" +
        (c.to ? '<div class="ma-cfield"><span>' + esc(t("to")) + ":</span> " + esc(c.to) + "</div>" : "") +
        (c.subject ? '<div class="ma-cfield"><span>' + esc(t("subject")) + ":</span> " + esc(c.subject) + "</div>" : "") +
        (c.body ? '<div class="ma-cbody">' + esc(c.body) + "</div>" : "") +
        '<div class="ma-crow"><a class="ma-btn" href="' + esc(href) + '">' + esc(t("openMail")) + "</a>" +
        '<button type="button" class="ma-lbtn" data-act="copy" data-text="' + esc(c.body || "") + '">' + esc(t("copy")) + "</button></div></div>";
    }
    if (c.type === "task" && /^\d{1,10}$/.test(String(c.taskId || ""))) {
      return '<div class="ma-card"><a class="ma-tlink" href="my-tasks.html?task=' + encodeURIComponent(c.taskId) + '">' +
        esc(t("openTask")) + ": " + esc(c.name || "#" + c.taskId) + " ›</a></div>";
    }
    if (c.type === "link" && LINK_RE.test(String(c.href || ""))) {
      return '<div class="ma-card"><a class="ma-tlink" href="' + esc(c.href) + '">' + esc(c.label) + " ›</a></div>";
    }
    return "";
  }

  function msgHtml(m) {
    var who = m.role === "user" ? t("you") : m.role === "office" ? t("office") : t("assistant");
    var cards = (m.cards || []).map(cardHtml).join("");
    var foot = "";
    if (m.role === "user" && m.status === "waiting") {
      foot = '<div class="ma-mstat">' + esc(pcOff() ? t("waitingOffline") : t("thinking")) + "</div>";
    } else if (m.role === "user" && m.status === "failed") {
      foot = '<div class="ma-mstat warn">' + esc(t("failed")) +
        ' <button type="button" class="ma-lbtn" data-act="resend" data-id="' + esc(m.id) + '">' + esc(t("resend")) + "</button></div>";
    }
    return '<li class="ma-msg ' + esc(m.role) + (m.status ? " " + esc(m.status) : "") + '">' +
      '<div class="ma-who">' + esc(who) + (m.at ? " · " + esc(msgTime(m.at)) : "") + "</div>" +
      '<div class="ma-bubble">' + esc(m.text) + "</div>" + cards + foot + "</li>";
  }

  function chatPanel() {
    var chat = (S.data && S.data.chat) || [];
    var waiting = chat.some(function (m) { return m.role === "user" && m.status === "waiting"; });
    return (chat.length ? "" : '<p class="ma-intro">' + esc(t("chatIntro")) + "</p>") +
      '<ol class="ma-chat" aria-label="' + esc(t("tabChat")) + '">' + chat.map(msgHtml).join("") + "</ol>" +
      (waiting && !pcOff() ? '<div class="ma-think" aria-hidden="true"><span></span><span></span><span></span></div>' : "");
  }

  function itemsPanel() {
    var all = items();
    var open = all.filter(function (it) { return !it.done; });
    var missed = open.filter(isMissed).sort(byAt);
    var upcoming = open.filter(function (it) { return it.kind !== "todo" && !isMissed(it); }).sort(byAt);
    var todos = open.filter(function (it) { return it.kind === "todo"; }).sort(byAt);
    var done = all.filter(function (it) { return it.done; }).sort(function (a, b) { return String(b.doneAt).localeCompare(String(a.doneAt)); });
    var html = '<div class="ma-addrow">' +
      '<button type="button" class="ma-add" data-act="add" data-kind="reminder">' + esc(t("addReminder")) + "</button>" +
      '<button type="button" class="ma-add" data-act="add" data-kind="todo">' + esc(t("addTodo")) + "</button>" +
      '<button type="button" class="ma-add" data-act="add" data-kind="event">' + esc(t("addEvent")) + "</button></div>" +
      '<div id="maItemNote" role="status" aria-live="polite"></div>';
    if (!all.length) return html + '<p class="ma-empty">' + esc(t("noItems")) + "</p>";
    html += group(t("comingUp"), list(upcoming, itemLine)) +
      group(t("todos"), list(todos, itemLine)) +
      (missed.length ? group(t("missed"), '<p class="ma-muted ma-small">' + esc(t("missedNote")) + "</p>" + list(missed, itemLine), "missed") : "") +
      (done.length ? '<details class="ma-done"><summary>' + esc(t("doneRecent")) + " (" + done.length + ")</summary>" + list(done, itemLine) + "</details>" : "");
    return html;
  }

  function mePanel() {
    var mem = (S.data && S.data.memory) || [];
    var p = (S.data && S.data.prefs) || {};
    var memList = mem.length
      ? '<ul class="ma-list">' + mem.map(function (n) {
          return '<li class="ma-mem"><span class="ma-memtext">' + esc(n.text) + "</span>" +
            (n.by === "assistant" ? ' <span class="ma-muted ma-small">· ' + esc(t("memBy")) + "</span>" : "") +
            '<button type="button" class="ma-x" data-act="mem-del" data-id="' + esc(n.id) + '" aria-label="' + esc(t("memDelete", { text: n.text })) + '">×</button></li>';
        }).join("") + "</ul>"
      : '<p class="ma-muted">' + esc(t("memNone")) + "</p>";
    var timeSel = function (id, v) {
      return '<input type="time" id="' + id + '" min="' + BRIEF_FROM + '" max="' + BRIEF_TO + '" value="' + esc(v || "18:00") + '" />';
    };
    return '<h2 class="ma-ph" tabindex="-1">' + esc(t("memTitle")) + "</h2>" + memList +
      '<form class="ma-memform" id="maMemForm" novalidate><label class="ma-sr" for="maMemText">' + esc(t("memLabel")) + "</label>" +
        '<input type="text" id="maMemText" maxlength="300" placeholder="' + esc(t("memPlaceholder")) + '" />' +
        '<button type="submit" class="ma-btn">' + esc(t("add")) + "</button></form>" +
      '<h2 class="ma-ph">' + esc(t("settings")) + "</h2>" +
      '<form class="ma-prefs" id="maPrefs" novalidate>' +
        '<div class="ma-pref"><label><input type="checkbox" id="maEvening"' + (p.evening ? " checked" : "") + " /> " + esc(t("evening")) + "</label>" +
          '<span class="ma-at">' + esc(t("at")) + " " + timeSel("maEveningAt", p.eveningAt) + "</span></div>" +
        '<div class="ma-pref"><label><input type="checkbox" id="maWeekly"' + (p.weekly ? " checked" : "") + " /> " + esc(t("weekly")) + "</label>" +
          '<span class="ma-at">' + esc(t("at")) + " " + timeSel("maWeeklyAt", p.weeklyAt) + "</span></div>" +
        '<p class="ma-muted ma-small">' + esc(t("briefWindow")) + "</p>" +
        '<div class="ma-pref"><label for="maLang">' + esc(t("language")) + '</label> <select id="maLang">' +
          '<option value="en"' + (p.language !== "es" ? " selected" : "") + ">English</option>" +
          '<option value="es"' + (p.language === "es" ? " selected" : "") + ">Español</option></select></div>" +
        '<div class="ma-pref"><label><input type="checkbox" id="maEmailCopy"' + (p.emailCopy ? " checked" : "") + " /> " + esc(t("emailCopy")) + "</label></div>" +
        '<div class="ma-prow"><span id="maPrefStatus" class="ma-status" role="status" aria-live="polite"></span>' +
          '<button type="submit" class="ma-btn">' + esc(t("save")) + "</button></div>" +
      "</form>";
  }

  /* ── the office PC's status ──────────────────────────────────────────── */

  /* Offline when its assistant has not polled for messages for 10 minutes,
     the PC has not been seen for 15, or the office paused it. Ages are
     measured against the server's own clock (generatedAt), never the
     phone's. */
  function pcOff() {
    if (!S.data || !S.data.pc) return "";
    var pc = S.data.pc;
    if (pc.paused) return "paused";
    var gen = Date.parse(S.data.generatedAt || "") || Date.now();
    var chat = pc.chatAt ? (gen - Date.parse(pc.chatAt)) / 60000 : Infinity;
    var seen = pc.lastSeen ? (gen - Date.parse(pc.lastSeen)) / 60000 : Infinity;
    return chat > 10 || seen > 15 ? "offline" : "";
  }

  function renderBanner() {
    var box = el("maBanner");
    if (!box) return;
    var off = pcOff();
    box.innerHTML = off
      ? '<div class="ma-banner warn">' + esc(off === "paused" ? t("paused") : t("offline", { ago: agoText(S.data.pc.lastSeen) })) + "</div>"
      : "";
  }

  function renderHeader() {
    el("maTitle").textContent = S.data ? t("hi", { name: S.data.firstName || "" }) : t("title");
    var sub = el("maSub");
    if (!S.data) return;
    var n = S.data.dueToday || 0;
    sub.textContent = dayText(S.data.today) + " · " + (n === 1 ? t("dueTodayOne") : n ? t("dueToday", { n: n }) : t("nothingToday")) +
      (pcOff() ? "" : " · " + t("online"));
  }

  function renderTabs() {
    var nav = el("maTabs");
    nav.hidden = !S.data;
    if (!S.data) return;
    var unread = S.data.unread || 0;
    var labels = { today: "tabToday", tomorrow: "tabTomorrow", week: "tabWeek", chat: "tabChat", items: "tabItems", me: "tabMe" };
    nav.setAttribute("aria-label", t("tabsLabel"));
    nav.innerHTML = PANELS.map(function (p) {
      var badge = p === "chat" && unread ? ' <span class="ma-badge">' + esc(t("unread", { n: unread })) + "</span>" : "";
      return '<button type="button" role="tab" id="tab-' + p + '" aria-controls="' + p + '" aria-selected="' + String(S.panel === p) +
        '" tabindex="' + (S.panel === p ? "0" : "-1") + '" data-tab="' + p + '">' + esc(t(labels[p])) + badge + "</button>";
    }).join("");
  }

  function renderPanels() {
    PANELS.forEach(function (p) {
      var sec = el(p);
      if (sec) sec.hidden = !S.data || S.panel !== p;
    });
    if (!S.data) return;
    el("maToday").innerHTML = dayPanel("today");
    el("maTomorrow").innerHTML = dayPanel("tomorrow");
    el("maWeek").innerHTML = weekPanel();
    renderChat();
    el("maItems").innerHTML = itemsPanel();
    renderMe(false);
    el("maPrivacy").textContent = (S.data.officeReads ? t("privacyOffice") : t("privacyNoOffice")) + " " + t("privacyScope");
    var hint = el("maPushHint");
    if (hint) hint.textContent = t("pushHint");
  }

  function renderChat() {
    if (!S.data) return;
    el("maChat").innerHTML = chatPanel();
    var sug = el("maSuggest");
    if (sug) {
      sug.setAttribute("aria-label", t("suggestLabel"));
      sug.innerHTML = t("suggest").map(function (s) {
        return '<button type="button" data-act="suggest" data-text="' + esc(s) + '">' + esc(s) + "</button>";
      }).join("");
    }
    var ta = el("maText");
    if (ta) { ta.setAttribute("placeholder", t("placeholder")); ta.setAttribute("aria-label", t("chatLabel")); }
    var b = el("maSend");
    if (b && !S.sending) b.textContent = t("send");
  }

  /* The Me panel is drawn again only when what it shows changed: a poll
     must not wipe a note half typed or a setting half changed. */
  function renderMe(force) {
    var sig = JSON.stringify([S.lang, S.data.memory, S.data.prefs]);
    if (!force && sig === S.meSig) return;
    S.meSig = sig;
    el("maMe").innerHTML = mePanel();
  }

  function renderAll() {
    renderHeader();
    renderBanner();
    renderTabs();
    renderPanels();
    document.documentElement.lang = S.lang === "es" ? "es" : "en";
  }

  function renderOff() {
    el("maTitle").textContent = t("title");
    el("maSub").textContent = "";
    el("maTabs").hidden = true;
    PANELS.forEach(function (p) { var s = el(p); if (s) s.hidden = true; });
    el("maBanner").innerHTML = '<div class="ma-empty big"><b>' + esc(serverText(S.off && S.off.message) || t("loadFail")) + "</b></div>";
    /* No Me panel without an assistant: the phone-reminders switch is on
       the home page. */
    var push = el("maPushLink");
    if (push) push.setAttribute("href", "dashboard.html");
  }

  /* ── panels and links ────────────────────────────────────────────────── */

  function setPanel(p, opts) {
    opts = opts || {};
    if (PANELS.indexOf(p) < 0) p = "today";
    S.panel = p;
    if (opts.history !== false) {
      try { history.replaceState(history.state, "", location.pathname + (opts.keepSearch ? location.search : "") + "#" + p); } catch (e) { /* file: */ }
    }
    renderTabs();
    PANELS.forEach(function (x) { var s = el(x); if (s) s.hidden = x !== p; });
    if (p === "chat") { maybeRead(); chatToEnd(); }
    if (opts.focus) { var tab = el("tab-" + p); if (tab) tab.focus(); }
  }

  /* The chat reads from the top down, newest last: opening it, or a new
     answer landing while it is open, brings the newest into view. */
  function chatToEnd() {
    if (S.panel !== "chat" || typeof window.scrollTo !== "function") return;
    setTimeout(function () {
      try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (e) { /* an old browser */ }
    }, 30);
  }

  /* ── talking to the server ───────────────────────────────────────────── */

  function apply(d) {
    if (!d || !d.enabled) {
      S.data = null;
      S.off = d || null;
      return;
    }
    var agenda = d.agenda || S.agenda;
    S.data = d;
    S.agenda = agenda || null;
    S.off = null;
    var lang = d.prefs && d.prefs.language === "es" ? "es" : "en";
    if (lang !== S.lang) { S.lang = lang; S.meSig = ""; }
    store(LANG_KEY + ":" + account(), S.lang);
  }

  function isWaiting() {
    if (!S.data) return false;
    if (S.data.waiting) return true;
    return (S.data.chat || []).some(function (m) { return m.role === "user" && m.status === "waiting"; });
  }

  /* While a message waits: every 5 seconds for two minutes, then every 20 —
     every 3 minutes while the office PC is shown offline (no answer can
     come) — and never while the page is hidden (it asks again when it comes
     back). After 15 minutes it stops and offers Refresh. */
  function schedulePoll() {
    clearTimeout(S.pollTimer);
    S.pollTimer = null;
    if (!isWaiting()) { S.waitSince = 0; showStopped(false); return; }
    if (!S.waitSince) S.waitSince = Date.now();
    if (document.hidden) return;
    var waited = Date.now() - S.waitSince;
    if (waited >= STOP_AFTER_MS) { showStopped(true); return; }
    S.pollTimer = setTimeout(poll, pcOff() ? OFFLINE_MS : waited < FAST_FOR_MS ? FAST_MS : SLOW_MS);
  }

  /* The thinking poll gave up: say so under the chat box, with Refresh. */
  function showStopped(on) {
    if (!!S.pollStopped === on) return;
    S.pollStopped = on;
    var s = el("maStatus");
    if (!s) return;
    s.className = "ma-status";
    s.innerHTML = on ? esc(t("pollStopped")) + ' <button type="button" class="ma-btn" data-act="repoll">' + esc(t("refresh")) + "</button>" : "";
  }

  /* Refresh, or the phone showing the page again: a fresh round of asking. */
  function pollAgain() {
    S.waitSince = Date.now();
    showStopped(false);
    clearTimeout(S.pollTimer);
    poll();
  }

  async function poll() {
    S.pollTimer = null;
    if (!S.data) return;
    try {
      var r = await DCR.api(EP + "&rev=" + encodeURIComponent(S.data.rev));
      if (r && r.unchanged) {
        S.data.pc = r.pc || S.data.pc;
        S.data.waiting = r.waiting || "";
        S.data.unread = r.unread || 0;
        S.data.generatedAt = r.generatedAt || S.data.generatedAt;
        renderBanner();
        renderHeader();
      } else if (r) {
        var had = (S.data.chat || []).length;
        apply(r);
        if (!S.data) { renderOff(); return; }
        renderAll();
        maybeRead();
        if ((S.data.chat || []).length > had) chatToEnd();
      }
    } catch (e) { /* a dropped signal: ask again on the next turn */ }
    schedulePoll();
  }

  /* Answers on screen in the chat are read: the badge goes. Only when there
     is something unread, so opening the page does not write each time. */
  async function maybeRead() {
    if (!S.data || !S.data.unread || S.panel !== "chat" || document.hidden || S.reading) return;
    S.reading = true;
    try {
      var r = await DCR.api(EP, { method: "POST", body: { op: "read" } });
      if (S.data) {
        S.data.unread = 0;
        adoptRev(r);
        renderTabs();
      }
    } catch (e) { /* the badge stays; nothing is lost */ }
    S.reading = false;
  }

  async function post(body) {
    return DCR.api(EP, { method: "POST", body: body });
  }

  /* A write's revision is taken only when it is the very next one. When the
     office PC wrote in between (an answer or a briefing landed since this
     page last read), the old revision stays, so the next poll fetches the
     whole state instead of answering "unchanged" over what was missed. */
  function adoptRev(r) {
    if (S.data && r && r.rev && Number(r.rev) === Number(S.data.rev) + 1) S.data.rev = r.rev;
  }

  function chatStatus(kind, text) {
    var s = el("maStatus");
    if (!s) return;
    S.pollStopped = false;          // (these words replace the Refresh notice)
    s.className = "ma-status" + (kind ? " " + kind : "");
    s.textContent = text || "";
  }

  async function send(textOverride) {
    if (!S.data) return;
    var ta = el("maText");
    var text = String(textOverride !== undefined ? textOverride : ta.value).trim();
    if (!text) { chatStatus("err", t("writeFirst")); ta.focus(); return; }
    if (S.sending) { chatStatus("", t("busy")); return; }
    var d = getDraft();
    var clientId = textOverride === undefined && d && d.clientId && d.sent === text ? d.clientId : newClientId();
    if (textOverride === undefined) setDraft(ta.value, clientId, text);
    S.sending = true;
    var btn = el("maSend");
    btn.disabled = true;
    btn.textContent = t("sending");
    chatStatus("", t("sending"));
    try {
      var r = await post({ op: "say", text: text, clientId: clientId });
      if (textOverride === undefined) {
        var now = ta.value;
        var left = now.indexOf(text) === 0 ? now.slice(text.length).replace(/^\s+/, "") : now.trim() === text ? "" : now;
        ta.value = left;
        setDraft(left, "", "");
      }
      if (r && r.message && S.data) {
        var chat = S.data.chat || (S.data.chat = []);
        if (!chat.some(function (m) { return m.id === r.message.id; })) chat.push(r.message);
        if (!r.already) adoptRev(r);
        if (!S.data.waiting) S.data.waiting = r.message.at;
      }
      chatStatus("ok", t("sent"));
      renderChat();
      chatToEnd();
      S.waitSince = Date.now();
      schedulePoll();
    } catch (e) {
      chatStatus("err", e && e.status ? (serverText(e.message) || t("loadFail")) : t("noSignal"));
    } finally {
      S.sending = false;
      btn.disabled = false;
      btn.textContent = t("send");
    }
  }

  /* An item op from the page; the answer carries the whole list back. */
  async function itemOp(body) {
    if (S.busy) { note("", t("busy")); return null; }
    S.busy = true;
    try {
      var r = await post(body);
      if (r && r.items && S.data) S.data.items = r.items;
      if (r && r.memory && S.data) S.data.memory = r.memory;
      if (r && r.prefs && S.data) S.data.prefs = r.prefs;
      adoptRev(r);
      return r || {};
    } catch (e) {
      note("err", t("notSaved", { why: e && e.status ? serverText(e.message) : t("noSignal") }));
      return null;
    } finally {
      S.busy = false;
    }
  }
  function note(kind, text) {
    var box = el("maItemNote");
    if (box) box.innerHTML = text ? '<div class="ma-note ' + esc(kind || "") + '">' + esc(text) + "</div>" : "";
  }

  /* ── the add / change dialog ─────────────────────────────────────────── */

  function remindOptions() {
    return [
      { value: "", label: t("remindNone") }, { value: "0", label: t("remindAt") },
      { value: "10", label: t("remindMin", { n: 10 }) }, { value: "30", label: t("remindMin", { n: 30 }) },
      { value: "60", label: t("remindHour") }, { value: "120", label: t("remindHours") }, { value: "1440", label: t("remindDay") },
    ];
  }
  function nextHour() {
    var now = (S.data && S.data.now) || "";
    if (!STAMP_RE.test(now)) return { day: (S.data && S.data.today) || "", time: "09:00" };
    var next = plusHour(now.slice(0, 14) + "00");
    return { day: next.slice(0, 10), time: next.slice(11) };
  }

  async function editItem(kind, it) {
    var base = nextHour();
    var at = it && STAMP_RE.test(it.at || "") ? { day: it.at.slice(0, 10), time: it.at.slice(11) } : base;
    var fields;
    if (kind === "todo") {
      fields = [
        { name: "text", label: t("todoWhat"), value: it ? it.text : "" },
        { name: "due", label: t("dueDay"), type: "date", value: it ? it.due : "" },
        { name: "notes", label: t("notes"), type: "textarea", rows: 2, value: it ? it.notes : "" },
      ];
    } else if (kind === "reminder") {
      fields = [
        { name: "text", label: t("what"), value: it ? it.text : "" },
        { name: "day", label: t("day"), type: "date", value: at.day },
        { name: "time", label: t("time"), type: "time", value: at.time },
      ];
    } else {
      fields = [
        { name: "text", label: t("eventTitle"), value: it ? it.text : "" },
        { name: "day", label: t("day"), type: "date", value: at.day },
        { name: "time", label: t("start"), type: "time", value: at.time },
        { name: "end", label: t("end"), type: "time", value: it && STAMP_RE.test(it.end || "") ? it.end.slice(11) : "" },
        { name: "location", label: t("location"), value: it ? it.location : "" },
        { name: "remind", label: t("remindBefore"), type: "select", options: remindOptions(),
          value: it ? (it.remind === null || it.remind === undefined ? "" : String(it.remind)) : "30" },
        { name: "notes", label: t("notes"), type: "textarea", rows: 2, value: it ? it.notes : "" },
      ];
    }
    var v = await DCR.modal({
      title: it ? t("editItem") : t(kind === "todo" ? "newTodo" : kind === "reminder" ? "newReminder" : "newEvent"),
      okText: it ? t("save") : t("add"), cancelText: t("cancel"), fields: fields,
      validate: function (x) {
        var words = String(x.text || "").trim();
        if (!words) return t("needText");
        if (words.length > 300) return t("tooLong");
        if (kind !== "todo") {
          if (!DAY_RE.test(x.day || "")) return t("needDay");
          if (!/^\d{2}:\d{2}$/.test(x.time || "")) return t("needTime");
          if (kind === "event" && x.end && x.end < x.time) return t("endBefore");
        }
        return "";
      },
    });
    if (!v) return;
    var item = { kind: kind, text: String(v.text).trim() };
    if (kind === "todo") { item.due = v.due || ""; item.notes = v.notes || ""; }
    else {
      item.at = v.day + "T" + v.time;
      if (kind === "event") {
        item.end = v.end ? v.day + "T" + v.end : "";
        item.location = v.location || "";
        item.remind = v.remind === "" ? null : Number(v.remind);
        item.notes = v.notes || "";
      }
    }
    var body = it ? { op: "item.update", id: it.id, patch: (function () { var p = Object.assign({}, item); delete p.kind; return p; })() }
      : { op: "item.add", item: item };
    var r = await itemOp(body);
    if (!r) return;
    if (r.item) S.highlight = r.item.id;
    renderAll();
    note("ok", t("saved"));
  }

  /* ── wiring ──────────────────────────────────────────────────────────── */

  async function onAction(b, e) {
    var act = b.getAttribute("data-act");
    var id = b.getAttribute("data-id") || "";
    if (act === "done") {
      var it = findItem(id);
      if (!it) return;
      var r = await itemOp({ op: "item.complete", id: id, done: !!b.checked });
      if (r) renderAll(); else b.checked = !b.checked;
    } else if (act === "edit") {
      var cur = findItem(id);
      if (cur) editItem(cur.kind, cur);
    } else if (act === "delete") {
      var gone = findItem(id);
      if (!gone) return;
      var yes = await DCR.confirm(t("confirmDelete", { text: gone.text }), { danger: true, okText: t("delete"), cancelText: t("cancel") });
      if (!yes) return;
      if (await itemOp({ op: "item.delete", id: id })) renderAll();
    } else if (act === "add") {
      editItem(b.getAttribute("data-kind"), null);
    } else if (act === "ics") {
      var ev = findItem(id);
      if (ev) downloadIcs("dcr-" + ev.id + ".ics", icsCalendar([ev], new Date()));
    } else if (act === "week-ics") {
      var today = S.data.today, last = addDays(today, 6);
      var week = items().filter(function (x) { return x.kind === "event" && !x.done && String(x.at).slice(0, 10) >= today && String(x.at).slice(0, 10) <= last; });
      downloadIcs("dcr-week-" + today + ".ics", icsCalendar(week, new Date()));
    } else if (act === "open-item") {
      S.highlight = id;
      renderPanels();
      setPanel("items");
      var row = el("item-" + id);
      if (row && row.scrollIntoView) row.scrollIntoView({ block: "center" });
    } else if (act === "repoll") {
      pollAgain();
    } else if (act === "resend") {
      var m = ((S.data && S.data.chat) || []).filter(function (x) { return x.id === id; })[0];
      if (m) send(m.text);
    } else if (act === "suggest") {
      var ta = el("maText");
      ta.value = b.getAttribute("data-text") || "";
      setDraft(ta.value, "", "");
      ta.focus();
    } else if (act === "copy") {
      try { await navigator.clipboard.writeText(b.getAttribute("data-text") || ""); b.textContent = t("copied"); } catch (err) { /* no clipboard */ }
    } else if (act === "mem-del") {
      if (await itemOp({ op: "memory.delete", id: id })) renderMe(true);
    }
    if (e && act !== "done") e.preventDefault();
  }

  async function savePrefs() {
    var p = S.data.prefs || {};
    var want = {
      evening: !!el("maEvening").checked, eveningAt: el("maEveningAt").value || p.eveningAt,
      weekly: !!el("maWeekly").checked, weeklyAt: el("maWeeklyAt").value || p.weeklyAt,
      language: el("maLang").value === "es" ? "es" : "en", emailCopy: !!el("maEmailCopy").checked,
    };
    var changed = {};
    Object.keys(want).forEach(function (k) { if (want[k] !== p[k]) changed[k] = want[k]; });
    var st = el("maPrefStatus");
    var outside = [changed.eveningAt, changed.weeklyAt].some(function (v) { return v !== undefined && (v < BRIEF_FROM || v > BRIEF_TO); });
    if (outside) { st.textContent = t("srvBriefTime"); return; }
    if (!Object.keys(changed).length) { st.textContent = t("saved"); return; }
    st.textContent = t("sending");
    var r = await itemOp({ op: "prefs.set", prefs: changed });
    if (!r) { st.textContent = t("notSaved", { why: t("noSignal") }); return; }
    if (changed.language) { S.lang = want.language; store(LANG_KEY + ":" + account(), S.lang); }
    renderAll();
    renderMe(true);
    var st2 = el("maPrefStatus");
    if (st2) st2.textContent = t("saved");
  }

  async function addMemory() {
    var input = el("maMemText");
    var words = String(input.value || "").trim();
    if (!words) { input.focus(); return; }
    if (await itemOp({ op: "memory.add", text: words })) renderMe(true);
  }

  function wire() {
    document.addEventListener("click", function (e) {
      var tab = e.target && e.target.closest ? e.target.closest("[data-tab]") : null;
      if (tab) { setPanel(tab.getAttribute("data-tab")); return; }
      var b = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
      if (b && b.getAttribute("data-act") !== "done") onAction(b, e);
    });
    document.addEventListener("change", function (e) {
      var b = e.target && e.target.getAttribute && e.target.getAttribute("data-act") === "done" ? e.target : null;
      if (b) onAction(b, null);
    });
    document.addEventListener("submit", function (e) {
      var f = e.target;
      if (!f || !f.id) return;
      if (f.id === "maPrefs") { e.preventDefault(); savePrefs(); }
      else if (f.id === "maMemForm") { e.preventDefault(); addMemory(); }
    });
    /* Left and right move between the tabs, the way a tab list works. */
    el("maTabs").addEventListener("keydown", function (e) {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      var i = PANELS.indexOf(S.panel) + (e.key === "ArrowRight" ? 1 : -1);
      setPanel(PANELS[(i + PANELS.length) % PANELS.length], { focus: true });
      e.preventDefault();
    });
    var ta = el("maText");
    var timer = null;
    ta.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var d = getDraft();
        setDraft(ta.value, d && d.sent === ta.value.trim() ? d.clientId : (d && d.clientId) || "", (d && d.sent) || "");
      }, 350);
    });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    });
    el("maForm").addEventListener("submit", function (e) { e.preventDefault(); send(); });
    window.addEventListener("hashchange", function () {
      var h = String(location.hash || "").slice(1);
      if (S.data && PANELS.indexOf(h) >= 0 && h !== S.panel) setPanel(h, { history: false });
    });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      if (isWaiting()) pollAgain();
      maybeRead();
    });
  }

  async function loadAll() {
    var d = await DCR.api(EP + "&agenda=1");
    apply(d);
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("userPill").textContent = (profile.displayName || profile.email || "") + " · " + (profile.role || "");
    var saved = read(LANG_KEY + ":" + account());
    if (saved === "es" || saved === "en") S.lang = saved;
    el("maTitle").textContent = t("title");
    el("maSub").textContent = t("loading");
    wire();
    var draft = getDraft();
    if (draft && draft.t) { el("maText").value = draft.t; chatStatus("", t("draftRestored")); }
    try {
      await loadAll();
    } catch (e) {
      el("maSub").textContent = "";
      el("maBanner").innerHTML = '<div class="ma-empty big"><b>' + esc(e && e.status ? t("loadFail") : t("offlineLoad")) + "</b>" +
        (e && e.status && e.message ? "<span>" + esc(serverText(e.message)) + "</span>" : "") +
        '<button type="button" class="ma-btn" id="maRetry">' + esc(t("tryAgain")) + "</button></div>";
      el("maRetry").onclick = function () { location.reload(); };
      return;
    }
    if (!S.data) { renderOff(); return; }
    var q = new URLSearchParams(location.search);
    var want = q.get("item");
    var hash = String(location.hash || "").slice(1);
    S.panel = PANELS.indexOf(hash) >= 0 ? hash : S.data.unread ? "chat" : "today";
    if (want) {
      S.panel = "items";
      if (findItem(want)) S.highlight = want;
    }
    renderAll();
    setPanel(S.panel);
    /* A link with #tomorrow lands on that tab, from the top — not wherever
       the browser's jump to the anchor left it. */
    if (!want && S.panel !== "chat" && typeof window.scrollTo === "function") {
      setTimeout(function () { try { window.scrollTo(0, 0); } catch (e) { /* an old browser */ } }, 0);
    }
    if (want) {
      note(findItem(want) ? "ok" : "warn", findItem(want) ? t("itemOpened") : t("itemMissing"));
      var row = el("item-" + want);
      if (row && row.scrollIntoView) setTimeout(function () { row.scrollIntoView({ block: "center" }); }, 50);
    }
    schedulePoll();
  });

  /* The pure pieces, for the page's tests. */
  window.DCRMyAssistant = {
    icsEscape: icsEscape, icsFold: icsFold, icsCalendar: icsCalendar, mailtoUrl: mailtoUrl, strings: T,
    state: function () { return S; },
  };
})();
