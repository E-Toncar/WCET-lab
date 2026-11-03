// Example programs for the T-CREST Lab (Patmos-style assembly)
(function (global) {
  const EX = [
    {
      id: 'spm-vs-cache',
      title: 'Scratchpad vs. data cache',
      blurb: 'The same array is summed twice. Scratchpad loads (lwl) have a fixed latency, so that loop is costed exactly. Data-cache loads (lwc) are assumed to miss, so that loop is overestimated. Compare the two loop bodies in the block table.',
      src: `# Sum 8 values twice: from the scratchpad, then through the data cache.
.spm 0   5 3 8 1 9 2 7 4
.mem 64  5 3 8 1 9 2 7 4

.func main
        li    r1 = 0              # i
        li    r2 = 0              # sum
        li    r3 = 8              # n
spm_loop:
.loopbound 8
        cmplt p1 = r1, r3
        (!p1) br spm_done         # delayed branch: the next 2 bundles always execute
        nop
        nop
        lwl   r4 = [r1 + 0]       # scratchpad: fixed latency
        addi  r1 = r1, 1
        add   r2 = r2, r4
        br    spm_loop
        nop
        nop
spm_done:
        li    r1 = 0
        li    r5 = 0
cache_loop:
.loopbound 8
        cmplt p1 = r1, r3
        (!p1) br cache_done
        nop
        nop
        lwc   r4 = [r1 + 64]      # data cache: static analysis assumes a miss
        addi  r1 = r1, 1
        add   r5 = r5, r4
        br    cache_loop
        nop
        nop
cache_done:
        halt
`,
    },
    {
      id: 'branchy',
      title: 'Data-dependent branch',
      blurb: 'Finds the maximum of an array with a conditional branch. The measured time depends on the data; the WCET bound must assume the slow path on every iteration.',
      src: `# Maximum of 8 values with a data-dependent branch.
.mem 0   4 9 2 7 5 1 8 3

.func main
        li    r1 = 0              # i
        li    r2 = 0              # max
        li    r3 = 8              # n
loop:
.loopbound 8
        cmplt p1 = r1, r3
        (!p1) br done
        nop
        nop
        lwm   r4 = [r1 + 0]       # uncached main-memory load: fixed latency
        nop                       # fill the load delay
        cmplt p2 = r2, r4         # new maximum?
        (!p2) brnd skip           # non-delayed branch, +2 cycles when taken
        mov   r2 = r4             # slow path: update and count
        addi  r6 = r6, 1
        addi  r7 = r1, 0
        addi  r8 = r8, 2
skip:
        addi  r1 = r1, 1
        br    loop
        nop
        nop
done:
        halt
`,
    },
    {
      id: 'single-path',
      title: 'Single-path code',
      blurb: 'The same computation as "Data-dependent branch", rewritten with predication. Both paths are always issued, so every run takes the same time and the bound equals the measurement.',
      src: `# Maximum of 8 values, single-path version: no data-dependent branch.
.mem 0   4 9 2 7 5 1 8 3

.func main
        li    r1 = 0
        li    r2 = 0
        li    r3 = 8
loop:
.loopbound 8
        cmplt p1 = r1, r3
        (!p1) br done             # the loop branch depends only on the counter
        nop
        nop
        lwm   r4 = [r1 + 0]
        nop
        cmplt p2 = r2, r4
        (p2)  mov  r2 = r4        # predicated: issued every time, takes effect only if p2
        { (p2) addi r6 = r6, 1 ; (p2) addi r7 = r1, 0 }   # dual-issue bundle
        (p2)  addi r8 = r8, 2
        addi  r1 = r1, 1
        br    loop
        nop
        nop
done:
        halt
`,
    },
    {
      id: 'method-cache',
      title: 'Method and stack cache',
      blurb: 'main calls two functions in a loop. Shrink the method cache below the code size and every call and return becomes a miss; shrink the stack cache and frames spill to memory.',
      src: `# Calls in a loop: the method cache holds whole functions,
# the stack cache holds the stack frames reserved with sres.
.func main
        sres  4                   # reserve 4 words of stack cache
        li    r10 = 0
        li    r11 = 4
mloop:
.loopbound 4
        cmplt p1 = r10, r11
        (!p1) br mdone
        nop
        nop
        callnd scale              # non-delayed call: +3 cycles, method cache lookup
        callnd accumulate
        addi  r10 = r10, 1
        br    mloop
        nop
        nop
mdone:
        sfree 4
        halt

.func scale
        sres  6
        sws   [r0 + 0] = r10      # stack-cache store: fixed latency
        sl    r1 = r10, r11
        add   r1 = r1, r10
        addi  r1 = r1, 3
        sub   r1 = r1, r11
        lws   r2 = [r0 + 0]
        add   r1 = r1, r2
        sfree 6
        retnd

.func accumulate
        sres  6
        add   r12 = r12, r1
        addi  r13 = r13, 1
        xor   r14 = r12, r13
        and   r14 = r14, r11
        or    r15 = r15, r14
        sfree 6
        retnd
`,
    },
    {
      id: 'wrong-bound',
      title: 'A wrong flow fact',
      blurb: 'The annotation claims 5 iterations but the loop runs 10. The analysis trusts the annotation and returns a bound that is below the measured time. Flow facts must be correct.',
      src: `# The loop runs 10 times, but the annotation says 5.
.func main
        li    r1 = 0
        li    r3 = 10
loop:
.loopbound 5                      # WRONG: should be 10
        cmplt p1 = r1, r3
        (!p1) br done
        nop
        nop
        addi  r1 = r1, 1
        br    loop
        nop
        nop
done:
        halt
`,
    },
  ];
  if (typeof module !== 'undefined' && module.exports) module.exports = EX;
  else global.TCREST_EXAMPLES = EX;
})(typeof window !== 'undefined' ? window : globalThis);
