// ===== Campus graph core: 순수 함수만 (Leaflet 의존 없음) =====
const CampusCore = (() => {
  const R = 6371008.8;

  // 캠퍼스 범위에서는 등장방형 투영으로 충분 (오차 무시 가능)
  function makeProjection(lat0, lng0) {
    const k = Math.cos((lat0 * Math.PI) / 180);
    const d = Math.PI / 180;
    return {
      fwd: ([lng, lat]) => [(lng - lng0) * d * R * k, (lat - lat0) * d * R],
      inv: ([x, y]) => [lng0 + x / (d * R * k), lat0 + y / (d * R)],
    };
  }

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  function projectOnSegment(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    let t = L2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    const q = [a[0] + t * dx, a[1] + t * dy];
    return { t, q, d: dist(p, q) };
  }

  function segIntersect(p, p2, q, q2) {
    const r = [p2[0] - p[0], p2[1] - p[1]];
    const s = [q2[0] - q[0], q2[1] - q[1]];
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-12) return null;
    const w = [q[0] - p[0], q[1] - p[1]];
    const t = (w[0] * s[1] - w[1] * s[0]) / den;
    const u = (w[0] * r[1] - w[1] * r[0]) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { t, u, pt: [p[0] + t * r[0], p[1] + t * r[1]] };
  }

  function pointInRing(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function distToPolygon(p, ring) {
    if (pointInRing(p, ring)) return 0;
    let best = Infinity;
    for (let i = 0; i < ring.length - 1; i++) best = Math.min(best, projectOnSegment(p, ring[i], ring[i + 1]).d);
    return best;
  }

  class UF {
    constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
    find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
    union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p[b] = a; }
  }

  /**
   * data: { paths:[{id, coords:[[lng,lat]...], props}], entrances:[{id, coord:[lng,lat], props}], buildings:[{id, ring:[[lng,lat]...], props}] }
   * opts: { snapTol (m), entranceTol (m), buildingTol (m) }
   */
  function buildTopology(data, opts = {}) {
    const snapTol = opts.snapTol ?? 1.0;
    const entranceTol = opts.entranceTol ?? 15;
    const buildingTol = opts.buildingTol ?? 8;
    const issues = [];

    const allPts = [
      ...data.paths.flatMap((p) => p.coords),
      ...data.entrances.map((e) => e.coord),
    ];
    if (allPts.length === 0) return { nodes: [], edges: [], issues, proj: null, mainComponent: -1 };
    const lat0 = allPts.reduce((s, c) => s + c[1], 0) / allPts.length;
    const lng0 = allPts.reduce((s, c) => s + c[0], 0) / allPts.length;
    const proj = makeProjection(lat0, lng0);

    // 1) 선분 목록
    const paths = data.paths
      .filter((p) => p.coords.length >= 2)
      .map((p) => ({ ...p, pts: p.coords.map(proj.fwd), inserts: p.coords.slice(0, -1).map(() => []) }));
    const segs = [];
    paths.forEach((p, pi) => {
      for (let i = 0; i < p.pts.length - 1; i++) segs.push({ pi, i, a: p.pts[i], b: p.pts[i + 1] });
    });

    // 2) 교차점에서 쪼개기
    for (let x = 0; x < segs.length; x++) {
      for (let y = x + 1; y < segs.length; y++) {
        const A = segs[x], B = segs[y];
        if (A.pi === B.pi && Math.abs(A.i - B.i) <= 1) continue;
        const hit = segIntersect(A.a, A.b, B.a, B.b);
        if (!hit) continue;
        paths[A.pi].inserts[A.i].push({ t: hit.t, pt: hit.pt });
        paths[B.pi].inserts[B.i].push({ t: hit.u, pt: hit.pt });
      }
    }

    // 3) T자 접합: 선의 끝점이 다른 선분 가까이에 있으면 그 선분에 점 삽입
    paths.forEach((p, pi) => {
      [0, p.pts.length - 1].forEach((vi) => {
        const v = p.pts[vi];
        segs.forEach((S) => {
          if (S.pi === pi && (S.i === vi || S.i === vi - 1)) return;
          const pr = projectOnSegment(v, S.a, S.b);
          if (pr.d <= snapTol && pr.t > 0 && pr.t < 1) paths[S.pi].inserts[S.i].push({ t: pr.t, pt: pr.q });
        });
      });
    });

    // 4) 확장된 꼭짓점 시퀀스
    const verts = []; // {pt}
    const seqs = paths.map((p) => {
      const seq = [];
      p.pts.forEach((pt, i) => {
        seq.push(verts.push({ pt }) - 1);
        if (i < p.pts.length - 1) {
          p.inserts[i].sort((a, b) => a.t - b.t).forEach((ins) => seq.push(verts.push({ pt: ins.pt }) - 1));
        }
      });
      return seq;
    });

    // 5) 허용오차 안의 꼭짓점 병합 (격자 해시)
    const uf = new UF(verts.length);
    const cell = Math.max(snapTol, 0.01);
    const grid = new Map();
    verts.forEach((v, idx) => {
      const gx = Math.floor(v.pt[0] / cell), gy = Math.floor(v.pt[1] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        (grid.get(`${gx + dx},${gy + dy}`) || []).forEach((o) => {
          if (dist(verts[o].pt, v.pt) <= snapTol) uf.union(o, idx);
        });
      }
      const key = `${gx},${gy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(idx);
    });

    const nodes = [];
    const rootToNode = new Map();
    const acc = new Map();
    verts.forEach((v, idx) => {
      const r = uf.find(idx);
      if (!acc.has(r)) acc.set(r, { sx: 0, sy: 0, n: 0 });
      const a = acc.get(r); a.sx += v.pt[0]; a.sy += v.pt[1]; a.n++;
    });
    acc.forEach((a, r) => {
      const xy = [a.sx / a.n, a.sy / a.n];
      rootToNode.set(r, nodes.push({ id: nodes.length, xy, ll: proj.inv(xy), entranceId: null }) - 1);
    });
    const vNode = (idx) => rootToNode.get(uf.find(idx));

    // 6) 엣지
    let edges = [];
    const addEdge = (a, b, props, pathId) => {
      if (a === b) return;
      edges.push({ a, b, len: dist(nodes[a].xy, nodes[b].xy), props, pathId });
    };
    seqs.forEach((seq, pi) => {
      for (let k = 0; k < seq.length - 1; k++) addEdge(vNode(seq[k]), vNode(seq[k + 1]), paths[pi].props, paths[pi].id);
    });

    // 7) 입구를 가장 가까운 인도에 연결
    const entranceNode = new Map();
    data.entrances.forEach((e) => {
      const p = proj.fwd(e.coord);
      let best = null;
      edges.forEach((ed, ei) => {
        const pr = projectOnSegment(p, nodes[ed.a].xy, nodes[ed.b].xy);
        if (!best || pr.d < best.d) best = { ...pr, ei };
      });
      if (!best || best.d > entranceTol) {
        issues.push({ level: 'error', kind: 'isolated_entrance', id: e.id, coord: e.coord,
          msg: best ? `인도에서 ${best.d.toFixed(1)}m 떨어져 있어 연결되지 않았어요 (허용 ${entranceTol}m)` : '연결할 인도가 없어요' });
        return;
      }
      const ed = edges[best.ei];
      let hub;
      if (dist(best.q, nodes[ed.a].xy) <= snapTol) hub = ed.a;
      else if (dist(best.q, nodes[ed.b].xy) <= snapTol) hub = ed.b;
      else {
        hub = nodes.push({ id: nodes.length, xy: best.q, ll: proj.inv(best.q), entranceId: null }) - 1;
        edges.splice(best.ei, 1);
        addEdge(ed.a, hub, ed.props, ed.pathId);
        addEdge(hub, ed.b, ed.props, ed.pathId);
      }
      let en;
      if (dist(p, nodes[hub].xy) <= snapTol && nodes[hub].entranceId == null) en = hub;
      else {
        en = nodes.push({ id: nodes.length, xy: p, ll: e.coord, entranceId: null }) - 1;
        addEdge(en, hub, { connector: true }, null);
      }
      nodes[en].entranceId = e.id;
      entranceNode.set(e.id, en);
    });

    // 8) 연결 요소 분석
    const cuf = new UF(nodes.length);
    edges.forEach((ed) => cuf.union(ed.a, ed.b));
    const deg = new Array(nodes.length).fill(0);
    edges.forEach((ed) => { deg[ed.a]++; deg[ed.b]++; });
    const compSize = new Map();
    nodes.forEach((n, i) => { if (deg[i] > 0) { const r = cuf.find(i); compSize.set(r, (compSize.get(r) || 0) + 1); } });
    let mainComponent = -1, maxSize = 0;
    compSize.forEach((s, r) => { if (s > maxSize) { maxSize = s; mainComponent = r; } });
    nodes.forEach((n, i) => { n.comp = deg[i] > 0 ? cuf.find(i) : -1; n.deg = deg[i]; });

    const strayPaths = new Set();
    edges.forEach((ed) => { if (nodes[ed.a].comp !== mainComponent && ed.pathId) strayPaths.add(ed.pathId); });
    strayPaths.forEach((pid) => {
      const p = data.paths.find((x) => x.id === pid);
      issues.push({ level: 'error', kind: 'disconnected_path', id: pid, coord: p.coords[0],
        msg: '주 인도망과 이어지지 않은 길이에요. 끝점을 다른 길에 붙여 주세요' });
    });
    entranceNode.forEach((ni, eid) => {
      if (nodes[ni].comp !== mainComponent) {
        const e = data.entrances.find((x) => x.id === eid);
        issues.push({ level: 'error', kind: 'entrance_off_network', id: eid, coord: e.coord,
          msg: '입구가 떨어진 길에 붙어 있어 주 인도망에서 갈 수 없어요' });
      }
    });
    nodes.forEach((n, i) => {
      if (n.deg === 1 && n.entranceId == null) {
        issues.push({ level: 'warn', kind: 'dead_end', id: null, coord: n.ll,
          msg: '막다른 길 끝이에요. 실제로 막힌 길이 아니라면 다른 길과 이어 주세요' });
      }
    });

    // 9) 입구 ↔ 건물 검사
    data.entrances.forEach((e) => {
      const bId = e.props.building_id;
      if (!bId) {
        issues.push({ level: 'error', kind: 'entrance_no_building', id: e.id, coord: e.coord, msg: '소속 건물이 지정되지 않은 입구예요' });
        return;
      }
      const b = data.buildings.find((x) => x.id === bId);
      if (!b) {
        issues.push({ level: 'error', kind: 'entrance_bad_building', id: e.id, coord: e.coord, msg: '지정된 건물이 삭제되었어요. 다시 지정해 주세요' });
        return;
      }
      const d = distToPolygon(proj.fwd(e.coord), b.ring.map(proj.fwd));
      if (d > buildingTol) {
        issues.push({ level: 'warn', kind: 'entrance_far', id: e.id, coord: e.coord,
          msg: `「${b.props.name || '이름 없음'}」 외곽선에서 ${d.toFixed(1)}m 떨어져 있어요. 건물을 잘못 고르지 않았는지 확인해 주세요` });
      }
    });
    data.buildings.forEach((b) => {
      if (!data.entrances.some((e) => e.props.building_id === b.id)) {
        const c = b.ring[0];
        issues.push({ level: 'warn', kind: 'building_no_entrance', id: b.id, coord: c,
          msg: `「${b.props.name || '이름 없음'}」에 입구가 없어서 경로를 안내할 수 없어요` });
      }
    });

    return { nodes, edges, issues, proj, mainComponent, entranceNode };
  }

  // ----- 경로 탐색 -----
  function isOpenNow(hours, now = new Date()) {
    if (!hours || !hours.trim()) return true; // 정보 없으면 열린 것으로 간주
    const m = hours.match(/(\d{1,2}):(\d{2})\s*[-~]\s*(\d{1,2}):(\d{2})/);
    if (!m) return true;
    const cur = now.getHours() * 60 + now.getMinutes();
    const s = +m[1] * 60 + +m[2], e = +m[3] * 60 + +m[4];
    return s <= e ? cur >= s && cur <= e : cur >= s || cur <= e; // 자정 넘김 지원
  }

  function edgeAllowed(ed, opt) {
    if (ed.props?.active === false) return false; // 공사 등으로 막힌 길
    if (opt.avoidStairs && (ed.props?.is_stairs || ed.props?.wheelchair === false)) return false;
    return true;
  }

  /**
   * topo: buildTopology 결과
   * startLL: [lng,lat]   targets: [{entranceId, ...}] (이미 필터된 입구)
   */
  function route(topo, startLL, targetEntranceIds, opt = {}) {
    const { nodes, edges, proj } = topo;
    if (!proj || edges.length === 0) return { error: '인도 데이터가 없어요' };
    const sp = proj.fwd(startLL);

    // 출발점을 가장 가까운 허용 엣지에 붙이기
    let best = null;
    edges.forEach((ed, ei) => {
      if (!edgeAllowed(ed, opt) || ed.props?.connector) return;
      const pr = projectOnSegment(sp, nodes[ed.a].xy, nodes[ed.b].xy);
      if (!best || pr.d < best.d) best = { ...pr, ei };
    });
    if (!best) return { error: '출발점 근처에 이용할 수 있는 인도가 없어요' };

    const N = nodes.length;
    const S = N; // 가상 출발 노드
    const adj = Array.from({ length: N + 1 }, () => []);
    edges.forEach((ed, ei) => {
      if (!edgeAllowed(ed, opt)) return;
      adj[ed.a].push({ to: ed.b, w: ed.len, ei });
      adj[ed.b].push({ to: ed.a, w: ed.len, ei });
    });
    const se = edges[best.ei];
    adj[S].push({ to: se.a, w: best.t * se.len, ei: best.ei, partial: 'a' });
    adj[S].push({ to: se.b, w: (1 - best.t) * se.len, ei: best.ei, partial: 'b' });

    const targetNodes = new Set();
    targetEntranceIds.forEach((id) => { const n = topo.entranceNode.get(id); if (n != null) targetNodes.add(n); });
    if (targetNodes.size === 0) return { error: '조건에 맞고 인도에 연결된 입구가 없어요' };

    // 이진 힙 다익스트라 (가장 먼저 닿는 입구 = 가장 가까운 입구)
    const D = new Float64Array(N + 1).fill(Infinity);
    const prev = new Int32Array(N + 1).fill(-1);
    D[S] = 0;
    const heap = [[0, S]];
    const push = (x) => { heap.push(x); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };

    let reached = -1;
    while (heap.length) {
      const [d, u] = pop();
      if (d > D[u]) continue;
      if (targetNodes.has(u)) { reached = u; break; }
      for (const e of adj[u]) {
        const nd = d + e.w;
        if (nd < D[e.to]) { D[e.to] = nd; prev[e.to] = u; push([nd, e.to]); }
      }
    }
    if (reached < 0 && opt.avoidStairs) return { error: '계단 없이 갈 수 있는 길이 없어요. 계단 피하기를 끄거나 경사로/엘리베이터 경로를 추가해 주세요' };
    if (reached < 0) return { error: '출발점에서 목적지 입구까지 이어진 길이 없어요. 검증 탭에서 끊긴 길을 확인해 주세요' };

    const seq = [];
    for (let v = reached; v !== -1; v = prev[v]) seq.push(v);
    seq.reverse();
    const line = seq.map((v) => (v === S ? proj.inv(best.q) : nodes[v].ll));
    line.unshift(startLL);
    // 각 점에 연결된 길의 수 (3 이상이면 갈림길). 처음 두 점(현재 위치, 길에 붙인 점)은 갈림길이 아님
    const degs = seq.map((v) => (v === S ? 2 : nodes[v].deg));
    degs.unshift(2);
    return {
      line, // [[lng,lat]...] 첫 점은 GPS 위치, 둘째 점부터 길 위
      degs,
      distance: D[reached] + best.d,
      entranceId: nodes[reached].entranceId,
      snapDistance: best.d,
    };
  }

  // 가장 가까운 건물 (입구 자동 지정용)
  function nearestBuilding(ll, buildings) {
    if (!buildings.length) return null;
    const proj = makeProjection(ll[1], ll[0]);
    const p = proj.fwd(ll);
    let best = null;
    buildings.forEach((b) => {
      const d = distToPolygon(p, b.ring.map(proj.fwd));
      if (!best || d < best.d) best = { id: b.id, d };
    });
    return best;
  }

  // pgRouting에 넣기 좋은 형태로 내보내기
  function topologyToGeoJSON(topo) {
    return {
      type: 'FeatureCollection',
      features: topo.edges.map((ed, i) => ({
        type: 'Feature',
        properties: {
          id: i + 1, source: ed.a + 1, target: ed.b + 1,
          cost: +ed.len.toFixed(2), reverse_cost: +ed.len.toFixed(2),
          path_id: ed.pathId, connector: !!ed.props?.connector,
          is_stairs: !!ed.props?.is_stairs, wheelchair: ed.props?.wheelchair !== false,
          indoor: !!ed.props?.indoor,
          source_entrance: topo.nodes[ed.a].entranceId, target_entrance: topo.nodes[ed.b].entranceId,
        },
        geometry: { type: 'LineString', coordinates: [topo.nodes[ed.a].ll, topo.nodes[ed.b].ll] },
      })),
    };
  }

  // 횡단보도 미이용: 안내 경로가 지나는 횡단보도(props.crosswalk) 가운데 근처를 실제 GPS가 한 번도 안 지났으면 질러간 것으로 봄
  // track: [[lng, lat, 정확도m, 초], ...] (현장 테스트 기록 형식)
  // ponytail: 거리 기준 하나라 횡단보도가 지름길과 10m 안으로 붙어 있으면 못 잡음. 더 필요하면 지나간 순서·방향까지 볼 것
  function missedCrosswalks(paths, routeLine, track, opt = {}) {
    const radius = opt.radius ?? 10, maxAcc = opt.maxAcc ?? 15;
    if (!routeLine || routeLine.length < 2) return [];
    const pj = makeProjection(routeLine[0][1], routeLine[0][0]);
    const near = (p, line) => { let d = Infinity; for (let i = 1; i < line.length; i++) d = Math.min(d, projectOnSegment(p, line[i - 1], line[i]).d); return d; };
    const R = routeLine.map(pj.fwd);
    const pts = track.filter((t) => t[2] <= maxAcc).map((t) => pj.fwd([t[0], t[1]]));
    if (!pts.length) return [];
    return paths.filter((p) => p.props?.crosswalk && p.props.active !== false).flatMap((p) => {
      const C = p.coords.map(pj.fwd), mid = [(C[0][0] + C.at(-1)[0]) / 2, (C[0][1] + C.at(-1)[1]) / 2];
      if (near(mid, R) > 2) return []; // 안내 경로가 이 횡단보도를 안 지남
      const d = Math.min(...pts.map((q) => Math.hypot(q[0] - mid[0], q[1] - mid[1]))); // 끝점은 질러가도 지나므로 가운데로 판단
      return d > radius ? [{ pathId: p.id, minDist: d }] : [];
    });
  }

  // 상대 높이 변화(m) → 몇 층 이동했는지. 첫 층은 floorChange(2.5m) 넘으면, 그 뒤로는 floorHeight마다 한 층
  // 반올림(층고 절반)으로 하면 계단 중간 층계참에서 층이 바뀌어 버려서 이 방식을 씀
  function floorDelta(dy, opt = {}) {
    const ch = opt.floorChange ?? 2.5, h = opt.floorHeight ?? 3.5, a = Math.abs(dy);
    return a < ch ? 0 : Math.sign(dy) * (1 + Math.floor((a - ch) / h));
  }

  return { buildTopology, route, nearestBuilding, isOpenNow, topologyToGeoJSON, makeProjection, missedCrosswalks, floorDelta };
})();
if (typeof module !== 'undefined') module.exports = CampusCore;
