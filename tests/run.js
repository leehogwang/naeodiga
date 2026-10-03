// 자동 테스트: node tests/run.js
// 외부 패키지 없이 실행돼요. 실패가 하나라도 있으면 종료 코드 1을 돌려줘요 (GitHub Actions에서 빨간불).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
global.CampusCore = require(path.join(root, 'js/core.js'));
const CampusBot = require(path.join(root, 'js/chatbot.js'));
const CampusGuide = require(path.join(root, 'js/guide.js'));

const groups = {};
function test(group, name, fn) {
  const g = (groups[group] = groups[group] || { pass: 0, fail: [] });
  try { fn(); g.pass++; } catch (e) { g.fail.push(`${name}: ${e.message}`); }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg || '조건이 맞지 않아요'); };
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg ? msg + ' ' : ''}기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`); };
const near = (a, b, tol, msg) => { if (Math.abs(a - b) > tol) throw new Error(`${msg ? msg + ' ' : ''}기대 ${b}±${tol}, 실제 ${a.toFixed(2)}`); };

// ---------------------------------------------------------------
// 1. 경로 엔진 (가상의 작은 지도로 정확한 값을 검사)
// ---------------------------------------------------------------
const m = (x, y) => [127 + x * 0.00001125, 37 + y * 0.000009]; // 대략 미터 단위 좌표
const toy = {
  paths: [
    { id: 'p1', coords: [m(0, 0), m(100, 0)], props: {} },                      // 가로
    { id: 'p2', coords: [m(50, -50), m(50, 50)], props: {} },                   // 세로 (가로와 교차)
    { id: 'p3', coords: [m(80, 0.5), m(80, 40)], props: { is_stairs: true } },  // 0.5m 떨어진 T자, 계단
    { id: 'p4', coords: [m(200, 200), m(220, 200)], props: {} },                // 떨어진 길
    { id: 'p5', coords: [m(0, 0), m(-30, 0)], props: { active: false } },       // 공사 중
  ],
  entrances: [
    { id: 'e1', coord: m(80, 45), props: { building_id: 'b1', type: 'main' } },
    { id: 'e2', coord: m(55, 30), props: { building_id: 'b1', type: 'side' } },
    { id: 'e3', coord: m(300, 300), props: { building_id: 'b1' } },
  ],
  buildings: [{ id: 'b1', ring: [m(60, 30), m(90, 30), m(90, 60), m(60, 60), m(60, 30)], props: { name: '테스트관' } }],
};
const topo = CampusCore.buildTopology(toy);
test('경로 엔진', '교차하는 길을 교차점에서 잘라 이어 줌', () => {
  const r = CampusCore.route(topo, m(10, -3), ['e2'], {});
  near(r.distance, 3 + 40 + 30 + 5, 1, '가로→교차점→세로→입구 거리');
});
test('경로 엔진', '0.5m 떨어진 T자 끝점을 붙여 줌', () => {
  const r = CampusCore.route(topo, m(70, -3), ['e1'], {});
  ok(!r.error, r.error); near(r.distance, 3 + 10 + 40 + 5, 1);
});
test('경로 엔진', '여러 입구 중 가장 가까운 곳을 고름', () => {
  eq(CampusCore.route(topo, m(70, -3), ['e1', 'e2'], {}).entranceId, 'e1');
  eq(CampusCore.route(topo, m(40, -3), ['e1', 'e2'], {}).entranceId, 'e2');
});
test('경로 엔진', '계단 피하기를 켜면 계단 길을 안 씀', () => {
  ok(CampusCore.route(topo, m(85, 10), ['e1'], { avoidStairs: true }).error, '계단으로만 갈 수 있는 입구는 실패해야 함');
});
test('경로 엔진', '공사 중(active=false) 길은 안 씀', () => {
  const r = CampusCore.route(topo, m(-20, -1), ['e2'], {});
  ok(r.snapDistance > 15, '공사 중인 길 위가 아니라 다른 길에 붙어야 함');
});
test('경로 엔진', '인도와 떨어진 입구를 오류로 찾음', () => ok(topo.issues.some((i) => i.kind === 'isolated_entrance' && i.id === 'e3')));
test('경로 엔진', '끊긴 길을 오류로 찾음', () => ok(topo.issues.some((i) => i.kind === 'disconnected_path' && i.id === 'p4')));
test('경로 엔진', '운영시간 판단 (자정 넘김 포함)', () => {
  eq(CampusCore.isOpenNow('08:00-22:00', new Date(2026, 0, 1, 23, 0)), false);
  eq(CampusCore.isOpenNow('22:00-06:00', new Date(2026, 0, 1, 23, 0)), true);
  eq(CampusCore.isOpenNow('', new Date()), true);
});

// ---------------------------------------------------------------
// 2. 실제 캠퍼스 데이터 (data/campus.geojson)
// ---------------------------------------------------------------
const fc = JSON.parse(fs.readFileSync(path.join(root, 'data/campus.geojson'), 'utf8'));
const data = { buildings: [], entrances: [], paths: [] };
(fc.features || []).forEach((f) => {
  const { kind, id, ...props } = f.properties || {}, g = f.geometry || {};
  if (kind === 'building') data.buildings.push({ id, ring: g.coordinates[0], props });
  if (kind === 'entrance') data.entrances.push({ id, coord: g.coordinates, props });
  if (kind === 'path') data.paths.push({ id, coords: g.coordinates, props });
});
const inKorea = (c) => Array.isArray(c) && c[0] > 124 && c[0] < 132 && c[1] > 33 && c[1] < 39;
const bById = new Map(data.buildings.map((b) => [b.id, b]));
const entsOf = (bid) => data.entrances.filter((e) => e.props.building_id === bid);

test('데이터', 'GeoJSON 형식', () => { eq(fc.type, 'FeatureCollection'); ok(fc.features.length > 0, '항목이 없어요'); });
test('데이터', 'id 중복 없음', () => {
  const ids = fc.features.map((f) => f.properties.id), dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  ok(!dup.length, `중복 id: ${dup.join(', ')}`);
});
test('데이터', '모든 좌표가 한국 범위 [경도, 위도] 순서', () => {
  const bad = [];
  data.buildings.forEach((b) => b.ring.forEach((c) => !inKorea(c) && bad.push(b.props.name)));
  data.entrances.forEach((e) => !inKorea(e.coord) && bad.push(e.id));
  data.paths.forEach((p) => p.coords.forEach((c) => !inKorea(c) && bad.push(p.id)));
  ok(!bad.length, `이상한 좌표: ${[...new Set(bad)].slice(0, 5).join(', ')}`);
});
test('데이터', '모든 건물에 이름과 입구가 있음', () => {
  const bad = data.buildings.filter((b) => !b.props.name || !entsOf(b.id).length).map((b) => b.props.name || b.id);
  ok(!bad.length, `이름이나 입구가 없는 건물: ${bad.join(', ')}`);
});
test('데이터', '모든 입구가 있는 건물을 가리킴', () => {
  const bad = data.entrances.filter((e) => !bById.has(e.props.building_id)).map((e) => e.id);
  ok(!bad.length, `건물이 없는 입구: ${bad.join(', ')}`);
});
test('데이터', '층별 안내 형식 (층 번호, 시설 목록)', () => {
  const bad = [];
  data.buildings.forEach((b) => (b.props.floor_info || []).forEach((r) => {
    if (!Number.isFinite(Number(r.floor)) || r.floor === '') bad.push(`${b.props.name} 층 번호 없음`);
    if (!(r.items || []).length) bad.push(`${b.props.name} ${r.floor}층 비어 있음`);
  }));
  ok(!bad.length, bad.slice(0, 5).join(', '));
});
test('데이터', '층 설명에 숫자 빠진 곳 없음 ("지상 층" 같은 실수)', () => {
  const bad = data.buildings.filter((b) => b.props.floors && /(지상|지하)\s*층/.test(b.props.floors)).map((b) => `${b.props.name}: ${b.props.floors}`);
  ok(!bad.length, bad.join(', '));
});
const realTopo = CampusCore.buildTopology(data);
test('데이터', '인도가 하나로 이어져 있음 (끊긴 길 없음)', () => {
  const errs = realTopo.issues.filter((i) => i.level === 'error');
  ok(!errs.length, errs.slice(0, 3).map((i) => i.msg).join(' / '));
});
test('데이터', '여러 출발점에서 모든 건물까지 경로가 나옴', () => {
  const starts = data.paths.filter((_, i) => i % Math.max(1, Math.floor(data.paths.length / 6)) === 0).slice(0, 6).map((p) => p.coords[0]);
  const bad = [];
  starts.forEach((s) => data.buildings.forEach((b) => {
    const r = CampusCore.route(realTopo, s, entsOf(b.id).map((e) => e.id), {});
    if (r.error) bad.push(`${b.props.name}: ${r.error}`);
  }));
  ok(!bad.length, `${bad.length}건 실패: ${bad.slice(0, 3).join(' / ')}`);
});

// ---------------------------------------------------------------
// 3. 챗봇 (실제 데이터로 실제로 할 법한 질문)
// ---------------------------------------------------------------
const bname = (id) => bById.get(id)?.props.name;
// [질문, 기대 의도(여러 개면 배열), 기대 건물 이름 또는 null, 답에 들어 있어야 할 말, 들어 있으면 안 되는 말]
const QA = [
  ['안녕', 'greet'],
  ['도움말', 'help'],
  ['고마워', 'thanks'],
  ['중원도서관 어디야?', 'route', '중원도서관'],
  ['도서관 어디야', 'route', '중원도서관'],
  ['U7', 'route', '중원도서관'],
  ['ㅈㅇㄷㅅㄱ', 'route', '중원도서관'],
  ['중원도사관 가는 길', 'route', '중원도서관'],
  ['인문관 어디', 'route', '인문사회관'],
  ['K6 어디야', 'route', '인문사회관'],
  ['학관 어디야', 'route', '학생회관'],
  ['체육관 어디', 'route', '건국체육관'],
  ['운동장 어디야', 'route', 'ku운동장'],
  ['노천극장 가는 길', 'route', '노천극장'],
  ['복합실습동 어디야', 'route', '복합실습동'],
  ['해오름학사 여동', 'route', '해오름학사 여동'],
  ['기숙사 어디야?', 'clarify', null, '4곳'],
  ['제3공학관 어디', ['unknown', 'clarify']],
  ['학생회관 층별 안내', 'floorlist', '학생회관'],
  ['학생회관 2층에 뭐 있어?', 'floorlist', '학생회관', '신한은행'],
  ['도서관 3층에 뭐 있어?', 'floorlist', '중원도서관', '그룹스터디실'],
  ['4층은?', 'floorlist', '중원도서관', '일반도서 자료실'],
  ['교수연구동 소개해줘', 'info', '교수연구동'],
  ['편의점 어디 있어?', 'item', '학생회관', '편의점'],
  ['CU 어디야', 'item', '학생회관', '편의점', 'K-CUBE'],
  ['카페 어디', 'item', null, '중원도서관'],
  ['프린터 어디 있어', 'item', '인문사회관'],
  ['우체국 어디야', 'item', '학생회관', '2층'],
  ['보건실 몇 층이야', 'item', '학생회관', '2층'],
  ['헬스장 어디야', 'item', '학생회관', '지하 1층'],
  ['구내식당 어디', 'item', '해오름학사 여동'],
  ['맘스터치 어디야', 'item', '해오름학사 남동'],
  ['중원도서관 몇 시까지 해?', 'hours', '중원도서관'],
  ['거기 입구 알려줘', 'entrance', '중원도서관'],
  ['자연과학관 엘리베이터 있어?', 'access', '자연과학관'],
];
const bot = CampusBot.create(data);
QA.forEach(([q, intent, bn, must, mustNot]) => {
  test('챗봇', q, () => {
    const r = bot.reply(q);
    const want = Array.isArray(intent) ? intent : [intent];
    ok(want.includes(r.intent), `의도 기대 ${want.join('/')}, 실제 ${r.intent} ("${r.text.slice(0, 40)}")`);
    if (bn) {
      const got = bname(r.building) || (r.actions || []).map((a) => bname(a.bid)).find(Boolean) || '';
      ok(got === bn || r.text.includes(bn), `건물 기대 ${bn}, 실제 ${got || '없음'} ("${r.text.slice(0, 40)}")`);
    }
    const full = r.text + (r.floorsText || '');
    if (must) ok(full.includes(must), `답에 "${must}"가 없음 ("${full.slice(0, 50)}")`);
    if (mustNot) ok(!full.includes(mustNot), `답에 "${mustNot}"가 들어 있음`);
  });
});
test('챗봇', '모든 건물 이름과 별칭을 알아들음', () => {
  const b2 = CampusBot.create(data), miss = [];
  data.buildings.forEach((b) => [b.props.name, ...(b.props.aliases || [])].forEach((n) => {
    const r = b2.reply(`${n} 어디야?`);
    if (r.building !== b.id) miss.push(n);
  }));
  ok(!miss.length, `못 알아들은 이름: ${miss.join(', ')}`);
});
test('챗봇', '호실 노드가 있으면 건물 길찾기 + 위치 표시', () => {
  const nodes = [{ name: '상허 309', latitude: 36.95, longitude: 127.9, floor: 3, building: { code: 'U10' } }];
  const b3 = CampusBot.create({ ...data, nodes });
  const r = b3.reply('상허 연구동 309호 어디야?');
  eq(r.intent, 'room'); eq(bname(r.building), '상허 연구동');
  ok(r.auto && r.auto.node && r.auto.node.ll[0] === 127.9, '노드 좌표가 없음');
  ok(r.text.includes('3층 309호'), r.text);
  eq(b3.reply('국제교육관 309호 어디야?').intent, 'floors', '노드 없는 건물은 기존 답');
  eq(b3.reply('상허 309').intent, 'room', "'호' 없이 번호만");
  eq(b3.reply('국제교육관 309').intent, 'floors', "'호' 없이, 노드 없음");
});

// ---------------------------------------------------------------
// 4. 단계별 안내와 음성 안내의 일관성
//    걸어가다 경로를 다시 계산해도, 남은 꺾는 곳의 방향이 처음 안내와 같아야 함
// ---------------------------------------------------------------
test('길 안내', '걷는 중 다시 계산해도 꺾는 방향이 바뀌지 않음 (모든 건물)', () => {
  const start = data.paths[0].coords[0], bad = [];
  data.buildings.forEach((b) => {
    const ids = entsOf(b.id).map((e) => e.id);
    const r = CampusCore.route(realTopo, start, ids, {}); if (r.error) return;
    const turns = CampusBot.directions(r.line).filter((s) => ['right', 'left', 'uturn'].includes(s.turn));
    const mid = r.line[Math.floor(r.line.length / 2)];
    const r2 = CampusCore.route(realTopo, mid, ids, {}); if (r2.error) return;
    CampusBot.directions(r2.line).filter((s) => ['right', 'left', 'uturn'].includes(s.turn)).forEach((s) => {
      const same = turns.find((t) => Math.hypot((t.at[0] - s.at[0]) * 89000, (t.at[1] - s.at[1]) * 111000) < 3);
      if (same && same.turn !== s.turn) bad.push(`${b.props.name}: ${same.turn}→${s.turn}`);
    });
  });
  ok(!bad.length, bad.slice(0, 3).join(', '));
});
test('길 안내', '모든 안내가 출발로 시작해서 도착으로 끝남', () => {
  const start = data.paths[0].coords[0];
  data.buildings.forEach((b) => {
    const r = CampusCore.route(realTopo, start, entsOf(b.id).map((e) => e.id), {}); if (r.error) return;
    const st = CampusBot.directions(r.line, { arrive: '도착' });
    eq(st[0].turn, 'start', b.props.name); eq(st.at(-1).turn, 'arrive', b.props.name);
  });
});

// ---------------------------------------------------------------
// 5. 현장 기록으로 검증한 음성 안내 버그 (다시 생기지 않게)
// ---------------------------------------------------------------
const real = (s) => ['right', 'left', 'uturn'].includes(s.turn);
test('음성 안내', '휘어진 길(갈림길 아님)은 꺾기로 보지 않음', () => {
  // 반지름 20m로 90° 휘어지는 길, 갈림길 없음
  const pts = []; for (let a = 0; a <= 90; a += 10) pts.push(m(20 * Math.sin((a * Math.PI) / 180), 20 - 20 * Math.cos((a * Math.PI) / 180)));
  const st = CampusBot.directions(pts, { degs: pts.map(() => 2) });
  eq(st.filter(real).length, 0, '꺾기 수');
});
test('음성 안내', '갈림길에서 직각으로 꺾으면 꺾기로 봄', () => {
  const pts = [m(0, 0), m(30, 0), m(30, 30)];
  const st = CampusBot.directions(pts, { degs: [1, 3, 1] });
  eq(st.filter(real).length, 1); eq(st[1].turn, 'left', '동쪽으로 가다 북쪽');
});
const rtPath = path.join(root, 'data/route-tests.json');
const trialsRec = fs.existsSync(rtPath) ? (JSON.parse(fs.readFileSync(rtPath, 'utf8')).trials || []) : [];
if (trialsRec.length) {
  test('음성 안내', '현장 기록: GPS가 길 옆에 찍혀도 코앞(3m 안)에 가짜 꺾기가 생기지 않음', () => {
    let fake = 0, n = 0;
    trialsRec.forEach((tr) => {
      const ids = entsOf(tr.building_id).map((e) => e.id); if (!ids.length) return;
      tr.track.forEach((p, i) => {
        if (i % 5) return;
        const r = CampusCore.route(realTopo, [p[0], p[1]], ids, {}); if (r.error) return;
        const st = CampusBot.directions(r.line.slice(1), { degs: r.degs.slice(1) });
        const first = st.slice(1).find(real);
        const pj = CampusCore.makeProjection(p[1], p[0]);
        if (first && Math.hypot(...pj.fwd(first.at)) < 3 && r.snapDistance > 2) fake++;
        n++;
      });
    });
    ok(fake / n < 0.05, `GPS가 길 옆일 때 코앞 꺾기 ${fake}/${n}번 (5% 미만이어야 함)`);
  });
  // 현장 기록 10건을 앱과 같은 로직(js/guide.js)으로 그대로 재생
  const OPT = { turnAnnounce: 15, offRouteDistance: 15, arriveRadius: 15, walkSpeed: 1.35 };
  const runs = trialsRec.map((tr) => {
    const ents = entsOf(tr.building_id), ids = ents.map((e) => e.id);
    let r = CampusCore.route(realTopo, tr.start, ids, {}); if (r.error) return null;
    const mk = (rr) => CampusGuide.create(rr, CampusBot.directions(rr.line.slice(1), { degs: rr.degs.slice(1) }));
    let g = mk(r);
    const firstTurn = g.steps.slice(1).find(CampusGuide.isRealTurn);
    const st = CampusGuide.startTurn(g, { ...OPT, now: 0 });
    const ann = [], out = { b: tr.building, ann, arrivals: 0, startOk: !(firstTurn && firstTurn.along <= 20) || !!st };
    for (const p of tr.track) {
      const now = p[3] * 1000;
      const target = ents.find((e) => e.id === r.entranceId).coord;
      const res = CampusGuide.update(g, { ll: [p[0], p[1]], acc: p[2], speed: 1.35 }, { ...OPT, now, target });
      if (res.done) continue;
      if (res.arrived) { out.arrivals++; continue; }
      if (res.offRoute) { const r2 = CampusCore.route(realTopo, [p[0], p[1]], ids, {}); if (!r2.error) { r = r2; g = mk(r); } continue; }
      if (res.announce) ann.push({ t: p[3], d: res.announce.dist, turn: res.announce.turn.turn });
    }
    // 도착 뒤에도 위치가 계속 들어와도 다시 도착하지 않는지 (기록 끝 위치를 몇 번 더 넣어 봄)
    const last = tr.track.at(-1);
    for (let k = 1; k <= 5; k++) { const res = CampusGuide.update(g, { ll: [last[0], last[1]], acc: last[2] }, { ...OPT, now: (last[3] + k) * 1000, target: null }); if (res.arrived) out.arrivals++; }
    return out;
  }).filter(Boolean);
  const allAnn = runs.flatMap((x) => x.ann);
  test('음성 안내', '현장 기록 재생: 도착 안내는 한 번만 (도착 기관총 방지)', () => {
    const bad = runs.filter((x) => x.arrivals > 1).map((x) => `${x.b} ${x.arrivals}회`);
    ok(!bad.length, bad.join(', '));
  });
  test('음성 안내', '현장 기록 재생: 첫 꺾기가 20m 안이면 출발 안내에서 함께 말함 (직진하라더니 바로 꺾으라는 모순 방지)', () => {
    const bad = runs.filter((x) => !x.startOk).map((x) => x.b); ok(!bad.length, bad.join(', '));
  });
  test('음성 안내', '현장 기록 재생: 꺾기 안내는 대부분 충분히 미리 (중간값 12m 이상, 6m 안에서 처음 말한 것 10% 이하)', () => {
    const ds = allAnn.map((a) => a.d).sort((a, b) => a - b), med = ds[Math.floor(ds.length / 2)];
    const late = ds.filter((d) => d < 6).length;
    ok(ds.length > 0, '안내가 하나도 없음');
    ok(med >= 12, `중간값 ${med.toFixed(1)}m`);
    ok(late / ds.length <= 0.1, `6m 안에서 처음 말한 것 ${late}/${ds.length}`);
  });
  test('음성 안내', '현장 기록 재생: 4초 안에 안내가 겹치지 않음 (좌우 동시 발화 방지)', () => {
    const bad = [];
    runs.forEach((x) => x.ann.forEach((a, k) => { if (k && a.t - x.ann[k - 1].t < 4 && a.d > 6) bad.push(`${x.b} ${a.t}초`); }));
    ok(!bad.length, bad.join(', '));
  });
  test('음성 안내', '현장 기록 재생: 같은 방향 안내 도배 없음 (실제 걸은 100m당 안내 4회 이하)', () => {
    const bad = [];
    runs.forEach((x, i) => {
      const r = CampusCore.route(realTopo, trialsRec[i].start, entsOf(trialsRec[i].building_id).map((e) => e.id), {});
      const walked = Math.max(trialsRec[i].walked_m || 0, r.distance, 50); // 중간에 경로가 바뀌면 실제로 더 걸으므로 큰 쪽
      if (x.ann.length / walked * 100 > 4) bad.push(`${x.b} ${Math.round(walked)}m에 ${x.ann.length}회`);
    });
    ok(!bad.length, bad.join(', '));
  });
}

test('경로 엔진', '상대 높이로 층 이동 판정 (층계참에서는 안 바뀜)', () => {
  const f = (dy) => CampusCore.floorDelta(dy, { floorChange: 2.5, floorHeight: 3.5 });
  eq(f(0.5), 0, '손 높이 흔들림'); eq(f(1.8), 0, '층계참'); eq(f(2.6), 1); eq(f(3.6), 1);
  eq(f(5.9), 1, '두 층 직전'); eq(f(7.1), 2, '과기대 3층 7.12m'); eq(f(-3.5), -1, '내려감');
});
test('경로 엔진', '횡단보도 미이용 감지 (건넘 vs 대각선으로 질러감)', () => {
  const cw = [{ id: 'cw', coords: [m(50, 0), m(50, 20)], props: { crosswalk: true } }];
  const line = [m(0, 0), m(50, 0), m(50, 20), m(80, 20)];
  const trk = (pts) => pts.map((p, i) => [...p, 5, i]);
  eq(CampusCore.missedCrosswalks(cw, line, trk([m(0, 0), m(25, 0), m(50, 0), m(50, 10), m(50, 20), m(80, 20)])).length, 0, '횡단보도로 건넘');
  eq(CampusCore.missedCrosswalks(cw, line, trk([m(0, 0), m(20, 8), m(40, 16), m(50, 20), m(80, 20)])).length, 1, '대각선으로 질러감');
  eq(CampusCore.missedCrosswalks(cw, [m(0, 0), m(40, 0)], trk([m(0, 0), m(40, 0)])).length, 0, '경로가 횡단보도를 안 지남');
});

// 현장 기록에서 횡단보도 미이용 자동 표시 (사람 행동이라 실패로 치지 않고 알려만 줌)
const missed = trialsRec.flatMap((tr) => {
  const r = CampusCore.route(realTopo, tr.start, [tr.planned_entrance_id], {}); if (r.error) return [];
  return CampusCore.missedCrosswalks(data.paths, r.line.slice(1), tr.track).map((x) => `${tr.building} (${tr.started_at.slice(0, 16)}): 횡단보도 ${x.pathId} 가운데에서 ${Math.round(x.minDist)}m 떨어져 지나감`);
});

// ---------------------------------------------------------------
let total = 0, failed = 0;
console.log('\n캠퍼스 길찾기 자동 테스트\n');
Object.entries(groups).forEach(([g, r]) => {
  total += r.pass + r.fail.length; failed += r.fail.length;
  console.log(`${r.fail.length ? '✗' : '✓'} ${g}: ${r.pass}/${r.pass + r.fail.length} 통과`);
  r.fail.forEach((f) => console.log(`    - ${f}`));
});
const nCw = data.paths.filter((p) => p.props.crosswalk).length;
console.log(`\n횡단보도 미이용 의심 (현장 기록 ${trialsRec.length}건, 횡단보도 ${nCw}곳): ${!nCw ? '편집기에서 횡단보도를 표시하면 검사해요' : missed.length ? `\n    - ${missed.join('\n    - ')}` : '없음'}`);
console.log(`\n전체 ${total}개 중 ${total - failed}개 통과${failed ? `, ${failed}개 실패` : ''}\n`);
process.exit(failed ? 1 : 0);
