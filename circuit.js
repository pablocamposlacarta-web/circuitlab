/**
 * solver.js — Motor matemático de circuitos
 * Resuelve circuitos en serie y paralelo usando análisis nodal simplificado.
 * Calcula V, I, R, P para cada componente.
 */

const Solver = (() => {

  /**
   * Calcula la resistencia de un cable mediante resistividad.
   * R = ρ · L / A
   * @param {number} rho  — resistividad en Ω·m
   * @param {number} L    — longitud en metros
   * @param {number} Amm2 — sección transversal en mm²
   * @returns {number} resistencia en Ω
   */
  function calcResistivity(rho, L, Amm2) {
    const A = Amm2 * 1e-6; // mm² → m²
    if (A <= 0 || L <= 0) return Infinity;
    return (rho * L) / A;
  }

  /**
   * Análisis nodal simplificado para el grafo de un circuito.
   * Soporta: baterías, resistencias, interruptores abiertos/cerrados,
   *          LEDs (resistencia fija equivalente), amperímetros (0 Ω),
   *          voltímetros (∞ Ω — no modifican el circuito principal).
   *
   * Algoritmo:
   *  1. Construye el grafo de nodos (union-find) a partir de los cables.
   *  2. Localiza la batería (o baterías en serie equivalente).
   *  3. Determina si el circuito está cerrado.
   *  4. Calcula la resistencia equivalente total.
   *  5. Aplica Ley de Ohm y distribuye corrientes/voltajes.
   *
   * @param {Object} state — estado completo del circuito desde circuit.js
   * @returns {Object} resultados { closed, V, I, R, P, components[] }
   */
  function solve(state) {
    const { components, wires } = state;

    // Resultado vacío por defecto
    const empty = {
      closed: false,
      V: 0, I: 0, R: Infinity, P: 0,
      statusText: 'Circuito abierto',
      componentResults: {}
    };

    if (!components.length || !wires.length) return empty;

    // ---------- 1. Union-Find para nodos ----------
    // Cada terminal es un nodo identificado por "compId_terminalIndex"
    const parent = {};
    function find(x) {
      if (parent[x] === undefined) parent[x] = x;
      if (parent[x] !== x) parent[x] = find(parent[x]);
      return parent[x];
    }
    function union(a, b) {
      parent[find(a)] = find(b);
    }

    // Conectar terminales según cables
    wires.forEach(w => {
      if (w.fromComp && w.toComp) {
        const a = `${w.fromComp}_${w.fromTerm}`;
        const b = `${w.toComp}_${w.toTerm}`;
        union(a, b);
      }
    });

    // ---------- 2. Localizar baterías e interruptores abiertos ----------
    const batteries = components.filter(c => c.type === 'battery');
    const openSwitches = components.filter(c => c.type === 'switch' && !c.closed);

    if (!batteries.length) return { ...empty, statusText: 'Sin fuente de voltaje' };

    // Voltaje total (baterías en serie sumadas)
    const Vtotal = batteries.reduce((s, b) => s + (b.voltage || 9), 0);

    // ---------- 3. Comprobar si hay interruptores abiertos en el camino ----------
    // Un interruptor abierto actúa como un cable inexistente → rompe el circuito.
    // (Ya se maneja porque sus terminales NO están unidos en el union-find si no están cerrados)

    // ---------- 4. Construir topología y detectar circuito cerrado ----------
    // El circuito está cerrado si el terminal + de la batería y el terminal − están
    // en el mismo componente conectado (excluyendo la propia batería).

    // Para cada batería tomamos terminal 0 (positivo) y terminal 1 (negativo).
    // Si todas están en serie podemos considerar la primera batería.
    const bat = batteries[0];
    const batPos = find(`${bat.id}_0`);
    const batNeg = find(`${bat.id}_1`);

    // El circuito está cerrado si existe un camino de retorno (pos ≠ neg en nodos distintos
    // pero conectados a través de otros componentes)
    if (batPos === batNeg) {
      // Cortocircuito directo (no debería suceder con UX normal, pero por seguridad)
      return { ...empty, closed: true, V: Vtotal, I: Infinity, R: 0, P: Infinity, statusText: 'Cortocircuito ⚠' };
    }

    // Recorrer componentes para ver si forman un camino cerrado
    // Clasificamos cada componente no-batería como rama entre sus dos terminales
    const resistiveComps = components.filter(c => c.type !== 'battery' && c.type !== 'voltmeter');

    // Verificar circuito cerrado: algún componente conecta (directa o transitivamente)
    // batPos con batNeg
    let closed = false;
    for (const c of resistiveComps) {
      const t0 = find(`${c.id}_0`);
      const t1 = find(`${c.id}_1`);
      // Si este componente une ambos lados de la batería → hay camino
      if ((t0 === batPos && t1 === batNeg) || (t0 === batNeg && t1 === batPos)) {
        closed = true;
        break;
      }
    }

    if (!closed) return { ...empty, statusText: 'Circuito abierto' };

    // ---------- 5. Calcular resistencia equivalente ----------
    // Identificamos los grupos de componentes conectados entre los dos nodos de la batería.
    // Rama paralela: múltiples componentes comparten los mismos nodos terminales.
    // Rama serie: componentes encadenados.

    // Representamos el circuito como un grafo de resistencias entre nodos.
    // Usamos el algoritmo simplificado: construir lista de ramas y reducir.

    // Ramas: { r: resistencia, nodes: [nodeA, nodeB], compId }
    const branches = [];

    for (const c of resistiveComps) {
      const t0 = find(`${c.id}_0`);
      const t1 = find(`${c.id}_1`);

      // Si los dos terminales están en el mismo nodo → cortocircuito local (bypass)
      if (t0 === t1) continue; // No contribuye

      let r = 0;
      if (c.type === 'resistor') {
        r = c.resistance || 100;
      } else if (c.type === 'switch') {
        r = c.closed ? 0.001 : Infinity; // cerrado ≈ 0, abierto ≈ ∞
      } else if (c.type === 'led') {
        r = c.resistance || 470; // resistencia equivalente del LED
      } else if (c.type === 'ammeter') {
        r = 0.001; // amperímetro ideal ≈ 0Ω
      }

      if (r < Infinity) {
        branches.push({ r, nodes: [t0, t1], compId: c.id, comp: c });
      }
    }

    if (!branches.length) return { ...empty, statusText: 'Sin componentes resistivos' };

    // Reducción del circuito: agrupamos ramas entre los mismos pares de nodos (paralelo)
    // luego intentamos serie si hay un único camino lineal.

    // Mapa: "nodeA_nodeB" → array de ramas
    const branchMap = {};
    for (const b of branches) {
      const key = [b.nodes[0], b.nodes[1]].sort().join('|');
      if (!branchMap[key]) branchMap[key] = [];
      branchMap[key].push(b);
    }

    // Resistencia equivalente por grupo (paralelo dentro del mismo par de nodos)
    const groupResistances = {};
    for (const [key, branchList] of Object.entries(branchMap)) {
      let Req;
      if (branchList.length === 1) {
        Req = branchList[0].r;
      } else {
        // Paralelo: 1/Req = Σ(1/ri)
        const inv = branchList.reduce((s, b) => s + (b.r > 0 ? 1 / b.r : 1e9), 0);
        Req = inv > 0 ? 1 / inv : Infinity;
      }
      groupResistances[key] = { Req, branches: branchList };
    }

    // Suma serie de todos los grupos (suponemos circuito serie/paralelo simple)
    // Para circuitos más complejos este paso encadena los grupos.
    let Rtotal = Object.values(groupResistances).reduce((s, g) => s + g.Req, 0);
    if (Rtotal <= 0) Rtotal = 0.001;

    // ---------- 6. Ley de Ohm global ----------
    const Itotal = Vtotal / Rtotal;
    const Ptotal = Vtotal * Itotal;

    // ---------- 7. Distribuir V, I, P a cada componente ----------
    const componentResults = {};

    // Corriente total a través de componentes en serie es la misma.
    // Para paralelos, dividir por conductancia.
    for (const [key, group] of Object.entries(groupResistances)) {
      const Vgroup = Itotal * group.Req; // voltaje en este grupo

      for (const b of group.branches) {
        let Ibranch, Vbranch, Pbranch;

        if (group.branches.length === 1) {
          // Serie
          Ibranch = Itotal;
          Vbranch = Vgroup;
        } else {
          // Paralelo: Ibranch = Vgroup / r
          Ibranch = b.r > 0 ? Vgroup / b.r : 0;
          Vbranch = Vgroup;
        }
        Pbranch = Vbranch * Ibranch;

        componentResults[b.compId] = {
          V: round(Vbranch),
          I: round(Ibranch),
          R: round(b.r),
          P: round(Pbranch),
          burned: Pbranch > (b.comp.maxPower || 0.5)
        };
      }
    }

    // Resultado de la batería
    batteries.forEach(bat => {
      componentResults[bat.id] = {
        V: round(bat.voltage || 9),
        I: round(Itotal),
        R: 0,
        P: round(Ptotal)
      };
    });

    return {
      closed: true,
      V: round(Vtotal),
      I: round(Itotal),
      R: round(Rtotal),
      P: round(Ptotal),
      statusText: 'Circuito cerrado ✓',
      componentResults
    };
  }

  function round(v, d = 4) {
    if (!isFinite(v)) return v;
    return +v.toPrecision(4);
  }

  // ----------------------------------------------------------------
  // Resistividad
  // ----------------------------------------------------------------
  const MATERIALS = {
    'Cobre (Cu)':    1.72e-8,
    'Aluminio (Al)': 2.82e-8,
    'Plata (Ag)':    1.59e-8,
    'Tungsteno (W)': 5.6e-8,
    'Hierro (Fe)':   1.0e-6,
  };

  return { solve, calcResistivity, MATERIALS, round };

})();
