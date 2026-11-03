// ============================================================================
// T-CREST Lab core: Patmos-style assembly -> cycle-level simulator
//                   + platin-style static WCET analysis (CFG, loops, IPET/LP)
// A didactic model of ideas from T-CREST (Patmos, method cache, stack cache,
// scratchpad, platin). Timing numbers are configurable, not the real hardware.
// ============================================================================
(function (global) {
  'use strict';

  const DEFAULTS = {
    memLatency: 21,     // cycles for one main-memory transfer (a cache line or a single word)
    dcacheSets: 4,      // direct-mapped data cache: number of lines
    dcacheLine: 4,      // words per line
    mcBlocks: 16,       // method cache: number of blocks
    mcBlockWords: 4,    // words per method cache block
    scWords: 16,        // stack cache size in words
  };

  // ------------------------------------------------------------- assembler
  const R = (s, ln) => {
    const m = /^r(\d+)$/.exec(s);
    if (!m || +m[1] > 31) throw new Error('Line ' + ln + ': expected a register r0..r31, found "' + s + '"');
    return +m[1];
  };
  const P = (s, ln) => {
    const m = /^(!?)p([0-7])$/.exec(s);
    if (!m) throw new Error('Line ' + ln + ': expected a predicate p0..p7, found "' + s + '"');
    return { n: +m[2], neg: !!m[1] };
  };
  const IMM = (s, ln) => {
    if (!/^-?\d+$/.test(s)) throw new Error('Line ' + ln + ': expected a number, found "' + s + '"');
    return parseInt(s, 10);
  };
  const MEM = (s, ln) => {
    const m = /^\[\s*(r\d+)\s*(?:([+-])\s*(\d+))?\s*\]$/.exec(s);
    if (!m) throw new Error('Line ' + ln + ': expected a memory operand like [r1 + 4], found "' + s + '"');
    return { base: R(m[1], ln), off: m[2] === '-' ? -+m[3] : +(m[3] || 0) };
  };

  const ALU = { add: (a, b) => a + b, sub: (a, b) => a - b, and: (a, b) => a & b, or: (a, b) => a | b, xor: (a, b) => a ^ b, sl: (a, b) => a << b, sr: (a, b) => a >>> b, mul: (a, b) => Math.imul(a, b) };
  const CMP = { eq: (a, b) => a === b, neq: (a, b) => a !== b, lt: (a, b) => a < b, le: (a, b) => a <= b, ult: (a, b) => (a >>> 0) < (b >>> 0) };
  const LOADS = { lwc: 'dcache', lwm: 'main', lwl: 'spm', lws: 'stack' };
  const STORES = { swc: 'dcache', swm: 'main', swl: 'spm', sws: 'stack' };

  function parseInst(text, ln) {
    let t = text.trim();
    let guard = { n: 0, neg: false };
    const g = /^\(\s*(!?p[0-7])\s*\)\s*(.*)$/.exec(t);
    if (g) { guard = P(g[1], ln); t = g[2]; }
    const sp = t.indexOf(' ');
    const op = (sp < 0 ? t : t.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : t.slice(sp + 1).trim();
    const I = { op, guard, text: text.trim(), line: ln, reads: [], writes: [], preadsExtra: [] };
    const lhsrhs = () => {
      const k = rest.indexOf('=');
      if (k < 0) throw new Error('Line ' + ln + ': "' + op + '" needs the form  dst = src');
      return [rest.slice(0, k).trim(), rest.slice(k + 1).split(',').map((x) => x.trim())];
    };
    let m;
    if (op === 'nop' || op === 'halt' || op === 'retnd') { I.kind = op; }
    else if (op === 'li') { const [d, [v]] = lhsrhs(); I.kind = 'li'; I.rd = R(d, ln); I.imm = IMM(v, ln); }
    else if (op === 'mov') { const [d, [s]] = lhsrhs(); I.kind = 'alu'; I.fn = 'add'; I.rd = R(d, ln); I.rs = R(s, ln); I.rt = 0; }
    else if ((m = /^(add|sub|and|or|xor|sl|sr|mul)(i?)$/.exec(op))) {
      const [d, a] = lhsrhs();
      if (a.length !== 2) throw new Error('Line ' + ln + ': "' + op + '" needs two source operands');
      I.kind = 'alu'; I.fn = m[1]; I.rd = R(d, ln); I.rs = R(a[0], ln);
      if (m[2]) I.imm = IMM(a[1], ln); else I.rt = R(a[1], ln);
    }
    else if ((m = /^cmp(i?)(eq|neq|lt|le|ult)$/.exec(op))) {
      const [d, a] = lhsrhs();
      I.kind = 'cmp'; I.fn = m[2]; I.pd = P(d, ln).n; I.rs = R(a[0], ln);
      if (m[1]) I.imm = IMM(a[1], ln); else I.rt = R(a[1], ln);
    }
    else if ((m = /^p(and|or|xor|mov|not)$/.exec(op))) {
      const [d, a] = lhsrhs();
      I.kind = 'pred'; I.fn = m[1]; I.pd = P(d, ln).n; I.ps = P(a[0], ln); I.pt = a[1] ? P(a[1], ln) : null;
    }
    else if (LOADS[op]) { const [d, [a]] = lhsrhs(); I.kind = 'load'; I.space = LOADS[op]; I.rd = R(d, ln); I.mem = MEM(a, ln); }
    else if (STORES[op]) {
      const k = rest.indexOf('=');
      if (k < 0) throw new Error('Line ' + ln + ': store needs the form  [rX + off] = rY');
      I.kind = 'store'; I.space = STORES[op]; I.mem = MEM(rest.slice(0, k).trim(), ln); I.rt = R(rest.slice(k + 1).trim(), ln);
    }
    else if (op === 'br' || op === 'brnd') { I.kind = op; I.target = rest; if (!rest) throw new Error('Line ' + ln + ': branch needs a label'); }
    else if (op === 'callnd') { I.kind = 'call'; I.target = rest; if (!rest) throw new Error('Line ' + ln + ': callnd needs a function name'); }
    else if (op === 'sres' || op === 'sfree') { I.kind = op; I.n = IMM(rest, ln); if (I.n < 0) throw new Error('Line ' + ln + ': negative size'); }
    else throw new Error('Line ' + ln + ': unknown instruction "' + op + '"');
    // register read/write sets (for hazards)
    if (I.rs != null) I.reads.push(I.rs);
    if (I.rt != null) I.reads.push(I.rt);
    if (I.mem) I.reads.push(I.mem.base);
    if (I.rd != null) I.writes.push(I.rd);
    return I;
  }

  function assemble(src) {
    const lines = src.split('\n');
    const bundles = [];
    const labels = {};
    const funcs = [];
    const bounds = {}; // bundle index -> bound
    const mem = {}, spm = {};
    let pendingBound = null, cur = null;
    lines.forEach((raw, i) => {
      const ln = i + 1;
      let s = raw.replace(/(#|\/\/).*$/, '').trim();
      if (!s) return;
      let lm;
      while ((lm = /^([A-Za-z_]\w*):\s*(.*)$/.exec(s))) {
        if (labels[lm[1]] != null) throw new Error('Line ' + ln + ': label "' + lm[1] + '" defined twice');
        labels[lm[1]] = bundles.length;
        s = lm[2];
      }
      if (!s) return;
      if (s[0] === '.') {
        const parts = s.split(/\s+/);
        const d = parts[0];
        if (d === '.func') {
          if (!parts[1]) throw new Error('Line ' + ln + ': .func needs a name');
          if (cur) cur.end = bundles.length;
          cur = { name: parts[1], start: bundles.length, end: null, line: ln };
          if (labels[parts[1]] != null) throw new Error('Line ' + ln + ': name "' + parts[1] + '" already used');
          labels[parts[1]] = bundles.length;
          funcs.push(cur);
        } else if (d === '.loopbound') {
          pendingBound = IMM(parts[1], ln);
          if (pendingBound < 0) throw new Error('Line ' + ln + ': loop bound must be >= 0');
        } else if (d === '.mem' || d === '.spm') {
          const addr = IMM(parts[1], ln);
          parts.slice(2).forEach((v, k) => { (d === '.mem' ? mem : spm)[addr + k] = IMM(v, ln); });
        } else throw new Error('Line ' + ln + ': unknown directive "' + d + '"');
        return;
      }
      if (!cur) throw new Error('Line ' + ln + ': instructions must follow a ".func name" line');
      let insts;
      if (s[0] === '{') {
        if (!/\}\s*$/.test(s)) throw new Error('Line ' + ln + ': a bundle "{ a ; b }" must close on the same line');
        insts = s.slice(1, s.lastIndexOf('}')).split(';').map((x) => x.trim()).filter(Boolean).map((x) => parseInst(x, ln));
        if (insts.length > 2) throw new Error('Line ' + ln + ': Patmos issues at most two instructions per bundle');
        if (insts.length === 2) {
          if (insts[1].kind.match(/^(br|brnd|call|retnd|halt|sres|sfree)$/)) throw new Error('Line ' + ln + ': control-flow and stack-control instructions must be in the first slot');
          if ((insts[0].kind === 'load' || insts[0].kind === 'store') && (insts[1].kind === 'load' || insts[1].kind === 'store')) throw new Error('Line ' + ln + ': only one memory access per bundle');
        }
      } else insts = [parseInst(s, ln)];
      if (pendingBound != null) { bounds[bundles.length] = pendingBound; pendingBound = null; }
      bundles.push({ idx: bundles.length, insts, line: ln, fn: funcs.length - 1, text: insts.map((x) => x.text).join(' ; ') });
    });
    if (cur) cur.end = bundles.length;
    if (!funcs.length) throw new Error('Program has no ".func main"');
    if (!funcs.find((f) => f.name === 'main')) throw new Error('Program needs a function called main');
    for (const f of funcs) if (f.start === f.end) throw new Error('Function ' + f.name + ' is empty');
    // resolve targets
    for (const b of bundles) for (const I of b.insts) {
      if (I.kind === 'br' || I.kind === 'brnd') {
        if (labels[I.target] == null) throw new Error('Line ' + I.line + ': unknown label "' + I.target + '"');
        I.t = labels[I.target];
        if (bundles[I.t] && bundles[I.t].fn !== b.fn) throw new Error('Line ' + I.line + ': branch leaves its function; use callnd');
      }
      if (I.kind === 'call') {
        const f = funcs.findIndex((x) => x.name === I.target);
        if (f < 0) throw new Error('Line ' + I.line + ': unknown function "' + I.target + '"');
        I.f = f;
      }
    }
    // function sizes in words (each instruction is one 32-bit word here)
    for (const f of funcs) {
      f.words = 0;
      for (let i = f.start; i < f.end; i++) f.words += bundles[i].insts.length;
    }
    return { bundles, labels, funcs, bounds, mem, spm };
  }

  // ----------------------------------------------------------------- CFG
  const ctrlOf = (b) => b.insts[0];
  function buildCFG(prog) {
    const { bundles, funcs } = prog;
    const leaders = new Set();
    for (const f of funcs) leaders.add(f.start);
    for (const lbl of Object.values(prog.labels)) leaders.add(lbl);
    for (const b of bundles) {
      const I = ctrlOf(b);
      if (I.kind === 'br') {
        for (let k = 1; k <= 2; k++) {
          const d = bundles[b.idx + k];
          if (!d || d.fn !== b.fn) throw new Error('Line ' + I.line + ': br needs two delay-slot bundles after it inside the function');
          if (/^(br|brnd|call|retnd|halt)$/.test(ctrlOf(d).kind)) throw new Error('Line ' + d.line + ': a branch delay slot cannot contain another control-flow instruction');
        }
        leaders.add(b.idx + 3);
      }
      if (/^(brnd|call|retnd|halt)$/.test(I.kind)) leaders.add(b.idx + 1);
    }
    // a delay slot that is also a leader is an error
    for (const b of bundles) if (ctrlOf(b).kind === 'br') for (let k = 1; k <= 2; k++) if (leaders.has(b.idx + k) && Object.values(prog.labels).includes(b.idx + k))
      throw new Error('Line ' + bundles[b.idx + k].line + ': a label points into a branch delay slot');
    const blocks = [];
    const blockOf = new Array(bundles.length);
    for (const f of funcs) {
      f.blocks = [];
      let curB = null;
      for (let i = f.start; i < f.end; i++) {
        if (leaders.has(i) || !curB) {
          // delay slots never start a block (checked above), so this is safe
          curB = { id: blocks.length, fn: funcs.indexOf(f), start: i, end: i, succ: [], pred: [], label: null };
          blocks.push(curB); f.blocks.push(curB.id);
        }
        curB.end = i + 1;
        blockOf[i] = curB.id;
        // a br ends the block after its delay slots: keep the slots inside
        const I = ctrlOf(bundles[i]);
        if (I.kind === 'br') { for (let k = 1; k <= 2; k++) { blockOf[i + k] = curB.id; } curB.end = i + 3; i += 2; curB.brAt = i - 2; }
      }
    }
    const labelAt = {};
    for (const [n, i] of Object.entries(prog.labels)) labelAt[i] = n;
    for (const b of blocks) {
      b.label = labelAt[b.start] || null;
      b.name = 'BB' + b.id + (b.label ? ' ' + b.label : '');
    }
    // edges
    const edges = [];
    const addEdge = (from, to, kind) => {
      const e = { id: edges.length, from, to, kind };
      edges.push(e);
      if (to != null) blocks[to].pred.push(e.id);
      blocks[from].succ.push(e.id);
      return e;
    };
    for (const b of blocks) {
      const f = funcs[b.fn];
      const lastIdx = b.brAt != null ? b.brAt : b.end - 1;
      const I = ctrlOf(bundles[lastIdx]);
      const uncond = I.guard.n === 0 && !I.guard.neg;
      const fall = () => {
        if (b.end >= f.end) throw new Error('Line ' + bundles[b.end - 1].line + ': control falls off the end of function ' + f.name + ' (add retnd or halt)');
        addEdge(b.id, blockOf[b.end], 'fall');
      };
      if (I.kind === 'br' || I.kind === 'brnd') {
        addEdge(b.id, blockOf[I.t], I.kind === 'brnd' ? 'taken-nd' : 'taken');
        if (!uncond) fall();
      } else if (I.kind === 'call') {
        b.call = I.f;
        if (!uncond) throw new Error('Line ' + I.line + ': predicated calls are not supported in this lab');
        fall();
        edges[edges.length - 1].kind = 'call-return';
      } else if (I.kind === 'retnd' || I.kind === 'halt') {
        if (!uncond) throw new Error('Line ' + I.line + ': predicated ' + I.kind + ' is not supported in this lab');
        if (I.kind === 'halt' && f.name !== 'main') throw new Error('Line ' + I.line + ': halt is only allowed in main');
        if (I.kind === 'retnd' && f.name === 'main') throw new Error('Line ' + I.line + ': main must end with halt, not retnd');
        addEdge(b.id, null, 'exit');
      } else fall();
    }
    return { blocks, edges, blockOf };
  }

  // ------------------------------------------------- dominators and loops
  function findLoops(prog, cfg) {
    const loops = [];
    for (const f of prog.funcs) {
      const ids = f.blocks;
      const entry = ids[0];
      const all = new Set(ids);
      const dom = new Map(ids.map((i) => [i, i === entry ? new Set([i]) : new Set(ids)]));
      let changed = true;
      while (changed) {
        changed = false;
        for (const b of ids) {
          if (b === entry) continue;
          let nd = null;
          for (const eid of cfg.blocks[b].pred) {
            const p = cfg.edges[eid].from;
            if (!all.has(p)) continue;
            nd = nd ? new Set([...nd].filter((x) => dom.get(p).has(x))) : new Set(dom.get(p));
          }
          nd = nd || new Set();
          nd.add(b);
          if (nd.size !== dom.get(b).size) { dom.set(b, nd); changed = true; }
        }
      }
      // back edges
      const byHeader = new Map();
      for (const b of ids) for (const eid of cfg.blocks[b].succ) {
        const e = cfg.edges[eid];
        if (e.to == null) continue;
        if (dom.get(b).has(e.to)) {
          if (!byHeader.has(e.to)) byHeader.set(e.to, []);
          byHeader.get(e.to).push(eid);
        }
      }
      for (const [h, backs] of byHeader) {
        const body = new Set([h]);
        const stack = backs.map((eid) => cfg.edges[eid].from);
        while (stack.length) {
          const x = stack.pop();
          if (body.has(x)) continue;
          body.add(x);
          for (const eid of cfg.blocks[x].pred) stack.push(cfg.edges[eid].from);
        }
        const entries = cfg.blocks[h].pred.filter((eid) => !backs.includes(eid));
        const hb = cfg.blocks[h];
        let bound = null;
        for (let i = hb.start; i < hb.end; i++) if (prog.bounds[i] != null) bound = prog.bounds[i];
        loops.push({ id: loops.length, header: h, backs, entries, body, bound, fn: f.name, name: hb.label || 'BB' + h });
        hb.loop = loops.length - 1;
      }
    }
    // check annotations that are not on a header
    for (const [i, v] of Object.entries(prog.bounds)) {
      const b = cfg.blocks[cfg.blockOf[i]];
      if (b.loop == null) throw new Error('Line ' + prog.bundles[i].line + ': .loopbound ' + v + ' is not at a loop header');
    }
    return loops;
  }

  // ------------------------------------------------------- timing model
  function instCostWorst(I, cfgT) {
    if (I.kind === 'load' || I.kind === 'store') {
      if (I.space === 'main' || I.space === 'dcache') return cfgT.memLatency; // data cache: always-miss assumption; stores are write-through
    }
    return 0;
  }
  function blockTiming(prog, cfg, loops, T, mc) {
    const { bundles } = prog;
    // registers that are the target of a load in the last bundle of some block (per function)
    const tailLoads = prog.funcs.map(() => new Set());
    for (const b of cfg.blocks) {
      const last = bundles[b.end - 1];
      for (const I of last.insts) if (I.kind === 'load') for (const r of I.writes) tailLoads[b.fn].add(r);
    }
    for (const b of cfg.blocks) {
      const parts = { issue: 0, memory: 0, stall: 0, stack: 0 };
      let prevLoad = new Set();
      for (let i = b.start; i < b.end; i++) {
        const bun = bundles[i];
        parts.issue += 1;
        const reads = new Set(bun.insts.flatMap((I) => I.reads.filter((r) => r !== 0)));
        if (i === b.start) { if ([...reads].some((r) => tailLoads[b.fn].has(r))) parts.stall += 1; }
        else if ([...reads].some((r) => prevLoad.has(r))) parts.stall += 1;
        prevLoad = new Set();
        for (const I of bun.insts) {
          parts.memory += instCostWorst(I, T);
          if (I.kind === 'load') for (const r of I.writes) prevLoad.add(r);
          if ((I.kind === 'sres' || I.kind === 'sfree') && !mc.stackFits) parts.stack += T.memLatency + I.n;
        }
      }
      b.cost = parts.issue + parts.memory + parts.stall + parts.stack;
      b.parts = parts;
    }
    for (const e of cfg.edges) {
      e.cost = 0; e.parts = {};
      if (e.kind === 'taken-nd') { e.cost = 2; e.parts.branch = 2; }
      if (e.kind === 'call-return') {
        const caller = cfg.blocks[e.from].fn, callee = cfg.blocks[e.from].call;
        e.parts.callret = 6; e.cost = 6;
        if (!mc.persistent) {
          const m = mcMissCost(prog.funcs[callee], T) + mcMissCost(prog.funcs[caller], T);
          e.parts.methodCache = m; e.cost += m;
        }
      }
    }
  }
  const mcBlocksOf = (f, T) => Math.ceil(f.words / T.mcBlockWords);
  const mcMissCost = (f, T) => T.memLatency + f.words; // burst setup + one cycle per word

  // ---------------------------------------------- call graph properties
  function callGraph(prog, cfg) {
    const calls = prog.funcs.map(() => new Set());
    for (const b of cfg.blocks) if (b.call != null) calls[b.fn].add(b.call);
    const main = prog.funcs.findIndex((f) => f.name === 'main');
    const reach = new Set();
    const state = new Map();
    const visit = (f, path) => {
      if (state.get(f) === 1) throw new Error('Recursion (' + path.concat(prog.funcs[f].name).join(' → ') + ') is not supported: platin also needs recursion bounds');
      if (state.get(f) === 2) return;
      state.set(f, 1); reach.add(f);
      for (const g of calls[f]) visit(g, path.concat(prog.funcs[f].name));
      state.set(f, 2);
    };
    visit(main, []);
    // stack depth: sum of sres in a function + deepest callee chain
    const sres = prog.funcs.map((f) => {
      let n = 0;
      for (let i = f.start; i < f.end; i++) for (const I of prog.bundles[i].insts) if (I.kind === 'sres') n += I.n;
      return n;
    });
    const depthMemo = new Map();
    const depth = (f) => {
      if (depthMemo.has(f)) return depthMemo.get(f);
      let d = 0;
      for (const g of calls[f]) d = Math.max(d, depth(g));
      depthMemo.set(f, sres[f] + d);
      return sres[f] + d;
    };
    return { calls, main, reach: [...reach], maxStack: depth(main), sres };
  }

  // ------------------------------------------------ simplex (maximize)
  // maximize c·x  s.t.  A x <= b, x >= 0, with b >= 0 (origin feasible)
  function simplexMax(c, A, b) {
    const m = A.length, n = c.length;
    const W = n + m + 1;
    const T = A.map((row, i) => {
      const r = new Float64Array(W);
      for (let j = 0; j < n; j++) r[j] = row[j] || 0;
      r[n + i] = 1; r[W - 1] = b[i];
      return r;
    });
    const z = new Float64Array(W);
    for (let j = 0; j < n; j++) z[j] = -c[j];
    const basis = Array.from({ length: m }, (_, i) => n + i);
    const EPS = 1e-9;
    for (let iter = 0; iter < 50000; iter++) {
      let col = -1;
      for (let j = 0; j < W - 1; j++) if (z[j] < -EPS) { col = j; break; } // Bland's rule
      if (col < 0) break;
      let row = -1, best = Infinity;
      for (let i = 0; i < m; i++) if (T[i][col] > EPS) {
        const ratio = T[i][W - 1] / T[i][col];
        if (ratio < best - EPS || (Math.abs(ratio - best) <= EPS && basis[i] < basis[row])) { best = ratio; row = i; }
      }
      if (row < 0) return { status: 'unbounded', col };
      const pr = T[row], pv = pr[col];
      for (let j = 0; j < W; j++) pr[j] /= pv;
      for (let i = 0; i < m; i++) if (i !== row) {
        const f = T[i][col];
        if (Math.abs(f) > EPS) for (let j = 0; j < W; j++) T[i][j] -= f * pr[j];
      }
      const f = z[col];
      for (let j = 0; j < W; j++) z[j] -= f * pr[j];
      basis[row] = col;
    }
    const x = new Array(n).fill(0);
    basis.forEach((v, i) => { if (v < n) x[v] = T[i][W - 1]; });
    return { status: 'optimal', value: z[W - 1], x };
  }

  // ------------------------------------------------------------ IPET
  function ipet(prog, cfg, loops, cg, T, mc) {
    // variables: one per CFG edge, plus one "entry" variable per function
    const nE = cfg.edges.length;
    const entryVar = prog.funcs.map((_, i) => nE + i);
    const nV = nE + prog.funcs.length;
    const names = cfg.edges.map((e) => 'x' + e.id).concat(prog.funcs.map((f) => 'e_' + f.name));
    const rows = [], rhs = [], human = [];
    const inVars = (bid) => {
      const b = cfg.blocks[bid];
      const v = b.pred.map((eid) => eid);
      if (prog.funcs[b.fn].start === b.start) v.push(entryVar[b.fn]);
      return v;
    };
    const addLe = (coef, r, text) => {
      const row = new Array(nV).fill(0);
      for (const [v, k] of coef) row[v] += k;
      rows.push(row); rhs.push(r); if (text) human.push(text);
    };
    const term = (coef) => coef.map(([v, k]) => (k === 1 ? '' : k === -1 ? '-' : k + '·') + names[v]).join(' + ').replace(/\+ -/g, '- ');
    const addEq = (coef, text) => { addLe(coef, 0); addLe(coef.map(([v, k]) => [v, -k]), 0); human.push(text || term(coef) + ' = 0'); };
    // program is started once
    addLe([[entryVar[cg.main], 1]], 1, 'e_main = 1   (the program runs once)');
    // unreachable functions are never entered
    for (let f = 0; f < prog.funcs.length; f++) {
      if (f === cg.main) continue;
      const callers = cfg.blocks.filter((b) => b.call === f);
      const coef = [[entryVar[f], 1]];
      for (const b of callers) for (const v of inVars(b.id)) coef.push([v, -1]);
      addEq(coef, 'e_' + prog.funcs[f].name + ' = ' + (callers.length ? callers.map((b) => '#' + 'BB' + b.id).join(' + ') + '   (each call site enters ' + prog.funcs[f].name + ')' : '0   (never called)'));
    }
    // flow conservation
    for (const b of cfg.blocks) {
      const coef = inVars(b.id).map((v) => [v, 1]).concat(b.succ.map((eid) => [eid, -1]));
      addEq(coef, 'BB' + b.id + ':  ' + inVars(b.id).map((v) => names[v]).join(' + ') + ' = ' + b.succ.map((eid) => names[eid]).join(' + '));
    }
    // loop bounds
    for (const L of loops) {
      if (L.bound == null) throw new Error('Loop at ' + L.name + ' (function ' + L.fn + ', line ' + prog.bundles[cfg.blocks[L.header].start].line + ') has no .loopbound annotation. Without a bound the IPET problem is unbounded, so platin could not compute a WCET either.');
      const coef = L.backs.map((eid) => [eid, 1]);
      const ent = L.entries.slice();
      if (prog.funcs[cfg.blocks[L.header].fn].start === cfg.blocks[L.header].start) ent.push(entryVar[cfg.blocks[L.header].fn]);
      for (const v of ent) coef.push([v, -L.bound]);
      addLe(coef, 0);
      human.push(L.backs.map((e) => names[e]).join(' + ') + ' ≤ ' + L.bound + ' · (' + ent.map((v) => names[v]).join(' + ') + ')   (loop ' + L.name + ', .loopbound ' + L.bound + ')');
    }
    // objective
    const c = new Array(nV).fill(0);
    for (const b of cfg.blocks) for (const v of inVars(b.id)) c[v] += b.cost;
    for (const e of cfg.edges) c[e.id] += e.cost;
    const sol = simplexMax(c, rows, rhs);
    if (sol.status !== 'optimal') throw new Error('The IPET problem is unbounded: some loop is missing a bound.');
    let constant = 0;
    const constParts = [];
    if (mc.persistent) {
      for (const f of cg.reach) { const k = mcMissCost(prog.funcs[f], T); constant += k; constParts.push(prog.funcs[f].name + ' ' + k); }
    } else {
      const k = mcMissCost(prog.funcs[cg.main], T); constant += k; constParts.push('initial load of main ' + k);
    }
    const counts = cfg.blocks.map((b) => inVars(b.id).reduce((s, v) => s + sol.x[v], 0));
    const edgeCounts = cfg.edges.map((e) => sol.x[e.id]);
    const integral = sol.x.every((v) => Math.abs(v - Math.round(v)) < 1e-6);
    const objective = cfg.blocks.map((b) => b.cost + '·#BB' + b.id).concat(cfg.edges.filter((e) => e.cost).map((e) => e.cost + '·' + names[e.id]));
    return { wcet: Math.round((sol.value + constant) * 1000) / 1000, lp: sol.value, constant, constParts, counts, edgeCounts, integral, human, objective, nVars: nV, nRows: rows.length };
  }

  // ------------------------------------------------------- simulator
  function simulate(prog, cfg, loops, T, opts) {
    opts = Object.assign({ maxBundles: 2000000, traceLimit: 400 }, opts || {});
    const { bundles, funcs } = prog;
    const R = new Int32Array(32);
    const Pr = [true, false, false, false, false, false, false, false];
    const mem = Object.assign({}, prog.mem), spm = Object.assign({}, prog.spm), stackMem = {};
    const rd = (m, a) => (m[a] | 0);
    // data cache (direct mapped, write-through, no write-allocate)
    const dc = new Array(T.dcacheSets).fill(-1);
    // method cache (FIFO of whole functions)
    let mcList = [];
    const mcUsed = () => mcList.reduce((s, f) => s + mcBlocksOf(funcs[f], T), 0);
    const stats = { cycles: 0, bundles: 0, issue: 0, stalls: 0, dcHits: 0, dcMiss: 0, mainAcc: 0, memCycles: 0, mcHits: 0, mcMiss: 0, mcCycles: 0, scSpill: 0, scCycles: 0, branchCycles: 0, callCycles: 0 };
    const trace = [];
    const warnings = [];
    function mcAccess(f) {
      if (mcList.includes(f)) { stats.mcHits++; return 0; }
      const need = mcBlocksOf(funcs[f], T);
      if (need > T.mcBlocks) throw new Error('Function ' + funcs[f].name + ' (' + need + ' blocks) does not fit into the method cache (' + T.mcBlocks + ' blocks)');
      while (mcUsed() + need > T.mcBlocks) mcList.shift();
      mcList.push(f);
      stats.mcMiss++;
      const c = mcMissCost(funcs[f], T);
      stats.mcCycles += c;
      return c;
    }
    // stack cache: occupancy model with spill/fill to main memory
    let scDepth = 0, scSpilled = 0;
    const counts = new Array(cfg.blocks.length).fill(0);
    const loopIt = loops.map(() => 0), loopMax = loops.map(() => 0);
    const main = funcs.findIndex((f) => f.name === 'main');
    let pc = funcs[main].start;
    const callStack = [];
    let pending = null;
    let lastLoad = new Set();
    let prevBid = null;
    const warnedLoop = loops.map(() => false);
    stats.cycles += mcAccess(main);
    let halted = false;
    while (!halted) {
      if (stats.bundles >= opts.maxBundles) throw new Error('Simulation stopped after ' + opts.maxBundles.toLocaleString('en') + ' bundles (endless loop?)');
      const bun = bundles[pc];
      if (!bun) throw new Error('Program counter left the program at bundle ' + pc);
      const bid = cfg.blockOf[pc];
      if (cfg.blocks[bid].start === pc) {
        counts[bid]++;
        // loop bound monitoring: an arrival at a header over a back edge is one more iteration
        const L = cfg.blocks[bid].loop;
        if (L != null) {
          const lp = loops[L];
          if (prevBid != null && lp.backs.some((eid) => cfg.edges[eid].from === prevBid)) loopIt[L]++;
          else loopIt[L] = 0;
          loopMax[L] = Math.max(loopMax[L], loopIt[L]);
          if (lp.bound != null && loopIt[L] > lp.bound && !warnedLoop[L]) {
            warnedLoop[L] = true;
            warnings.push('Loop ' + lp.name + ' ran more than its .loopbound of ' + lp.bound + ' iterations. The annotation is wrong, so the computed WCET bound is not safe.');
          }
        }
      }
      let cyc = 1, note = [];
      stats.issue++;
      // load-use interlock
      const reads = bun.insts.flatMap((I) => (guardOk(I) ? I.reads.filter((r) => r !== 0) : []));
      if (reads.some((r) => lastLoad.has(r))) { cyc++; stats.stalls++; note.push('load-use stall'); }
      lastLoad = new Set();
      let nextPc = null, setPending = false, retFrom = null;
      // read operands of both slots first (bundle semantics), then write
      const writesR = [], writesP = [];
      function guardOk(I) { const v = Pr[I.guard.n]; return I.guard.neg ? !v : v; }
      for (const I of bun.insts) {
        if (!guardOk(I)) { if (I.kind !== 'nop') note.push('(' + (I.guard.neg ? '!' : '') + 'p' + I.guard.n + ') off: ' + I.op); continue; }
        const a = I.rs != null ? R[I.rs] : 0;
        const b = I.rt != null ? R[I.rt] : I.imm;
        switch (I.kind) {
          case 'nop': break;
          case 'li': writesR.push([I.rd, I.imm]); break;
          case 'alu': writesR.push([I.rd, ALU[I.fn](a, I.imm != null ? I.imm : R[I.rt])]); break;
          case 'cmp': writesP.push([I.pd, CMP[I.fn](a, I.imm != null ? I.imm : R[I.rt])]); break;
          case 'pred': {
            const pv = (p) => (p.neg ? !Pr[p.n] : Pr[p.n]);
            const x = pv(I.ps), y = I.pt ? pv(I.pt) : false;
            const r = I.fn === 'and' ? x && y : I.fn === 'or' ? x || y : I.fn === 'xor' ? x !== y : I.fn === 'not' ? !x : x;
            writesP.push([I.pd, r]); break;
          }
          case 'load': {
            const addr = R[I.mem.base] + I.mem.off;
            let v;
            if (I.space === 'spm') v = rd(spm, addr);
            else if (I.space === 'stack') v = rd(stackMem, addr);
            else v = rd(mem, addr);
            if (I.space === 'dcache') {
              const line = Math.floor(addr / T.dcacheLine), set = ((line % T.dcacheSets) + T.dcacheSets) % T.dcacheSets;
              if (dc[set] === line) { stats.dcHits++; note.push('D$ hit @' + addr); }
              else { dc[set] = line; stats.dcMiss++; cyc += T.memLatency; stats.memCycles += T.memLatency; note.push('D$ miss @' + addr + ' +' + T.memLatency); }
            } else if (I.space === 'main') { stats.mainAcc++; cyc += T.memLatency; stats.memCycles += T.memLatency; note.push('main mem @' + addr + ' +' + T.memLatency); }
            writesR.push([I.rd, v]);
            lastLoad.add(I.rd);
            break;
          }
          case 'store': {
            const addr = R[I.mem.base] + I.mem.off;
            const v = R[I.rt];
            if (I.space === 'spm') spm[addr] = v;
            else if (I.space === 'stack') stackMem[addr] = v;
            else {
              mem[addr] = v; stats.mainAcc++; cyc += T.memLatency; stats.memCycles += T.memLatency;
              note.push((I.space === 'dcache' ? 'write-through' : 'main mem') + ' @' + addr + ' +' + T.memLatency);
            }
            break;
          }
          case 'sres': {
            const newSp = Math.max(0, scDepth + I.n - T.scWords);
            const spill = newSp - scSpilled;
            if (spill > 0) { const c = T.memLatency + spill; cyc += c; stats.scSpill += spill; stats.scCycles += c; note.push('stack spill ' + spill + 'w +' + c); }
            scSpilled = Math.max(scSpilled, newSp); scDepth += I.n; break;
          }
          case 'sfree': {
            scDepth = Math.max(0, scDepth - I.n);
            const keep = Math.max(0, scDepth - T.scWords);
            const fill = scSpilled - keep;
            if (fill > 0) { const c = T.memLatency + fill; cyc += c; stats.scCycles += c; note.push('stack fill ' + fill + 'w +' + c); }
            scSpilled = keep; break;
          }
          case 'br': pending = { t: I.t, n: 2 }; setPending = true; note.push('branch taken → ' + I.target + ' after 2 delay slots'); break;
          case 'brnd': nextPc = I.t; cyc += 2; stats.branchCycles += 2; note.push('non-delayed branch → ' + I.target + ' +2'); break;
          case 'call': {
            callStack.push({ ret: pc + 1, fn: bun.fn, callBlock: bid });
            cyc += 3; stats.callCycles += 3;
            const m = mcAccess(I.f); cyc += m;
            note.push('call ' + I.target + ' +3' + (m ? ', M$ miss +' + m : ', M$ hit'));
            nextPc = funcs[I.f].start; break;
          }
          case 'retnd': {
            const fr = callStack.pop();
            cyc += 3; stats.callCycles += 3;
            const m = mcAccess(fr.fn); cyc += m;
            note.push('return to ' + funcs[fr.fn].name + ' +3' + (m ? ', M$ miss +' + m : ', M$ hit'));
            nextPc = fr.ret; retFrom = fr.callBlock; break;
          }
          case 'halt': halted = true; note.push('halt'); break;
        }
      }
      for (const [r, v] of writesR) if (r !== 0) R[r] = v | 0;
      for (const [p, v] of writesP) if (p !== 0) Pr[p] = !!v;
      stats.cycles += cyc; stats.bundles++;
      if (trace.length < opts.traceLimit) trace.push({ cycle: stats.cycles - cyc, pc, block: bid, text: bun.text, cyc, note: note.join('; ') });
      if (halted) break;
      prevBid = retFrom != null ? retFrom : bun.insts[0].kind === 'call' && guardOk(bun.insts[0]) ? null : bid;
      if (nextPc != null) pc = nextPc;
      else if (pending && !setPending) {
        pending.n--;
        if (pending.n === 0) { pc = pending.t; pending = null; } else pc++;
      } else pc++;
    }
    stats.mcCyclesTotal = stats.mcCycles;
    return { stats, counts, trace, regs: Array.from(R), preds: Pr.slice(), warnings, loopMax, spm, mem };
  }

  // ------------------------------------------------------------ driver
  function analyze(src, cfgT) {
    const T = Object.assign({}, DEFAULTS, cfgT || {});
    const prog = assemble(src);
    const cfg = buildCFG(prog);
    const loops = findLoops(prog, cfg);
    const cg = callGraph(prog, cfg);
    const totalMcBlocks = cg.reach.reduce((s, f) => s + mcBlocksOf(prog.funcs[f], T), 0);
    for (const f of cg.reach) if (mcBlocksOf(prog.funcs[f], T) > T.mcBlocks) throw new Error('Function ' + prog.funcs[f].name + ' needs ' + mcBlocksOf(prog.funcs[f], T) + ' method cache blocks but the cache has only ' + T.mcBlocks);
    const mc = { persistent: totalMcBlocks <= T.mcBlocks, totalMcBlocks, stackFits: cg.maxStack <= T.scWords, maxStack: cg.maxStack };
    blockTiming(prog, cfg, loops, T, mc);
    const wc = ipet(prog, cfg, loops, cg, T, mc);
    let sim = null, simError = null;
    try { sim = simulate(prog, cfg, loops, T); } catch (e) { simError = e.message; }
    return { T, prog, cfg, loops, cg, mc, wc, sim, simError };
  }

  const api = { analyze, assemble, DEFAULTS, simplexMax };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.TcrestCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
