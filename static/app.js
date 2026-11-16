/* ==========================================================
   GRAN RIFA — lógica de la interfaz (versión ligera, sin ventanas)
   ========================================================== */
(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const azar = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const esc = (t) =>
    String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reducirMovimiento = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const app = { datos: null, girando: false, sonido: true, avisosVistos: new Set() };
  try { app.sonido = localStorage.getItem("rifa-sonido") !== "off"; } catch {}

  const maquina = $("#maquina");
  const controles = $("#controles");

  /* ========================================================
     API
     ======================================================== */
  async function api(ruta, metodo = "GET") {
    const r = await fetch(ruta, { method: metodo, headers: { Accept: "application/json" }, cache: "no-store" });
    let datos = {};
    try { datos = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, datos };
  }

  /* ========================================================
     SONIDO (sintetizado con Web Audio, no necesita archivos)
     ======================================================== */
  const Sonido = (() => {
    let ctx = null, master = null;
    function init() {
      try {
        if (!ctx) {
          ctx = new (window.AudioContext || window.webkitAudioContext)();
          master = ctx.createGain();
          master.gain.value = 0.55;
          master.connect(ctx.destination);
        }
        if (ctx.state === "suspended") ctx.resume();
      } catch {}
    }
    function tono(freq, dur, { tipo = "sine", vol = 0.3, cuando = 0, hasta = null } = {}) {
      if (!ctx || !app.sonido) return;
      const t = ctx.currentTime + cuando;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = tipo;
      o.frequency.setValueAtTime(freq, t);
      if (hasta) o.frequency.exponentialRampToValueAtTime(hasta, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    return {
      init,
      tick: () => tono(1500 + Math.random() * 300, 0.03, { tipo: "square", vol: 0.045 }),
      palanca: () => { tono(220, 0.35, { tipo: "sawtooth", vol: 0.1, hasta: 70 }); tono(90, 0.25, { vol: 0.3, cuando: 0.2 }); },
      golpe: () => { tono(300, 0.12, { tipo: "triangle", vol: 0.4, hasta: 120 }); tono(1320, 0.4, { vol: 0.16, cuando: 0.04 }); },
      fanfarria: () => {
        const n = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5];
        const t = [0, 0.12, 0.24, 0.36, 0.58, 0.7, 0.82];
        const d = [0.14, 0.14, 0.14, 0.24, 0.14, 0.14, 1.0];
        n.forEach((f, i) => {
          tono(f, d[i], { tipo: "triangle", vol: 0.26, cuando: t[i] });
          tono(f / 2, d[i], { tipo: "square", vol: 0.035, cuando: t[i] });
        });
      },
      reestablecer: () => [392, 523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tono(f, 0.22, { tipo: "triangle", vol: 0.2, cuando: i * 0.07 })),
      error: () => { tono(180, 0.18, { tipo: "square", vol: 0.08 }); tono(140, 0.25, { tipo: "square", vol: 0.08, cuando: 0.16 }); },
    };
  })();

  /* ========================================================
     FONDO: pocas partículas, a ~30 cuadros por segundo
     ======================================================== */
  (() => {
    const cv = $("#fondo"), ctx = cv.getContext("2d");
    const colores = ["255,204,77", "255,61,154", "53,224,255", "255,255,255"];
    let W = 0, H = 0, ps = [], ultimo = 0;
    const nueva = (inicio) => ({
      x: Math.random() * W, y: inicio ? Math.random() * H : H + 10,
      r: 0.8 + Math.random() * 2, v: 0.25 + Math.random() * 0.7,
      fase: Math.random() * 6.28, c: azar(colores),
    });
    function ajustar() {
      W = cv.width = innerWidth;   // resolución 1x: suficiente para puntitos de luz
      H = cv.height = innerHeight;
    }
    function dibujar(t) {
      if (t - ultimo > 32) {
        ultimo = t;
        ctx.clearRect(0, 0, W, H);
        for (const p of ps) {
          p.y -= p.v;
          if (p.y < -10) Object.assign(p, nueva(false));
          ctx.globalAlpha = 0.25 + 0.35 * (1 + Math.sin(t / 700 + p.fase)) / 2;
          ctx.fillStyle = `rgb(${p.c})`;
          ctx.fillRect(p.x, p.y, p.r, p.r);
        }
      }
      if (!reducirMovimiento) requestAnimationFrame(dibujar);
    }
    ajustar();
    addEventListener("resize", ajustar);
    ps = Array.from({ length: 45 }, () => nueva(true));
    requestAnimationFrame(dibujar);
  })();

  /* ========================================================
     CONFETI Y FUEGOS ARTIFICIALES (solo se dibuja mientras hay piezas)
     ======================================================== */
  const Confeti = (() => {
    const cv = $("#confeti"), ctx = cv.getContext("2d");
    const colores = ["#ffcc4d", "#fff3c4", "#ff3d6e", "#35e0ff", "#9b5cff", "#3ee6a0", "#ff8a3d", "#ffffff"];
    let piezas = [], activo = false, W = 0, H = 0;
    function ajustar() { W = cv.width = innerWidth; H = cv.height = innerHeight; }
    ajustar();
    addEventListener("resize", ajustar);

    function papel(x, y, ang, vel) {
      piezas.push({
        chispa: false, x, y, vx: Math.cos(ang) * vel, vy: Math.sin(ang) * vel,
        rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3,
        giro: Math.random() * 6.28, vg: 0.08 + Math.random() * 0.12,
        w: 7 + Math.random() * 7, h: 10 + Math.random() * 8,
        color: azar(colores), vida: 0, max: 220 + Math.random() * 120, roce: 0.955, g: 0.22,
      });
    }
    function chispa(x, y, ang, vel, color) {
      piezas.push({ chispa: true, x, y, vx: Math.cos(ang) * vel, vy: Math.sin(ang) * vel, color, vida: 0, max: 60 + Math.random() * 30, roce: 0.95, g: 0.06 });
    }
    function correr() {
      if (activo) return;
      activo = true;
      requestAnimationFrame(paso);
    }
    function paso() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      piezas = piezas.filter((p) => p.vida < p.max && p.y < H + 40);
      for (const p of piezas) {
        p.vida++;
        p.vx *= p.roce; p.vy = p.vy * p.roce + p.g;
        p.x += p.vx; p.y += p.vy;
        ctx.globalAlpha = Math.min(1, (p.max - p.vida) / 40);
        ctx.fillStyle = p.color;
        if (p.chispa) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
          continue;
        }
        p.rot += p.vr; p.giro += p.vg;
        const c = Math.cos(p.rot), s = Math.sin(p.rot), k = Math.cos(p.giro);
        ctx.setTransform(c, s, -s * k, c * k, p.x, p.y); // rotar + "voltear" sin save/restore
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      if (piezas.length) requestAnimationFrame(paso);
      else { activo = false; ctx.clearRect(0, 0, W, H); }
    }
    return {
      canones(n = 60) {
        for (let i = 0; i < n; i++) {
          papel(-10, H * 0.95, -Math.PI / 3 + (Math.random() - 0.5) * 0.7, 20 + Math.random() * 20);
          papel(W + 10, H * 0.95, -Math.PI * 2 / 3 + (Math.random() - 0.5) * 0.7, 20 + Math.random() * 20);
        }
        correr();
      },
      lluvia(n = 90) {
        for (let i = 0; i < n; i++) papel(Math.random() * W, -20 - Math.random() * H * 0.4, Math.PI / 2, 1 + Math.random() * 3);
        correr();
      },
      explosion(x, y, n = 80) {
        for (let i = 0; i < n; i++) papel(x, y, Math.random() * Math.PI * 2, 6 + Math.random() * 14);
        correr();
      },
      fuegos(veces = 7) {
        for (let k = 0; k < veces; k++) {
          setTimeout(() => {
            const x = W * (0.15 + Math.random() * 0.7), y = H * (0.12 + Math.random() * 0.35);
            const color = azar(colores);
            for (let i = 0; i < 50; i++) chispa(x, y, (i / 50) * Math.PI * 2, 3 + Math.random() * 5, color);
            correr();
            Sonido.golpe();
          }, k * 450 + Math.random() * 200);
        }
      },
    };
  })();

  /* ========================================================
     CARRETE (ruleta estilo tragamonedas)
     ======================================================== */
  const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);

  class Carrete {
    constructor(raiz, render) {
      this.raiz = raiz;
      this.tira = raiz.querySelector(".tira");
      this.render = render;
      this.desenfoque = "";
      this.visibles = [null, null, null];
    }
    alto() { return this.tira.firstElementChild?.offsetHeight || 100; }
    montar(valores) {
      this.tira.innerHTML = valores.map((v) => `<div class="celda">${this.render(v)}</div>`).join("");
    }
    ponerY(y) { this.tira.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0)`; }
    mostrar(arriba, centro, abajo) {
      this.visibles = [arriba, centro, abajo];
      this.montar(this.visibles);
      this.ponerY(0);
    }
    refrescar() { this.mostrar(...this.visibles); }
    /* Solo 3 niveles de desenfoque: el navegador lo calcula una vez por nivel
       y luego solo mueve la imagen (muy barato). */
    desenfocar(velocidad) {
      const nivel = velocidad > 28 ? "rapido" : velocidad > 9 ? "medio" : "";
      if (nivel === this.desenfoque) return;
      if (this.desenfoque) this.tira.classList.remove(this.desenfoque);
      if (nivel) this.tira.classList.add(nivel);
      this.desenfoque = nivel;
    }
    /*  La tira se arma así:  [arriba, OBJETIVO, abajo, ...relleno..., visibles actuales]
        y baja hasta que el OBJETIVO queda en la línea de premio. */
    girar({ objetivo, arriba, abajo, relleno, duracion }) {
      const valores = [arriba, objetivo, abajo, ...relleno, ...this.visibles];
      this.montar(valores);
      const H = this.alto();
      const yInicio = (1 - (valores.length - 2)) * H;
      const retroceso = H * 0.3, rebote = H * 0.2;
      const T1 = 260, T2 = duracion, T3 = 560;
      this.raiz.classList.remove("detenido");
      this.ponerY(yInicio);

      return new Promise((resolve) => {
        const t0 = performance.now();
        let yPrev = yInicio, idxPrev = null, ultimoTick = 0;
        const desde = yInicio - retroceso;
        const frame = (ahora) => {
          const t = ahora - t0;
          let y, fin = false;
          if (t < T1) {                       // pequeño retroceso, como una palanca real
            y = yInicio - retroceso * Math.sin((t / T1) * Math.PI / 2);
          } else if (t < T1 + T2) {           // giro principal que va frenando
            y = desde + (rebote - desde) * easeOutCubic((t - T1) / T2);
          } else if (t < T1 + T2 + T3) {      // rebote final al encajar
            const p = (t - T1 - T2) / T3;
            y = rebote * Math.cos(p * Math.PI * 1.5) * Math.pow(1 - p, 2);
          } else {
            y = 0; fin = true;
          }
          this.ponerY(y);
          this.desenfocar(Math.abs(y - yPrev));
          yPrev = y;
          const idx = Math.round((H - y) / H);
          if (idx !== idxPrev) {
            idxPrev = idx;
            if (ahora - ultimoTick > 45) { ultimoTick = ahora; Sonido.tick(); }
          }
          if (!fin) return requestAnimationFrame(frame);
          this.desenfocar(0);
          this.mostrar(arriba, objetivo, abajo);
          void this.raiz.offsetWidth; // reinicia la animación de "detenido"
          this.raiz.classList.add("detenido");
          resolve();
        };
        requestAnimationFrame(frame);
      });
    }
  }

  /* ---------- Cómo se dibuja cada celda ---------- */
  const fmtNum = (n, total) => String(n).padStart(Math.max(2, String(total ?? 0).length), "0");
  const fmtRegalo = (n) => fmtNum(n, app.datos?.total_regalos);
  const fmtJuguete = (n) => fmtNum(n, app.datos?.total_juguetes);

  function renderNombre(v) {
    if (!v) return "";
    if (v.especial) return `<span class="n-especial">${esc(v.especial)}</span>`;
    const largo = Math.max(v.nombre.length, (v.apellido || "").length);
    const cls = largo > 24 ? "xl" : largo > 16 ? "l" : "";
    return `<span class="n-nombre ${cls}">${esc(v.nombre)}</span>` +
      (v.apellido ? `<span class="n-apellido ${cls}">${esc(v.apellido)}</span>` : "");
  }
  // "?" = todavía no se ha girado · "—" = ya no quedan de ese tipo
  const renderNumero = (fmt) => (v) => {
    if (v == null) return "";
    if (v === "?") return `<span class="r-num r-incognita">?</span>`;
    if (v === "—") return `<span class="r-vacio">—</span>`;
    return `<span class="r-num">${fmt(v)}</span>`;
  };

  const carreteNombre = new Carrete($("#carrete-nombre"), renderNombre);
  const carreteRegalo = new Carrete($("#carrete-regalo"), renderNumero(fmtRegalo));
  const carreteJuguete = new Carrete($("#carrete-juguete"), renderNumero(fmtJuguete));

  /* Lo que puede aparecer en cada ruleta: SOLO lo que todavía no se ha dado */
  const poolNombres = () => (app.datos?.nombres ?? []).filter((n) => n.d);
  const poolRegalos = () => app.datos?.regalos_disponibles ?? [];
  const poolJuguetes = () => app.datos?.juguetes_disponibles ?? [];
  const tomar = (pool) => (pool.length ? azar(pool) : null);
  const esIgual = (a, b) => (typeof a === "object" && a && b ? a.nombre === b.nombre && a.apellido === b.apellido : a === b);

  /* Dos vecinos distintos (arriba y abajo) que no sean el objetivo */
  function vecinos(pool, objetivo) {
    const libres = pool.filter((x) => !esIgual(x, objetivo));
    const a = tomar(libres);
    const resto = libres.filter((x) => !esIgual(x, a));
    return [a, resto.length ? tomar(resto) : null];
  }

  /* Gira una ruleta hasta "objetivo". Si ya no quedan (objetivo = null) se queda en "—". */
  function girarCarrete(carrete, pool, objetivo, pasos, duracion) {
    if (objetivo == null) {
      carrete.mostrar(null, "—", null);
      return Promise.resolve();
    }
    const [arriba, abajo] = vecinos(pool, objetivo);
    // El ganador no se mezcla en el relleno: aparece una sola vez, al detenerse
    const otros = pool.filter((x) => !esIgual(x, objetivo));
    const relleno = otros.length ? otros : [objetivo];
    return carrete
      .girar({ objetivo, arriba, abajo, relleno: Array.from({ length: pasos }, () => tomar(relleno)), duracion })
      .then(() => Sonido.golpe());
  }

  /* ========================================================
     BOMBILLAS Y PALANCA
     ======================================================== */
  function colocarBombillas() {
    const cont = $("#bombillas");
    const W = cont.clientWidth, H = cont.clientHeight;
    if (!W || !H) return;
    const per = 2 * (W + H);
    const n = Math.max(16, Math.round(per / 34));
    let html = "";
    for (let i = 0; i < n; i++) {
      let d = (i / n) * per, x, y;
      if (d < W) { x = d; y = 0; }
      else if ((d -= W) < H) { x = W; y = d; }
      else if ((d -= H) < W) { x = W - d; y = H; }
      else { d -= W; x = 0; y = H - d; }
      html += `<span class="bombilla" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;--k:${i % 3};--p:${i % 2}"></span>`;
    }
    cont.innerHTML = html;
  }

  function ajustarPalanca() {
    const pal = $("#palanca");
    const H = pal.clientHeight;
    if (!H) return;
    const punta = (H - 46) + (H - 80) * 0.28;  // dónde queda la punta al bajar
    pal.style.setProperty("--recorrido", `${punta - 24}px`);
  }

  /* ========================================================
     INTERFAZ
     ======================================================== */
  function reiniciarAnimacion(el, clase) {
    el.classList.remove(clase);
    void el.offsetWidth;
    el.classList.add(clase);
  }

  function ponerValor(sel, valor) {
    const el = $(sel);
    const txt = String(valor);
    if (el.textContent !== txt) {
      el.textContent = txt;
      reiniciarAnimacion(el, "salto");
    }
  }

  function modo() {
    const d = app.datos;
    if (!d) return "cargando";
    if (app.girando) return "girando";
    if (d.sin_participantes) return "vacio";
    if (d.terminado) return "fin";
    if (d.sin_nombres) return "agotado";
    return "listo";
  }

  function actualizarUI({ nuevoGanador = false } = {}) {
    const d = app.datos;
    if (!d) return;
    $("#titulo").textContent = d.titulo;
    document.title = d.titulo;

    ponerValor("#v-regalos", d.regalos_restantes);
    $("#v-regalos-total").textContent = `de ${d.total_regalos}`;
    ponerValor("#v-participantes", d.participantes_disponibles);
    $("#v-participantes-total").textContent = `de ${d.participantes_total}`;
    ponerValor("#v-ronda", d.ronda);
    ponerValor("#v-juguetes", d.juguetes_restantes);
    $("#v-juguetes-total").textContent = `de ${d.total_juguetes}`;
    const avance = (total, restantes) => `scaleX(${total ? (total - restantes) / total : 0})`;
    $("#progreso-barra").style.transform = avance(d.total_regalos, d.regalos_restantes);
    $("#progreso-juguetes").style.transform = avance(d.total_juguetes, d.juguetes_restantes);

    const plural = (n, palabra) => `${n} ${palabra}${n === 1 ? "" : "s"}`;
    const quedan = [];
    if (d.regalos_restantes) quedan.push(plural(d.regalos_restantes, "regalo"));
    if (d.juguetes_restantes) quedan.push(plural(d.juguetes_restantes, "juguete"));
    $("#agotado-restantes").textContent = quedan.join(" y ");
    const dados = [];
    if (d.total_regalos) dados.push(plural(d.total_regalos, "regalo"));
    if (d.total_juguetes) dados.push(plural(d.total_juguetes, "juguete"));
    $("#fin-total").textContent = dados.length ? `los ${dados.join(" y ")}` : "todos los premios";

    controles.dataset.modo = modo();
    $("#btn-girar").disabled = modo() !== "listo";
    $("#palanca").disabled = app.girando;   // palanca bloqueada desde que gira hasta "Continuar"

    renderHistorial(nuevoGanador);

    pintarMensaje();
  }

  /* Línea de aviso fija debajo del botón (no flota ni tapa nada).
     Muestra un error reciente o los avisos del servidor
     (por ejemplo, un error de formato en participantes.json). */
  let errorActual = "";
  function mostrarError(msg) { errorActual = msg || ""; pintarMensaje(); }
  function pintarMensaje() {
    const el = $("#mensaje");
    const texto = errorActual || (app.datos?.avisos || []).join("  ·  ");
    el.textContent = texto;
    el.hidden = !texto;
    el.classList.toggle("es-error", !!errorActual);
  }

  /* ========================================================
     VENTANA DEL GANADOR
     ======================================================== */
  const modalGanador = $("#modal-ganador");
  const modalAbierto = () => modalGanador.classList.contains("abierto");

  function mostrarGanador(g, regalo, juguete, ronda) {
    $("#mg-titulo").innerHTML = [..."¡FELICIDADES!"].map((c, i) => `<span style="--i:${i}">${c}</span>`).join("");
    $("#mg-nombre").textContent = g.nombre;
    $("#mg-apellido").textContent = g.apellido;
    // Si ya no quedaban regalos (o juguetes), ese boleto no se muestra
    $("#mg-boleto-regalo").hidden = regalo == null;
    $("#mg-boleto-juguete").hidden = juguete == null;
    if (regalo != null) $("#mg-regalo").textContent = fmtRegalo(regalo);
    if (juguete != null) $("#mg-juguete").textContent = fmtJuguete(juguete);
    $("#mg-ronda").textContent = ronda > 1 ? `Ronda ${ronda}` : "";
    modalGanador.classList.add("abierto");
    setTimeout(() => Confeti.lluvia(), 500);
    setTimeout(() => $("#btn-continuar").focus({ preventScroll: true }), 50);
  }

  function cerrarGanador() {
    if (!modalAbierto()) return;
    modalGanador.classList.remove("abierto");
    app.girando = false;          // ahora sí se puede volver a girar
    actualizarUI();
    if (app.datos?.terminado) setTimeout(() => { Confeti.fuegos(); Sonido.fanfarria(); }, 400);
  }

  function renderHistorial(resaltar) {
    const h = app.datos.historial;
    $("#hist-count").textContent = h.length;
    $("#hist-vacio").hidden = h.length > 0;
    const variasRondas = h.some((x) => x.ronda > 1);
    $("#lista-historial").innerHTML = h
      .map((g, i) => `
        <li class="hi${resaltar && i === 0 ? " nuevo" : ""}">
          ${g.regalo != null
            ? `<span class="hi-regalo"><small>Regalo</small>${fmtRegalo(g.regalo)}</span>`
            : `<span class="hi-regalo vacio"><small>Regalo</small>—</span>`}
          ${g.juguete != null
            ? `<span class="hi-juguete"><small>Juguete</small>${fmtJuguete(g.juguete)}</span>`
            : `<span class="hi-juguete vacio"><small>Juguete</small>—</span>`}
          <span class="hi-persona"><b>${esc(g.nombre)}</b><span>${esc(g.apellido)}</span></span>
          ${variasRondas ? `<span class="hi-ronda">Ronda ${g.ronda}</span>` : "<span></span>"}
        </li>`)
      .join("");
  }

  /* ========================================================
     FLUJO PRINCIPAL: GIRAR
     ======================================================== */
  let finGanando = null;

  async function girar() {
    if (app.girando || !app.datos || modalAbierto()) return;
    mostrarError("");
    Sonido.init();
    if (modo() !== "listo") {
      reiniciarAnimacion(maquina, "sacudir");
      Sonido.error();
      return;
    }

    clearTimeout(finGanando);
    maquina.classList.remove("ganando");
    app.girando = true;
    actualizarUI();
    Sonido.palanca();
    reiniciarAnimacion($("#palanca"), "tirando");
    maquina.classList.add("girando");

    let r = null;
    try { r = await api("/api/sortear", "POST"); } catch {}

    if (!r || !r.ok) {
      app.girando = false;
      maquina.classList.remove("girando");
      if (r?.datos?.estado) app.datos = r.datos.estado;
      actualizarUI();
      Sonido.error();
      mostrarError(r?.datos?.mensaje || "No se pudo conectar con el servidor. ¿Sigue abierta la ventana de la rifa?");
      return;
    }

    const { ganador, regalo, juguete, ronda, estado } = r.datos;

    // Las ruletas se rellenan con lo que seguía disponible ANTES de este sorteo
    // (nada que ya se haya dado aparece). Se detienen una tras otra.
    await Promise.all([
      girarCarrete(carreteNombre, poolNombres(), ganador, 30, 3300),
      girarCarrete(carreteRegalo, poolRegalos(), regalo, 40, 4500),
      girarCarrete(carreteJuguete, poolJuguetes(), juguete, 50, 5700),
    ]);

    // ¡Premio!
    maquina.classList.remove("girando");
    maquina.classList.add("ganando");
    finGanando = setTimeout(() => maquina.classList.remove("ganando"), 3500);
    Sonido.fanfarria();
    Confeti.canones();

    // La máquina sigue bloqueada (app.girando = true) hasta pulsar "Continuar"
    app.datos = estado;
    actualizarUI({ nuevoGanador: true });

    setTimeout(() => mostrarGanador(ganador, regalo, juguete, ronda), 1100);
  }

  /* ========================================================
     REESTABLECER NOMBRES (cuando se acaban y aún hay regalos)
     ======================================================== */
  async function reestablecerNombres() {
    if (app.girando || modalAbierto()) return;
    Sonido.init();
    mostrarError("");
    const btn = $("#btn-reestablecer");
    btn.disabled = true;
    let r = null;
    try { r = await api("/api/reestablecer-nombres", "POST"); } catch {}
    btn.disabled = false;
    if (!r || !r.ok) {
      if (r?.datos?.estado) { app.datos = r.datos.estado; actualizarUI(); }
      mostrarError(r?.datos?.mensaje || "No se pudo conectar con el servidor.");
      return;
    }
    app.datos = r.datos.estado;
    app.girando = true;
    actualizarUI();
    Sonido.reestablecer();
    maquina.classList.add("girando");
    await girarCarrete(carreteNombre, poolNombres(), { especial: `¡Ronda ${r.datos.ronda}!` }, 24, 1800);
    maquina.classList.remove("girando");
    app.girando = false;
    Confeti.explosion(innerWidth / 2, innerHeight * 0.45);
    actualizarUI();
  }

  /* ========================================================
     REINICIAR TODO (borra la base de datos)
     Primer clic: el botón pide confirmación. Segundo clic: reinicia.
     ======================================================== */
  let esperaConfirmar = null;
  async function clicReiniciar() {
    const btn = $("#btn-reiniciar");
    if (app.girando || modalAbierto()) return;
    if (!btn.classList.contains("confirmar")) {
      btn.classList.add("confirmar");
      esperaConfirmar = setTimeout(() => btn.classList.remove("confirmar"), 4000);
      return;
    }
    clearTimeout(esperaConfirmar);
    btn.classList.remove("confirmar");
    let r = null;
    try { r = await api("/api/reiniciar", "POST"); } catch {}
    if (!r || !r.ok) {
      mostrarError(r?.datos?.mensaje || "No se pudo reiniciar la rifa.");
      return;
    }
    mostrarError("");
    app.datos = r.datos.estado;
    clearTimeout(finGanando);
    maquina.classList.remove("ganando");
    ponerCarretesIniciales();
    actualizarUI();
  }

  /* ========================================================
     INICIO
     ======================================================== */
  /* Estado inicial: signos de interrogación y, arriba/abajo, solo cosas aún disponibles */
  function ponerCarretesIniciales() {
    const poner = (carrete, pool, centro) => {
      const [arriba, abajo] = vecinos(pool, centro);
      carrete.mostrar(arriba, pool.length ? centro : "—", abajo);
    };
    poner(carreteNombre, poolNombres(), { especial: "¿Quién ganará?" });
    poner(carreteRegalo, poolRegalos(), "?");
    poner(carreteJuguete, poolJuguetes(), "?");
  }

  async function cargarEstado() {
    try {
      const r = await api("/api/estado");
      return r.ok ? r.datos : null;
    } catch {
      return null;
    }
  }

  async function refrescar() {
    if (app.girando) return;
    const datos = await cargarEstado();
    if (!datos || app.girando) return;
    const reiniciada = (app.datos?.historial.length ?? 0) > 0 && datos.historial.length === 0;
    const totalCambio = app.datos?.total_regalos !== datos.total_regalos || app.datos?.total_juguetes !== datos.total_juguetes;
    app.datos = datos;
    if (reiniciada || totalCambio) ponerCarretesIniciales();
    actualizarUI();
  }

  async function iniciar() {
    colocarBombillas();
    ajustarPalanca();
    $("#btn-sonido").classList.toggle("mudo", !app.sonido);

    app.datos = await cargarEstado();
    if (!app.datos) {
      $("#cargando-txt").innerHTML = "No se pudo conectar con el servidor. Ejecuta <code>INICIAR_RIFA.bat</code> y recarga.";
      return;
    }
    ponerCarretesIniciales();
    actualizarUI();
  }

  /* ---------- Eventos ---------- */
  $("#btn-girar").addEventListener("click", girar);
  $("#palanca").addEventListener("click", girar);
  $("#btn-reestablecer").addEventListener("click", reestablecerNombres);
  $("#btn-reiniciar").addEventListener("click", clicReiniciar);
  $("#btn-continuar").addEventListener("click", cerrarGanador);

  function alternarSonido() {
    app.sonido = !app.sonido;
    $("#btn-sonido").classList.toggle("mudo", !app.sonido);
    try { localStorage.setItem("rifa-sonido", app.sonido ? "on" : "off"); } catch {}
  }
  function alternarPantalla() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
  $("#btn-sonido").addEventListener("click", alternarSonido);
  $("#btn-pantalla").addEventListener("click", alternarPantalla);

  addEventListener("keydown", (e) => {
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    if (modalAbierto()) {
      if (e.key === " " || e.key === "Enter" || e.key === "Escape") { e.preventDefault(); cerrarGanador(); }
      return;
    }
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      girar(); // si no se puede girar, la máquina se sacude
    } else if (e.key === "m" || e.key === "M") {
      alternarSonido();
    } else if (e.key === "f" || e.key === "F") {
      alternarPantalla();
    }
  });

  // Recoloca bombillas y palanca cuando la máquina cambia de tamaño
  let temporizador;
  const reacomodar = () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => { colocarBombillas(); ajustarPalanca(); }, 100);
  };
  if ("ResizeObserver" in window) new ResizeObserver(reacomodar).observe($("#bombillas"));
  addEventListener("resize", reacomodar);
  addEventListener("focus", refrescar);

  document.fonts?.ready.then(() => { carreteNombre.refrescar(); carreteRegalo.refrescar(); carreteJuguete.refrescar(); });
  iniciar();
})();
