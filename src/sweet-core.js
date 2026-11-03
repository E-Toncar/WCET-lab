// ============================================================================
// SWEET Lab core: mini-C front end -> ALF-like IR -> Abstract Execution (AE)
// A didactic re-implementation of the ideas in SWEET (Mälardalen University).
// It is NOT the real SWEET and does not read real ALF files.
// ============================================================================
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- intervals
  const INF = Infinity;
  const iv = (lo, hi) => (lo > hi ? null : [lo, hi]);
  const TOP = () => [-INF, INF];
  const ivStr = (v) => {
    if (!v) return '⊥';
    const f = (x) => (x === INF ? '+∞' : x === -INF ? '-∞' : String(x));
    return v[0] === v[1] ? f(v[0]) : '[' + f(v[0]) + '..' + f(v[1]) + ']';
  };
  const join = (a, b) => [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
  const meet = (a, b) => iv(Math.max(a[0], b[0]), Math.min(a[1], b[1]));
  const mulS = (x, y) => (x === 0 || y === 0 ? 0 : x * y);
  const ops = {
    '+': (a, b) => [a[0] + b[0], a[1] + b[1]],
    '-': (a, b) => [a[0] - b[1], a[1] - b[0]],
    '*': (a, b) => {
      const c = [mulS(a[0], b[0]), mulS(a[0], b[1]), mulS(a[1], b[0]), mulS(a[1], b[1])];
      return [Math.min(...c), Math.max(...c)];
    },
    '/': (a, b) => {
      // integer division, divisor interval with 0 removed
      const parts = [];
      if (b[0] <= -1) parts.push([b[0], Math.min(b[1], -1)]);
      if (b[1] >= 1) parts.push([Math.max(b[0], 1), b[1]]);
      if (!parts.length) return TOP(); // division by exactly 0: give up
      let r = null;
      for (const d of parts) {
        const c = [a[0] / d[0], a[0] / d[1], a[1] / d[0], a[1] / d[1]]
          .map((x) => (isNaN(x) ? 0 : Math.trunc(x)));
        const p = [Math.min(...c), Math.max(...c)];
        r = r ? join(r, p) : p;
      }
      return r;
    },
    '%': (a, b) => {
      const m = Math.max(Math.abs(b[0]), Math.abs(b[1]));
      if (m === 0) return TOP();
      const lim = m - 1;
      if (a[0] >= 0) return [0, Math.min(a[1], lim)];
      if (a[1] <= 0) return [Math.max(a[0], -lim), 0];
      return [-lim, lim];
    },
  };

  // ----------------------------------------------------------------- lexer
  function lex(src) {
    const toks = [];
    const re = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(\d+)|([A-Za-z_]\w*)|(\+\+|--|\+=|-=|\*=|==|!=|<=|>=|&&|\|\||[-+*/%<>=!(){};,])/y;
    let m, line = 1;
    re.lastIndex = 0;
    while (re.lastIndex < src.length) {
      const start = re.lastIndex;
      m = re.exec(src);
      if (!m) throw new Error('Line ' + line + ': unexpected character "' + src[start] + '"');
      if (m[1]) toks.push({ t: 'num', v: parseInt(m[1], 10), line });
      else if (m[2]) toks.push({ t: 'id', v: m[2], line });
      else if (m[3]) toks.push({ t: 'op', v: m[3], line });
      line += (m[0].match(/\n/g) || []).length;
    }
    toks.push({ t: 'eof', v: '<end>', line });
    return toks;
  }

  // ----------------------------------------------------------------- parser
  const KW = new Set(['int', 'if', 'else', 'while', 'for', 'nondet']);
  function parse(src) {
    const toks = lex(src);
    let p = 0;
    const peek = () => toks[p];
    const next = () => toks[p++];
    const is = (v) => toks[p].v === v && toks[p].t !== 'num';
    const expect = (v) => {
      if (!is(v)) throw new Error('Line ' + peek().line + ': expected "' + v + '" but found "' + peek().v + '"');
      return next();
    };
    const ident = () => {
      const t = next();
      if (t.t !== 'id' || KW.has(t.v)) throw new Error('Line ' + t.line + ': expected a variable name, found "' + t.v + '"');
      return t.v;
    };

    function primary() {
      const t = peek();
      if (t.t === 'num') { next(); return { k: 'num', v: t.v }; }
      if (is('(')) { next(); const e = expr(); expect(')'); return e; }
      if (is('nondet')) {
        next(); expect('(');
        const lo = signedNum(); expect(','); const hi = signedNum(); expect(')');
        if (lo > hi) throw new Error('Line ' + t.line + ': nondet(lo, hi) needs lo <= hi');
        return { k: 'nondet', lo, hi };
      }
      if (t.t === 'id') return { k: 'var', v: ident() };
      throw new Error('Line ' + t.line + ': unexpected "' + t.v + '" in expression');
    }
    function signedNum() {
      let s = 1;
      if (is('-')) { next(); s = -1; }
      const t = next();
      if (t.t !== 'num') throw new Error('Line ' + t.line + ': expected a number');
      return s * t.v;
    }
    function unary() {
      if (is('-')) { next(); return { k: 'bin', op: '-', a: { k: 'num', v: 0 }, b: unary() }; }
      if (is('!')) { next(); return { k: 'not', a: unary() }; }
      return primary();
    }
    const levels = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']];
    function binLevel(i) {
      if (i === levels.length) return unary();
      let a = binLevel(i + 1);
      while (peek().t === 'op' && levels[i].includes(peek().v)) {
        const op = next().v;
        const b = binLevel(i + 1);
        a = op === '&&' || op === '||' ? { k: 'logic', op, a, b } : { k: 'bin', op, a, b };
      }
      return a;
    }
    const expr = () => binLevel(0);

    function simple() {
      const line = peek().line;
      if (is('int')) {
        next(); const v = ident();
        if (is('=')) { next(); return { k: 'assign', v, e: expr(), line, decl: true }; }
        return { k: 'decl', v, line };
      }
      const v = ident();
      if (is('++')) { next(); return { k: 'assign', v, e: { k: 'bin', op: '+', a: { k: 'var', v }, b: { k: 'num', v: 1 } }, line }; }
      if (is('--')) { next(); return { k: 'assign', v, e: { k: 'bin', op: '-', a: { k: 'var', v }, b: { k: 'num', v: 1 } }, line }; }
      for (const op of ['+=', '-=', '*=']) {
        if (is(op)) { next(); return { k: 'assign', v, e: { k: 'bin', op: op[0], a: { k: 'var', v }, b: expr() }, line }; }
      }
      expect('=');
      return { k: 'assign', v, e: expr(), line };
    }
    function block() {
      if (is('{')) {
        next(); const body = [];
        while (!is('}')) { if (peek().t === 'eof') throw new Error('Missing "}"'); body.push(stmt()); }
        next(); return body;
      }
      return [stmt()];
    }
    function stmt() {
      const line = peek().line;
      if (is('{')) return { k: 'block', body: block(), line };
      if (is('if')) {
        next(); expect('('); const c = expr(); expect(')');
        const t = block(); let e = null;
        if (is('else')) { next(); e = block(); }
        return { k: 'if', c, t, e, line };
      }
      if (is('while')) {
        next(); expect('('); const c = expr(); expect(')');
        return { k: 'while', c, body: block(), line };
      }
      if (is('for')) {
        next(); expect('(');
        const init = is(';') ? null : simple(); expect(';');
        const c = is(';') ? { k: 'num', v: 1 } : expr(); expect(';');
        const step = is(')') ? null : simple(); expect(')');
        return { k: 'for', init, c, step, body: block(), line };
      }
      if (is(';')) { next(); return { k: 'block', body: [], line }; }
      const s = simple(); expect(';'); return s;
    }
    const prog = [];
    while (peek().t !== 'eof') prog.push(stmt());
    return prog;
  }

  // ------------------------------------------------- expression printing
  const PREC = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
  function eStr(e, parent) {
    parent = parent || 0;
    let s, pr = 9;
    switch (e.k) {
      case 'num': return String(e.v);
      case 'var': return e.v;
      case 'nondet': return 'nondet(' + e.lo + ', ' + e.hi + ')';
      case 'not': return '!' + eStr(e.a, 8);
      case 'bin': case 'logic':
        pr = PREC[e.op];
        s = eStr(e.a, pr) + ' ' + e.op + ' ' + eStr(e.b, pr + 1);
        return pr < parent ? '(' + s + ')' : s;
    }
    return '?';
  }
  // ALF-flavoured printing of expressions (prefix form, like ALF's s-expressions)
  const ALFOP = { '+': 'add', '-': 'sub', '*': 'u_mul', '/': 's_div', '%': 's_mod', '<': 's_lt', '<=': 's_le', '>': 's_gt', '>=': 's_ge', '==': 'eq', '!=': 'neq' };
  function eAlf(e) {
    switch (e.k) {
      case 'num': return '{ dec_signed 32 ' + e.v + ' }';
      case 'var': return '{ load 32 { addr 32 { fref 32 ' + e.v + ' } } }';
      case 'nondet': return '{ undefined 32 }  /* input in ' + ivStr([e.lo, e.hi]) + ' */';
      case 'not': return '{ not 1 ' + eAlf(e.a) + ' }';
      case 'bin': return '{ ' + ALFOP[e.op] + ' 32 ' + eAlf(e.a) + ' ' + eAlf(e.b) + ' }';
      case 'logic': return '{ ' + (e.op === '&&' ? 'and' : 'or') + ' 1 ' + eAlf(e.a) + ' ' + eAlf(e.b) + ' }';
    }
  }

  // ------------------------------------------------------------- lowering
  // CFG: blocks with straight-line assignments and one terminator.
  function lower(prog) {
    const blocks = [];
    const loops = [];
    const loopStack = [];
    const vars = new Set();
    function nb(note) {
      const b = { id: blocks.length, name: 'B' + blocks.length, stmts: [], term: null, note: note || '', loops: loopStack.map((l) => l.id), line: null };
      blocks.push(b);
      for (const l of loopStack) l.members.add(b.id);
      return b;
    }
    function collectVars(e) {
      if (!e) return;
      if (e.k === 'var') vars.add(e.v);
      if (e.a) collectVars(e.a);
      if (e.b) collectVars(e.b);
    }
    // condition with short-circuit lowering
    function cond(e, cur, t, f) {
      collectVars(e);
      if (e.k === 'logic' && e.op === '&&') {
        const mid = nb('second operand of &&');
        cond(e.a, cur, mid, f);
        cond(e.b, mid, t, f);
      } else if (e.k === 'logic' && e.op === '||') {
        const mid = nb('second operand of ||');
        cond(e.a, cur, t, mid);
        cond(e.b, mid, t, f);
      } else if (e.k === 'not') {
        cond(e.a, cur, f, t);
      } else {
        cur.term = { k: 'cond', e, t: t.id, f: f.id };
      }
    }
    function stmts(list, cur) {
      for (const s of list) cur = stmt(s, cur);
      return cur;
    }
    function assign(s, cur) {
      vars.add(s.v);
      if (s.k === 'decl') { cur.stmts.push({ v: s.v, e: null, line: s.line }); return; }
      collectVars(s.e);
      cur.stmts.push({ v: s.v, e: s.e, line: s.line });
    }
    function stmt(s, cur) {
      if (cur.line == null) cur.line = s.line;
      switch (s.k) {
        case 'decl': case 'assign': assign(s, cur); return cur;
        case 'block': return stmts(s.body, cur);
        case 'if': {
          const tb = nb('then (line ' + s.line + ')');
          const eb = s.e ? nb('else (line ' + s.line + ')') : null;
          const join = nb('after if (line ' + s.line + ')');
          cond(s.c, cur, tb, eb || join);
          const te = stmts(s.t, tb); te.term = te.term || { k: 'jump', to: join.id };
          if (eb) { const ee = stmts(s.e, eb); ee.term = ee.term || { k: 'jump', to: join.id }; }
          // move join to the end so block numbers follow source order
          blocks.splice(blocks.indexOf(join), 1); blocks.push(join);
          return join;
        }
        case 'while': case 'for': {
          if (s.k === 'for' && s.init) assign(s.init, cur);
          const L = { id: loops.length, name: 'L' + (loops.length + 1), line: s.line, header: null, members: new Set(), kind: s.k, text: (s.k === 'for' ? 'for (…; ' : 'while (') + eStr(s.c) + (s.k === 'for' ? '; …)' : ')') };
          loops.push(L);
          loopStack.push(L);
          const h = nb('loop ' + L.name + ' header (line ' + s.line + ')');
          h.line = s.line;
          L.header = h.id;
          h.isHeader = L.id;
          cur.term = { k: 'jump', to: h.id };
          const body = nb('loop ' + L.name + ' body');
          const latch = s.k === 'for' ? nb('loop ' + L.name + ' step') : null;
          loopStack.pop();
          const exit = nb('after loop ' + L.name);
          loopStack.push(L);
          cond(s.c, h, body, exit);
          const be = stmts(s.body, body);
          if (latch) { be.term = { k: 'jump', to: latch.id }; if (s.step) assign(s.step, latch); latch.term = { k: 'jump', to: h.id }; }
          else be.term = { k: 'jump', to: h.id };
          loopStack.pop();
          blocks.splice(blocks.indexOf(exit), 1); blocks.push(exit);
          return exit;
        }
      }
      throw new Error('internal: unknown statement');
    }
    const entry = nb('program entry');
    const last = stmts(prog, entry);
    last.term = { k: 'exit' };
    // renumber blocks in emission order for readability
    const map = new Map();
    blocks.forEach((b, i) => map.set(b.id, i));
    for (const b of blocks) {
      b.id = map.get(b.id); b.name = 'B' + b.id;
      if (b.term.k === 'jump') b.term.to = map.get(b.term.to);
      if (b.term.k === 'cond') { b.term.t = map.get(b.term.t); b.term.f = map.get(b.term.f); }
    }
    for (const L of loops) {
      L.header = map.get(L.header);
      L.members = new Set([...L.members].map((x) => map.get(x)));
    }
    blocks.sort((a, b) => a.id - b.id);
    // predecessors
    for (const b of blocks) b.preds = [];
    for (const b of blocks) for (const s of succs(b)) blocks[s].preds.push(b.id);
    // nesting depth of loops
    for (const L of loops) L.parent = null;
    for (const L of loops) {
      let best = null;
      for (const M of loops) if (M !== L && M.members.has(L.header) && (!best || best.members.size > M.members.size)) best = M;
      L.parent = best ? best.id : null;
    }
    return { blocks, loops, vars: [...vars].sort() };
  }
  function succs(b) {
    if (b.term.k === 'jump') return [b.term.to];
    if (b.term.k === 'cond') return [b.term.t, b.term.f];
    return [];
  }

  // ------------------------------------------------------- ALF-like listing
  function toAlf(cfg) {
    const out = [];
    out.push('{ alf');
    out.push('  { macro_defs }  { least_addr_unit 8 }  little_endian');
    out.push('  { exports }  { imports }');
    out.push('  { decls');
    for (const v of cfg.vars) out.push('    { alloc { fref 32 ' + v + ' } 32 }');
    out.push('  }');
    out.push('  { inits }');
    out.push('  { funcs');
    out.push('    { func { label 32 { lref 32 main } { dec_unsigned 32 0 } }');
    out.push('      { arg_decls } { scope { decls } { inits } { stmts');
    for (const b of cfg.blocks) {
      out.push('');
      out.push('        { label 32 { lref 32 ' + b.name + ' } { dec_unsigned 32 0 } }' + (b.note ? '   /* ' + b.note + ' */' : ''));
      for (const s of b.stmts) {
        if (!s.e) out.push('        /* int ' + s.v + ';  (uninitialised: value is TOP) */');
        else out.push('        { store { addr 32 { fref 32 ' + s.v + ' } } with ' + eAlf(s.e) + ' }');
      }
      const t = b.term;
      if (t.k === 'jump') out.push('        { jump { label 32 { lref 32 B' + t.to + ' } } leaving 0 }');
      else if (t.k === 'cond')
        out.push('        { switch ' + eAlf(t.e) + '\n            { target { dec_unsigned 1 1 } { label 32 { lref 32 B' + t.t + ' } } }\n            { default { label 32 { lref 32 B' + t.f + ' } } } }');
      else out.push('        { return }');
    }
    out.push('      } } }');
    out.push('  }');
    out.push('}');
    return out.join('\n');
  }
  function toReadable(cfg) {
    // compact three-address style view, one block per entry
    return cfg.blocks.map((b) => ({
      id: b.id, name: b.name, note: b.note, header: b.isHeader != null ? cfg.loops[b.isHeader].name : null,
      stmts: b.stmts.map((s) => (s.e ? s.v + ' := ' + eStr(s.e) : 'int ' + s.v + '  (TOP)')),
      term: b.term.k === 'jump' ? 'goto B' + b.term.to
        : b.term.k === 'cond' ? 'if (' + eStr(b.term.e) + ') goto B' + b.term.t + ' else goto B' + b.term.f
        : 'return',
      succs: succs(b), cost: blockCost(b),
    }));
  }

  // --------------------------------------------------------- timing model
  // Simple ALF-level timing model (SWEET also had one): unit costs.
  function exprCost(e) {
    if (!e) return 0;
    switch (e.k) {
      case 'num': return 0;
      case 'var': return 1;              // a load
      case 'nondet': return 1;
      case 'not': return 1 + exprCost(e.a);
      case 'bin': return (e.op === '*' ? 3 : e.op === '/' || e.op === '%' ? 10 : 1) + exprCost(e.a) + exprCost(e.b);
      case 'logic': return 1 + exprCost(e.a) + exprCost(e.b);
    }
    return 1;
  }
  function blockCost(b) {
    let c = 0;
    for (const s of b.stmts) c += s.e ? 1 + exprCost(s.e) : 0; // +1 for the store
    if (b.term.k === 'cond') c += 2 + exprCost(b.term.e);
    else if (b.term.k === 'jump') c += 1;
    else c += 1;
    return c;
  }

  // ----------------------------------------------------- abstract execution
  function evalE(e, env) {
    switch (e.k) {
      case 'num': return [e.v, e.v];
      case 'var': return env[e.v] || TOP();
      case 'nondet': return [e.lo, e.hi];
      case 'not': {
        const a = evalE(e.a, env);
        const t = canBeTrue(a), f = canBeFalse(a);
        return [f && !t ? 1 : t && !f ? 0 : 0, f ? 1 : 0].sort((x, y) => x - y);
      }
      case 'logic': {
        const a = truth(evalE(e.a, env)), b = truth(evalE(e.b, env));
        const r = e.op === '&&' ? [a[0] && b[0] ? 1 : 0, a[1] && b[1] ? 1 : 0] : [a[0] || b[0] ? 1 : 0, a[1] || b[1] ? 1 : 0];
        return r;
      }
      case 'bin': {
        const a = evalE(e.a, env), b = evalE(e.b, env);
        if (ops[e.op]) return ops[e.op](a, b);
        const r = relation(e.op, a, b);
        return [r.f ? 0 : 1, r.t ? 1 : 0];
      }
    }
  }
  const canBeTrue = (v) => !(v[0] === 0 && v[1] === 0);
  const canBeFalse = (v) => v[0] <= 0 && v[1] >= 0;
  const truth = (v) => [canBeTrue(v) && !canBeFalse(v) ? 1 : 0, canBeTrue(v) ? 1 : 0]; // [mustTrue, mayTrue]
  function relation(op, a, b) {
    switch (op) {
      case '<': return { t: a[0] < b[1], f: a[1] >= b[0] };
      case '<=': return { t: a[0] <= b[1], f: a[1] > b[0] };
      case '>': return { t: a[1] > b[0], f: a[0] <= b[1] };
      case '>=': return { t: a[1] >= b[0], f: a[0] < b[1] };
      case '==': { const o = meet(a, b); return { t: !!o, f: !(a[0] === a[1] && b[0] === b[1] && a[0] === b[0]) }; }
      case '!=': { const r = relation('==', a, b); return { t: r.f, f: r.t }; }
    }
  }
  const NEG = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '==': '!=', '!=': '==' };
  const FLIP = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };
  // refine x against y for relation (x op y) being true; returns new interval for x or null
  function refineOne(op, x, y) {
    switch (op) {
      case '<': return meet(x, [-INF, y[1] - 1]);
      case '<=': return meet(x, [-INF, y[1]]);
      case '>': return meet(x, [y[0] + 1, INF]);
      case '>=': return meet(x, [y[0], INF]);
      case '==': return meet(x, y);
      case '!=':
        if (y[0] === y[1]) {
          if (x[0] === y[0]) return iv(x[0] + 1, x[1]);
          if (x[1] === y[0]) return iv(x[0], x[1] - 1);
        }
        return x;
    }
  }
  // returns refined env if branch (e is `want`) is feasible, else null
  function branch(e, env, want) {
    if (e.k === 'bin' && !ops[e.op]) {
      const op = want ? e.op : NEG[e.op];
      const a = evalE(e.a, env), b = evalE(e.b, env);
      const r = relation(op, a, b);
      if (!r.t) return null;
      const ne = Object.assign({}, env);
      if (e.a.k === 'var') { const na = refineOne(op, a, b); if (!na) return null; ne[e.a.v] = na; }
      if (e.b.k === 'var') { const nbv = refineOne(FLIP[op], b, ne[e.a.v] && e.a.k === 'var' ? ne[e.a.v] : a); if (!nbv) return null; ne[e.b.v] = nbv; }
      return ne;
    }
    const v = evalE(e, env);
    if (want ? !canBeTrue(v) : !canBeFalse(v)) return null;
    if (e.k === 'var') {
      const ne = Object.assign({}, env);
      ne[e.v] = want ? (refineOne('!=', v, [0, 0]) || v) : [0, 0];
      return ne;
    }
    return env;
  }
  const envStr = (env, vars) => vars.filter((v) => env[v]).map((v) => v + '=' + ivStr(env[v])).join(', ');

  // options: { merge: 'none' | 'loop-exit' | 'all', maxStates, maxSteps }
  function abstractExecute(cfg, opt) {
    opt = Object.assign({ merge: 'none', maxStates: 20000, maxSteps: 400000, maxTrace: 600 }, opt || {});
    const nB = cfg.blocks.length, nL = cfg.loops.length;
    const trace = [];
    const T = (ev) => { if (trace.length < opt.maxTrace) trace.push(ev); else if (trace.length === opt.maxTrace) trace.push({ k: 'more' }); };
    const loopStats = cfg.loops.map(() => ({ min: INF, max: -INF, entries: 0 }));
    const mergeTargets = new Set();
    if (opt.merge === 'loop-exit' || opt.merge === 'all') for (const b of cfg.blocks) for (const s of succs(b)) {
      for (const L of cfg.loops) if (L.members.has(b.id) && !L.members.has(s)) mergeTargets.add(s);
    }
    if (opt.merge === 'all') for (const b of cfg.blocks) if (b.preds.length > 1) mergeTargets.add(b.id);

    let sid = 0;
    const mk = (pc, env, loops, cmin, cmax, time, merged) => ({ id: sid++, pc, env, loops, cmin, cmax, time, merged });
    const work = [mk(0, {}, [], new Array(nB).fill(0), new Array(nB).fill(0), [0, 0], false)];
    const finished = [];
    const waiting = new Map();
    let steps = 0, splits = 0, merges = 0, created = 1, aborted = null, anyMerge = false;

    const ctxKey = (loops) => loops.map((c) => c.L + ':' + c.it).join('/');

    function transition(st, from, to, env) {
      // copy-on-write of loop context
      let loops = st.loops.map((c) => ({ L: c.L, it: c.it }));
      // 1. leave loops (innermost first)
      while (loops.length) {
        const top = loops[loops.length - 1];
        const L = cfg.loops[top.L];
        if (L.members.has(to)) break;
        loops.pop();
        const s = loopStats[top.L];
        s.min = Math.min(s.min, top.it); s.max = Math.max(s.max, top.it); s.entries++;
        T({ k: 'exit', s: st.id, L: L.name, it: top.it, at: 'B' + from });
      }
      // 2. back edge or 3. loop entry
      const hb = cfg.blocks[to].isHeader;
      if (hb != null) {
        const L = cfg.loops[hb];
        if (L.members.has(from) && loops.length && loops[loops.length - 1].L === hb) loops[loops.length - 1].it++;
        else loops.push({ L: hb, it: 0 });
      }
      return { pc: to, env, loops };
    }

    function pushState(st) {
      if (mergeTargets.has(st.pc)) {
        const key = st.pc + '|' + ctxKey(st.loops);
        if (!waiting.has(key)) waiting.set(key, []);
        waiting.get(key).push(st);
      } else work.push(st);
    }

    // Merge-point ordering: release only one waiting group at a time, choosing the
    // one deepest inside loops, then the earliest iteration, then the earliest block.
    // That way states that are still inside a loop catch up before a loop exit merges.
    function flushWaiting() {
      let bestKey = null, best = null;
      for (const [key, group] of waiting) {
        const g = group[0];
        const pr = [-g.loops.length, ...g.loops.map((c) => c.it), g.pc];
        if (!best || cmpArr(pr, best) < 0) { best = pr; bestKey = key; }
      }
      const sel = [[bestKey, waiting.get(bestKey)]];
      waiting.delete(bestKey);
      for (const [key, group] of sel) {
        let m = group[0];
        if (group.length > 1) {
          merges += group.length - 1; anyMerge = true;
          const env = Object.assign({}, m.env);
          const cmin = m.cmin.slice(), cmax = m.cmax.slice();
          let time = m.time.slice();
          for (let i = 1; i < group.length; i++) {
            const g = group[i];
            for (const v of new Set([...Object.keys(env), ...Object.keys(g.env)])) env[v] = env[v] && g.env[v] ? join(env[v], g.env[v]) : TOP();
            for (let b = 0; b < nB; b++) { cmin[b] = Math.min(cmin[b], g.cmin[b]); cmax[b] = Math.max(cmax[b], g.cmax[b]); }
            time = join(time, g.time);
          }
          m = mk(m.pc, env, m.loops, cmin, cmax, time, true);
          T({ k: 'merge', n: group.length, at: 'B' + m.pc, s: m.id, env: envStr(env, cfg.vars) });
        }
        work.push(m);
        void key;
      }
    }
    function cmpArr(a, b) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] === undefined ? -1 : a[i], y = b[i] === undefined ? -1 : b[i];
        if (x !== y) return x - y;
      }
      return 0;
    }

    while (work.length || waiting.size) {
      if (!work.length) { flushWaiting(); continue; }
      const st = work.pop();
      if (++steps > opt.maxSteps) { aborted = 'Stopped after ' + opt.maxSteps.toLocaleString('en') + ' abstract block executions. AE uses no widening, so a loop whose exit condition never becomes definite (for example, a bound that depends on an unconstrained input) keeps iterating. Constrain the input with nondet(lo, hi) or merge states.'; break; }
      if (work.length + finished.length + waiting.size > opt.maxStates) { aborted = 'Stopped: more than ' + opt.maxStates.toLocaleString('en') + ' abstract states (path explosion). Try merging at loop exits or join points.'; break; }
      const b = cfg.blocks[st.pc];
      // execute block
      let env = Object.assign({}, st.env);
      for (const s of b.stmts) env[s.v] = s.e ? evalE(s.e, env) : TOP();
      st.cmin[b.id]++; st.cmax[b.id]++;
      const c = blockCost(b);
      st.time = [st.time[0] + c, st.time[1] + c];
      const t = b.term;
      if (t.k === 'exit') {
        finished.push(Object.assign({}, st, { env }));
        T({ k: 'end', s: st.id, env: envStr(env, cfg.vars), time: st.time.slice() });
        continue;
      }
      let outs;
      if (t.k === 'jump') outs = [[t.to, env]];
      else {
        const te = branch(t.e, env, true), fe = branch(t.e, env, false);
        outs = [];
        if (te) outs.push([t.t, te]);
        if (fe) outs.push([t.f, fe]);
        if (outs.length === 2) {
          splits++; created++;
          T({ k: 'split', s: st.id, at: b.name, cond: eStr(t.e), tEnv: envStr(te, cfg.vars), fEnv: envStr(fe, cfg.vars), tB: 'B' + t.t, fB: 'B' + t.f });
        } else if (!outs.length) {
          T({ k: 'dead', s: st.id, at: b.name });
          continue;
        }
      }
      // successors (push false branch first so the true branch is explored first)
      for (let i = outs.length - 1; i >= 0; i--) {
        const [to, e2] = outs[i];
        const tr = transition(st, b.id, to, e2);
        const ns = i === 0 && outs.length === 1 ? st : mk(to, null, null, st.cmin.slice(), st.cmax.slice(), st.time.slice(), st.merged);
        if (i === 0) { ns.cmin = st.cmin; ns.cmax = st.cmax; }
        ns.pc = tr.pc; ns.env = tr.env; ns.loops = tr.loops;
        pushState(ns);
      }
    }

    // ---- collect flow facts
    const res = { steps, splits, merges, paths: finished.length, aborted, trace, anyMerge };
    const any = finished.length > 0;
    res.blockCounts = cfg.blocks.map((b) => {
      if (!any) return { min: 0, max: 0 };
      let mn = INF, mx = 0;
      for (const f of finished) { mn = Math.min(mn, f.cmin[b.id]); mx = Math.max(mx, f.cmax[b.id]); }
      return { min: mn, max: mx };
    });
    res.loops = cfg.loops.map((L, i) => ({
      name: L.name, header: 'B' + L.header, line: L.line, text: L.text, parent: L.parent != null ? cfg.loops[L.parent].name : null,
      perEntryMin: loopStats[i].entries ? loopStats[i].min : null,
      perEntryMax: loopStats[i].entries ? loopStats[i].max : null,
      totalHeaderMax: any ? res.blockCounts[L.header].max : null,
      totalHeaderMin: any ? res.blockCounts[L.header].min : null,
      // total body iterations per run = header executions - loop entries
      totalIterMax: any ? Math.max(...finished.map((f) => f.cmax[L.header] - entriesOf(cfg, L, f.cmin))) : null,
    }));
    res.infeasible = cfg.blocks.filter((b) => any && res.blockCounts[b.id].max === 0).map((b) => b.name);
    res.time = any ? [Math.min(...finished.map((f) => f.time[0])), Math.max(...finished.map((f) => f.time[1]))] : null;
    res.finalEnv = any ? finished.reduce((acc, f) => {
      for (const v of cfg.vars) if (f.env[v]) acc[v] = acc[v] ? join(acc[v], f.env[v]) : f.env[v];
      return acc;
    }, {}) : {};
    // infeasible pairs: only exact if no state merging happened and analysis completed
    res.pairs = [];
    res.pairsExact = !anyMerge && !aborted && any;
    if (res.pairsExact) {
      const cand = cfg.blocks.filter((b) => b.preds.length === 1 && cfg.blocks[b.preds[0]].term.k === 'cond' && res.blockCounts[b.id].max > 0).map((b) => b.id);
      for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
        const a = cand[i], c = cand[j];
        if (cfg.blocks[a].preds[0] === cfg.blocks[c].preds[0]) continue; // siblings: exclusive by structure
        if (!finished.some((f) => f.cmax[a] > 0 && f.cmax[c] > 0)) res.pairs.push(['B' + a, 'B' + c]);
        if (res.pairs.length >= 40) break;
      }
    }
    return res;
  }
  // number of times loop L was entered on a finished path = executions of edges into header from outside
  function entriesOf(cfg, L, counts) {
    let n = 0;
    for (const p of cfg.blocks[L.header].preds) if (!L.members.has(p)) {
      const pb = cfg.blocks[p];
      // a block outside the loop that jumps to the header: if it is a cond block, we cannot attribute exactly; approximate by its count
      n += counts[p];
      void pb;
    }
    return n;
  }

  // ---------------------------------------------------------- flow facts text
  function flowFactsText(cfg, res, inputs) {
    const L = [];
    L.push('// Flow facts derived by abstract execution (simplified notation,');
    L.push('// modelled on the kinds of facts SWEET emits; not SWEET\'s exact syntax).');
    L.push('// #Bn = number of executions of basic block Bn in one run of the program.');
    L.push('');
    if (inputs.length) {
      L.push('// input value annotations used');
      for (const i of inputs) L.push('input ' + i);
      L.push('');
    }
    if (res.aborted) L.push('// WARNING: analysis did not complete; facts below are incomplete and NOT safe.\n');
    L.push('// loop bounds, local to each entry of the loop (iterations = back-edge traversals)');
    for (const l of res.loops) {
      if (l.perEntryMax == null) { L.push('loop ' + l.name + ' @ ' + l.header + ' : never entered'); continue; }
      L.push('loop ' + l.name + ' @ ' + l.header + ' : ' + l.perEntryMin + ' <= iterations <= ' + l.perEntryMax + (l.parent ? '   // nested in ' + l.parent : ''));
    }
    L.push('');
    L.push('// loop bounds, total for one program run (context-insensitive)');
    for (const l of res.loops) if (l.totalHeaderMax != null) L.push('#' + l.header + ' <= ' + l.totalHeaderMax + '   // header of ' + l.name);
    L.push('');
    L.push('// upper execution bounds for every basic block');
    for (const b of cfg.blocks) {
      const c = res.blockCounts[b.id];
      L.push('#' + b.name + ' ' + (c.min === c.max ? '= ' + c.max : 'in [' + c.min + '..' + c.max + ']'));
    }
    L.push('');
    L.push('// infeasible code (never executed for any allowed input)');
    if (res.infeasible.length) for (const b of res.infeasible) L.push('#' + b + ' = 0');
    else L.push('// none found');
    L.push('');
    L.push('// infeasible path pairs: blocks that never both execute in the same run');
    if (!res.pairsExact) L.push('// not computed: requires a complete analysis without state merging');
    else if (res.pairs.length) for (const [a, b] of res.pairs) L.push('#' + a + ' = 0  ||  #' + b + ' = 0');
    else L.push('// none found');
    return L.join('\n');
  }

  function analyze(src, opt) {
    const prog = parse(src);
    const cfg = lower(prog);
    const inputs = [];
    (function findInputs(list) {
      const visitE = (e, v) => { if (!e) return; if (e.k === 'nondet') inputs.push((v ? v + ' in ' : '') + ivStr([e.lo, e.hi])); visitE(e.a); visitE(e.b); };
      for (const s of list) {
        if (s.k === 'assign') visitE(s.e, s.v);
        if (s.k === 'if') { visitE(s.c); findInputs(s.t); if (s.e) findInputs(s.e); }
        if (s.k === 'while' || s.k === 'for') { visitE(s.c); if (s.init) findInputs([s.init]); if (s.step) findInputs([s.step]); findInputs(s.body); }
        if (s.k === 'block') findInputs(s.body);
      }
    })(prog);
    const res = abstractExecute(cfg, opt);
    return { cfg, res, alf: toAlf(cfg), blocks: toReadable(cfg), facts: flowFactsText(cfg, res, inputs), inputs, ivStr, envStr: (e) => envStr(e, cfg.vars) };
  }

  const api = { analyze, parse, lower, abstractExecute, ivStr };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.SweetCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
