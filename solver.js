/**
 * circuit.js — Motor de interacción del simulador
 * Gestiona: lienzo, componentes, cables, terminales,
 *            drag&drop, selección, simulación y animaciones.
 */

(() => {
  'use strict';

  // ============================================================
  // CONSTANTES DE DISEÑO
  // ============================================================
  const GRID = 32;
  const TERMINAL_R = 6;
  const COMP_W = 96;
  const COMP_H = 56;
  const WIRE_HIT = 10;        // píxeles de tolerancia para seleccionar cables
  const MAX_POWER_DEFAULT = 0.5; // vatios → componente "se quema"

  const COLORS = {
    bg:           '#0a0f14',
    grid:         'rgba(48,54,61,0.4)',
    wireIdle:     '#3d4f63',
    wireActive:   '#39d353',
    wireSelected: '#ffa657',
    wireDraw:     '#58a6ff',
    termIdle:     '#444c56',
    termHover:    '#ffa657',
    termActive:   '#39d353',
    termConnect:  '#58a6ff',
    selected:     '#ffa657',
    burned:       '#f85149',
    battery:      '#FFD700',
    resistor:     '#FF6B35',
    switch_open:  '#4FC3F7',
    switch_closed:'#39d353',
    led_off:      '#A8FF78',
    led_on:       '#FFFF00',
    ammeter:      '#FF9FF3',
    voltmeter:    '#78D2FF',
    text:         '#e6edf3',
    textDim:      '#8b949e',
    shadow:       'rgba(0,0,0,0.7)',
  };

  // ============================================================
  // ESTADO GLOBAL
  // ============================================================
  let components    = [];   // Array de objetos Component
  let wires         = [];   // Array de objetos Wire
  let selectedComp  = null; // Componente seleccionado
  let selectedWire  = null; // Cable seleccionado
  let simRunning    = false;
  let simResult     = null;

  // Drag de lienzo
  let dragging      = false;
  let dragComp      = null;
  let dragOffX      = 0, dragOffY = 0;

  // Dibujar cable
  let drawingWire   = false;
  let wireStart     = null; // { comp, termIndex, x, y }
  let wireMouseX    = 0, wireMouseY = 0;

  // Drag desde paleta
  let paletteGhost  = null; // { type, x, y }

  // Animación de corriente
  let animOffset    = 0;
  let animRAF       = null;

  // ID counter
  let nextId = 1;
  function uid() { return `c${nextId++}`; }

  // ============================================================
  // CANVAS SETUP
  // ============================================================
  const canvas  = document.getElementById('circuit-canvas');
  const ctx     = canvas.getContext('2d');
  const tooltip = document.createElement('div');
  tooltip.id = 'canvas-tooltip';
  document.getElementById('canvas-container').appendChild(tooltip);

  function resizeCanvas() {
    const container = document.getElementById('canvas-container');
    canvas.width  = container.clientWidth;
    canvas.height = container.clientHeight;
    render();
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // ============================================================
  // COMPONENTE
  // ============================================================
  function createComponent(type, x, y) {
    const c = {
      id: uid(),
      type,
      x: snapGrid(x - COMP_W / 2),
      y: snapGrid(y - COMP_H / 2),
      w: COMP_W,
      h: COMP_H,
      label: defaultLabel(type),
      burned: false,
      // Propiedades según tipo
      voltage:    type === 'battery'   ? 9    : undefined,
      resistance: type === 'resistor'  ? 100  :
                  type === 'led'       ? 470  : undefined,
      maxPower:   MAX_POWER_DEFAULT,
      closed:     type === 'switch'    ? false : undefined,
    };
    return c;
  }

  function defaultLabel(type) {
    const map = {
      battery:   'Batería',
      resistor:  'R',
      switch:    'S',
      led:       'LED',
      ammeter:   'A',
      voltmeter: 'V',
    };
    return map[type] || type;
  }

  /** Terminales del componente: [{ x, y }]  — siempre 2 terminales */
  function getTerminals(c) {
    return [
      { x: c.x,           y: c.y + c.h / 2 }, // terminal 0 (izquierda)
      { x: c.x + c.w,     y: c.y + c.h / 2 }, // terminal 1 (derecha)
    ];
  }

  function snapGrid(v) {
    return Math.round(v / GRID) * GRID;
  }

  // ============================================================
  // RENDER PRINCIPAL
  // ============================================================
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Cables primero (detrás de componentes)
    wires.forEach(w => drawWire(w));
    if (drawingWire && wireStart) drawWirePreview();

    // Componentes
    components.forEach(c => drawComponent(c));

    // Partículas de electron si simulando
    if (simRunning && simResult && simResult.closed) {
      drawElectrons();
    }
  }

  // ---------- Dibujar cable ----------
  function drawWire(w) {
    const fromComp = getCompById(w.fromComp);
    const toComp   = getCompById(w.toComp);
    if (!fromComp || !toComp) return;

    const p1 = getTerminals(fromComp)[w.fromTerm];
    const p2 = getTerminals(toComp)[w.toTerm];

    const isActive = simRunning && simResult && simResult.closed;
    const isSel    = selectedWire === w;

    // Sombra
    ctx.save();
    ctx.shadowColor = isActive ? COLORS.wireActive : 'transparent';
    ctx.shadowBlur  = isActive ? 10 : 0;

    ctx.beginPath();
    // Cable con curva suave si hay desplazamiento vertical
    const midX = (p1.x + p2.x) / 2;
    ctx.moveTo(p1.x, p1.y);
    ctx.bezierCurveTo(midX, p1.y, midX, p2.y, p2.x, p2.y);

    ctx.strokeStyle = isSel ? COLORS.wireSelected
                    : isActive ? COLORS.wireActive
                    : COLORS.wireIdle;
    ctx.lineWidth   = isSel ? 3 : 2.5;
    ctx.lineCap     = 'round';
    ctx.stroke();
    ctx.restore();

    // Dirección del cable (flecha pequeña en modo sim)
    if (isActive) {
      drawArrow(ctx, p1.x, p1.y, p2.x, p2.y, COLORS.wireActive);
    }
  }

  function drawArrow(ctx, x1, y1, x2, y2, color) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const len = 8;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle   = color;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(mx - len * Math.cos(angle - 0.4), my - len * Math.sin(angle - 0.4));
    ctx.moveTo(mx, my);
    ctx.lineTo(mx - len * Math.cos(angle + 0.4), my - len * Math.sin(angle + 0.4));
    ctx.stroke();
    ctx.restore();
  }

  function drawWirePreview() {
    ctx.save();
    ctx.strokeStyle = COLORS.wireDraw;
    ctx.lineWidth   = 2;
    ctx.setLineDash([6, 4]);
    ctx.lineDashOffset = -animOffset;
    ctx.beginPath();
    ctx.moveTo(wireStart.x, wireStart.y);
    ctx.lineTo(wireMouseX, wireMouseY);
    ctx.stroke();
    ctx.restore();
    ctx.setLineDash([]);
  }

  // ---------- Dibujar componente ----------
  function drawComponent(c) {
    const isSel    = selectedComp === c;
    const result   = simResult && simResult.componentResults[c.id];
    const isBurned = result && result.burned;

    ctx.save();

    // Caja de fondo
    const rx = 6;
    ctx.beginPath();
    roundRect(ctx, c.x + 4, c.y + 4, c.w - 8, c.h - 8, rx);

    // Color de fondo según estado
    const bgAlpha = isBurned ? 0.35 : 0.18;
    ctx.fillStyle = isBurned ? `rgba(248,81,73,${bgAlpha})` : `rgba(28,39,51,${bgAlpha})`;
    ctx.fill();

    // Borde
    const borderColor = isSel    ? COLORS.selected
                       : isBurned ? COLORS.burned
                       : typeColor(c.type);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth   = isSel ? 2.5 : 1.5;
    if (isSel) {
      ctx.shadowColor = borderColor;
      ctx.shadowBlur  = 10;
    }
    ctx.stroke();
    ctx.restore();

    // Dibujar el símbolo del componente
    drawSymbol(c, result);

    // Terminales
    drawTerminals(c);

    // Etiqueta
    drawLabel(c, result);

    // Efecto "quemado"
    if (isBurned) drawBurnEffect(c);
  }

  function typeColor(type) {
    const map = {
      battery:   COLORS.battery,
      resistor:  COLORS.resistor,
      switch:    COLORS.switch_open,
      led:       COLORS.led_off,
      ammeter:   COLORS.ammeter,
      voltmeter: COLORS.voltmeter,
    };
    return map[type] || '#888';
  }

  function drawSymbol(c, result) {
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    const col = typeColor(c.type);
    const isActive = simRunning && result;

    ctx.save();
    ctx.strokeStyle = col;
    ctx.fillStyle   = col;
    ctx.lineWidth   = 2;
    ctx.lineCap     = 'round';

    if (c.type === 'battery') {
      // Símbolo de batería
      ctx.strokeStyle = COLORS.battery;
      // Cable izq
      ctx.beginPath(); ctx.moveTo(c.x + 4, cy); ctx.lineTo(cx - 18, cy); ctx.stroke();
      // Placas
      for (let i = 0; i < 2; i++) {
        const px = cx - 14 + i * 14;
        const tall = i % 2 === 0;
        ctx.lineWidth = tall ? 3 : 1.5;
        ctx.beginPath();
        ctx.moveTo(px, cy - (tall ? 12 : 8));
        ctx.lineTo(px, cy + (tall ? 12 : 8));
        ctx.stroke();
      }
      // Cable der
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx + 5, cy); ctx.lineTo(c.x + c.w - 4, cy); ctx.stroke();
      // + y −
      ctx.font = 'bold 10px Share Tech Mono';
      ctx.fillStyle = '#FFD700';
      ctx.fillText('+', cx - 22, cy - 14);
      ctx.fillStyle = '#888';
      ctx.fillText('−', cx + 8, cy - 14);

    } else if (c.type === 'resistor') {
      ctx.strokeStyle = COLORS.resistor;
      // Cable izq/der
      ctx.beginPath(); ctx.moveTo(c.x + 4, cy); ctx.lineTo(cx - 22, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + 22, cy); ctx.lineTo(c.x + c.w - 4, cy); ctx.stroke();
      // Rectángulo
      ctx.beginPath();
      ctx.rect(cx - 22, cy - 9, 44, 18);
      ctx.stroke();
      // Bandas de color
      const bands = ['#FF4444', '#888', '#FFD700'];
      bands.forEach((col, i) => {
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx - 11 + i * 10, cy - 9);
        ctx.lineTo(cx - 11 + i * 10, cy + 9);
        ctx.stroke();
      });

    } else if (c.type === 'switch') {
      const closed = c.closed;
      ctx.strokeStyle = closed ? COLORS.switch_closed : COLORS.switch_open;
      // Cable izq
      ctx.beginPath(); ctx.moveTo(c.x + 4, cy); ctx.lineTo(cx - 16, cy); ctx.stroke();
      // Punto izq
      ctx.beginPath(); ctx.arc(cx - 16, cy, 3, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle; ctx.fill();
      // Brazo del interruptor
      ctx.beginPath();
      ctx.moveTo(cx - 14, cy);
      if (closed) {
        ctx.lineTo(cx + 14, cy);
      } else {
        ctx.lineTo(cx + 14, cy - 14);
      }
      ctx.stroke();
      // Punto der
      ctx.beginPath(); ctx.arc(cx + 16, cy, 3, 0, Math.PI * 2); ctx.fill();
      // Cable der
      ctx.beginPath(); ctx.moveTo(cx + 16, cy); ctx.lineTo(c.x + c.w - 4, cy); ctx.stroke();

    } else if (c.type === 'led') {
      const on = isActive && result && result.I > 0.001;
      ctx.strokeStyle = on ? COLORS.led_on : COLORS.led_off;
      ctx.fillStyle   = on ? 'rgba(255,255,0,0.15)' : 'transparent';
      // Cables
      ctx.beginPath(); ctx.moveTo(c.x + 4, cy); ctx.lineTo(cx - 16, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + 16, cy); ctx.lineTo(c.x + c.w - 4, cy); ctx.stroke();
      // Círculo exterior
      ctx.beginPath(); ctx.arc(cx, cy, 15, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      // X interior
      ctx.beginPath();
      ctx.moveTo(cx - 8, cy - 8); ctx.lineTo(cx + 8, cy + 8);
      ctx.moveTo(cx + 8, cy - 8); ctx.lineTo(cx - 8, cy + 8);
      ctx.stroke();
      // Rayos si encendido
      if (on) {
        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = 1.5;
        for (let a = 0; a < 6; a++) {
          const angle = (a / 6) * Math.PI * 2 + animOffset * 0.05;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(angle) * 17, cy + Math.sin(angle) * 17);
          ctx.lineTo(cx + Math.cos(angle) * 22, cy + Math.sin(angle) * 22);
          ctx.stroke();
        }
      }

    } else if (c.type === 'ammeter' || c.type === 'voltmeter') {
      const col2 = c.type === 'ammeter' ? COLORS.ammeter : COLORS.voltmeter;
      ctx.strokeStyle = col2;
      ctx.fillStyle = 'transparent';
      // Cables
      ctx.beginPath(); ctx.moveTo(c.x + 4, cy); ctx.lineTo(cx - 14, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + 14, cy); ctx.lineTo(c.x + c.w - 4, cy); ctx.stroke();
      // Círculo
      ctx.beginPath(); ctx.arc(cx, cy, 13, 0, Math.PI * 2); ctx.stroke();
      // Letra
      ctx.fillStyle = col2;
      ctx.font = 'bold 13px Share Tech Mono';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.type === 'ammeter' ? 'A' : 'V', cx, cy + 1);
    }

    ctx.restore();
  }

  function drawTerminals(c) {
    const terms = getTerminals(c);
    terms.forEach((t, i) => {
      const hover = hoveredTerminal && hoveredTerminal.comp === c && hoveredTerminal.index === i;
      ctx.save();
      ctx.beginPath();
      ctx.arc(t.x, t.y, TERMINAL_R, 0, Math.PI * 2);
      ctx.fillStyle = hover ? COLORS.termHover
                    : drawingWire ? COLORS.termConnect
                    : (simRunning && simResult && simResult.closed) ? COLORS.termActive
                    : COLORS.termIdle;
      ctx.fill();
      ctx.strokeStyle = hover ? COLORS.termHover : '#000';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    });
  }

  function drawLabel(c, result) {
    ctx.save();
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.font         = '9px Share Tech Mono';
    ctx.fillStyle    = COLORS.textDim;

    let label = c.label;
    if (c.type === 'battery')  label += `\n${c.voltage}V`;
    if (c.type === 'resistor') label += `\n${c.resistance}Ω`;

    // Multiline
    const lines = label.split('\n');
    lines.forEach((line, i) => {
      ctx.fillText(line, c.x + c.w / 2, c.y + c.h - 14 + i * 10);
    });

    // Resultados de simulación sobre el componente
    if (result && simRunning) {
      ctx.font      = '9px Share Tech Mono';
      ctx.fillStyle = simResult.closed ? COLORS.wireActive : COLORS.textDim;
      const info = `I=${fmtI(result.I)}  P=${fmtP(result.P)}`;
      ctx.fillText(info, c.x + c.w / 2, c.y + 2);
    }

    ctx.restore();
  }

  function drawBurnEffect(c) {
    ctx.save();
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Parpadeo
    const alpha = 0.5 + 0.5 * Math.sin(animOffset * 0.2);
    ctx.globalAlpha = alpha;
    ctx.fillText('💥', c.x + c.w / 2, c.y + c.h / 2);
    ctx.restore();
  }

  function drawElectrons() {
    if (!simResult.closed) return;
    // Animar partículas sobre cada cable activo
    wires.forEach(w => {
      const fromComp = getCompById(w.fromComp);
      const toComp   = getCompById(w.toComp);
      if (!fromComp || !toComp) return;

      const p1 = getTerminals(fromComp)[w.fromTerm];
      const p2 = getTerminals(toComp)[w.toTerm];

      // 3 partículas por cable
      for (let i = 0; i < 3; i++) {
        const t = ((animOffset * 0.012 + i / 3) % 1);
        const ex = p1.x + (p2.x - p1.x) * t;
        const ey = p1.y + (p2.y - p1.y) * t;

        ctx.save();
        ctx.beginPath();
        ctx.arc(ex, ey, 3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(57,211,83,0.9)';
        ctx.shadowColor = '#39d353';
        ctx.shadowBlur  = 6;
        ctx.fill();
        ctx.restore();
      }
    });
  }

  // ============================================================
  // UTILIDADES CANVAS
  // ============================================================
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function fmtI(v) {
    if (!isFinite(v)) return '∞A';
    if (v >= 1) return v.toFixed(2) + 'A';
    return (v * 1000).toFixed(1) + 'mA';
  }
  function fmtP(v) {
    if (!isFinite(v)) return '∞W';
    if (v >= 1) return v.toFixed(2) + 'W';
    return (v * 1000).toFixed(1) + 'mW';
  }

  // ============================================================
  // HIT TESTING
  // ============================================================
  function getCompById(id) {
    return components.find(c => c.id === id);
  }

  function compAt(x, y) {
    // Buscar de atrás hacia adelante (último colocado = encima)
    for (let i = components.length - 1; i >= 0; i--) {
      const c = components[i];
      if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return c;
    }
    return null;
  }

  let hoveredTerminal = null;

  function terminalAt(x, y, excludeComp) {
    for (const c of components) {
      if (c === excludeComp) continue;
      const terms = getTerminals(c);
      for (let i = 0; i < terms.length; i++) {
        const t = terms[i];
        const d = Math.hypot(t.x - x, t.y - y);
        if (d <= TERMINAL_R + 4) return { comp: c, index: i, x: t.x, y: t.y };
      }
    }
    return null;
  }

  function ownTerminalAt(comp, x, y) {
    const terms = getTerminals(comp);
    for (let i = 0; i < terms.length; i++) {
      const t = terms[i];
      if (Math.hypot(t.x - x, t.y - y) <= TERMINAL_R + 4) return i;
    }
    return -1;
  }

  function wireAt(x, y) {
    for (const w of wires) {
      const fromComp = getCompById(w.fromComp);
      const toComp   = getCompById(w.toComp);
      if (!fromComp || !toComp) continue;
      const p1 = getTerminals(fromComp)[w.fromTerm];
      const p2 = getTerminals(toComp)[w.toTerm];
      if (distPointToSegment(x, y, p1.x, p1.y, p2.x, p2.y) < WIRE_HIT) return w;
    }
    return null;
  }

  function distPointToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // ============================================================
  // ANIMACIÓN LOOP
  // ============================================================
  function startAnimLoop() {
    if (animRAF) return;
    function loop() {
      animOffset++;
      render();
      animRAF = requestAnimationFrame(loop);
    }
    animRAF = requestAnimationFrame(loop);
  }

  function stopAnimLoop() {
    if (animRAF) cancelAnimationFrame(animRAF);
    animRAF = null;
  }

  // ============================================================
  // EVENTOS DEL CANVAS
  // ============================================================
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup',   onMouseUp);
  canvas.addEventListener('dblclick',  onDblClick);
  canvas.addEventListener('contextmenu', e => { e.preventDefault(); onRightClick(e); });

  function canvasXY(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onMouseDown(e) {
    const { x, y } = canvasXY(e);

    // ¿Clic en terminal propio? → empezar a dibujar cable
    if (!drawingWire) {
      for (const c of components) {
        const ti = ownTerminalAt(c, x, y);
        if (ti !== -1) {
          const t = getTerminals(c)[ti];
          drawingWire = true;
          wireStart   = { comp: c, termIndex: ti, x: t.x, y: t.y };
          selectedComp = null;
          selectedWire = null;
          setStatus('Arrastrando cable — haz clic en otro terminal para conectar');
          return;
        }
      }
    }

    // ¿Hay cable siendo dibujado y clic en terminal objetivo?
    if (drawingWire) {
      const target = terminalAt(x, y, wireStart.comp);
      if (target) {
        connectWire(wireStart.comp, wireStart.termIndex, target.comp, target.index);
      }
      drawingWire = false;
      wireStart   = null;
      render();
      return;
    }

    // ¿Clic en componente?
    const c = compAt(x, y);
    if (c) {
      selectComponent(c);
      dragging  = true;
      dragComp  = c;
      dragOffX  = x - c.x;
      dragOffY  = y - c.y;
      return;
    }

    // ¿Clic en cable?
    const w = wireAt(x, y);
    if (w) {
      selectedComp = null;
      selectedWire = w;
      updatePropsPanel(null);
      render();
      return;
    }

    // Clic en vacío → deseleccionar
    selectedComp = null;
    selectedWire = null;
    updatePropsPanel(null);
    render();
  }

  function onMouseMove(e) {
    const { x, y } = canvasXY(e);
    document.getElementById('status-coords').textContent = `x:${Math.round(x)}  y:${Math.round(y)}`;

    // Hover de terminal
    const prevHovered = hoveredTerminal;
    hoveredTerminal = terminalAt(x, y, null);
    if (hoveredTerminal !== prevHovered) render();

    // Arrastrar cable
    if (drawingWire) {
      wireMouseX = x;
      wireMouseY = y;
      render();
      return;
    }

    // Mover componente
    if (dragging && dragComp) {
      dragComp.x = snapGrid(x - dragOffX);
      dragComp.y = snapGrid(y - dragOffY);
      render();
      if (simRunning) runSimulation();
      return;
    }

    // Tooltip sobre componente
    const c = compAt(x, y);
    if (c && simRunning && simResult) {
      const res = simResult.componentResults[c.id];
      if (res) showTooltip(e, c, res);
      else hideTooltip();
    } else {
      hideTooltip();
    }
  }

  function onMouseUp(e) {
    dragging = false;
    dragComp = null;
  }

  function onDblClick(e) {
    const { x, y } = canvasXY(e);
    const c = compAt(x, y);
    if (c) {
      if (c.type === 'switch') {
        c.closed = !c.closed;
        setStatus(`Interruptor ${c.id}: ${c.closed ? 'cerrado' : 'abierto'}`);
        if (simRunning) runSimulation();
        render();
      } else {
        openPropsModal(c);
      }
    }
  }

  function onRightClick(e) {
    const { x, y } = canvasXY(e);
    const c = compAt(x, y);
    if (c) openPropsModal(c);
  }

  // ============================================================
  // DRAG DESDE PALETA
  // ============================================================
  document.querySelectorAll('.palette-item').forEach(item => {
    item.addEventListener('dragstart', e => {
      e.dataTransfer.setData('component-type', item.dataset.type);
    });
    item.addEventListener('click', () => {
      // Clic en paleta → colocar en centro del canvas
      const cx = canvas.width  / 2 + (Math.random() - 0.5) * 100;
      const cy = canvas.height / 2 + (Math.random() - 0.5) * 60;
      addComponent(item.dataset.type, cx, cy);
    });
  });

  canvas.addEventListener('dragover', e => { e.preventDefault(); });
  canvas.addEventListener('drop', e => {
    e.preventDefault();
    const type = e.dataTransfer.getData('component-type');
    if (!type) return;
    const { x, y } = canvasXY(e);
    addComponent(type, x, y);
  });

  function addComponent(type, x, y) {
    const c = createComponent(type, x, y);
    components.push(c);
    selectComponent(c);
    document.getElementById('canvas-hint').classList.add('hidden');
    setStatus(`Añadido: ${c.label} (${c.id})`);
    render();
    if (simRunning) runSimulation();
  }

  // ============================================================
  // CABLE
  // ============================================================
  function connectWire(fromComp, fromTerm, toComp, toTerm) {
    // Evitar duplicados
    const dup = wires.find(w =>
      (w.fromComp === fromComp.id && w.fromTerm === fromTerm && w.toComp === toComp.id && w.toTerm === toTerm) ||
      (w.fromComp === toComp.id  && w.fromTerm === toTerm   && w.toComp === fromComp.id && w.toTerm === fromTerm)
    );
    if (dup) { setStatus('Los terminales ya están conectados'); return; }

    wires.push({
      id: `w${nextId++}`,
      fromComp: fromComp.id, fromTerm,
      toComp:   toComp.id,   toTerm,
    });
    setStatus(`Conectado ${fromComp.id}[${fromTerm}] → ${toComp.id}[${toTerm}]`);
    if (simRunning) runSimulation();
    render();
  }

  // ============================================================
  // SELECCIÓN Y BORRADO
  // ============================================================
  function selectComponent(c) {
    selectedComp = c;
    selectedWire = null;
    updatePropsPanel(c);
    render();
  }

  function deleteSelected() {
    if (selectedComp) {
      const id = selectedComp.id;
      components = components.filter(c => c !== selectedComp);
      wires      = wires.filter(w => w.fromComp !== id && w.toComp !== id);
      selectedComp = null;
      updatePropsPanel(null);
      setStatus('Componente eliminado');
    } else if (selectedWire) {
      wires = wires.filter(w => w !== selectedWire);
      selectedWire = null;
      setStatus('Cable eliminado');
    }
    if (simRunning) runSimulation();
    render();
  }

  // ============================================================
  // PANEL DE PROPIEDADES (sidebar)
  // ============================================================
  function updatePropsPanel(c) {
    const content = document.getElementById('props-content');
    if (!c) {
      content.innerHTML = '<p class="props-hint">Selecciona un componente en el lienzo para editar sus propiedades.</p>';
      return;
    }

    let html = `
      <div class="prop-title">${iconForType(c.type)} ${c.label}</div>
      <div class="prop-id">ID: ${c.id}</div>
      <div class="prop-form">
        <div class="form-group">
          <label>Nombre:</label>
          <input type="text" id="p-label" value="${c.label}" />
        </div>`;

    if (c.type === 'battery') {
      html += `<div class="form-group"><label>Voltaje (V):</label>
               <input type="number" id="p-voltage" value="${c.voltage}" min="0.1" step="0.5" /></div>`;
    }
    if (c.type === 'resistor' || c.type === 'led') {
      html += `<div class="form-group"><label>Resistencia (Ω):</label>
               <input type="number" id="p-resistance" value="${c.resistance}" min="0.1" step="1" /></div>
               <div class="form-group"><label>Potencia máx (W):</label>
               <input type="number" id="p-maxpower" value="${c.maxPower}" min="0.01" step="0.1" /></div>`;
    }
    if (c.type === 'switch') {
      html += `<div class="form-group"><label>Estado:</label>
               <select id="p-switch-state">
                 <option value="open"   ${!c.closed  ? 'selected' : ''}>Abierto</option>
                 <option value="closed" ${c.closed   ? 'selected' : ''}>Cerrado</option>
               </select></div>`;
    }

    html += `<button class="action-btn btn-primary apply-props-btn" id="btn-apply-props">Aplicar</button>
             </div>`;

    // Resultados de sim en el panel
    const res = simResult && simResult.componentResults[c.id];
    if (res) {
      html += `<div style="margin-top:10px;border-top:1px solid #30363d;padding-top:8px;">
        <div class="comp-badge">V = ${res.V} V</div>
        <div class="comp-badge">I = ${fmtI(res.I)}</div>
        <div class="comp-badge">R = ${res.R} Ω</div>
        <div class="comp-badge">P = ${fmtP(res.P)}</div>
        ${res.burned ? '<div style="color:#f85149;font-family:monospace;font-size:11px;margin-top:4px;">⚠ Componente sobrecargado</div>' : ''}
      </div>`;
    }

    content.innerHTML = html;

    document.getElementById('btn-apply-props').addEventListener('click', () => applyProps(c));
  }

  function applyProps(c) {
    const labelEl = document.getElementById('p-label');
    if (labelEl) c.label = labelEl.value;

    if (c.type === 'battery') {
      const v = parseFloat(document.getElementById('p-voltage').value);
      if (!isNaN(v) && v > 0) c.voltage = v;
    }
    if (c.type === 'resistor' || c.type === 'led') {
      const r = parseFloat(document.getElementById('p-resistance').value);
      const p = parseFloat(document.getElementById('p-maxpower').value);
      if (!isNaN(r) && r > 0) c.resistance = r;
      if (!isNaN(p) && p > 0) c.maxPower = p;
    }
    if (c.type === 'switch') {
      c.closed = document.getElementById('p-switch-state').value === 'closed';
    }

    if (simRunning) runSimulation();
    render();
    updatePropsPanel(c);
    setStatus(`Propiedades de ${c.id} actualizadas`);
  }

  function iconForType(type) {
    const m = { battery:'🔋', resistor:'⬜', switch:'🔌', led:'💡', ammeter:'⭕', voltmeter:'🔵' };
    return m[type] || '⚙';
  }

  // ============================================================
  // MODAL DE PROPIEDADES (doble clic)
  // ============================================================
  function openPropsModal(c) {
    const overlay = document.getElementById('modal-overlay');
    const title   = document.getElementById('modal-title');
    const body    = document.getElementById('modal-body');

    title.textContent = `Propiedades — ${c.label} (${c.id})`;

    let html = `<div class="prop-form">
      <div class="form-group"><label>Nombre:</label>
        <input type="text" id="m-label" value="${c.label}" /></div>`;

    if (c.type === 'battery') {
      html += `<div class="form-group"><label>Voltaje (V):</label>
               <input type="number" id="m-voltage" value="${c.voltage}" min="0.1" step="0.5" /></div>`;
    }
    if (c.type === 'resistor' || c.type === 'led') {
      html += `<div class="form-group"><label>Resistencia (Ω):</label>
               <input type="number" id="m-resistance" value="${c.resistance}" min="0.1" step="1" /></div>
               <div class="form-group"><label>Potencia máx (W):</label>
               <input type="number" id="m-maxpower" value="${c.maxPower}" min="0.01" step="0.1" /></div>`;
    }
    html += '</div>';
    body.innerHTML = html;
    overlay.classList.remove('hidden');

    document.getElementById('modal-ok').onclick = () => {
      const lbl = document.getElementById('m-label');
      if (lbl) c.label = lbl.value;
      if (c.type === 'battery') {
        const v = parseFloat(document.getElementById('m-voltage').value);
        if (!isNaN(v) && v > 0) c.voltage = v;
      }
      if (c.type === 'resistor' || c.type === 'led') {
        const r = parseFloat(document.getElementById('m-resistance').value);
        const p = parseFloat(document.getElementById('m-maxpower').value);
        if (!isNaN(r) && r > 0) c.resistance = r;
        if (!isNaN(p) && p > 0) c.maxPower = p;
      }
      overlay.classList.add('hidden');
      if (simRunning) runSimulation();
      render();
      updatePropsPanel(c);
    };

    document.getElementById('modal-cancel').onclick = () => {
      overlay.classList.add('hidden');
    };
  }

  // ============================================================
  // SIMULACIÓN
  // ============================================================
  function runSimulation() {
    simResult = Solver.solve({ components, wires });
    updateResultsPanel();
    // Marcar componentes quemados
    components.forEach(c => {
      const res = simResult.componentResults[c.id];
      c.burned = res ? res.burned : false;
    });
    render();
  }

  function updateResultsPanel() {
    if (!simResult) return;
    const statusEl = document.getElementById('res-status');
    statusEl.textContent = simResult.closed ? 'Cerrado ✓' : 'Abierto';
    statusEl.className   = 'result-value ' + (simResult.closed ? 'status-closed' : 'status-open');

    document.getElementById('res-voltage').textContent    = simResult.closed ? `${simResult.V} V`   : '— V';
    document.getElementById('res-current').textContent    = simResult.closed ? fmtI(simResult.I)    : '— A';
    document.getElementById('res-resistance').textContent = simResult.closed ? `${simResult.R} Ω`   : '— Ω';
    document.getElementById('res-power').textContent      = simResult.closed ? fmtP(simResult.P)    : '— W';
  }

  // ============================================================
  // TOOLTIP
  // ============================================================
  function showTooltip(e, c, res) {
    tooltip.innerHTML = `
      <b>${c.label}</b><br>
      V = ${res.V} V<br>
      I = ${fmtI(res.I)}<br>
      R = ${res.R} Ω<br>
      P = ${fmtP(res.P)}
      ${res.burned ? '<br>⚠ Sobrecargado' : ''}
    `;
    tooltip.style.display = 'block';
    const r = canvas.getBoundingClientRect();
    let tx = (e.clientX - r.left) + 12;
    let ty = (e.clientY - r.top)  + 12;
    if (tx + 160 > canvas.width) tx -= 170;
    tooltip.style.left = tx + 'px';
    tooltip.style.top  = ty + 'px';
  }
  function hideTooltip() { tooltip.style.display = 'none'; }

  // ============================================================
  // STATUS BAR
  // ============================================================
  function setStatus(msg) {
    document.getElementById('status-msg').textContent = msg;
  }

  // ============================================================
  // BOTONES DE ACCIÓN
  // ============================================================
  document.getElementById('btn-simulate').addEventListener('click', () => {
    simRunning = true;
    document.body.classList.add('simulating');
    runSimulation();
    startAnimLoop();
    setStatus('▶ Simulando…');
  });

  document.getElementById('btn-stop').addEventListener('click', () => {
    simRunning = false;
    simResult  = null;
    document.body.classList.remove('simulating');
    components.forEach(c => c.burned = false);
    stopAnimLoop();
    updateResultsPanel();
    render();
    setStatus('■ Simulación detenida');
    // Reset results
    document.getElementById('res-status').textContent = 'Abierto';
    document.getElementById('res-status').className   = 'result-value status-open';
    ['res-voltage','res-current','res-resistance','res-power'].forEach(id => {
      document.getElementById(id).textContent = '—';
    });
  });

  document.getElementById('btn-delete').addEventListener('click', deleteSelected);

  document.getElementById('btn-clear').addEventListener('click', () => {
    if (!confirm('¿Borrar todo el circuito?')) return;
    components = []; wires = [];
    selectedComp = null; selectedWire = null;
    simResult = null; simRunning = false;
    document.body.classList.remove('simulating');
    stopAnimLoop();
    document.getElementById('canvas-hint').classList.remove('hidden');
    updatePropsPanel(null);
    render();
    setStatus('Lienzo limpiado');
  });

  // ============================================================
  // TECLADO
  // ============================================================
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      deleteSelected();
    }
    if (e.key === ' ') {
      e.preventDefault();
      if (!simRunning) document.getElementById('btn-simulate').click();
    }
    if (e.key === 'Escape') {
      drawingWire  = false;
      wireStart    = null;
      selectedComp = null;
      selectedWire = null;
      updatePropsPanel(null);
      render();
      setStatus('Listo');
    }
  });

  // ============================================================
  // RESISTIVIDAD (panel lateral)
  // ============================================================
  document.getElementById('rho-material').addEventListener('change', function() {
    document.getElementById('rho-custom-group').style.display =
      this.value === 'custom' ? 'block' : 'none';
  });

  document.getElementById('btn-calc-rho').addEventListener('click', () => {
    const matSel = document.getElementById('rho-material');
    const rho    = matSel.value === 'custom'
                   ? parseFloat(document.getElementById('rho-custom').value)
                   : parseFloat(matSel.value);
    const L    = parseFloat(document.getElementById('rho-length').value);
    const Amm2 = parseFloat(document.getElementById('rho-area').value);

    if (isNaN(rho) || isNaN(L) || isNaN(Amm2) || Amm2 <= 0 || L <= 0) {
      alert('Por favor introduce valores válidos y positivos.');
      return;
    }

    const R = Solver.calcResistivity(rho, L, Amm2);
    const A_m2 = Amm2 * 1e-6;

    const resultDiv = document.getElementById('rho-result');
    resultDiv.innerHTML = `
      ρ = ${rho.toExponential(3)} Ω·m<br>
      L = ${L} m<br>
      A = ${Amm2} mm² = ${A_m2.toExponential(3)} m²<br>
      <b>R = ρL/A = ${Solver.round(R)} Ω</b>
    `;
    resultDiv.style.display = 'block';

    // Si hay una resistencia seleccionada, ofrecer aplicar el valor
    if (selectedComp && (selectedComp.type === 'resistor' || selectedComp.type === 'led')) {
      if (confirm(`¿Aplicar R = ${Solver.round(R)} Ω al componente "${selectedComp.label}"?`)) {
        selectedComp.resistance = Solver.round(R);
        if (simRunning) runSimulation();
        render();
        updatePropsPanel(selectedComp);
      }
    }
  });

  // ============================================================
  // INICIO
  // ============================================================
  setStatus('Listo — arrastra un componente al lienzo para comenzar');
  render();

})();
