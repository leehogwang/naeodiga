// ===== 길 안내 진행 (경로 따라가기 + 꺾기 안내 시점 판단) =====
// 화면이나 음성 장치와 상관없는 순수 로직이라 자동 테스트에서 현장 기록을 그대로 재생해 검사할 수 있어요.
//
// 핵심 원칙 (현장 테스트 10회에서 나온 문제를 고친 방식)
// 1) 경로와 안내 단계는 출발할 때 한 번만 만들고, 걷는 동안은 GPS를 그 경로 위에 투영해 '얼마나 왔는지'만 계산
//    → GPS가 길 옆 4~5m에 찍힐 때 생기던 가짜 꺾기, 같은 방향 반복 안내가 사라짐
// 2) 경로에서 offRouteDistance 이상 벗어난 상태가 두 번 연속일 때만 경로를 다시 찾음
// 3) 꺾는 곳까지 '경로를 따라 남은 거리'가 turnAnnounce + (말하는 2초 동안 걸을 거리) 안이면 한 번만 안내
// 4) 15m 안에 이어지는 꺾기는 한 문장으로 묶고, 직전 안내 4초 안에는 겹쳐 말하지 않음
// 5) 도착은 한 번만 판단하고 그 뒤로는 아무것도 하지 않음
const CampusGuide = (() => {
  const isRealTurn = (st) => !!st && ['right', 'left', 'uturn'].includes(st.turn);

  function create(route, steps) {
    const path = route.line.slice(1); // [0]은 GPS 위치, [1]부터 길 위
    const pj = CampusCore.makeProjection(path[0][1], path[0][0]);
    const P = path.map(pj.fwd), cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    return { route, steps, path, pj, P, cum, total: cum.at(-1), progress: 0, offCount: 0, said: [], lastTurnAt: -1e12, arrived: false };
  }

  const distLL = (g, a, b) => { const A = g.pj.fwd(a), B = g.pj.fwd(b); return Math.hypot(A[0] - B[0], A[1] - B[1]); };

  // 위치를 경로에 투영: { dist: 경로까지 거리, along: 경로를 따라 간 거리, q: 투영점(미터 좌표), i: 구간 번호 }
  function project(g, ll) {
    const q = g.pj.fwd(ll);
    let best = null;
    const scan = (lo, hi) => {
      for (let i = 1; i < g.P.length; i++) {
        if (g.cum[i] < lo || g.cum[i - 1] > hi) continue;
        const a = g.P[i - 1], b = g.P[i], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
        let t = L ? ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
        const x = [a[0] + t * dx, a[1] + t * dy], dist = Math.hypot(x[0] - q[0], x[1] - q[1]);
        const along = g.cum[i - 1] + t * Math.sqrt(L);
        // 지그재그 길에서 나중에 지나갈 옆 구간으로 훌쩍 건너뛰지 않도록, 앞으로 많이 건너뛸수록 불리하게
        const score = dist + 0.5 * Math.max(0, along - g.progress - 12);
        if (!best || score < best.score) best = { dist, along, q: x, i, score };
      }
    };
    scan(g.progress - 15, g.progress + 80);
    if (!best || best.dist > 25) scan(-1, Infinity);
    return best;
  }

  const wasSaid = (g, st) => g.said.some((at) => distLL(g, at, st.at) < 8);
  // 15m 안에 바로 이어지는 꺾기
  function chainOf(g, st) {
    const k = g.steps.indexOf(st), after = g.steps[k + 1];
    return isRealTurn(after) && st.dist <= 15 ? after : null;
  }
  function markChain(g, st) { g.said.push(st.at); const nx = chainOf(g, st); if (nx) g.said.push(nx.at); }

  // 출발 안내에 함께 말할 첫 꺾기 (첫 꺾기가 가까우면 "직진하세요" 대신 이걸 말함)
  function startTurn(g, opt) {
    const ft = g.steps.slice(1).find(isRealTurn);
    if (!ft || ft.along > opt.turnAnnounce + 5) return null;
    markChain(g, ft); g.lastTurnAt = opt.now;
    return { turn: ft, chain: chainOf(g, ft), dist: ft.along };
  }

  // 위치가 바뀔 때마다 호출
  // fix: { ll, acc, speed }, opt: { now, target, turnAnnounce, offRouteDistance, arriveRadius, walkSpeed }
  // 돌려주는 값: { arrived, offRoute, announce: { turn, chain, dist } | null, pr, left }
  function update(g, fix, opt) {
    if (g.arrived) return { done: true };
    const pr = project(g, fix.ll);
    const offTol = Math.max(opt.offRouteDistance, Math.min(fix.acc, 30));
    if (pr && pr.dist <= offTol) { g.offCount = 0; g.progress = Math.max(g.progress, pr.along); } else g.offCount++;
    const left = g.total - g.progress;
    const toTarget = opt.target ? distLL(g, fix.ll, opt.target) : Infinity;
    if (toTarget <= Math.max(opt.arriveRadius, Math.min(fix.acc, 30)) || (pr && pr.dist <= offTol && left <= Math.min(opt.arriveRadius, 8))) {
      g.arrived = true;
      return { arrived: true, pr, left, arriveDist: Number.isFinite(toTarget) ? toTarget : left };
    }
    if (g.offCount >= 2) return { offRoute: true, pr, left };
    let announce = null;
    if (fix.acc <= 30) {
      const next = g.steps.slice(1).find((st) => isRealTurn(st) && st.along > g.progress - 3 && !wasSaid(g, st));
      if (next) {
        const d = Math.max(0, next.along - g.progress);
        const speed = Number.isFinite(fix.speed) && fix.speed > 0.3 ? Math.min(fix.speed, 2.5) : opt.walkSpeed;
        const close = d <= opt.turnAnnounce + speed * 2;
        const quiet = opt.now - g.lastTurnAt < 4000 && d > 6;
        if (close && !quiet) {
          const chain = chainOf(g, next);
          markChain(g, next); g.lastTurnAt = opt.now;
          announce = { turn: next, chain, dist: d };
        }
      }
    }
    return { pr, left, announce };
  }

  return { create, project, update, startTurn, isRealTurn };
})();
if (typeof module !== 'undefined') module.exports = CampusGuide;
