/* The accountant's home screen.

   The books live in QuickBooks Online. This screen's only job is to make the
   handover reliable: what is ready to enter, what is already in, and what is
   stuck and on whom — so nothing is entered twice and nothing is missed.

   Every decision is the server's. This selects rows and shows what came back. */
(function () {
  "use strict";
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var state = { d: null, picked: {}, openCheck: null, detail: null, tell: {} };

  function money(v) {
    return "$" + (Number(v) || 0).toLocaleString("en-US",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function day(v) {
    var s = String(v || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
    var d = new Date(s + "T12:00:00Z");
    return isNaN(d) ? s : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  function lateText(n) {
    if (n === null || n === undefined || n <= 0) return "";
    return n === 1 ? "1 day late" : n + " days late";
  }

  function cardsHtml(t) {
    var c = [
      ["Ready to enter", money(t.readyAmount),
        t.readyCount + (t.readyCount === 1 ? " bill" : " bills"), t.readyCount ? "go" : ""],
      ["Overdue among them", money(t.overdueAmount),
        t.overdueCount + " past due", t.overdueCount ? "late" : ""],
      ["Waiting on approval", money(t.waitingAmount),
        t.waitingCount + " not yours to action", t.waitingCount ? "wait" : ""],
      ["Money in to enter", money(t.arReadyAmount),
        t.arReadyCount + (t.arReadyCount === 1 ? " invoice" : " invoices"), ""],
    ];
    return c.map(function (x) {
      return '<div class="ac-card' + (x[3] ? " " + x[3] : "") + '">' +
        '<div class="k">' + esc(x[0]) + "</div>" +
        '<div class="v">' + esc(x[1]) + "</div>" +
        '<div class="n">' + esc(x[2]) + "</div></div>";
    }).join("");
  }

  /* ── the picture ────────────────────────────────────────────────────────

     The tiles say what the numbers are. The picture says where the money is
     standing and whose move it is, which is the question she opens the screen
     to ask. Both are drawn from the same payload and neither computes a figure
     the other does not have — two pictures of one truth, never two truths.

     It is drawn as two bands, not one pipeline, because a bill can be keyed
     into QuickBooks before it is paid and was, last month. Money leaving the
     door and keying the books are two errands that happen to share a row. */
  var VIEW_KEY = "dcr_books_view";
  function view() {
    // A blocked or cleared store is not an error; the picture is the default.
    try { return localStorage.getItem(VIEW_KEY) === "cards" ? "cards" : "picture"; }
    catch (e) { return "picture"; }
  }
  function setView(v) { try { localStorage.setItem(VIEW_KEY, v); } catch (e) { /* fine */ } }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  /* Whole days from today to a due date, both as YYYY-MM-DD. Negative is late.
     Done in UTC noon like day() so a timezone cannot move a due date a day. */
  function daysUntil(due, todayKey) {
    var a = String(due || "").slice(0, 10), b = String(todayKey || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
    var at = function (k) { return Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)); };
    return Math.round((at(a) - at(b)) / 86400000);
  }

  function stageHtml(s, top) {
    var has = s.count > 0;
    var cls = !has ? "idle" : s.mine ? "mine" : s.theirs ? "theirs" : s.done ? "done" : "";
    var pct = has && top > 0 && s.amount ? Math.max(4, Math.round((s.amount / top) * 100)) : 0;
    return '<button type="button" class="bk-st ' + cls + '"' +
      (has ? ' data-jump="' + esc(s.to) + '"' : " disabled") +
      ' aria-label="' + esc(s.label + ": " + s.big + ", " + s.sub + (s.who ? ". " + s.who : "")) + '">' +
      (has && s.step ? '<span class="bk-step">Step ' + s.step + "</span>" : "") +
      '<span class="k">' + esc(s.label) + "</span>" +
      '<span class="v">' + esc(s.big) + "</span>" +
      '<span class="n">' + esc(s.sub) + "</span>" +
      (has && s.flag ? '<span class="flag">' + esc(s.flag) + "</span>" : "") +
      (has && s.chips && s.chips.length
        ? '<span class="bk-chips">' + s.chips.map(function (c) {
            return '<span class="bk-chip ' + esc(c[0]) + '">' + esc(c[1]) + "</span>";
          }).join("") + "</span>"
        : "") +
      (pct ? '<span class="bar"><i style="width:' + pct + '%"></i></span>' : "") +
      (has && s.who ? '<span class="bk-who">' + esc(s.who) + "</span>" : "") +
      "</button>";
  }

  /* `seps` is what goes BETWEEN the boxes, and it is not decoration: an arrow
     is a claim that one thing follows the other. Bills and invoices to key are
     two inputs to the same errand, not a sequence, so they are joined by a
     plus. Draw it wrong and the picture teaches something false. */
  function band(title, caption, total, stages, extra, seps) {
    var top = stages.reduce(function (n, s) {
      return s.count && s.amount > n ? s.amount : n;
    }, 0);
    var flow = "";
    stages.forEach(function (s, i) {
      if (i) {
        flow += '<span class="bk-arrow" aria-hidden="true">' +
          ((seps && seps[i - 1]) || "&rarr;") + "</span>";
      }
      flow += stageHtml(s, top);
    });
    return '<div class="bk-band"><div class="bk-bh"><h4>' + esc(title) + "</h4>" +
      '<span class="cap">' + esc(caption) + "</span>" +
      (total ? '<span class="tot">' + esc(total) + "</span>" : "") + "</div>" +
      '<div class="bk-flow">' + flow + "</div>" + (extra || "") + "</div>";
  }

  /* The bills that are approved and still cannot be paid.

     Deliberately NOT a box in the chain: a bill only lands here when somebody
     skipped a step, so it is not a stage every bill passes through, and drawing
     it as one would say it was. A strip across the flow is also harder to miss
     than a fourth small box, which is the point — this pile is the one that
     silently goes nowhere. */
  function heldHtml(c, step) {
    if (!c.toDecideCount) return "";
    return '<button type="button" class="bk-held" data-jump="secDecide">' +
      '<span class="w">Held up</span>' +
      "<span>" + esc(plural(c.toDecideCount, "approved bill", "approved bills")) + " — " +
        money(c.toDecideAmount) + " — cannot be paid: nobody recorded check or cash. " +
        "A manager or admin sets it on the bill.</span>" +
      (step ? '<span class="st">Step ' + step + "</span>" : "") +
      '<span class="go">Show me &rarr;</span></button>';
  }

  /* NOT DRAWN HERE: the bill checkCap refuses for having no frozen
     ApprovedAmount. It is approved, it is owed, and deskChecks builds no row
     for it, so it is in neither queue and no box on this band knows about it.

     A strip announcing it was written and taken back out. Scoped to d.ready it
     disappeared the moment the bill was keyed into QuickBooks — and then the
     all-clear printed over it, which is worse than never drawing it. Counting
     its gross ExpenseAmount it accused a bill already paid in full of being an
     unpayable debt. Sitting in the band total but not in the aging set it
     re-created the contradiction the aging line had just been widened to kill.

     So this band claims only what it draws: the header and the aging line both
     say "approved and still owed" and both mean exactly toPay + toDecide. The
     bill is still listed, with its money, under "Ready to enter in QuickBooks".
     Showing it properly means reading d.payments to net off what is settled and
     covering d.entered as well as d.ready — worth doing, and worth doing on its
     own rather than as a fourth population bolted onto a drawing. */

  /* How late the money already is.

     Built from the due dates on the very rows in the queues below, so the bar
     and the tables cannot disagree with each other.

     It covers everything APPROVED and still owed — the "to pay" queue and the
     held-up pile both. Scoping it to "to pay" alone let it print "Nothing you
     owe is past due yet" directly underneath a strip announcing $50,000 of
     approved bills, one of them forty days late, because those sit in the
     other pile. The sentence now names the set it is talking about, so it
     cannot be read as covering money it never looked at. */
  var AGE = [
    ["late", "Already past due"], ["soon", "Due within 7 days"],
    ["later", "Later"], ["undated", "No due date"],
  ];
  function agingHtml(rows, todayKey) {
    var b = { late: { n: 0, amt: 0 }, soon: { n: 0, amt: 0 },
              later: { n: 0, amt: 0 }, undated: { n: 0, amt: 0 } };
    rows.forEach(function (r) {
      var n = daysUntil(r.expenseDueDate, todayKey);
      var k = n === null ? "undated" : n < 0 ? "late" : n <= 7 ? "soon" : "later";
      b[k].n += 1;
      b[k].amt += Number(r.owed) || 0;
    });
    var total = AGE.reduce(function (n, a) { return n + b[a[0]].amt; }, 0);
    if (!total) return "";
    var line = b.late.amt
      ? "<b class=\"late\">" + money(b.late.amt) + "</b> of the " + money(total) +
        " approved and still owed is already past due."
      : "Nothing approved and still owed is past due yet.";
    return '<div class="bk-age"><div class="ln">' + line + "</div>" +
      '<div class="bk-agebar" role="img" aria-label="' +
        esc(AGE.map(function (a) { return b[a[0]].n + " " + a[1].toLowerCase(); }).join(", ")) + '">' +
      AGE.map(function (a) {
        var w = (b[a[0]].amt / total) * 100;
        return w > 0 ? '<span class="' + a[0] + '" style="width:' + w + '%"></span>' : "";
      }).join("") + "</div>" +
      '<div class="bk-legend">' + AGE.map(function (a) {
        return b[a[0]].n
          ? '<span><i class="' + a[0] + '"></i>' + esc(a[1]) + " — " +
            esc(plural(b[a[0]].n, "bill", "bills")) + ", " + money(b[a[0]].amt) + "</span>"
          : "";
      }).join("") + "</div></div>";
  }

  /* The step numbers come from the server's own to-do list, so the picture and
     the list underneath it can never disagree about what comes first. */
  var STAGE_OF = { check: "pay", cash: "pay", either: "pay", tell: "tell",
                   waiting: "decide", qbo: "qbo" };

  function picture(d) {
    var t = d.totals || {};
    var c = (d.checks && d.checks.totals) || {};
    var can = d.can || {};
    var step = {}, n = 0;
    (d.todo || []).forEach(function (x) {
      var s = STAGE_OF[x.kind];
      if (s && !step[s]) step[s] = ++n;
    });

    /* Exactly what the "Not ready — and who it is on" section lists: bills
       waiting on an approval AND bills blocked for some other reason. Counting
       both but totalling only one of them is how a box comes to say
       "2 bills, $3,400" when the two bills are worth $5,000. */
    var stuck = (d.waiting || []).concat(d.blocked || []);
    var stuckAmount = stuck.reduce(function (n, b) {
      return n + (Number(b.expenseAmount) || 0);
    }, 0);
    var chips = [];
    if (c.checkCount) chips.push(["check", plural(c.checkCount, "check", "checks")]);
    if (c.cashCount) chips.push(["cash", c.cashCount + " cash"]);
    if (c.eitherCount) chips.push(["either", c.eitherCount + " either"]);

    var out = [
      { to: "secWaiting", label: "Not ready", step: 0, theirs: true,
        count: stuck.length, amount: stuckAmount,
        big: money(stuckAmount), sub: plural(stuck.length, "bill", "bills"),
        flag: t.blockedCount
          ? plural(t.blockedCount, "bill needs", "bills need") + " paperwork first"
          : "",
        who: "with a manager" },
      { to: "secPay", label: "To pay", step: step.pay, mine: !!can.pay,
        count: c.toPayCount || 0, amount: c.toPayAmount || 0,
        big: money(c.toPayAmount), sub: plural(c.toPayCount || 0, "bill", "bills"),
        chips: chips, who: can.pay ? "yours to do" : "needs the payments permission" },
      { to: "secTell", label: "Paid — tell them to collect", step: step.tell,
        mine: !!can.pay, count: c.toTellCount || 0, amount: c.toTellAmount || 0,
        big: money(c.toTellAmount), sub: plural(c.toTellCount || 0, "payment", "payments"),
        who: can.pay ? "yours to do" : "needs the payments permission" },
    ];

    /* Bills flow; invoices do not.

       "On the books" is desk.totals.enteredCount, and the only thing in this
       whole repo that writes the entered marker writes it on the Expenses
       list. Nothing can mark an invoice keyed. So an arrow from the invoices
       box into that count would assert a flow that cannot happen, and a step
       number on it would promise a task that can never be ticked off. The
       invoices box therefore sits to one side, joined by a dot rather than an
       arrow, and the band caption says why. */
    var books = [
      { to: "secQbo", label: "Bills to key in", step: step.qbo, mine: !!can.mark,
        count: t.readyCount || 0, amount: t.readyAmount || 0,
        big: money(t.readyAmount), sub: plural(t.readyCount || 0, "bill", "bills"),
        who: can.mark ? "yours to do" : "read only",
        flag: t.overdueCount ? t.overdueCount + " past due · " + money(t.overdueAmount) : "" },
      { to: "secEntered", label: "Bills on the books", step: 0, done: true,
        count: t.enteredCount || 0, amount: 0,
        big: String(t.enteredCount || 0), sub: plural(t.enteredCount || 0, "bill keyed", "bills keyed"),
        who: "done" },
      { to: "secAr", label: "Invoices we sent", step: 0, mine: false,
        count: t.arReadyCount || 0, amount: t.arReadyAmount || 0,
        big: money(t.arReadyAmount), sub: plural(t.arReadyCount || 0, "invoice", "invoices"),
        who: "key by hand" },
    ];

    /* One set, one name, used by the header and by the aging line underneath
       it — so the two cannot describe different money in the same breath.
       "Approved and still owed" is exactly the two queues: waiting-on-approval
       money is not owed yet and keeps to its own box. */
    var owed = ((d.checks && d.checks.toPay) || []).concat((d.checks && d.checks.toDecide) || []);
    var owedOut = (c.toPayAmount || 0) + (c.toDecideAmount || 0);

    var h = '<div class="bk">' +
      band("Money out the door", "Left to right, what happens to a bill.",
        owedOut ? money(owedOut) + " approved and still owed" : "", out,
        heldHtml(c, step.decide) + agingHtml(owed, d.today)) +
      band("Into QuickBooks",
        "Keying, not money — a bill can be keyed before it is paid. Bills get a done " +
        "marker; invoices have none, so the portal cannot tell you which of those are keyed.",
        "", books, "", ["→", "·"]);

    /* The all-clear names the work, rather than asking the boxes whether any of
       them is non-zero.

       Read off the boxes it was wrong twice over. "Bills on the books" is a
       finished pile that only grows, so it suppressed the line forever. So does
       "Invoices we sent": nothing in the repo writes the entered marker to an
       invoice, so that count never falls either. Both are excluded here BY
       NAME, and the sentence says "no bill", which is the claim this list
       actually supports — what has been done with the invoices we sent is not
       something the portal knows. */
    var nothingDoing = !stuck.length && !c.toPayCount && !c.toDecideCount &&
      !c.toTellCount && !(t.readyCount || 0);
    if (nothingDoing) {
      h += '<div class="bk-quiet">Nothing anywhere. No bill is waiting on anybody.</div>';
    }
    return h + '<div class="bk-foot"><b>Blue</b> is yours to do. <b>Gold</b> is waiting on a ' +
      "manager and is not yours to action. Click any box to jump to it.</div></div>";
  }

  /* One slot, two ways of filling it. Not both at once: the picture already
     carries all four tile figures, and two copies of a number on one screen is
     two places for it to be wrong. */
  /* Which button looks pressed. Separate from drawing, because after a failed
     reload there is nothing to draw but the buttons still have to tell the
     truth about which view is selected — otherwise she clicks "Numbers",
     nothing happens, "Picture" stays lit, and the control looks broken. */
  function paintView() {
    var group = el("acView");
    if (!group) return;
    var as = view();
    group.querySelectorAll("[data-view]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-view") === as ? "true" : "false");
    });
  }

  function summary(d) {
    var box = el("acCards"), as = view();
    /* The picture brings its own .bk panel; giving the slot one too drew a
       bordered card inside an identical bordered card. */
    box.className = as === "picture" ? "" : "ac-cards";
    box.innerHTML = as === "picture" ? picture(d) : cardsHtml(d.totals);
    paintView();
    box.querySelectorAll("[data-jump]").forEach(function (b) {
      b.onclick = function () { jump(b.getAttribute("data-jump")); };
    });
  }

  /* Scrolled to AND marked. A section that merely arrives on screen is one she
     then has to find again with her eyes.

     The mark waits for the scrolling to stop. A smooth scroll of three thousand
     pixels outlasts a one-second flash, so marking it on the way out means she
     arrives at a section that has already finished announcing itself. */
  function jump(id) {
    var s = el(id);
    if (!s) return;
    var easy = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    s.scrollIntoView({ behavior: easy ? "auto" : "smooth", block: "start" });
    var last = null, tries = 0;
    (function settle() {
      var y = Math.round(window.scrollY);
      if (y === last || ++tries > 40) {       // two equal samples, or ~2.5s
        s.classList.remove("ac-flash");
        void s.offsetWidth;                   // restart the animation
        s.classList.add("ac-flash");
        return;
      }
      last = y;
      setTimeout(settle, 60);
    })();
  }

  function billRow(b, opts) {
    opts = opts || {};
    var late = lateText(b.lateBy);
    return "<tr>" +
      (opts.pick
        ? '<td><input type="checkbox" data-pick="' + esc(b.id) + '"' +
          (state.picked[b.id] ? " checked" : "") + "></td>"
        : "") +
      "<td>" +
        '<span class="who">' + esc(b.expenseVendorCompany || b.expenseVendorName || "(no vendor)") + "</span>" +
        (b.expenseInvoiceNumber ? ' <span class="meta">#' + esc(b.expenseInvoiceNumber) + "</span>" : "") +
        '<div class="meta">' + esc(b.projectLabel || "(no job)") +
          (b.expenseDueDate ? " · due " + esc(day(b.expenseDueDate)) : "") + "</div>" +
        (late ? '<span class="late">' + esc(late) + "</span>" : "") +
        (opts.reason && b.reason ? '<div class="reason">' + esc(b.reason) + "</div>" : "") +
        (opts.entered
          ? '<div class="meta">entered ' + esc(day(b.qboEnteredDate)) +
            (b.qboEnteredBy ? " by " + esc(b.qboEnteredBy) : "") +
            (b.qboRef ? " · " + esc(b.qboRef) : "") + "</div>"
          : "") +
      "</td>" +
      '<td class="num">' + money(b.expenseAmount) + "</td>" +
      '<td class="num"><a href="bill.html?id=' + encodeURIComponent(b.id) +
        "&project=" + encodeURIComponent(b.projectID) + '">Open &rarr;</a></td>' +
      (opts.entered
        ? '<td class="num"><a href="#" data-undo="' + esc(b.id) + '">Undo</a></td>'
        : "") +
      "</tr>";
  }

  function table(rows, head, render) {
    return '<table class="ac-t"><thead><tr>' +
      head.map(function (h) {
        return '<th' + (h[1] ? ' class="num"' : "") + ">" + esc(h[0]) + "</th>";
      }).join("") + "</tr></thead><tbody>" +
      rows.map(render).join("") + "</tbody></table>";
  }

  /* ── checks ──────────────────────────────────────────────────────────────

     Above QuickBooks on purpose. Both sections are about somebody waiting on
     money; entering a bill in the books is about a keystroke. */
  /* One renderer, three piles. What separates them is what the approver
     authorised — check, cash, or nothing yet — and that is a fact about the
     bill, not a different kind of screen. */
  var PILES = {
    pay: {
      key: "toPay", title: "Bills to pay",
      hint: "Approved and still owed. Each row says how it was authorised \u2014 open it to " +
        "see the invoice and record the payment.",
      empty: "Nothing owed. Every approved bill has been paid.",
      act: "Pay",
    },
    decide: {
      key: "toDecide", title: "Approved — but nobody said how to pay",
      hint: "These were approved before a payment method was recorded, or the approver skipped it. " +
        "A manager or admin sets it on the bill; it is not yours to choose.",
      empty: "",
      act: "Open",
    },
  };

  var METHOD_CHIP = {
    check: ["check", "check"],
    cash: ["cash", "cash"],
    both: ["either", "check or cash"],
  };
  function methodChip(m) {
    var x = METHOD_CHIP[m];
    if (!x) return '<span class="ck-method none">not set</span>';
    return '<span class="ck-method ' + esc(x[0]) + '">' + esc(x[1]) + "</span>";
  }

  function pile(c, can, which) {
    var P = PILES[which];
    var rows = c[P.key] || [];
    var count = rows.length;
    var amount = rows.reduce(function (n, b) { return n + (Number(b.owed) || 0); }, 0);

    if (!count && which === "decide") return "";      // silent when there is nothing wrong

    var h = '<div class="ac-sec" id="sec' + (which === "pay" ? "Pay" : "Decide") +
      '"><header><h3>' + esc(P.title) + "</h3>" +
      '<span class="hint">' + esc(P.hint) + '</span><span class="grow"></span>' +
      '<span class="hint">' + count + " waiting · " + money(amount) + "</span></header>";

    if (!count) {
      h += '<div class="ac-none">' + esc(P.empty) + "</div></div>";
      return h;
    }
    if (!can.pay && which !== "decide") {
      h += '<div class="ac-note">These are approved and waiting to be paid, but your account ' +
        "cannot record payments. Ask an admin for the payments permission.</div>";
    }
    h += '<table class="ac-t"><thead><tr><th>Pay to</th><th>How</th>' +
      '<th class="num">Amount</th><th class="num"></th></tr></thead><tbody>';
    rows.forEach(function (b) {
      var open = String(state.openCheck) === String(b.id);
      h += '<tr class="ck-row" data-open="' + esc(b.id) + '">' +
        '<td><div class="ck-payee">' + esc(b.payee || "(no payee on file)") + "</div>" +
        '<div class="ck-for">' + esc(b.memo || b.projectLabel || "") +
          (b.partial ? '<span class="ck-part">part paid</span>' : "") + "</div></td>" +
        "<td>" + methodChip(b.payMethod) + "</td>" +
        '<td class="num"><b>' + money(b.owed) + "</b>" +
          (b.partial ? '<div class="ck-for">of ' + money(b.approvedFor) + "</div>" : "") + "</td>" +
        '<td class="num">' + (open ? "Close" : esc(P.act) + " &rarr;") + "</td></tr>";
      if (open) h += '<tr><td colspan="4">' + checkPanel(b, can, which) + "</td></tr>";
    });
    h += "</tbody></table></div>";
    return h;
  }

  /* The panel: what to write on the check, and everything it is written against. */
  function checkPanel(b, can, which) {
    var undecided = which === "decide";
    var d = state.detail;
    if (!d || String(d.bill.id) !== String(b.id)) {
      return '<div class="ck-panel"><div class="ac-none">Loading the paperwork…</div></div>';
    }
    var c = d.check;
    var h = '<div class="ck-panel">';
    if (!c.canWrite) return h + '<div class="ac-note">' + esc(c.reason) + "</div></div>";
    if (undecided) {
      return h + '<div class="ac-note">This bill was approved for ' + money(c.max) +
        ", but nobody recorded whether to pay it by check or in cash. A manager or admin " +
        "sets that on the bill — it is an authorisation, not a bookkeeping choice." +
        '</div><div class="ck-acts"><a class="ac-b" href="bill.html?id=' +
        encodeURIComponent(d.bill.id) + "&project=" + encodeURIComponent(d.bill.projectID) +
        '">Open the bill &rarr;</a>' +
        '<button class="ac-b" id="ckClose">Close</button></div></div>';
    }

    h += '<div class="ck-grid">' +
      '<div class="ck-f"><label>Make the check out to</label>' +
        '<input id="ckPayee" class="big" value="' + esc(c.payee) + '" maxlength="120">' +
        (c.payeeNote
          ? '<div class="sub warn">' + esc(c.payeeNote) + "</div>"
          : (c.payeePerson && c.payeePerson !== c.payee
              ? '<div class="sub">Their invoice was sent by ' + esc(c.payeePerson) + ".</div>"
              : "")) +
      "</div>" +
      '<div class="ck-f"><label>Amount</label>' +
        '<input id="ckAmount" class="big" inputmode="decimal" value="' + esc(c.max.toFixed(2)) + '">' +
        '<div class="sub">' + (c.alreadyPaid > 0
          ? money(c.alreadyPaid) + " already paid of " + money(c.approvedFor) + " approved."
          : "Approved for " + money(c.approvedFor) + ".") + "</div>" +
      "</div>" +
      '<div class="ck-f"><label id="ckRefLab">Check number</label>' +
        '<input id="ckNumber" placeholder="e.g. 2041" maxlength="40">' +
        '<div class="sub" id="ckRefSub">So it can be found again.</div>' +
      "</div></div>" +
      /* Where the approver said "either", the accountant says which — and may
         say it twice, because a bill can be settled part cash, part check. The
         payment row is what records where the money actually went. */
      (c.allowed && c.allowed.length > 1
        ? '<div class="ck-f" style="margin-bottom:14px"><label>How are you paying this one?</label>' +
          '<div class="ck-methods" id="ckHow">' +
          c.allowed.map(function (m) {
            return '<button type="button" class="ck-mbtn" data-how="' + esc(m) + '"' +
              ' aria-pressed="false">' + (m === "cash" ? "In cash" : "By check") + "</button>";
          }).join("") + "</div>" +
          '<div class="sub">Approved either way. Pay part of it now and the rest the other ' +
          "way if that suits — each payment is recorded separately.</div></div>"
        : '<input type="hidden" id="ckHowFixed" value="' +
          esc((c.allowed && c.allowed[0]) || "check") + '">') +
      '<div class="ck-f" style="margin-bottom:14px"><label>Memo — what the payment is for</label>' +
        '<input id="ckMemo" value="' + esc(c.memo) + '" maxlength="' + esc(c.memoMax) + '"></div>';

    h += '<div class="ck-docs"><h4>What you are paying against</h4>';
    if (d.commitment) {
      h += '<div class="ck-commit' + (d.commitment.sure ? "" : " guess") + '">' +
        "<b>" + esc(d.commitment.kind) + "</b> — " + esc(d.commitment.vendor) +
        (d.commitment.amount ? " · " + money(d.commitment.amount) : "") +
        (d.commitment.status ? " · " + esc(d.commitment.status) : "") +
        '<div class="ck-for">' + esc(d.commitment.note) + "</div></div>";
    }
    if (d.submission) {
      h += '<div class="ck-doc"><span class="nm">Signed submission ' +
        esc(d.submission.reference) + '</span><span class="tag">signed by ' +
        esc(d.submission.signedBy || d.submission.contactName) + "</span></div>";
    }
    (d.documents.files || []).forEach(function (f) {
      var tag = f.label || (f.match === "loose" ? "found by name — may be another bill's" : "");
      h += '<div class="ck-doc"><span class="nm">' + esc(f.name) + "</span>" +
        (tag ? '<span class="tag' + (f.match === "loose" ? " guess" : "") + '">' + esc(tag) + "</span>" : "") +
        "</div>";
    });
    (d.documents.links || []).forEach(function (l) {
      h += '<div class="ck-doc"><a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' +
        esc(l.label) + '</a><span class="tag">' + esc(l.why) + "</span></div>";
    });
    if (!(d.documents.files || []).length) {
      h += '<div class="ck-none-note">No files are attached to this bill.</div>';
    }
    (d.documents.notes || []).forEach(function (n) {
      h += '<div class="ck-none-note">' + esc(n) + "</div>";
    });
    /* On the page, not a link away from it. Deciding whether to pay something
       means looking at the invoice, and a screen that sends her elsewhere to do
       that is a screen she leaves. */
    var files = (d.documents.files || []);
    if (files.length) {
      h += '<div class="ck-doctabs">' + files.map(function (f, i) {
        return '<button type="button" class="ck-dtab" data-doc="' + i + '"' +
          ' aria-pressed="' + (i === 0 ? "true" : "false") + '">' +
          esc(f.label || f.name) + "</button>";
      }).join("") + "</div>" +
        '<div class="ck-viewer" id="ckViewer">Loading the invoice…</div>';
    }
    h += '<div style="margin-top:10px"><a class="ac-b" href="bill.html?id=' +
      encodeURIComponent(d.bill.id) + "&project=" + encodeURIComponent(d.bill.projectID) +
      '">Open the full bill screen &rarr;</a></div></div>';

    if (d.written && d.written.length) {
      var paid = d.written.reduce(function (n, w) { return n + (Number(w.amount) || 0); }, 0);
      h += '<div class="ck-docs"><h4>Already paid on this bill</h4>';
      d.written.forEach(function (w) {
        var isCash = String(w.method || "").toLowerCase() === "cash";
        h += '<div class="ck-doc"><span class="nm">' +
          (isCash ? "Cash" : "Check #" + esc(w.checkNumber)) + " · " + money(w.amount) +
          "</span>" + methodChip(isCash ? "cash" : "check") +
          '<span class="tag">' + esc(day(w.writtenDate)) +
          (w.toldDate ? " · told " + esc(w.toldHow) + " " + esc(day(w.toldDate)) : " · not told yet") +
          "</span></div>";
      });
      h += '<div class="ck-doc"><span class="nm">' + money(paid) + " paid · " +
        money(c.max) + ' still owed</span></div>';
      h += "</div>";
    }

    h += '<div class="ck-acts">' +
      (can.pay ? '<button class="btn-accept" id="ckWrite">&#10003; ' +
        "Record the payment" + "</button>" : "") +
      '<button class="ac-b" id="ckClose">Close</button>' +
      '<span class="ac-msg" id="ckMsg"></span></div>';
    return h + "</div>";
  }

  /* ── telling them it is ready ─────────────────────────────────────────── */
  function checksToTell(c, can) {
    var h = '<div class="ac-sec" id="secTell"><header><h3>Written — tell them it is ready</h3>' +
      '<span class="hint">The check exists. Nobody has told the subcontractor to come and ' +
      "collect it.</span></header>";
    if (!c.toTell.length) {
      return h + '<div class="ac-none">Everyone with a check waiting has been told.</div></div>';
    }
    c.toTell.forEach(function (t) {
      var k = state.tell[t.paymentId] || {};
      h += '<div class="ck-tell">' +
        '<div class="top"><div><span class="ck-payee">' + esc(t.payee || "(no payee)") + "</span>" +
          '<div class="ck-for">' + (t.isCash
            ? "Cash" + (t.checkNumber ? " · " + esc(t.checkNumber) : "")
            : "Check #" + esc(t.checkNumber)) +
          " · " + esc(day(t.writtenDate)) +
          '<span class="ck-method' + (t.isCash ? " cash" : "") + '">' +
          (t.isCash ? "cash" : "check") + "</span></div></div>" +
        '<div class="ck-payee">' + money(t.amount) + "</div></div>";

      if (!k.loaded) {
        h += '<div class="ck-acts"><button class="ac-b" data-load="' + esc(t.paymentId) +
          '" data-bill="' + esc(t.billId) + '">How do I reach them?</button></div></div>';
        return;
      }
      var w = k.contact || {};
      if (!w.email && !w.phone) {
        h += '<div class="ck-how none">No email or phone on file for them.</div>' +
          '<div class="ck-none-note">The check is written and waiting. Add a contact on the ' +
          "project, or tell them next time they call.</div>";
      } else {
        h += '<div class="ck-how ' +
          (w.source === "submission" ? "certain" : (w.needsConfirming ? "guess" : "")) + '">' +
          esc(w.why || "") + "</div>" +
          '<div class="ck-none-note">' +
            (w.email ? "Email: " + esc(w.email) : "") +
            (w.email && w.phone ? " · " : "") +
            (w.phone ? "Phone: " + esc(w.phone) : "") + "</div>";
      }
      h += '<div class="ck-msg-box">' + esc((k.message && k.message.body) || "") + "</div>" +
        '<div class="ck-acts">';
      if (w.email) {
        h += '<a class="btn-accept" data-mail="' + esc(t.paymentId) + '" href="#">Open the email</a>';
      }
      if (w.phone) {
        h += '<a class="ac-b" href="tel:' + esc(String(w.phone).replace(/[^0-9+]/g, "")) +
          '">Call ' + esc(w.phone) + "</a>";
      }
      h += '<button class="ac-b" data-copy="' + esc(t.paymentId) + '">Copy the message</button>';
      if (can.pay) {
        if (w.email) {
          h += '<button class="ac-b go" data-told="' + esc(t.paymentId) +
            '" data-how="email">&#10003; Told by email</button>';
        }
        if (w.phone) {
          h += '<button class="ac-b go" data-told="' + esc(t.paymentId) +
            '" data-how="phone">&#10003; Told by phone</button>';
        }
        h += '<button class="ac-b go" data-told="' + esc(t.paymentId) +
          '" data-how="in person">&#10003; Told in person</button>';
      }
      h += '<span class="ac-msg" id="tellMsg' + esc(t.paymentId) + '"></span></div>' +
        '<div class="ck-none-note" style="margin-top:6px">The portal cannot send email itself — ' +
        "this opens the message in your own email, already written. Press Send there, then mark " +
        "it here.</div></div>";
    });
    return h + "</div>";
  }

  /* What is waiting on HER, above everything else.

     The tiles underneath answer "what is the state of the books". This answers
     "what do I have to do", which is the question she opens the screen to ask,
     and it was previously something she had to work out by reading four
     sections. One line each, with the money, in the order she would do them. */
  var TODO_ICON = { check: "✎", cash: "◉", either: "◐", tell: "☎", waiting: "⏸", qbo: "⇨" };

  function todoBlock(d) {
    var items = d.todo || [];
    var sp = d.spend;
    var h = '<div class="ac-sec ac-todo"><header><h3>What needs doing</h3>' +
      '<span class="hint">' + (items.length ? "In the order it makes sense to do it."
        : "Nothing is waiting on you right now.") + "</span></header>";

    if (items.length) {
      h += '<ul class="ac-todo-list">' + items.map(function (t) {
        return '<li class="' + esc(t.kind) + '"><span class="ic">' + (TODO_ICON[t.kind] || "•") +
          "</span><span class=\"tx\">" + esc(t.text) + "</span>" +
          '<span class="am">' + money(t.amount) + "</span></li>";
      }).join("") + "</ul>";
    }

    /* One line about spend, and a door to the screen that actually answers it.
       Not a second copy of the ledger: two places for one number is two places
       for it to be wrong. */
    if (sp && sp.count) {
      h += '<div class="ac-glance">Last ' + sp.days + " days: <b>" + money(sp.cost) +
        "</b> across " + sp.count + " purchase" + (sp.count === 1 ? "" : "s") +
        (sp.noReceipt ? ' · <span class="warn">' + sp.noReceipt + " with no receipt</span>" : "") +
        ' · <a href="ledger.html">See all expenses &rarr;</a></div>';
    } else if (sp) {
      h += '<div class="ac-glance">No purchases recorded in the last ' + sp.days +
        ' days. <a href="ledger.html">See all expenses &rarr;</a></div>';
    }
    return h + "</div>";
  }

  function render() {
    var d = state.d, can = d.can || {};
    summary(d);
    var h = "";

    h = todoBlock(d) + h;
    if (d.checks) {
      h += pile(d.checks, can, "pay");
      h += pile(d.checks, can, "decide");
      h += checksToTell(d.checks, can);
    }

    // ── ready to enter ───────────────────────────────────────────────────
    h += '<div class="ac-sec" id="secQbo"><header><h3>Ready to enter in QuickBooks</h3>' +
      '<span class="hint">Approved, with the paperwork behind it.</span>' +
      '<span class="grow"></span>' +
      '<a class="ac-b" id="acCsv">&#8615; Export CSV</a></header>';
    if (!d.ready.length) {
      h += '<div class="ac-none">Nothing waiting to be entered. The books are up to date.</div>';
    } else {
      h += table(d.ready, [["", 0], ["Bill", 0], ["Amount", 1], ["", 1]],
        function (b) { return billRow(b, { pick: true }); });
      if (can.mark) {
        h += '<header style="margin-top:12px">' +
          '<button class="ac-b" id="acAll">Select all</button>' +
          '<input class="ac-ref" id="acRef" placeholder="QuickBooks ref (optional)">' +
          '<button class="ac-b go" id="acMark" disabled>&#10003; Mark entered</button>' +
          '<span class="hint" id="acCount"></span></header>';
      }
      h += '<div class="ac-note"><b>Before you import:</b> QuickBooks Online only imports ' +
        "bills from a spreadsheet on Advanced (Spreadsheet Sync) or through a third-party " +
        "importer — Essentials and Plus have no native bill import, so on those plans this " +
        "file is for keying from, not uploading. Either way, vendor names must already match " +
        "QuickBooks exactly or the import creates duplicates. " +
        "The <b>Portal Bill ID</b> column is how you match a row back here afterwards.</div>";
      h += '<div class="ac-msg" id="acMsg"></div>';
    }
    h += "</div>";

    // ── money in ─────────────────────────────────────────────────────────
    h += '<div class="ac-sec" id="secAr"><header><h3>Money in — invoices we sent</h3>' +
      '<span class="hint">Sent to the client and not yet in the books.</span>' +
      '<span class="grow"></span>' +
      '<a class="ac-b" id="acCsvInv">&#8615; Export CSV</a></header>';
    h += d.ar.ready.length
      ? table(d.ar.ready, [["Invoice", 0], ["Amount", 1], ["Status", 1]], function (iv) {
          return "<tr><td><span class=\"who\">" +
            esc(iv.invoiceClientName || iv.invoiceNumber || "Invoice") + "</span>" +
            (iv.invoiceNumber ? ' <span class="meta">#' + esc(iv.invoiceNumber) + "</span>" : "") +
            '<div class="meta">' + esc(iv.projectLabel || "") +
              (iv.invoiceSentDate ? " · sent " + esc(day(iv.invoiceSentDate)) : "") + "</div></td>" +
            '<td class="num">' + money(iv.invoiceAmount) + "</td>" +
            '<td class="num">' + (iv.invoicePaid ? "Paid" : "Unpaid") + "</td></tr>";
        })
      : '<div class="ac-none">Nothing to enter on the money-in side.</div>';
    h += '<div class="ac-note">QuickBooks Online does import invoices from CSV natively ' +
      "(Settings &rarr; Import data &rarr; Invoices). Customers must exist there first.</div></div>";

    // ── not yours to action ──────────────────────────────────────────────
    if (d.waiting.length || d.blocked.length) {
      h += '<div class="ac-sec" id="secWaiting"><header><h3>Not ready — and who it is on</h3>' +
        '<span class="hint">Nothing here is yours to action; it is here so you are not ' +
        "waiting on it blind.</span></header>";
      var stuck = d.waiting.map(function (b) { return { ...b, reason: "Waiting for a manager or admin to approve it." }; })
        .concat(d.blocked);
      h += table(stuck, [["Bill", 0], ["Amount", 1], ["", 1]],
        function (b) { return billRow(b, { reason: true }); });
      h += "</div>";
    }

    // ── already entered ──────────────────────────────────────────────────
    h += '<div class="ac-sec" id="secEntered"><header><h3>Already entered</h3>' +
      '<span class="hint">' + d.entered.length + " on the books. Undo if you marked one by " +
      "mistake.</span></header>";
    h += d.entered.length
      ? table(d.entered.slice(0, 40), [["Bill", 0], ["Amount", 1], ["", 1], ["", 1]],
          function (b) { return billRow(b, { entered: true }); })
      : '<div class="ac-none">Nothing marked as entered yet.</div>';
    h += "</div>";

    el("acBody").innerHTML = h;
    wire();
  }

  function wire() {
    var box = el("acBody");
    box.querySelectorAll("[data-pick]").forEach(function (cb) {
      cb.onchange = function () {
        var id = cb.getAttribute("data-pick");
        if (cb.checked) state.picked[id] = true; else delete state.picked[id];
        syncPick();
      };
    });
    var all = el("acAll");
    if (all) all.onclick = function () {
      var want = Object.keys(state.picked).length < state.d.ready.length;
      state.picked = {};
      if (want) state.d.ready.forEach(function (b) { state.picked[b.id] = true; });
      box.querySelectorAll("[data-pick]").forEach(function (cb) {
        cb.checked = !!state.picked[cb.getAttribute("data-pick")];
      });
      syncPick();
    };
    var mark = el("acMark");
    if (mark) mark.onclick = doMark;
    box.querySelectorAll("[data-undo]").forEach(function (a) {
      a.onclick = function (e) { e.preventDefault(); doUnmark(a.getAttribute("data-undo")); };
    });
    var csv = el("acCsv");
    if (csv) csv.onclick = function (e) { e.preventDefault(); download("bills"); };
    wireChecks();
    var csvI = el("acCsvInv");
    if (csvI) csvI.onclick = function (e) { e.preventDefault(); download("invoices"); };
    syncPick();
  }

  function syncPick() {
    var n = Object.keys(state.picked).length;
    var mark = el("acMark"), count = el("acCount");
    if (mark) mark.disabled = n === 0;
    if (count) {
      var amt = state.d.ready
        .filter(function (b) { return state.picked[b.id]; })
        .reduce(function (t, b) { return t + (Number(b.expenseAmount) || 0); }, 0);
      count.textContent = n ? n + " selected · " + money(amt) : "";
    }
  }

  /* The export goes through the API with the bearer token, so it cannot be a
     plain link — the file is fetched and handed to the browser as a blob. */
  async function download(which) {
    try {
      var r = await fetch(DCR.API_BASE + "/api/portal?action=accounting&csv=" + which, {
        headers: { Authorization: "Bearer " + DCR.getToken() },
      });
      if (!r.ok) throw new Error("Could not build that export.");
      var text = await r.text();
      // The handler answers JSON when it cannot stream; unwrap either shape.
      if (text.charAt(0) === "{") {
        try { text = JSON.parse(text).csv || text; } catch (e) { /* it was CSV after all */ }
      }
      var url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
      var a = document.createElement("a");
      a.href = url;
      a.download = "dcr-" + which + "-" + state.d.today + ".csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (e) { DCR.alert(e.message || "Could not export that."); }
  }

  async function doMark() {
    var ids = Object.keys(state.picked);
    if (!ids.length) return;
    var amt = state.d.ready.filter(function (b) { return state.picked[b.id]; })
      .reduce(function (t, b) { return t + (Number(b.expenseAmount) || 0); }, 0);
    var sure = await DCR.confirm(
      "Mark " + ids.length + (ids.length === 1 ? " bill" : " bills") + " (" + money(amt) +
      ") as entered in QuickBooks? This records that you have keyed them — it does not " +
      "send anything to Intuit.", { title: "Mark entered", okText: "Mark entered" });
    if (!sure) return;

    var mark = el("acMark"), msg = el("acMsg");
    mark.disabled = true;
    msg.textContent = "Recording…"; msg.className = "ac-msg";
    try {
      var r = await DCR.api("/api/portal?action=accounting", { method: "POST",
        body: { op: "mark", ids: ids, ref: (el("acRef") || {}).value || "" } });
      state.picked = {};
      await load();
      /* A partial result is reported in full. Silently marking eight of ten is
         how two of them get entered twice. */
      if (r.refused && r.refused.length) {
        DCR.alert(r.refused.map(function (x) { return "Bill " + x.id + ": " + x.reason; }).join("\n"),
          { title: (r.marked || []).length + " marked, " + r.refused.length + " not" });
      }
    } catch (e) {
      msg.textContent = e.message || "Could not record that."; msg.className = "ac-msg err";
      mark.disabled = false;
    }
  }

  async function doUnmark(id) {
    var sure = await DCR.confirm("Put this bill back on the ready list?",
      { title: "Undo", okText: "Undo" });
    if (!sure) return;
    try {
      await DCR.api("/api/portal?action=accounting", { method: "POST",
        body: { op: "unmark", ids: [id] } });
      await load();
    } catch (e) { DCR.alert(e.message || "Could not undo that."); }
  }


  /* ── check actions ────────────────────────────────────────────────────── */

  /* The invoice, drawn in the panel.

     Images come straight from SharePoint's pre-authed URL. PDFs are fetched as
     bytes and re-typed first, because SharePoint serves them with a download
     disposition and an iframe pointed at that URL downloads the file instead of
     showing it. */
  var docUrls = [];
  function showDoc(i) {
    var d = state.detail;
    if (!d) return;
    var f = (d.documents.files || [])[i];
    var box = el("ckViewer");
    if (!f || !box) return;
    document.querySelectorAll("[data-doc]").forEach(function (b) {
      b.setAttribute("aria-pressed", Number(b.getAttribute("data-doc")) === i ? "true" : "false");
    });
    box.textContent = "Loading\u2026";
    if (/\.(jpe?g|png|gif|webp|bmp|heic|tiff?)$/i.test(f.name || "")) {
      box.innerHTML = '<img alt="' + esc(f.name) + '" src="' + esc(f.url) + '">';
      return;
    }
    if (/\.pdf$/i.test(f.name || "")) {
      DCR.blobUrl("/api/portal?action=drive&fileId=" + encodeURIComponent(f.id))
        .then(function (u) {
          docUrls.push(u);
          box.innerHTML = '<iframe title="' + esc(f.name) + '" src="' + esc(u) + '#view=FitH"></iframe>';
        })
        .catch(function (e) {
          box.innerHTML = '<div class="ck-none-note">' + esc(e.message || "Could not show it.") +
            ' <a href="' + esc(f.webUrl || f.url) + '" target="_blank" rel="noopener noreferrer">' +
            "Open it in SharePoint</a></div>";
        });
      return;
    }
    box.innerHTML = '<div class="ck-none-note">This kind of file cannot be shown here. ' +
      '<a href="' + esc(f.webUrl || f.url) + '" target="_blank" rel="noopener noreferrer">Open it</a></div>';
  }

  /* Which method THIS payment is. Fixed when the bill allows only one, chosen
     when it allows either, and read from the DOM at the moment of recording so
     it can never drift from the button she pressed. */
  function chosenMethod() {
    var fixed = el("ckHowFixed");
    if (fixed) return fixed.value || "check";
    var on = document.querySelector("[data-how][aria-pressed='true']");
    return on ? on.getAttribute("data-how") : "";
  }

  function paintMethod() {
    var m = chosenMethod();
    var lab = el("ckRefLab"), sub = el("ckRefSub"), num = el("ckNumber");
    if (!lab) return;
    if (m === "cash") {
      lab.textContent = "Reference (optional)";
      sub.textContent = "Cash has no number of its own. Anything that helps you find it later.";
      if (num) num.placeholder = "e.g. petty cash slip";
    } else {
      lab.textContent = "Check number";
      sub.textContent = "So it can be found again.";
      if (num) num.placeholder = "e.g. 2041";
    }
    var go = el("ckWrite");
    if (go) {
      go.textContent = m === "cash" ? "\u2713 Record the cash payment"
        : m === "check" ? "\u2713 Record the check"
        : "\u2713 Record the payment";
      go.disabled = !m;
    }
  }

  function wireChecks() {
    var box = el("acBody");
    document.querySelectorAll("[data-doc]").forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); showDoc(Number(b.getAttribute("data-doc"))); };
    });
    if (el("ckViewer")) showDoc(0);
    document.querySelectorAll("[data-how]").forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        document.querySelectorAll("[data-how]").forEach(function (x) {
          x.setAttribute("aria-pressed", x === b ? "true" : "false");
        });
        paintMethod();
      };
    });
    paintMethod();

    box.querySelectorAll("[data-open]").forEach(function (tr) {
      tr.onclick = async function () {
        var id = tr.getAttribute("data-open");
        if (String(state.openCheck) === String(id)) {
          state.openCheck = null; state.detail = null; return render();
        }
        state.openCheck = id; state.detail = null; render();
        try {
          state.detail = await DCR.api("/api/portal?action=accounting&bill=" + encodeURIComponent(id));
        } catch (e) {
          state.openCheck = null;
          render();
          return DCR.alert(e.message || "Could not open that bill.");
        }
        render();
      };
    });

    var close = el("ckClose");
    if (close) close.onclick = function (e) {
      e.stopPropagation();
      state.openCheck = null; state.detail = null; render();
    };

    var write = el("ckWrite");
    if (write) write.onclick = function (e) { e.stopPropagation(); doWriteCheck(); };

    /* The panel lives inside the row, and the row toggles itself shut on click.
       Without this every keystroke in the amount box would close the panel. */
    box.querySelectorAll(".ck-panel").forEach(function (p) {
      p.onclick = function (e) { e.stopPropagation(); };
    });

    box.querySelectorAll("[data-load]").forEach(function (btn) {
      btn.onclick = async function () {
        var pid = btn.getAttribute("data-load");
        var bid = btn.getAttribute("data-bill");
        btn.disabled = true;
        btn.textContent = "Looking…";
        try {
          var d = await DCR.api("/api/portal?action=accounting&bill=" + encodeURIComponent(bid));
          /* THIS check's message, not the bill's. A bill can carry more than one
             check, and the amount on a pickup notice is a statement about the
             one piece of paper waiting in the drawer. */
          var mine = (d.written || []).filter(function (w) { return String(w.id) === String(pid); })[0];
          if (!mine) {
            btn.disabled = false;
            btn.textContent = "How do I reach them?";
            return DCR.alert("That check is no longer on this bill. Refresh the page.");
          }
          state.tell[pid] = { loaded: true, contact: d.contact, message: mine.message };
        } catch (e) {
          btn.disabled = false;
          btn.textContent = "How do I reach them?";
          return DCR.alert(e.message || "Could not look them up.");
        }
        render();
      };
    });

    box.querySelectorAll("[data-mail]").forEach(function (a) {
      a.onclick = function (e) {
        e.preventDefault();
        var k = state.tell[a.getAttribute("data-mail")] || {};
        if (!k.contact || !k.contact.email) return;
        /* A detached anchor rather than assigning location.href: on some
           browsers that assignment counts as a navigation and tears the page
           down, which would lose the "Told them" button before it is pressed. */
        var link = document.createElement("a");
        link.href = "mailto:" + encodeURIComponent(k.contact.email) +
          "?subject=" + encodeURIComponent(k.message.subject) +
          "&body=" + encodeURIComponent(k.message.body);
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
      };
    });

    box.querySelectorAll("[data-copy]").forEach(function (btn) {
      btn.onclick = async function () {
        var k = state.tell[btn.getAttribute("data-copy")] || {};
        try {
          await navigator.clipboard.writeText((k.message && k.message.body) || "");
          btn.textContent = "Copied";
          setTimeout(function () { btn.textContent = "Copy the message"; }, 1500);
        } catch (e) {
          /* The clipboard is refused outside a secure context. Saying so beats
             a button that silently does nothing. */
          DCR.alert("Could not copy it. Select the message above and copy it by hand.");
        }
      };
    });

    /* How they were told is recorded, not assumed — it is the difference between
       a record and a guess when somebody rings up next month asking where their
       check went. One button per way, so it stays one click. */
    box.querySelectorAll("[data-told]").forEach(function (btn) {
      btn.onclick = async function () {
        var pid = btn.getAttribute("data-told");
        var how = btn.getAttribute("data-how");
        btn.disabled = true;
        try {
          await DCR.api("/api/portal?action=accounting", {
            method: "POST", body: { op: "told", paymentId: pid, how: how },
          });
        } catch (e) {
          btn.disabled = false;
          return DCR.alert(e.message || "Could not record that.");
        }
        delete state.tell[pid];
        await load();
      };
    });
  }

  async function doWriteCheck() {
    var msg = el("ckMsg");
    var d = state.detail;
    if (!d) return;
    var payee = (el("ckPayee").value || "").trim();
    /* Strip only what people actually type around a figure — a dollar sign,
       thousands commas, spaces. Anything else is refused rather than cleaned
       away: stripping a minus sign turns "-100" into a hundred-dollar check,
       and "1e5" into fifteen. On a number somebody signs, a refusal the
       accountant retypes beats a silent reinterpretation. */
    var typed = (el("ckAmount").value || "").trim();
    var cleaned = typed.replace(/[$,\s]/g, "");
    var amount = /^\d+(\.\d{1,2})?$/.test(cleaned) ? Number(cleaned) : NaN;
    var number = (el("ckNumber").value || "").trim();
    var memo = (el("ckMemo").value || "").trim();

    var method = chosenMethod();
    var cash = method === "cash";
    var bad = !method ? "Say whether this is by check or in cash."
      : (!number && !cash) ? "Enter the check number."
      : !isFinite(amount) ? "That is not an amount. Type it like 4500.00."
      : !(amount > 0) ? "Enter the amount."
      : amount > d.check.max + 0.005
        ? "That is more than the " + money(d.check.max) + " still authorised on this bill."
        : "";
    if (bad) { msg.textContent = bad; msg.className = "ac-msg err"; return; }

    var sure = await DCR.confirm(
      (cash ? "Record a cash payment of " + money(amount)
            : "Record check #" + number + " for " + money(amount)) +
      " to " + (payee || d.check.payee) + "?",
      { okText: "Record it" });
    if (!sure) return;

    el("ckWrite").disabled = true;
    msg.className = "ac-msg";
    msg.textContent = "Recording…";
    try {
      await DCR.api("/api/portal?action=accounting", {
        method: "POST",
        body: { op: "check", billId: d.bill.id, amount: amount, payMethod: method,
                checkNumber: number, payee: payee, memo: memo },
      });
    } catch (e) {
      var b = el("ckWrite");
      if (b) b.disabled = false;
      msg.textContent = e.message || "Could not record it.";
      msg.className = "ac-msg err";
      return;
    }
    state.openCheck = null;
    state.detail = null;
    await load();
  }

  function dropDocUrls() {
    docUrls.splice(0).forEach(function (u) { URL.revokeObjectURL(u); });
  }

  async function load() {
    dropDocUrls();
    try {
      state.d = await DCR.api("/api/portal?action=accounting");
      render();
    } catch (e) {
      /* The payload is dropped, not kept.

         DCR.api throws on any non-2xx and on a dead connection, and only a 401
         navigates away — so a 500, a throttle or a dropped Wi-Fi lands here.
         Holding the previous payload meant the view toggle, which only checks
         that there IS one, would happily repaint the figures from before the
         thing she just did. She would read "9 bills ready" over an error
         message and key six of them a second time. */
      state.d = null;
      el("acBody").innerHTML = '<div class="ac-sec" style="color:var(--err)">' +
        esc(e.message || "Could not open the books.") + "</div>";
      el("acCards").innerHTML = "";
      el("acCards").className = "ac-cards";   // or an empty bordered panel is left behind
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };
    var name = (profile.displayName || profile.email || "").split(" ")[0].split("@")[0];
    el("acGreeting").textContent = name ? "— " + name : "";

    /* Wired once, outside the part that redraws: the choice belongs to her and
       to this browser, and re-reading the books to change a view would be a
       Graph round trip for a preference. */
    var group = el("acView");
    if (group) {
      group.querySelectorAll("[data-view]").forEach(function (b) {
        b.onclick = function () {
          setView(b.getAttribute("data-view"));
          paintView();                         // even with nothing to draw
          if (state.d) summary(state.d);
        };
      });
    }
    load();
  });
})();
